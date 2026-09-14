/**
 * Brief chat webview: layout, host message dispatch, view switching.
 */

import { parseChatViewState } from "../src/webview-message.js";
import { Composer } from "./composer.js";
import { brandMark, el, icon } from "./dom.js";
import { HistoryView } from "./history.js";
import { SubagentsStrip } from "./subagents.js";
import { RunningTasksStrip } from "./running-tasks.js";
import { Transcript } from "./transcript.js";
import type {
	ChatReadReceipt,
	AgentEvent,
	AgentMessage,
	HostToWebview,
	ImageAttachment,
	ComposerAttachment,
	RpcModel,
	SelectionAttachment,
	SessionActionSnapshot,
	StatusSnapshot,
	StatisticsKind,
	StatisticsSnapshot,
	WebviewToHost,
} from "../src/protocol.js";

const vscode = acquireVsCodeApi();

function post(message: WebviewToHost): void {
	vscode.postMessage(message);
}

let historyOnly = false;
let historySessionId: string | undefined;
const app = document.getElementById("app") as HTMLDivElement;
app.classList.add("chat-root");
app.addEventListener("focusin", () => { post({ type: "viewFocused" }); focusRenderedChat(); });
window.addEventListener("focus", () => focusRenderedChat());
document.addEventListener("visibilitychange", () => focusRenderedChat());

// Session actions live in the VS Code view title bar (same row as maximize).

// ---------------------------------------------------------------------------
// Notices + views
// ---------------------------------------------------------------------------

// Toasts float OVER the thread instead of sitting above it. As a flow sibling
// each arriving notice shortened the scroller by its own height, which pushed
// the tail out from under a reader who was following it — most visibly when
// opening a subagent, where the notice and the new thread land together and the
// reader is left chasing the bottom. The dock is zero-height, so the transcript
// never resizes and no scroll compensation is needed.
const noticesDock = el("div", "notices-dock");
const notices = el("div", "notices");
noticesDock.appendChild(notices);

const observeBanner = el("div", "observe-banner");
observeBanner.style.display = "none";
{
	const mark = brandMark(14);
	mark.classList.add("working-mark");
	observeBanner.appendChild(mark);
	observeBanner.appendChild(el("span", "observe-text", "Live in another client — read-only"));
	const stopObservingBtn = document.createElement("button");
	stopObservingBtn.className = "observe-stop";
	stopObservingBtn.textContent = "Back to my session";
	stopObservingBtn.title = "Stop watching and return to your chat session";
	stopObservingBtn.addEventListener("click", () => post({ type: "stopObserving" }));
	observeBanner.appendChild(stopObservingBtn);
}

const chatView = el("div", "chat-view");
const scroller = el("div", "messages");
const pendingInputs = el("details", "pending-inputs") as HTMLDetailsElement;
pendingInputs.hidden = true;
pendingInputs.open = true;
const pendingInputsHeading = el("summary", "pending-inputs-heading");
const pendingInputsList = el("div", "pending-inputs-list");
pendingInputs.append(pendingInputsHeading, pendingInputsList);
const statisticsArea = el("section", "statistics-area");
statisticsArea.setAttribute("aria-label", "Brief local statistics");
statisticsArea.hidden = true;
chatView.append(scroller, statisticsArea, pendingInputs);

// Local, manual snapshots. These never enter Transcript or saved view state.
const statisticsCards = new Map<StatisticsKind, {
	root: HTMLElement; requestId: number; snapshot?: StatisticsSnapshot; error?: string; loading: boolean;
}>();
const statisticsRequestScope = Math.floor(Math.random() * 4_000_000_000);
let nextStatisticsRequestId = 0;

function clearStatistics(): void {
	statisticsCards.clear();
	statisticsArea.replaceChildren();
	statisticsArea.hidden = true;
}

function queryStatistics(kind: StatisticsKind): void {
	let card = statisticsCards.get(kind);
	if (!card) {
		card = { root: el("article", "statistics-card"), requestId: 0, loading: false };
		card.root.dataset.kind = kind;
		statisticsCards.set(kind, card);
		statisticsArea.appendChild(card.root);
	}
	card.requestId = statisticsRequestScope * 1_000_000 + ++nextStatisticsRequestId;
	card.loading = true;
	card.error = undefined;
	statisticsArea.hidden = false;
	renderStatistics(kind);
	post({ type: "queryStatistics", kind, requestId: card.requestId });
}

function renderStatistics(kind: StatisticsKind): void {
	const card = statisticsCards.get(kind)!;
	const snapshot = card.snapshot;
	const title = `Brief local information · /${kind}`;
	const heading = el("h3", "", title);
	const actions = el("div", "statistics-actions");
	const refresh = el("button", "", "Refresh");
	refresh.addEventListener("click", () => queryStatistics(kind));
	const copy = el("button", "", "Copy") as HTMLButtonElement;
	copy.disabled = !snapshot;
	copy.addEventListener("click", async () => {
		if (!snapshot) return;
		const text = [title, `Queried: ${snapshot.queriedAt}`, snapshot.scope,
			...(card.error ? [`Old snapshot — ${card.error}`] : []),
			...(snapshot.running ? ["Running — values may still increase."] : []),
			...snapshot.rows.map((row) => `${row.label}: ${row.value}`)].join("\n");
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(text);
			addNotice("info", "Statistics snapshot copied.");
		} catch {
			addNotice("warning", "Could not copy statistics snapshot.");
		}
	});
	const close = el("button", "", "Close");
	close.addEventListener("click", () => {
		statisticsCards.delete(kind);
		card.root.remove();
		statisticsArea.hidden = statisticsCards.size === 0;
	});
	actions.append(refresh, copy, close);
	const header = el("div", "statistics-heading");
	header.append(heading, actions);
	card.root.replaceChildren(header);
	card.root.setAttribute("aria-busy", String(card.loading));
	card.root.classList.toggle("stale", Boolean(card.error && snapshot));
	const state = el("p", "statistics-state");
	state.setAttribute("role", "status");
	state.textContent = card.loading ? "Querying… Previous values remain a manual snapshot."
		: card.error ? `${snapshot ? "Old snapshot — " : "Query failed — "}${card.error}` : "Manual snapshot · not part of the conversation";
	card.root.appendChild(state);
	if (!snapshot) return;
	card.root.append(el("p", "statistics-time", `Queried: ${snapshot.queriedAt}`), el("p", "statistics-scope", snapshot.scope));
	if (snapshot.running) card.root.appendChild(el("p", "statistics-running", "Running — values may still increase."));
	const rows = el("dl", "statistics-rows");
	for (const row of snapshot.rows) rows.append(el("dt", "", row.label), el("dd", "", row.value));
	card.root.appendChild(rows);
}

/** Keep queue previews outside durable history. Preview text is not an identity. */
function renderPendingInputs(actions?: SessionActionSnapshot): void {
	pendingInputsList.replaceChildren();
	const add = (label: string, text: string) => {
		const row = el("div", "pending-input");
		row.append(el("span", "pending-input-phase", label), el("span", "pending-input-preview", text));
		row.title = text;
		pendingInputsList.appendChild(row);
	};
	if (actions?.active?.kind === "turn" && actions.active.phase !== "running") {
		add("Delivering", actions.active.label);
	}
	for (const text of actions?.steering ?? []) add("Next turn", text);
	for (const text of actions?.followUps ?? []) add("After run", text);
	const count = pendingInputsList.childElementCount;
	pendingInputs.hidden = count === 0;
	pendingInputsHeading.textContent = `Pending input · ${count}`;
	pendingInputsHeading.title = "Waiting to enter the conversation. Shows the runtime's visible queue only; disappearance is not a model-read receipt.";
}

// Scope IDs to this webview instance: a late rejection from a panel that was
// closed and reopened must never match a new panel's first `prompt-1` row.
const promptClientScope =
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let nextPromptClientRequestId = 0;
const pendingPrompts = new Map<string, { text: string; images: ImageAttachment[]; selections: SelectionAttachment[]; attachments: ComposerAttachment[]; optimistic: boolean }>();
// Native image pickers resolve later; replies must stay with the requesting
// document, including when an editor tab is closed and reopened.
const imageRequestScope = Math.floor(Math.random() * 4_000_000_000);
let nextImageRequestId = 0;
const pendingImageRequests = new Set<number>();
const fileSearchRequestScope = Math.floor(Math.random() * 4_000_000_000);
let nextFileSearchRequestId = 0;
const pendingFileSearches = new Map<number, number>();
/** Last host-confirmed session identity displayed in this panel. */
let authoritativeSessionId: string | undefined;
const composerDeps = {
	onSend: (text: string, images: ImageAttachment[], selections: SelectionAttachment[], attachments: ComposerAttachment[] = []) => {
		const clientRequestId = `${promptClientScope}-${++nextPromptClientRequestId}`;
		// Attachment files can have changed in an editor. Only the host can know
		// the actual message; wait for its authoritative echo instead of inventing one.
		const optimistic = !composer.isStreaming && attachments.length === 0;
		pendingPrompts.set(clientRequestId, { text, images: [...images], selections: [...selections], attachments: attachments.map((attachment) => ({ ...attachment, ...(attachment.image ? { image: { ...attachment.image } } : {}) })), optimistic });
		if (optimistic) transcript.showOptimisticUserMessage(clientRequestId, text, images);
		if (!composer.isStreaming) transcript.markSending();
		post({
			type: "prompt",
			// Stamp the thread this was typed in. The host refuses the send if that
			// is no longer the thread it would deliver to, so a view that moved
			// under the operator cannot put their words in another conversation.
			payload: { text, images, selections, ...(attachments.length ? { attachments } : {}), streamingBehavior: composer.streamingBehavior, clientRequestId, sessionId: authoritativeSessionId },
		});
	},
	onCreateAttachment: (attachment: ComposerAttachment) => {
		if (!authoritativeSessionId) {
			composer.attachmentCreated(attachment.id, "Wait for the session to connect before attaching content.");
			return;
		}
		post({ type: "createAttachment", sessionId: authoritativeSessionId, attachment });
	},
	onOpenAttachment: (id: string) => {
		if (authoritativeSessionId) post({ type: "openAttachment", sessionId: authoritativeSessionId, id });
	},
	onStop: () => post({ type: "abort" }),
	onSearchFiles: (query: string, requestId: number) => {
		const hostRequestId = fileSearchRequestScope * 1_000_000 + ++nextFileSearchRequestId;
		pendingFileSearches.clear();
		pendingFileSearches.set(hostRequestId, requestId);
		post({ type: "searchFiles", query, requestId: hostRequestId });
	},
	onDropWorkspaceUris: (uris: string[], requestId: number) => post({ type: "dropWorkspaceUris", uris, requestId }),
	onDraftChanged: (text: string, attachmentDraft?: { text: string; attachments: ComposerAttachment[] }) => {
		if (authoritativeSessionId) post({ type: "draftChanged", text, sessionId: authoritativeSessionId, ...(attachmentDraft ? { attachmentDraft } : {}) });
	},
	onPickImage: () => {
		const requestId = imageRequestScope * 1_000_000 + ++nextImageRequestId;
		pendingImageRequests.add(requestId);
		composer.beginImagePick(requestId);
		post({ type: "pickImage", requestId });
	},
	onAttachSelection: () => post({ type: "attachSelection" }),
	onAttachActiveFile: () => post({ type: "attachActiveFile" }),
	onSetModel: (provider: string, modelId: string) => post({ type: "setModel", provider, modelId }),
	onSetThinking: (level: string) => post({ type: "setThinkingLevel", level }),
	onToggleFavorite: (provider: string, modelId: string) => post({ type: "toggleFavoriteModel", provider, modelId }),
	onOpenFile: (path: string, startLine?: number, endLine?: number) => post({ type: "openFile", path, startLine, endLine }),
	onNewSession: () => {
		composer.flushDraft();
		post({ type: "newSessionFromCurrent" });
	},
	onLogin: () => post({ type: "login" }),
	onLogout: () => post({ type: "logout" }),
	onRenameSession: (name?: string) => post(name === undefined ? { type: "promptRenameSession" } : { type: "renameSession", name }),
	onResume: () => post({ type: "openSidebarHistory" }),
	onForkSession: () => {
		composer.flushDraft();
		post({ type: "forkSession" });
	},
	onExportChat: () => post({ type: "exportChat" }),
	onCopyLastReply: () => post({ type: "copyLastReply" }),
	onQueryStatistics: queryStatistics,
};
const composer = new Composer(composerDeps);
function composerHasFocus(): boolean {
	return document.hasFocus() && composer.root.style.display !== "none" && composer.isFocused();
}
function reportComposerFocus(): void {
	post({ type: "composerFocusChanged", focused: composerHasFocus() });
}
composer.root.addEventListener("focusin", reportComposerFocus);
composer.root.addEventListener("focusout", () => { post({ type: "composerFocusChanged", focused: false }); });
window.addEventListener("focus", reportComposerFocus);
window.addEventListener("blur", () => { post({ type: "composerFocusChanged", focused: false }); });
const cachedModels = document.getElementById("cached-models");
if (cachedModels?.textContent) composer.setModels(JSON.parse(cachedModels.textContent) as RpcModel[]);
cachedModels?.remove();

const transcript = new Transcript(scroller, {
	onOpenLink: (href) => {
		if (/^(https?:|mailto:)/i.test(href)) post({ type: "openExternal", url: href });
		else post({ type: "openFile", path: decodeURIComponent(href) });
	},
	onOpenFile: (path, startLine, endLine) => post({ type: "openFile", path, startLine, endLine }),
	onForkFromUser: (ordinal) => post({ type: "forkFromUser", ordinal }),
	onSpawnedCardClick: (browseRef) => post({ type: "browseChild", browseRef }),
	onNewSession: () => requestNewSession(),
	onShowHistory: () => openHistory(),
	onFocusComposer: () => composer.focus(),
	onOptimisticConfirmed: (clientRequestId) => pendingPrompts.delete(clientRequestId),
});

const historyView = new HistoryView({
	readFolds: () => {
		const state = vscode.getState() as { historyFolds?: { active?: boolean; archive?: boolean } } | undefined;
		return state?.historyFolds;
	},
	writeFolds: (folds) => {
		const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
		vscode.setState({ ...prev, historyFolds: folds });
	},
	readSort: () => {
		const state = vscode.getState() as { historySort?: "priority" | "birth" } | undefined;
		return state?.historySort;
	},
	writeSort: (sort) => {
		const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
		vscode.setState({ ...prev, historySort: sort });
	},
	readScope: () => {
		const state = vscode.getState() as { historyScope?: "workspace" | "all" } | undefined;
		return state?.historyScope;
	},
	writeScope: (scope) => {
		const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
		vscode.setState({ ...prev, historyScope: scope });
	},
	onResume: (path, sessionId) => {
		// Before the switch, or the last 300ms of typing lands under the INCOMING
		// session id and overwrites the draft the operator saved there.
		composer.flushDraft();
		renderedReceipt = undefined;
		showView("chat");
		post({ type: "switchSession", path, sessionId });
	},
	onDelete: (path, sessionId) => {
		post({ type: "deleteSession", path, sessionId });
	},
	onArchive: (path, sessionId) => {
		post({ type: "archiveSession", path, sessionId });
	},
	onUnarchive: (path, sessionId) => {
		post({ type: "unarchiveSession", path, sessionId });
	},
	onRename: (path, sessionId, name) => {
		post({ type: "renameHistorySession", path, sessionId, name });
	},
	onStop: (path, sessionId) => {
		post({ type: "stopSession", path, sessionId });
	},
	onSearch: (query) => {
		post({ type: "searchHistory", query });
	},
	onBack: () => showView("chat"),
});

// ---------------------------------------------------------------------------
// Status strip
// ---------------------------------------------------------------------------

const statusStrip = el("div", "status-strip");
// Runtime state remains available to the webview, but is intentionally not shown
// in the composer chrome.
statusStrip.hidden = true;
const connDot = el("span", "conn-dot");
const liveLabel = el("span", "live-label", "Initializing…");
statusStrip.append(connDot, liveLabel, el("span", "spacer"));
composer.root.querySelector(".composer-card")!.appendChild(statusStrip);

const subagents = new SubagentsStrip({
	post,
	injectSpawnCard: (card) => transcript.injectSpawnCard(card),
	onRosterPainted: (opened) => {
		if (currentStatus) renderLiveLabel(currentStatus);
		if (opened) transcript.scrollToBottom();
	},
});
const subagentsStrip = subagents.root;
const runningTasks = new RunningTasksStrip();
const runningTasksStrip = runningTasks.root;

// Install prompt banner: one persistent, dismissible card when prime-agent can't run.
const installBanner = el("div", "install-banner");
let installPromptShown = false;
function renderInstallBanner(url: string, reason: string): void {
	if (installPromptShown) return;
	installPromptShown = true;
	installBanner.textContent = "";
	const card = el("div", "install-card");
	card.appendChild(el("div", "install-title", "Agent runtime not detected"));
	card.appendChild(el("div", "install-body", `We couldn't reach the agent runtime — ${reason}. Install it (takes a minute), then click Retry below.`));
	// The one-liner itself, copyable, so the common case needs no round trip to a
	// browser at all.
	const command = el("code", "install-cmd", "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh");
	command.title = "Click to copy";
	command.addEventListener("click", () => {
		// Only claim the copy happened if it did: clipboard access can be refused
		// when the document is not focused, and a false confirmation sends the
		// operator to paste nothing.
		const copied = navigator.clipboard?.writeText(command.textContent ?? "");
		if (copied) copied.then(() => addNotice("info", "Install command copied."), () => addNotice("warning", "Could not copy — select the command and copy it manually."));
		else addNotice("warning", "Could not copy — select the command and copy it manually.");
	});
	card.appendChild(command);
	const actions = el("div", "install-actions");
	const guide = document.createElement("button");
	guide.className = "install-cta";
	guide.textContent = "View the install guide";
	guide.addEventListener("click", () => post({ type: "openExternal", url }));
	// The card promised a retry; this is it. Without it the only reconnect control
	// is a kebab item named something else entirely.
	const retry = document.createElement("button");
	retry.className = "install-cta";
	retry.textContent = "Retry";
	retry.title = "Try starting the agent runtime again";
	retry.addEventListener("click", () => {
		installPromptShown = false;
		installBanner.classList.remove("visible");
		post({ type: "restart" });
	});
	const dismiss = document.createElement("button");
	dismiss.className = "install-dismiss";
	dismiss.title = "Dismiss";
	dismiss.appendChild(icon("close", 12));
	dismiss.addEventListener("click", () => {
		installBanner.classList.remove("visible");
		post({ type: "dismissInstallPrompt" });
	});
	actions.append(retry, guide);
	card.append(actions);
	card.appendChild(dismiss);
	installBanner.appendChild(card);
	installBanner.classList.add("visible");
}
app.append(installBanner, observeBanner, noticesDock, chatView, historyView.root, runningTasksStrip, subagentsStrip, composer.root);
historyView.root.style.display = "none";

function showView(view: "chat" | "history"): void {
	if (historyOnly && view === "chat") return;
	chatView.style.display = view === "chat" ? "" : "none";
	composer.root.style.display = view === "chat" ? "" : "none";
	historyView.root.style.display = view === "history" ? "" : "none";
	// The strip and the Changes panel are siblings of both views and gate purely
	// on content, so without this they hang over the history list with no
	// composer under them. "" hands display back to their own .visible class.
	subagentsStrip.style.display = view === "chat" ? "" : "none";
	runningTasksStrip.style.display = view === "chat" ? "" : "none";
	if (view === "history") {
		post({ type: "composerFocusChanged", focused: false });
		historyView.showLoading();
	}
	else focusRenderedChat();
}

function requestNewSession(): void {
	composer.flushDraft();
	post({ type: "newSession" });
}

function startNewThread(): void {
	clearStatistics();
	showView("chat");
	subagents.resetForNewThread();
	pendingPrompts.clear();
	authoritativeSessionId = undefined;
	renderPendingInputs();
	transcript.clearSpawnCards?.();
	transcript.renderSnapshot([]);
	composer.resetForSessionBoundary();
	composer.setStreaming(false);
	composer.setEnabled(false, "Creating session…", true);
	if (currentStatus) {
		currentStatus = {
			...currentStatus,
			sessionId: undefined,
			sessionName: undefined,
			sessionLabel: "",
			streaming: false,
			restoring: true,
			statusText: "creating session…",
			statsText: "",
		};
		renderLiveLabel(currentStatus);
		composer.setSessionInfo(undefined, undefined, undefined, undefined);
	}
}

function openHistory(): void {
	showView("history");
	post({ type: "requestHistory" });
}

const newChatBtn = document.createElement("button");
newChatBtn.className = "icon-btn chrome-action";
newChatBtn.title = "New session";
newChatBtn.setAttribute("aria-label", "New session");
newChatBtn.addEventListener("click", () => requestNewSession());
const historyBtn = document.createElement("button");
historyBtn.className = "icon-btn chrome-action";
historyBtn.title = "Session history";
historyBtn.setAttribute("aria-label", "Session history");
historyBtn.addEventListener("click", () => openHistory());
app.append(newChatBtn, historyBtn);

// ---------------------------------------------------------------------------
// Status application
// ---------------------------------------------------------------------------

let currentStatus: StatusSnapshot | null = null;
let observing = false;
/** Agent-provided titles survive ordinary status refreshes, but never a session change. */
let extensionTitle: { sessionId?: string; title: string; provisional: boolean } | null = null;

/**
 * A status/snapshot only establishes a boundary when it names a session. An
 * offline or restoring status without an id is not evidence that the operator
 * changed threads, so it must not discard their in-progress draft.
 */
function adoptAuthoritativeSession(sessionId: string | undefined): boolean {
	if (!sessionId || sessionId === authoritativeSessionId) return false;
	clearStatistics();
	// The first identity belongs to the chat already being drafted, not a switch.
	if (!authoritativeSessionId) {
		authoritativeSessionId = sessionId;
		composer.setSessionIdentity(sessionId);
		if (!composer.textIsEmpty()) composer.flushDraft();
		return false;
	}
	authoritativeSessionId = sessionId;
	renderPendingInputs();
	pendingPrompts.clear();
	pendingImageRequests.clear();
	pendingFileSearches.clear();
	composer.resetForSessionBoundary();
	composer.setSessionIdentity(sessionId);
	// resetForSessionBoundary() drops the slash catalog with the rest of the
	// composer's per-session state, and the host only ever sends it in answer to
	// `ready` — i.e. once per webview. Whoever discards it has to ask again, or
	// the "/" menu is empty for every thread after the first one opened here.
	post({ type: "requestCommands" });
	return true;
}

function applyStatus(incomingStatus: StatusSnapshot): void {
	adoptAuthoritativeSession(incomingStatus.sessionId);
	if (incomingStatus.sessionId && incomingStatus.sessionFile) {
		const saved = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
		const session = saved.session as { sessionId?: string; sessionFile?: string } | undefined;
		if (session?.sessionId !== incomingStatus.sessionId || session?.sessionFile !== incomingStatus.sessionFile) {
			vscode.setState({ ...saved, session: { sessionId: incomingStatus.sessionId, sessionFile: incomingStatus.sessionFile } });
		}
	}
	const previousSessionId = currentStatus?.sessionId;
	// A title can arrive before the first snapshot. It is useful to paint then,
	// but the snapshot's own non-empty title is the first authoritative session
	// identity and must replace that provisional display.
	if (!currentStatus && extensionTitle?.provisional) {
		if (incomingStatus.sessionName) {
			extensionTitle = null;
		} else {
			extensionTitle = { ...extensionTitle, sessionId: incomingStatus.sessionId, provisional: false };
		}
	}
	if (previousSessionId !== incomingStatus.sessionId && extensionTitle?.sessionId !== undefined && extensionTitle.sessionId !== incomingStatus.sessionId) {
		extensionTitle = null;
	}
	const pendingTitle = extensionTitle;
	if (pendingTitle && pendingTitle.sessionId === undefined && incomingStatus.sessionId) {
		pendingTitle.sessionId = incomingStatus.sessionId;
	}
	const status = extensionTitle && extensionTitle.sessionId === incomingStatus.sessionId
		? { ...incomingStatus, sessionName: extensionTitle.title }
		: incomingStatus;
	if (currentStatus?.sessionId !== status.sessionId) {
		// A rename in flight belongs to the session that was on screen when it
		// started. Discard it rather than let Enter land on whatever replaced it.
		// Drop the previous session's tree before repainting — otherwise the old
		// subagent rows linger as a stuck artifact until the next children push.
		// Expanded state deliberately survives: browsing into a subagent is a
		// session change, and collapsing the strip under the operator mid-navigation
		// is exactly the freeze that made siblings unreachable.
		subagents.resetForSessionChange();
	}
	currentStatus = status;
	renderLiveLabel(status);

	composer.setToolbar(status.composerToolbar);
	composer.setSessionInfo(status.sessionId, status.sessionFile, status.costUsd, status.usageTotal);

	// Startup has no authoritative model yet. Keep the local picker choice.
	if (status.sessionId || status.modelId) {
		composer.setModel(status.modelLabel, status.modelProvider, status.modelId);
		transcript.setModelProvider(status.modelProvider);
		composer.setThinking(status.thinkingLevel, status.availableThinkingLevels ?? null);
	}
	composer.setStreaming(transcript.isStreaming() || status.streaming);
	composer.setBusy(status.compacting || status.retrying || status.restoring);
	// The strip says "offline"; the composer has to mean it, or the operator's
	// prompt disappears into a 120s timeout with a green dot above it.
	transcript.setLiveTranscript(status.liveTranscript === true);
	transcript.setStreamToolOutput(status.streamToolOutput === true);
	transcript.setShowUsageDetails(status.showUsageDetails === true);
	transcript.setShowThoughtProcess(status.showThoughtProcess === true);
	composer.setEnabled(
		status.connected && !status.restoring,
		status.restoring
			? (status.statusText === "creating session…" ? "Creating session…" : "Reconnecting…")
			: status.connected
				? null
				: "Not connected — the agent runtime isn't answering",
		!status.sessionId && !status.observingId,
	);
	// Apply capacity and thresholds together so each status paints the meter once.
	// Missing overrides must clear the previous session's threshold.
	composer.setContext(status.contextPercent, status.contextTokens, status.contextWindow,
		status.compactThresholdPercent ?? null, status.compactDefaultPercent ?? null);
	setObserving(!!status.observingId);
}

/** Runtime execution is authoritative when known; connection state stays text-only. */
function renderLiveLabel(status: StatusSnapshot): void {
	const working = subagents.workingCount();
	const busy = status.historyRunning !== undefined
		? status.historyRunning === true
		: status.connected && (status.streaming || status.compacting || status.retrying || working > 0);
	const base = !status.connected ? "offline" : busy
		? status.compacting ? "compacting…" : status.retrying ? "retrying…" : status.streaming ? "running" : "working"
		: "live";
	const staleWorkLabel = status.historyRunning === false &&
		["running", "working", "compacting", "compacting…", "retrying", "retrying…"].includes(status.statusText ?? "");
	const text = staleWorkLabel ? base : status.historyRunning === null ? "Execution status unavailable"
		: busy && (!status.statusText || ["opened", "live", "idle"].includes(status.statusText))
			? base === "offline" ? "working · offline" : base
			: status.statusText || base;
	const lanes: string[] = [];
	if (busy && status.connected && !status.streaming && working > 0) lanes.push(`${working} subagent${working === 1 ? "" : "s"} working`);
	liveLabel.textContent = lanes.length > 0 ? `${text} · ${lanes.join(" · ")}` : text === "opened" ? "" : text;
	const lamp = busy ? "working" : status.unreadComplete ? "complete" : "";
	liveLabel.className = `live-label ${lamp}`.trim();
	connDot.className = `conn-dot ${lamp}`.trim();
}

function setObserving(value: boolean): void {
	observing = value;
	observeBanner.style.display = value ? "" : "none";
	composer.setObserving(value);
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

function addNotice(level: "info" | "warning" | "error", text: string, action?: { id: string; label: string }): void {
	const note = el("div", `notice ${level}`);
	note.appendChild(el("span", "", text));
	if (action) {
		// The id is the host's own capability token; the webview only hands it back.
		const run = el("button", "notice-action") as HTMLButtonElement;
		run.textContent = action.label;
		run.title = action.label;
		run.addEventListener("click", () => {
			run.disabled = true;
			post({ type: "noticeAction", id: action.id });
			retireNotice(note);
		});
		note.appendChild(run);
	}
	const dismiss = el("button", "notice-dismiss");
	dismiss.title = "Dismiss";
	dismiss.setAttribute("aria-label", "Dismiss this notice");
	dismiss.appendChild(icon("close", 11));
	dismiss.addEventListener("click", () => retireNotice(note));
	note.appendChild(dismiss);
	notices.appendChild(note);
	if (level === "info") setTimeout(() => retireNotice(note), 9000);
}

function retireNotice(note: HTMLElement): void {
	if (!note.isConnected) return;
	note.remove();
}

// ---------------------------------------------------------------------------
// Host message dispatch
// ---------------------------------------------------------------------------

const rxRing: string[] = [];
(window as unknown as { __paRx?: string[] }).__paRx = rxRing;

window.addEventListener("message", (messageEvent) => {
	try {
		const d = messageEvent.data as { type?: string; error?: string; status?: { streaming?: boolean } } | undefined;
		const t = d?.type;
		let entry = t ?? "?";
		if (t === "promptRejected" && typeof d?.error === "string") entry = `promptRejected:${d.error.slice(0, 80)}`;
		else if (t === "notice" && typeof (d as { text?: string }).text === "string") entry = `notice:${((d as { text: string }).text).slice(0, 80)}`;
		if (rxRing.push(entry) > 30) rxRing.shift();
	} catch { /* ignore */ }
	try {
		dispatchHostMessage(messageEvent.data as HostToWebview);
	} catch (err) {
		// Surface handler errors as a hidden beacon so e2e tooling and end users can report them.
		console.error("[prime-agent] host message handler error:", err);
		const beacon = document.createElement("div");
		beacon.className = "pa-handler-error";
		beacon.style.display = "none";
		beacon.textContent = `${(messageEvent.data as { type?: string })?.type ?? "?"}: ${String((err as Error)?.stack ?? err).slice(0, 500)}`;
		document.body.appendChild(beacon);
	}
});

let viewMoving = false;
let capturedViewRequest: string | undefined;
let capturedViewSessionId: string | undefined;
let snapshotSessionId: string | undefined;
let renderedReceipt: ChatReadReceipt | undefined;

function focusRenderedChat(): void {
	acknowledgeRenderedChat();
}

function acknowledgeRenderedChat(): void {
	const receipt = renderedReceipt;
	if (!receipt || historyOnly || viewMoving || capturedViewRequest || chatView.style.display === "none" ||
		document.visibilityState !== "visible" || receipt.sessionId !== authoritativeSessionId) return;
	// Run after the successful DOM update. The host checks window focus and active view.
	window.requestAnimationFrame(() => {
		if (renderedReceipt === receipt && !historyOnly && !viewMoving && !capturedViewRequest &&
			chatView.style.display !== "none" && document.visibilityState === "visible" &&
			receipt.sessionId === authoritativeSessionId) post({ type: "chatRendered", receipt });
	});
}

function dispatchHostMessage(message: HostToWebview): void {
	switch (message.type) {
		case "statistics": {
			const card = statisticsCards.get(message.kind);
			if (!card || card.requestId !== message.requestId || !card.loading) break;
			card.loading = false;
			if (message.error || !message.snapshot) card.error = message.error || "No statistics snapshot was provided.";
			else { card.snapshot = message.snapshot; card.error = undefined; }
			renderStatistics(message.kind);
			break;
		}
		case "requestReadReceipt":
			acknowledgeRenderedChat();
			break;
		case "setHistoryMode":
			historyOnly = message.enabled;
			app.classList.toggle("history-only", historyOnly);
			statusStrip.style.display = historyOnly ? "none" : "";
			showView(historyOnly ? "history" : "chat");
			break;
		case "setViewMoving":
			viewMoving = message.moving;
			app.inert = viewMoving || Boolean(capturedViewRequest);
			break;
		case "captureViewState":
		case "restoreViewState": {
			try {
				if (message.sessionId !== (authoritativeSessionId ?? "")) throw new Error("The displayed session changed. Try moving it again.");
				if (message.type === "captureViewState") {
					if (capturedViewRequest || pendingPrompts.size || pendingImageRequests.size) throw new Error("Wait for pending messages or image requests before moving this chat.");
					const state = parseChatViewState({ composer: composer.captureViewState(), transcript: transcript.captureViewState() });
					if (!state) throw new Error("This draft exceeds the transfer limits. The original chat has been kept.");
					capturedViewRequest = message.requestId;
					capturedViewSessionId = message.sessionId;
					app.inert = viewMoving || Boolean(capturedViewRequest);
					post({ type: "viewStateCaptured", requestId: message.requestId, sessionId: message.sessionId, state });
				} else {
					if (message.sessionId && snapshotSessionId !== message.sessionId) throw new Error("Wait for the session snapshot before restoring this chat.");
					const state = parseChatViewState(message.state);
					if (!state) throw new Error("Invalid chat transfer state.");
					composer.restoreViewState(state.composer);
					showView("chat");
					transcript.restoreViewState(state.transcript);
					post({ type: "viewStateRestored", requestId: message.requestId, sessionId: message.sessionId });
				}
			} catch (error) {
				post({ type: "viewStateFailed", requestId: message.requestId, sessionId: message.sessionId, error: String(error).slice(0, 1024) });
			}
			break;
		}
		case "releaseViewState":
			if (capturedViewRequest === message.requestId && message.sessionId === capturedViewSessionId) {
				capturedViewRequest = undefined;
				capturedViewSessionId = undefined;
				app.inert = viewMoving || Boolean(capturedViewRequest);
			}
			break;
		case "snapshot":
			renderedReceipt = undefined;
			snapshotSessionId = message.status.sessionId;
			adoptAuthoritativeSession(message.status.sessionId);
			pendingPrompts.clear();
			transcript.clearSpawnCards?.();
			subagents.resetActivity();
			transcript.renderSnapshot(message.messages ?? []);
			renderPendingInputs(message.state?.sessionActions);
			// Up/Down recall has to survive a reload or a resume, so it is seeded
			// from the thread itself rather than only from what this panel sent.
			composer.setPromptHistory(userPromptsOf(message.messages ?? []));
			// applyStatus already sets the streaming state from the union of the
			// transcript and the host status; re-setting it from the transcript
			// alone would drop a run that started before we attached.
			applyStatus(message.status);
			if (message.steerDefault) composer.setSteerDefault(message.steerDefault);
			renderedReceipt = message.readReceipt;
			acknowledgeRenderedChat();
			break;
		case "event":
			if (message.event.type === "agent_end") renderedReceipt = undefined;
			if (message.event.type === "session_action_update") renderPendingInputs(message.event.actions);
			transcript.handleEvent(message.event);
			if (message.event.type === "agent_start" || message.event.type === "agent_end") {
				composer.setStreaming(message.event.type === "agent_start");
				if (currentStatus) {
					applyStatus({ ...currentStatus, streaming: message.event.type === "agent_start" });
				}
			}
			if (message.readReceipt) { renderedReceipt = message.readReceipt; acknowledgeRenderedChat(); }
			break;
		case "status":
			applyStatus(message.status);
			break;
		case "models":
			composer.setModels(message.models);
			break;
		case "favorites":
			composer.setFavorites(message.favorites);
			break;
		case "draft":
			// Authoritative for the thread now on screen: an empty payload means
			// "no draft here", and must clear the previous thread's unsent text
			// rather than let it follow the operator into someone else's session.
			composer.setDraft(message.text ?? "");
			break;
		case "compactThreshold":
			// The host sends the agent default alongside the override; reading it off
			// the last status instead lost it entirely before the first snapshot.
			composer.setCompactThreshold(message.percent, message.defaultPercent ?? currentStatus?.compactDefaultPercent ?? null);
			break;
		case "runningTasks":
			runningTasks.apply(message.tasks);
			break;
		case "sessionChildren":
			subagents.applyRoster(message);
			break;
		case "commands":
			composer.setCommands(message.commands);
			break;
		case "historySelection":
			historySessionId = message.sessionId;
			historyView.setCurrentSession(message.sessionId);
			break;
		case "history":
			historyView.render(message.sessions, historyOnly ? historySessionId : currentStatus?.sessionId);
			break;
		case "showHistory":
			openHistory();
			break;
		case "newThread":
			composer.flushDraft();
			startNewThread();
			break;
		case "observedSession":
			adoptAuthoritativeSession(message.sessionId);
			setObserving(true);
			// Same session boundary as a snapshot: without clearing these, the
			// spawn-card dedupe keeps suppressing every id seen before the observed
			// transcript, and "Subagent spawned" never appears again for them.
			pendingPrompts.clear();
			transcript.clearSpawnCards?.();
			subagents.resetActivity();
			transcript.renderSnapshot(message.messages);
			renderPendingInputs();
			showView("chat");
			break;
		case "observedEvent":
			if (message.sessionId !== authoritativeSessionId) break;
			if (message.event.type === "session_action_update") renderPendingInputs(message.event.actions);
			transcript.handleEvent(message.event);
			break;
		case "observedClosed":
			// The host sends a status after it has repainted our own session. Keep the
			// composer read-only until then so the visible transcript and target match.
			addNotice("info", "Stopped watching the live session.");
			break;
		case "notice":
			addNotice(message.level, message.text, message.action);
			break;
		case "installPrompt":
			renderInstallBanner(message.url, message.reason);
			break;
		case "uiState":
			if (message.title !== undefined) {
				extensionTitle = { sessionId: currentStatus?.sessionId, title: message.title, provisional: !currentStatus };
			}
			if (currentStatus && (message.statusText !== undefined || message.title !== undefined)) {
				applyStatus({
					...currentStatus,
					...(message.statusText !== undefined ? { statusText: message.statusText } : {}),
				});
			} else if (!currentStatus) {
				// An agent can set its title before the first state snapshot arrives.
				if (message.statusText !== undefined) liveLabel.textContent = message.statusText;
			}
			break;
		case "fileSearchResults":
			const composerRequestId = pendingFileSearches.get(message.requestId);
			if (composerRequestId === undefined) break;
			if (!message.pending) pendingFileSearches.delete(message.requestId);
			composer.onFileSearchResults(composerRequestId, message.files);
			break;
		case "attachmentCreated":
			if (message.sessionId === authoritativeSessionId) composer.attachmentCreated(message.id, message.error);
			break;
		case "imagePicked":
			if (!pendingImageRequests.delete(message.requestId)) break;
			composer.imagePicked(message.requestId, message.images);
			break;
		case "insertSelection":
			showView("chat");
			composer.addSelection(message.selection);
			break;
		case "insertMention":
			composer.insertMention(message.path);
			showView("chat");
			break;
		case "droppedWorkspaceUrisResolved":
			composer.resolveWorkspaceDrop(message.requestId, message.files);
			break;
		case "promptAccepted":
			if (message.clientRequestId && pendingPrompts.has(message.clientRequestId) && message.recallText !== undefined) composer.rememberAcceptedPrompt(message.recallText);
			// Host acceptance makes the prompt durable. Keep its optimistic row until
			// the transcript echoes it, but do not block switching away from a run.
			if (message.clientRequestId) pendingPrompts.delete(message.clientRequestId);
			break;
		case "editorText":
			composer.setText(message.text);
			break;
		case "stashOrRestoreDraft":
			if (composerHasFocus() && !historyOnly && !viewMoving && !capturedViewRequest) composer.stashDraft();
			break;
		case "focusComposer":
			showView("chat");
			composer.focus();
			break;
		case "promptRejected":
			// The echo we drew will never be confirmed by an event. Use the host's
			// correlation id so rejecting one queued send cannot erase another one.
			const rejected = message.clientRequestId ? pendingPrompts.get(message.clientRequestId) : undefined;
			const removed = transcript.rejectOptimistic(message.clientRequestId);
			if (message.clientRequestId) pendingPrompts.delete(message.clientRequestId);
			transcript.clearSendingIfIdle();
			// A selection-only prompt draws no local echo, so `removed` is false for
			// it — gating the restore on `removed` alone silently ate the operator's
			// attachments when the host refused the send.
			const hadEcho = Boolean(rejected?.optimistic && (rejected.text.length > 0 || rejected.images.length > 0));
			if (rejected && (removed || !hadEcho)) composer.restoreRejectedPayload(rejected.text, rejected.images, rejected.selections, rejected.attachments);
			addNotice("error", `Prompt rejected: ${message.error}`);
			break;
	}
}

/**
 * The thread's own user prompts, oldest first, for Up/Down recall.
 *
 * Text parts only: an image or a selection attachment cannot be typed back into
 * the box, and the host composes the attachment envelope itself, so recalling
 * anything but the words would put text in the composer that never matches the
 * message it came from.
 */
function userPromptsOf(messages: AgentMessage[]): string[] {
	const prompts: string[] = [];
	for (const message of messages) {
		if (!message || (message as { role?: unknown }).role !== "user") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			if (content.trim()) prompts.push(content);
		} else if (Array.isArray(content)) {
			const text = content
				.filter((part) => part && (part as { type?: unknown }).type === "text")
				.map((part) => (part as { text?: string }).text ?? "")
				.join("\n")
				.trim();
			if (text) prompts.push(text);
		}
	}
	return prompts;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

declare const BRIEF_BUILD_REV: string | undefined;
if (typeof BRIEF_BUILD_REV === "string") {
	document.body.dataset.briefBuild = BRIEF_BUILD_REV;
}

transcript.showWelcome();
post({ type: "ready" });
