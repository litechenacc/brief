/**
 * SessionController attaches this VS Code window to daemon-resident Prime sessions,
 * routes events to all attached chat webviews, and answers extension UI requests
 * using native VS Code dialogs.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { locateAgent } from "../runtime/agent-locator.js";
import { DaemonSidecar } from "../runtime/daemon-sidecar.js";
import { resolveOwnerClientId, resolveWorkerDescriptor } from "../runtime/daemon-owner.js";
import type { AttachSnapshot, DaemonServerMessage, RosterEntry, SavedSessionInfo, SessionSummaryRef } from "../runtime/daemon-sidecar.js";
import {
	COMPACT_REPLY_CEILING_MS,
	HISTORY_OTHER_LIMIT,
	HISTORY_WORKSPACE_LIMIT,
	SAVED_CATALOG_TTL_MS,
	THINKING_LEVELS,
	compactFailureHint,
	excerpt,
	formatNumber,
	historyActivityMs,
	isRunningSummary,
	isTransientWorkerAttachError,
	pickCompactionFallback,
	rosterStatus,
	supportedThinkingLevels,
} from "./session-logic.js";
import { compactMethods } from "./session-compact.js";
import { daemonAttachMethods } from "./session-daemon.js";
import { workspaceMethods } from "./session-workspace.js";
import { historyCatalogMethods } from "./session-history.js";
import { completedMessageTime } from "./session-completion.js";
import type { AttachRef, ResolvedHistorySession, WebviewSink } from "./session-types.js";
import type {
	AgentEvent,
	AgentMessage,
	ComposerToolbarItem,
	HostToWebview,
	ImageAttachment,
	ModelRef,
	PromptPayload,
	RecentSession,
	RpcExtensionUIRequest,
	RpcModel,
	RpcSessionState,
	RpcSlashCommand,
	SessionChild,
	StatusSnapshot,
	StatisticsKind,
	StatisticsSnapshot,
	RpcSessionStats,
} from "../shared/protocol.js";
import { DebugFileLog } from "../runtime/debug-log.js";
import { buildMarkdownExport } from "./markdown-export.js";
import { listRecentSessions, normalizeFsPath } from "./recent-sessions.js";
import { deriveSessionLabel, firstUserPrompt } from "./session-label.js";
import { deleteSession, isSessionActive, renameSessionOffline } from "./session-actions.js";
import { ComposerAttachments } from "./composer-attachments.js";
import type { ComposerAttachment } from "../shared/protocol.js";
import { RpcClient } from "../runtime/rpc-client.js";
import { readTasks } from "../runtime/background-tasks.js";
import { BashProcessTracker } from "../runtime/bash-processes.js";
import type { OwnerLookup } from "../runtime/daemon-owner.js";

const execFileAsync = promisify(execFile);
const MODEL_CACHE_KEY = "brief.availableModels";

/**
 * History bucket quotas. Separate on purpose: "this workspace" is the operator's
 * own history and must never be crowded out by throwaway sessions from other
 * folders, which is exactly what one shared cap did.
 */
export interface SessionController {
 forkFile(sessionFile: string, entryId?: string, revision?: string): Promise<{ revision: string; messages: Array<{ entryId: string; visible: boolean }>; sessionFile: string; sessionId: string; text: string }>;

	getActiveSelection(): { path: string; startLine: number; endLine: number; text: string; languageId: string } | null;
	getActiveFilePath(): string | null;
	searchFiles(query: string, requestId: number, reply?: (message: import("../shared/protocol.js").HostToWebview) => void): Promise<void>;
	resolveDroppedWorkspaceUris(uris: string[]): Promise<import("../shared/protocol.js").FileSearchItem[]>;
	searchDirs(query: string, max: number, token?: import("vscode").CancellationToken): Promise<string[]>;
	pickImages(requestId: number, reply?: (message: import("../shared/protocol.js").HostToWebview) => void): Promise<void>;
	openFile(relPath: string, startLine?: number, endLine?: number): Promise<void>;
	resolveWorkspaceUri(relPath: string): Promise<import("vscode").Uri | null>;
	compactionStillRunning(): Promise<boolean>;
	runNoticeAction(id: string): Promise<void>;
	offerNoticeAction(label: string, run: () => Promise<void>): { id: string; label: string };
	fetchAvailableModels(): Promise<import("../shared/protocol.js").RpcModel[]>;
	compactWithModel(model: import("../shared/protocol.js").RpcModel): Promise<void>;
	reportCompactFailure(detail: string): Promise<void>;
	compact(instructions?: string, opts?: { betweenTurnsOnly?: boolean }): Promise<void>;
	maybeTriggerAutoCompact(percent: number | null, owner: string): void;

	switchSession(sessionPath: string, sessionId: string, restoreDraft?: boolean): Promise<void>;
	startObserving(sessionId: string, previousAttachment?: AttachRef | null, epoch?: number, sessionPath?: string, observedAtStart?: string | null): Promise<boolean>;
	ensureSidecar(options?: { reattach?: boolean }): Promise<import("../runtime/daemon-sidecar.js").DaemonSidecar>;
	connectDaemon(): Promise<import("../runtime/daemon-sidecar.js").DaemonSidecar>;
	onSidecarClosed(): void;
	runReattach(sidecar: import("../runtime/daemon-sidecar.js").DaemonSidecar): Promise<void>;
	waitForDaemonDetach(activeSessionId: string): Promise<void>;
	detachDaemonSession(sidecar: import("../runtime/daemon-sidecar.js").DaemonSidecar, activeSessionId: string): Promise<void>;
	clearReattachTimer(): void;
	scheduleReattach(step: number): void;
	applyAttachedSnapshot(snapshot: import("../runtime/daemon-sidecar.js").AttachSnapshot | undefined): void;
	attachViaDaemon(activeSessionId: string, sessionPath: string, epoch?: number): Promise<boolean>;
	rollbackAttachment(sidecar: import("../runtime/daemon-sidecar.js").DaemonSidecar, attachment: AttachRef): Promise<false>;
	detachFromDaemon(expected?: AttachRef | null): Promise<boolean>;
	ownedRosterClientId(): string | undefined;
	listSessions(sidecar: import("../runtime/daemon-sidecar.js").DaemonSidecar): Promise<import("../runtime/daemon-sidecar.js").SessionSummaryRef[]>;
	releaseOwnerIdentity(): void;
	scheduleChildrenRefresh(): void;
	runChildrenRefresh(): Promise<void>;
	resetChildrenBaseline(): void;
	browseRefFor(activeSessionId: string, parentId?: string, contextId?: number): string | undefined;
	refreshChildren(): Promise<void>;
	browseChild(browseRef: string): Promise<boolean>;
	backToParent(): Promise<void>;
	onDaemonEvent(message: import("../runtime/daemon-sidecar.js").DaemonServerMessage): void;
	onDaemonClosing(reason: string | undefined): void;
	onRosterUpdate(message: import("../runtime/daemon-sidecar.js").DaemonServerMessage): void;
	setupRosterSubscription(sidecar: import("../runtime/daemon-sidecar.js").DaemonSidecar): Promise<void>;
	refreshAttachedState(): Promise<void>;
	clearObservation(expectedId?: string | null, epoch?: number): Promise<boolean>;
	stopObserving(): Promise<void>;

	scheduleHistoryRefresh(): void;
	historyPathKey(sessionPath: string): string;
	restoreHistoryUiState(): void;
	persistHistoryUiState(): void;
	overlayCachedHistory(): void;
	paintHistory(): void;
	viewedSessionPath(): string | undefined;
	recordHistoryCompletion(sessionPath: string, completedAt: number): boolean;
	markHistoryWaitingForUser(sessionPath: string | undefined, completedAt: number): void;
	markHistorySessionOpened(sessionPath: string, completedAt: number): void;
	refreshHistoryCompletions(rows: Array<{ path: string }>): Promise<void>;
	refreshHistoryRunningTasks(rows: Array<{ path: string }>): Promise<void>;
	markHistoryArchived(sessionPath: string): void;
	markHistoryUnarchived(sessionPath?: string): void;
	unarchiveSession(sessionPath: string, sessionId: string): Promise<void>;
	decorateHistoryRow(row: RecentSession): RecentSession;
	showHistoryView(): void;
	resolveHistorySession(sessionPath: string, sessionId: string, restoredDraft?: SessionSummaryRef): Promise<ResolvedHistorySession | null>;
	updateHistoryRuntime(sessionPath: string, status: RecentSession["status"], statusLabel?: string, revision?: number): void;
	updateHistoryRunningTask(sessionPath: string, kind: "background" | "shell", running: boolean): boolean;
	hasRunningTasks(sessionPath: string): boolean;
	recordHistoryPrompt(sessionPath: string | undefined, at: number): void;
	pendingTaskHandoff(sessionPath: string, awaitingWake: number | undefined): boolean;
	rowsFromCatalog(catalog: SessionSummaryRef[], revision?: number): RecentSession[];
	collectHistory(): Promise<RecentSession[]>;
	listHistory(): Promise<void>;
	searchHistory(query: string): Promise<void>;
	forgetHistoryRow(sessionPath: string): void;
	savedSessionCatalog(): Promise<SavedSessionInfo[]>;
}

export class SessionController implements vscode.Disposable {

	client: RpcClient | null = null;
	disposed = false;
	/**
	 * "The agent actually answers", not "a process object exists". Only a
	 * completed RPC round-trip sets it; start/stop/exit clear it. A binary that
	 * spawns and then never replies (stale daemon socket, half-finished install,
	 * a build that doesn't understand --mode rpc) is NOT connected, and the whole
	 * UI — status strip, composer, install recommendation — hangs off this.
	 */
	reachable = false;
	/**
	 * Bumped by every stop(). The CLI lookup can take a few seconds when the agent
	 * is not on the inherited PATH, and a stop landing inside that window must not
	 * be undone by the attempt it interrupted spawning a process nothing owns.
	 */
	startGeneration = 0;
	sinks = new Set<WebviewSink>();
	disposables: vscode.Disposable[] = [];
	state: RpcSessionState | null = null;
	cachedMessages: AgentMessage[] = [];
	/** First accepted prompt since the last snapshot/navigation, for live tab titles. */
	firstPromptLabel = "";
	extensionStatusText: string | undefined;
	streaming = false;
	awaitingInput = false;
	compacting = false;
	retrying = false;
	debugLog = new DebugFileLog();
	startingPromise: Promise<void> | null = null;
	observingId: string | null = null;
	/** Identity of the read-only session, kept separately from the hidden RPC state. */
	observedSession: { activeSessionId: string; sessionId?: string; sessionPath?: string } | null = null;
	/** A just-closed observed session stays non-interactive until our own view repaints. */
	observationRestoring = false;
	/**
	 * View epoch that owns an in-flight New Session. Prompts must not land on
	 * the previous session while the empty new page is on screen.
	 */
	creatingSessionEpoch: number | null = null;
	/** Daemon sidecar for resident-session parity (attach/prompt/abort on live sessions). */
	sidecar: DaemonSidecar | null = null;
	/** Serialize release/attach hand-offs for one daemon handle. */
	pendingDaemonDetaches = new Map<string, Promise<void>>();
	/**
	 * `activeSessionId` is the daemon's 12-char attach handle; `sessionId` is the
	 * daemon's durable session UUID used by history/UI. Neither is necessarily the
	 * transcript filename stem, so file operations derive that only from a verified
	 * catalog path.
	 */
	attached: AttachRef | null = null;
	/** View generation that owns the currently attached daemon session. */
	attachedEpoch: number | null = null;
	/** Attach attempt remembered across socket drops so a reconnect can re-anchor seamlessly. */
	attachAttempt: AttachRef | null = null;
	/** View generation that owned the reconnect attempt. */
	attachAttemptEpoch: number | null = null;
	/**
	 * The last daemon attach failure message. attachViaDaemon swallows the error
	 * into a boolean; the switch path keeps the text so a recovering worker
	 * (v0.9+ blocks attach until recovery resolves) is queued for retry instead
	 * of demoted to the read-only observe fallback.
	 */
	lastDaemonAttachError: string | null = null;
	/** Canonical 12-char attach handle the failing attach targeted (for the retry). */
	lastDaemonAttachCanonicalId: string | null = null;
	/**
	 * Why the daemon is about to close our sidecar socket (its `daemon_closing`
	 * broadcast). "update" means the ladder should re-attach by itself; "shutdown"
	 * means the ladder must stop and the own-RPC view takes over.
	 */
	daemonClosingReason: "update" | "shutdown" | null = null;
	/**
	 * The sidecar instance that currently holds a roster subscription (rev 24+,
	 * capability "agent_roster"). Tracked per instance because a socket drop or
	 * an owner swap kills the daemon-side subscription with the connection.
	 */
	rosterSubscribedSidecar: DaemonSidecar | null = null;
	/** Breadcrumbs for nested subagent browsing; each Back returns exactly one level. */
	returnTargets: Array<{ kind: "rpc" } | ({ kind: "attached" } & AttachRef)> = [];
	rentedState: RpcSessionState | null = null;
	/** Last history answer, replayed instantly so a reopened sidebar never flashes empty. */
	lastHistory: RecentSession[] | null = null;
	/** Latest rendered history capability set, including catalog-search-only rows. */
	actionHistory: RecentSession[] | null = null;
	savedCatalog: { at: number; rows: SavedSessionInfo[] } | null = null;
	/**
	 * History rank times, frozen while a turn is in flight. A live RPC event
	 * must not reshuffle the list; only `agent_end` (waiting for the user)
	 * advances a row.
	 */
	historySortMs = new Map<string, number>();
	/** Sessions the operator archived from Brief. Daemon auto-archive is not this. */
	historyArchived = new Set<string>();
	/** Completions observed in this window and not yet opened. Never persisted. */
	historyUnreadComplete = new Set<string>();
	/** Window-local completion baselines; read receipts use the same timestamps. */
	historyCompletedAt = new Map<string, number>();
	historyReadAt = new Map<string, number>();
	/**
	 * Latest prompt each session received, in message-timestamp terms. This is the
	 * only proof that a finished task's wake-up reached the session, so the lamp
	 * can tell "waiting for the agent" from "waiting for the operator".
	 */
	historyPromptedAt = new Map<string, number>();
	historyRuntime = new Map<string, { status: RecentSession["status"]; statusLabel?: string; revision: number }>();
	historyRuntimeClock = { revision: 0 };
	historyPeers = new Set<SessionController>([this]);
	/**
	 * Running-task evidence for the lamps. The roster verdict cannot carry it:
	 * a durable background task leaves no runtime trace at all, and a shell
	 * process found through the worker journal is invisible to the daemon. Kept
	 * apart from `historyRuntime` because it is evidence rather than a verdict —
	 * only the task itself may clear it, and keys are history path keys.
	 */
	historyRunningTasks = new Map<string, { background: boolean; shell: boolean }>();
	/**
	 * Session file this window's strip poll publishes shell evidence for. The
	 * poll is the only proof of a live shell process, so the window must retract
	 * that half when it stops reading the session.
	 */
	shellTaskPath: string | undefined;
	/** Monotonic navigation ownership: late session RPCs cannot repaint a newer view. */
	viewEpoch = 0;
	/** Supersedes slow history/search answers so they cannot repaint a newer query. */
	historyRequestGeneration = 0;
	/** Opaque, host-issued capabilities for the currently rendered child strip. */
	browseableChildren = new Map<string, { activeSessionId: string; parentId?: string; contextId: number }>();
	browseRefByActiveId = new Map<string, string>();
	/** Invalidates child capabilities only when the displayed session actually changes. */
	childrenContext = 0;
	/** This panel's session target; editor panel persistence owns reload recovery. */
	rememberedSession: { sessionId: string; sessionFile: string } | null = null;
	runningTasksTimer: NodeJS.Timeout | null = null;
	runningTasksRefreshing = false;
	lastRunningTasksPayload = "";
	readonly bashProcesses = new BashProcessTracker();

	constructor(
		readonly context: vscode.ExtensionContext,
		readonly output: vscode.OutputChannel,
	) {
		this.restoreHistoryUiState();
		this.disposables.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
			if (doc.uri.scheme !== "file") return;
			for (const [sessionId, saved] of this.attachmentDrafts) {
				if (this.composerAttachments.referencesTextPath(sessionId, saved.draft.attachments, doc.uri.fsPath)) {
					await this.saveDraft("", sessionId, saved.key, saved.draft);
				}
			}
		}));
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration("brief.liveTranscript") ||
					event.affectsConfiguration("brief.streamToolOutput") ||
					event.affectsConfiguration("brief.showUsageDetails") ||
					event.affectsConfiguration("brief.showThoughtProcess") ||
					event.affectsConfiguration("brief.composerToolbar")
				) {
					this.pushStatusLight();
				}
			}),
		);
	}

	liveTranscript(): boolean {
		return vscode.workspace.getConfiguration("brief").get<boolean>("liveTranscript", false) === true;
	}

	showThoughtProcess(): boolean {
		return vscode.workspace.getConfiguration("brief").get<boolean>("showThoughtProcess", false) === true;
	}

	showUsageDetails(): boolean {
		return vscode.workspace.getConfiguration("brief").get<boolean>("showUsageDetails", false) === true;
	}

	streamToolOutput(): boolean {
		return vscode.workspace.getConfiguration("brief").get<boolean>("streamToolOutput", false) === true;
	}

	composerToolbar(): ComposerToolbarItem[] {
		const configured = vscode.workspace.getConfiguration("brief").get<unknown>("composerToolbar", ["model", "effort", "spacer", "id", "cost", "context", "btn"]);
		const allowed = new Set<ComposerToolbarItem>(["model", "effort", "spacer", "id", "cost", "context", "btn"]);
		return Array.isArray(configured)
			? configured.filter((item): item is ComposerToolbarItem => typeof item === "string" && allowed.has(item as ComposerToolbarItem))
			: ["model", "effort", "spacer", "id", "cost", "context", "btn"];
	}

	get workspaceRoot(): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	}

	/** This extension is deliberately single-root until paths carry a root id. */
	isInWorkspaceRoot(uri: vscode.Uri): boolean {
		if (uri.scheme !== "file" || !this.workspaceRoot) return false;
		try {
			// A lexical prefix is not enough: VS Code follows workspace symlinks,
			// which otherwise lets a webview read an arbitrary target through a
			// friendly-looking in-root path.
			const root = realpathSync(this.workspaceRoot);
			const resolved = realpathSync(uri.fsPath);
			const relative = path.relative(root, resolved);
			return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		} catch {
			return false;
		}
	}

	workspaceRelativePath(uri: vscode.Uri): string | null {
		if (!this.isInWorkspaceRoot(uri)) return null;
		return path.relative(this.workspaceRoot, uri.fsPath).split(path.sep).join("/");
	}

	// ------------------------------------------------------------------
	// Webview wiring
	// ------------------------------------------------------------------

	attach(sink: WebviewSink): vscode.Disposable {
		if (this.disposed) return new vscode.Disposable(() => {});
		this.sinks.add(sink);
		// Seed the rebuilt document with the last history we computed. The sidebar
		// webview is destroyed on every hide, so without this the operator's next
		// visit to history starts from an empty list and flashes "Loading…".
		if (this.lastHistory) sink.post({ type: "history", sessions: this.lastHistory });
		this.scheduleRunningTasks();
		return new vscode.Disposable(() => {
			this.sinks.delete(sink);
			if (this.sinks.size === 0 && this.runningTasksTimer) {
				clearTimeout(this.runningTasksTimer);
				this.runningTasksTimer = null;
			}
			// No view is left to prove a shell process is running.
			if (this.sinks.size === 0) this.retractShellTaskEvidence();
		});
	}

	broadcast(message: HostToWebview): void {
		if (this.disposed) return;
		if (message.type === "snapshot" || message.type === "status") {
			const sessionPath = message.status.sessionFile;
			const key = sessionPath === undefined ? undefined : this.historyPathKey(sessionPath);
			const runtime = key === undefined ? undefined : this.historyRuntime.get(key);
			// A running task is local evidence the roster cannot have — the daemon
			// cannot see a durable background task — so it settles the lamp even
			// where the verdict is missing or says the session is idle.
			const taskRunning = key !== undefined && this.historyRunningTasks.has(key);
			message = { ...message, status: { ...message.status,
				unreadComplete: Boolean(key !== undefined && this.historyUnreadComplete.has(key)),
				historyRunning: taskRunning ? true : runtime ? runtime.status === undefined ? null : runtime.status === "running" : undefined,
			} };
		}
		if (this.sinks.size === 0) this.debugLog.append(`broadcast ${message.type} with no sinks`);
		for (const sink of this.sinks) {
			sink.post(message);
		}
	}

	showErrorNotice(text: string): void {
		this.broadcast({ type: "notice", level: "error", text });
	}

	broadcastInsertSelection(selection: { path: string; startLine: number; endLine: number; text: string; languageId: string }): void {
		this.broadcast({ type: "insertSelection", selection });
	}

	broadcastInsertMention(path: string): void {
		this.broadcast({ type: "insertMention", path });
	}

	// ------------------------------------------------------------------
	// Agent process lifecycle
	// ------------------------------------------------------------------

	async ensureStarted(): Promise<void> {
		if (this.disposed) return;
		if (!this.workspaceRoot) {
			this.broadcast({ type: "notice", level: "warning", text: "Open a workspace folder before starting Brief." });
			return;
		}
		this.debugLog.append("ensureStarted");
		if (this.attached || this.observingId || this.client?.running) return;
		if (this.startingPromise) return this.startingPromise;
		this.armInstallWatchdog();
		this.startingPromise = this.start()
			.catch((err) => {
				this.output.appendLine(`[prime-agent] failed to start: ${String(err)}`);
				this.broadcast({ type: "notice", level: "error", text: `Failed to start Brief: ${String(err)}` });
				throw err;
			})
			.finally(() => {
				this.startingPromise = null;
			});
		return this.startingPromise;
	}

	// ---- install prompt: one smart banner when prime-agent can't be detected ----

	installPromptDismissed(): boolean {
		return this.context.workspaceState.get<boolean>("brief-install-prompt-dismissed", false);
	}

	async dismissInstallPrompt(): Promise<void> {
		await this.context.workspaceState.update("brief-install-prompt-dismissed", true);
	}

	maybeShowInstallPrompt(reason: string): void {
		if (this.installPromptDismissed()) return;
		this.broadcast({
			type: "installPrompt",
			// Prime Intellect's own installer page, not a doc page in a repo: an
			// operator who cannot reach the CLI wants the command that installs it.
			url: "https://app.primeintellect.ai/prime-agent",
			reason,
		});
	}

	installWatchdog: NodeJS.Timeout | null = null;

	/** If the agent still isn't reachable ~25s after the first attempt, recommend installing it (once). */
	armInstallWatchdog(): void {
		if (this.installWatchdog) clearTimeout(this.installWatchdog);
		this.installWatchdog = setTimeout(() => {
			this.installWatchdog = null;
			if (this.disposed) return;
			// Reachability, not process liveness: "sees it but cannot connect" is a
			// binary that spawns fine and then never answers a single RPC, which
			// `client.running` reports as perfectly healthy forever.
			if (this.reachable) return;
			const reason = `prime-agent did not answer within 25s (command: ${vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent")})`;
			this.maybeShowInstallPrompt(reason);
			// Dismissing the card hides the recommendation, not the failure —
			// otherwise the second start after a dismissal is silently dead.
			if (this.installPromptDismissed()) {
				this.broadcast({ type: "notice", level: "warning", text: `Brief isn't responding — ${reason}` });
			}
		}, 25_000);
	}

	async persistForegroundSession(sessionId: string, sessionFile: string): Promise<void> {
		if (!sessionId || !sessionFile) return;
		this.rememberedSession = { sessionId, sessionFile };
	}

	private async startDaemonSupervisor(): Promise<void> {
		const config = vscode.workspace.getConfiguration("brief");
		const configured = config.get<unknown>("command", "prime-agent");
		const command = typeof configured === "string" && configured.trim() ? configured.trim() : "prime-agent";
		if (command.includes("\0")) throw new Error("brief.command contains an invalid character");
		const located = await locateAgent(command, (line) => this.output.appendLine(line));
		const env: NodeJS.ProcessEnv = { ...process.env, ...(located.envPath ? { PATH: located.envPath } : {}) };
		delete env.ELECTRON_RUN_AS_NODE;
		await new Promise<void>((resolve, reject) => {
			const child = spawn(located.command, ["--mode", "daemon"], {
				cwd: this.workspaceRoot,
				env,
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.once("error", reject);
			child.once("spawn", () => {
				child.removeListener("error", reject);
				child.on("error", () => {});
				child.unref();
				resolve();
			});
		});
	}

	async connectDaemon(): Promise<DaemonSidecar> {
		try {
			return await this.ensureSidecar({ reattach: false });
		} catch {
			await this.startDaemonSupervisor();
		}
		let lastError: unknown;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (this.disposed) throw new Error("Brief was disposed while starting the daemon");
			try {
				return await this.ensureSidecar({ reattach: false });
			} catch (err) {
				lastError = err;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		throw lastError ?? new Error("daemon socket unavailable");
	}

	async start(): Promise<void> {
		if (!this.workspaceRoot) throw new Error("Open a workspace folder before starting Brief.");
		if (this.disposed || this.attached || this.observingId) return;
		// A failed history resume must retry its own target, never open a blank session.
		if (this.rememberedSession) {
			await this.switchSession(this.rememberedSession.sessionFile, this.rememberedSession.sessionId);
			return;
		}
		const epoch = this.viewEpoch;
		const generation = this.startGeneration;
		const startupId = randomUUID();
		const started = Date.now();
		const log = (phase: string) => this.output.appendLine(`[startup] ${new Date().toISOString()} id=${startupId} phase=${phase} elapsedMs=${Date.now() - started}`);
		log("connect");
		const sidecar = await this.connectDaemon();
		log("connected");
		if (this.disposed || this.attached || epoch !== this.viewEpoch || generation !== this.startGeneration) return;
		const target = await sidecar.createResident({ cwd: this.workspaceRoot });
		log("created");
		if (this.disposed || epoch !== this.viewEpoch || generation !== this.startGeneration) return;
		const activeSessionId = target.activeSessionId;
		if (!activeSessionId) throw new Error("daemon returned no activeSessionId");
		if (!(await this.attachViaDaemon(activeSessionId, target.sessionFile ?? "", epoch))) {
			throw new Error(this.lastDaemonAttachError ?? "could not attach to daemon session");
		}
		this.reachable = true;
		log("attached");
	}

	async restart(): Promise<void> {
		const current = this.attached;
		if (!current) {
			await this.ensureStarted();
			return;
		}
		const sessionPath = current.sessionPath || this.rememberedSession?.sessionFile;
		if (!sessionPath) throw new Error("The current session has no transcript path");
		const sidecar = await this.connectDaemon();
		const epoch = this.beginNavigation();
		this.attached = null;
		this.attachedEpoch = null;
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		this.observationRestoring = true;
		await sidecar.request({ type: "kill", activeSessionId: current.activeSessionId }, 30_000);
		let created: SessionSummaryRef | undefined;
		let createError: unknown;
		for (let attempt = 0; attempt < 20 && !created; attempt += 1) {
			try {
				created = await sidecar.createResident({ cwd: this.workspaceRoot, sessionPath });
			} catch (err) {
				createError = err;
				if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		if (!created) throw createError ?? new Error("could not resume the stopped session");
		if (!created.activeSessionId || !(await this.attachViaDaemon(created.activeSessionId, created.sessionFile ?? sessionPath, epoch))) {
			throw new Error(this.lastDaemonAttachError ?? "could not attach to restarted session");
		}
	}

	stop(): void {
		this.startGeneration += 1;
		// Stop the RPC client only; resident daemon sessions survive disconnect.
		this.client?.stop();
		this.client = null;
		this.state = null;
		this.reachable = false;
		this.clearRunFlags();
		if (this.installWatchdog) {
			clearTimeout(this.installWatchdog);
			this.installWatchdog = null;
		}
		if (!this.disposed) this.pushStatus();
	}

	/**
	 * Busy flags describe ONE session's run. They must be dropped whenever the
	 * session on screen changes, or an idle/new session inherits "running", a
	 * Stop button and a steer pill that no agent_end will ever clear.
	 */
	clearRunFlags(): void {
		this.awaitingInput = false;
		this.streaming = false;
		this.compacting = false;
		this.retrying = false;
	}

	dispose(): void {
		if (this.runningTasksTimer) clearTimeout(this.runningTasksTimer);
		if (this.disposed) return;
		this.disposed = true;
		this.retractShellTaskEvidence();
		this.historyPeers.delete(this);
		this.stop();
		// Drop the attach intent before tearing the socket down, or the close
		// handler restarts the re-attach backoff against a dead controller.
		this.attached = null;
		this.attachedEpoch = null;
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		// A pending strip refresh would fire against a disposed sidecar.
		if (this.childrenTimer) clearTimeout(this.childrenTimer);
		this.childrenTimer = null;
		if (this.historyRefreshTimer) clearTimeout(this.historyRefreshTimer);
		this.historyRefreshTimer = null;
		if (this.statsTimer) clearTimeout(this.statsTimer);
		this.statsTimer = null;
		if (this.installWatchdog) clearTimeout(this.installWatchdog);
		this.installWatchdog = null;
		this.sidecar?.dispose();
		for (const d of this.disposables) d.dispose();
		this.sinks.clear();
		this.debugLog.dispose();
	}

	// ------------------------------------------------------------------
	// Event routing
	// ------------------------------------------------------------------

	/**
	 * Record one session's running-task evidence. Returns true when the answer
	 * changed, so callers repaint only on a real move.
	 */
	updateHistoryRunningTask(sessionPath: string, kind: "background" | "shell", running: boolean): boolean {
		const key = this.historyPathKey(sessionPath);
		const current = this.historyRunningTasks.get(key) ?? { background: false, shell: false };
		if (current[kind] === running) return false;
		const next = { ...current, [kind]: running };
		if (next.background || next.shell) this.historyRunningTasks.set(key, next);
		else this.historyRunningTasks.delete(key);
		return true;
	}

	/** True while a task this window can see is still running for the session. */
	hasRunningTasks(sessionPath: string): boolean {
		return this.historyRunningTasks.has(this.historyPathKey(sessionPath));
	}

	/** Record a prompt the session received; the marker only moves forward. */
	recordHistoryPrompt(sessionPath: string | undefined, at: number): void {
		if (sessionPath === undefined || !Number.isFinite(at) || at <= 0) return;
		const key = this.historyPathKey(sessionPath);
		if (at > (this.historyPromptedAt.get(key) ?? 0)) this.historyPromptedAt.set(key, at);
	}

	/**
	 * A task that finished while the prompt that resumes the session has not
	 * arrived yet. The work is over, but the session is waiting on its own
	 * wake-up rather than on the operator, so the run lamp stays red until that
	 * prompt lands — the way live children already hold it.
	 */
	pendingTaskHandoff(sessionPath: string, awaitingWake: number | undefined): boolean {
		if (awaitingWake === undefined) return false;
		return (this.historyPromptedAt.get(this.historyPathKey(sessionPath)) ?? 0) <= awaitingWake;
	}

	/**
	 * Retract the shell half this window published. Losing sight of a task is
	 * unknown, never proof that it finished: the daemon verdict takes the lamp
	 * back and owns it until fresh local evidence arrives.
	 */
	private retractShellTaskEvidence(): void {
		const previous = this.shellTaskPath;
		if (previous === undefined) return;
		this.shellTaskPath = undefined;
		this.updateHistoryRunningTask(previous, "shell", false);
	}

	private runningTaskLookup(): OwnerLookup | null {
		const sessionFile = this.viewedSessionPath();
		const activeSessionId = this.attached?.activeSessionId ?? this.observedSession?.activeSessionId;
		if (!sessionFile && !activeSessionId) return null;
		return { ...(sessionFile ? { sessionFile } : {}), ...(activeSessionId ? { activeSessionId } : {}) };
	}

	private scheduleRunningTasks(delay = 0): void {
		if (this.disposed || this.sinks.size === 0) return;
		if (this.runningTasksTimer) clearTimeout(this.runningTasksTimer);
		this.runningTasksTimer = setTimeout(() => {
			this.runningTasksTimer = null;
			void this.refreshRunningTasks();
		}, delay);
	}

	async refreshRunningTasks(): Promise<void> {
		if (this.disposed || this.runningTasksRefreshing || this.sinks.size === 0) return;
		const epoch = this.viewEpoch;
		const lookup = this.runningTaskLookup();
		this.runningTasksRefreshing = true;
		let count = 0;
		try {
			const background = await readTasks(lookup?.sessionFile);
			const bash = lookup ? await this.bashProcesses.refresh(lookup, new Set(background.running.flatMap(task => task.pid === undefined ? [] : [task.pid]))) : [];
			if (this.disposed || epoch !== this.viewEpoch || this.sinks.size === 0) return;
			const tasks = [...background.running, ...bash].sort((a, b) => a.startedAt - b.startedAt);
			count = tasks.length;
			// A finished turn is not a finished session: a task the strip shows, or one
			// whose wake-up the session has not received yet, holds the lamps red
			// exactly as live children do. Settling on "done" the moment the process
			// exits is what flashed green before the follow-up turn arrived.
			const sessionFile = lookup?.sessionFile;
			if (sessionFile === undefined) this.retractShellTaskEvidence();
			else {
				if (this.shellTaskPath !== undefined && this.shellTaskPath !== sessionFile) this.retractShellTaskEvidence();
				this.shellTaskPath = sessionFile;
				const moved = this.updateHistoryRunningTask(sessionFile, "background", background.running.length > 0 || this.pendingTaskHandoff(sessionFile, background.awaitingWake));
				if (this.updateHistoryRunningTask(sessionFile, "shell", bash.length > 0) || moved) this.paintHistory();
			}
			const payload = JSON.stringify(tasks);
			if (payload !== this.lastRunningTasksPayload) {
				this.lastRunningTasksPayload = payload;
				this.broadcast({ type: "runningTasks", tasks });
			}
		} catch (error) {
			this.debugLog.append(`running-tasks: refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.runningTasksRefreshing = false;
			if (!this.disposed && epoch === this.viewEpoch && this.sinks.size > 0) this.scheduleRunningTasks(count > 0 || this.effectiveStreaming() ? 1_000 : 5_000);
		}
	}

	onAgentEvent(event: AgentEvent): void {
		this.scheduleRunningTasks();
		// Subagent strip: keep counts honest mid-run. scheduleChildrenRefresh
		// coalesces these — a daemon `list all` re-reads every session file on
		// disk, so one per tool call is a real cost on a long turn.
		if (this.sidecar?.connected) {
			if (event.type === "tool_execution_end" || event.type === "agent_start" || event.type === "agent_end" || event.type === "turn_end") {
				this.scheduleChildrenRefresh();
			}
		}
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
			if (!this.firstPromptLabel) this.firstPromptLabel = deriveSessionLabel({ firstPrompt: firstUserPrompt([event.message]) });
			this.markHistoryUnarchived();
			// A prompt that just arrived is the wake-up a finished task was waiting
			// for, so the task evidence can let the lamp go.
			const arrived = event.message.timestamp;
			this.recordHistoryPrompt(this.viewedSessionPath(), typeof arrived === "number" ? arrived : Date.now());
		}
		switch (event.type) {
			case "agent_start": {
				this.streaming = true;
				this.awaitingInput = false;
				const sessionPath = this.viewedSessionPath();
				if (sessionPath) {
					this.historyUnreadComplete.delete(sessionPath);
					this.historyReadAt.set(sessionPath, this.historyCompletedAt.get(sessionPath) ?? 0);
					this.updateHistoryRuntime(sessionPath, "running");
					this.paintHistory();
				}
				break;
			}
			case "agent_end":
				this.streaming = false;
				if (this.attached && this.rentedState) this.rentedState = { ...this.rentedState, isStreaming: false };
				else if (this.state) this.state = { ...this.state, isStreaming: false };
				this.awaitingInput = true;
				this.retrying = false;
				// A root ending does not prove its daemon-backed children ended.
				// The scheduled catalog refresh supplies the aggregate verdict.
				if (!this.attached && !this.sidecar) {
					const sessionPath = this.viewedSessionPath();
					if (sessionPath) this.updateHistoryRuntime(sessionPath, "idle");
				}
				this.onBusySettled();
				this.scheduleChildrenRefresh();
				// Rank only moves when the turn is done and the agent is waiting.
				this.markHistoryWaitingForUser(undefined, completedMessageTime(event.messages ?? []));
				this.scheduleHistoryRefresh();
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				// Compaction rewrites the transcript, so the view is stale the moment
				// it ends. Refreshing on the EVENT rather than on the reply to our
				// own request is what makes this correct in the two cases that
				// matter: a compaction another client started on a shared session,
				// and our own request whose reply timed out while the work carried
				// on regardless. Nobody asked for this refresh, so it must not
				// overwrite whatever is being typed right now.
				void this.refreshSnapshot({ keepDraft: true }).catch(() => {
					// Reported through the output channel by refreshSnapshot itself.
				});
				break;
			case "auto_retry_start":
				this.retrying = true;
				break;
			case "auto_retry_end":
				this.retrying = false;
				break;
			case "session_info_changed":
			case "thinking_level_changed":
				void this.refreshStateAndStats();
				this.scheduleHistoryRefresh();
				break;
		}
		if (this.isCreatingSession()) return;
		this.broadcast({ type: "event", event });
		// Hot path: reuse cached stats; expensive stats refresh only on transitions.
		if (
			event.type === "agent_start" ||
			event.type === "agent_end" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.pushStatus();
		} else {
			this.pushStatusLight();
		}
	}

	async restoreAfterObservationClosed(epoch: number): Promise<void> {
		if (this.disposed || this.attached || this.observingId || epoch !== this.viewEpoch) return;
		this.beginRpcRestore();
		if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
	}

	onBusySettled(): void {
		void this.refreshStateAndStats();
	}

	// ------------------------------------------------------------------
	// Extension UI requests -> native VS Code dialogs
	// ------------------------------------------------------------------

	async onExtensionUiRequest(client: RpcClient, request: RpcExtensionUIRequest): Promise<void> {
		// Native dialogs may resolve after a restart. Their response belongs only to
		// the client and view that opened the dialog; never send an approval into a
		// replacement or now-hidden session. We still answer cancellation so the
		// original client cannot remain blocked on a dialog it no longer owns.
		const requestEpoch = this.viewEpoch;
		const respond = (body: Record<string, unknown>) => {
			if (!this.disposed && this.client === client && client.running) {
				const current = this.isCurrentRpcView(client, requestEpoch);
				client.sendRaw({ type: "extension_ui_response", id: request.id, ...(current ? body : { cancelled: true }) });
			}
		};
		// The background RPC keeps running while this window follows a daemon or
		// observed session. Its extension requests must not mutate or prompt over
		// the session on screen; explicitly cancel so it can unwind rather than wait.
		if (!this.isCurrentRpcView(client, requestEpoch)) {
			respond({ cancelled: true });
			return;
		}
		switch (request.method) {
			case "select": {
				const picked = await vscode.window.showQuickPick(request.options, { title: request.title, ignoreFocusOut: true });
				if (picked === undefined) respond({ cancelled: true });
				else respond({ value: picked });
				return;
			}
			case "confirm": {
				const yes = "Yes";
				const no = "No";
				const picked = await vscode.window.showInformationMessage(
					`${request.title}: ${request.message}`,
					{ modal: true },
					yes,
					no,
				);
				if (picked === undefined) respond({ cancelled: true });
				else respond({ confirmed: picked === yes });
				return;
			}
			case "input": {
				const value = await vscode.window.showInputBox({ title: request.title, placeHolder: request.placeholder, ignoreFocusOut: true });
				if (value === undefined) respond({ cancelled: true });
				else respond({ value });
				return;
			}
			case "editor": {
				const value = await vscode.window.showInputBox({ title: request.title, value: request.prefill ?? "", ignoreFocusOut: true });
				if (value === undefined) respond({ cancelled: true });
				else respond({ value });
				return;
			}
			case "notify": {
				const show =
					request.notifyType === "error"
						? vscode.window.showErrorMessage
						: request.notifyType === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(`Brief: ${request.message}`);
				return;
			}
			case "setStatus": {
				this.extensionStatusText = request.statusText;
				this.broadcast({ type: "uiState", statusText: request.statusText });
				this.pushStatus();
				return;
			}
			case "setTitle": {
				this.broadcast({ type: "uiState", title: request.title });
				return;
			}
			case "set_editor_text": {
				this.broadcast({ type: "editorText", text: request.text });
				return;
			}
			default:
				// Every request carries an id and may be awaited on the agent side
				// (setWidget is one we deliberately do not render). Answering with an
				// explicit cancel unwinds it now instead of at its own timeout.
				respond({ cancelled: true });
				return;
		}
	}

	// ------------------------------------------------------------------
	// High-level operations
	// ------------------------------------------------------------------

	isReattaching(): boolean {
		return this.attached === null && this.attachAttempt !== null && this.attachAttemptEpoch === this.viewEpoch;
	}

	/** Claim a new displayed-session intent before any validation or startup await. */
	isCreatingSession(): boolean {
		return this.creatingSessionEpoch === this.viewEpoch;
	}

	beginCreatingSession(): void {
		this.creatingSessionEpoch = this.viewEpoch;
		this.resetChildrenBaseline();
		this.resetViewedSessionState();
		this.clearRunFlags();
		this.bashProcesses.reset();
		this.lastRunningTasksPayload = "[]";
		this.broadcast({ type: "runningTasks", tasks: [] });
		this.broadcast({ type: "sessionChildren", children: [] });
		this.broadcast({
			type: "snapshot",
			messages: [],
			state: null,
			status: this.buildStatus(),
			steerDefault: vscode.workspace.getConfiguration("brief").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
		});
		this.pushStatus();
	}

	abortCreatingSession(previous: AttachRef | null, previousMessages: AgentMessage[], epoch: number): void {
		if (this.disposed || epoch !== this.viewEpoch) return;
		this.creatingSessionEpoch = null;
		this.cachedMessages = previousMessages;
		this.restoreAttachedView(previous, epoch);
		this.broadcast({
			type: "snapshot",
			messages: previousMessages,
			state: this.rentedState ?? this.state,
			status: this.buildStatus(),
			steerDefault: vscode.workspace.getConfiguration("brief").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
		});
		this.restoreDraft();
		this.pushStatus();
	}

	beginNavigation(): number {
		const epoch = ++this.viewEpoch;
		this.bashProcesses.reset();
		this.lastRunningTasksPayload = "[]";
		this.broadcast({ type: "runningTasks", tasks: [] });
		this.scheduleRunningTasks();
		// A socket-drop reconnect belongs to the view that dropped. Once the user
		// chooses another view, it must never resurrect the old one underneath it.
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		return epoch;
	}

	/** Block operations that would otherwise silently address the hidden RPC session. */
	guardObservedReadOnly(action: string): boolean {
		if (this.isCreatingSession()) {
			this.broadcast({ type: "notice", level: "warning", text: `Please wait for the new session to finish creating before ${action}.` });
			return true;
		}
		if (this.attached && this.attachedEpoch !== this.viewEpoch) {
			this.broadcast({ type: "notice", level: "warning", text: `Please wait for the session switch to finish before ${action}.` });
			return true;
		}
		if (!this.observingId && !this.observationRestoring) return false;
		this.broadcast({
			type: "notice",
			level: "warning",
			text: this.observationRestoring
				? `Please wait while your session view is restored before ${action}.`
				: `You are watching another live session read-only. Stop watching it before ${action}.`,
		});
		return true;
	}

	isCurrentAttachment(attached: AttachRef): boolean {
		return !this.disposed && this.attached === attached && this.attachedEpoch === this.viewEpoch;
	}

	/** Put a failed navigation back on the prior attached view without reviving its old async work. */
	restoreAttachedView(attached: AttachRef | null, epoch: number): void {
		if (this.disposed || epoch !== this.viewEpoch || !attached) return;
		// The socket can close while an explicit navigation is still resolving. Its
		// old attachment is no longer usable, so recover the hidden RPC view rather
		// than reviving a disconnected reference or letting actions fall through.
		if (this.observationRestoring && this.attached === null) {
			void this.restoreAfterObservationClosed(epoch);
			return;
		}
		if (this.attached !== attached) return;
		this.attached = { ...attached };
		this.attachedEpoch = epoch;
		this.pushStatus();
	}

	/** A background-RPC reply may only update the same un-attached view that asked. */
	isCurrentRpcView(client: RpcClient, epoch: number, allowRestoring = false): boolean {
		return (
			this.client === client &&
			!this.disposed &&
			this.attached === null &&
			this.observingId === null &&
			!this.isReattaching() &&
			!this.isCreatingSession() &&
			(allowRestoring || !this.observationRestoring) &&
			epoch === this.viewEpoch
		);
	}

	resetViewedSessionState(): void {
		this.firstPromptLabel = "";
		this.extensionStatusText = undefined;
		this.lastStatsText = "";
		this.lastUsage = {};
		this.autoCompactSent = false;
		// A refusal belongs to the thread that earned it, and so does the offer to
		// retry it: carrying either across a session change would rule out models
		// for a thread that never refused, and leave a button that acts on the
		// session the operator just left.
		this.compactionModelsTried.clear();
		this.noticeActions.clear();
	}

	/**
	 * A successful navigation changes the RPC target before its fresh transcript
	 * arrives. Clear the old view and keep controls disabled until that response
	 * proves which session is now on screen.
	 */
	beginRpcRestore(): void {
		this.observationRestoring = true;
		this.resetChildrenBaseline();
		this.resetViewedSessionState();
		this.cachedMessages = [];
		this.state = null;
		this.rentedState = null;
		this.clearRunFlags();
		this.bashProcesses.reset();
		this.lastRunningTasksPayload = "[]";
		this.broadcast({ type: "runningTasks", tasks: [] });
		this.broadcast({ type: "sessionChildren", children: [] });
		this.broadcast({
			type: "snapshot",
			messages: [],
			state: null,
			status: this.buildStatus(),
			steerDefault: vscode.workspace.getConfiguration("brief").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
		});
		this.pushStatus();
	}

	/**
	 * Restore this window's own RPC session. A failed read must NOT latch the
	 * restore lock: `beginRpcRestore()` has already blanked the transcript, and
	 * leaving `observationRestoring` set leaves a permanently disabled composer
	 * that neither Restart nor New Session can clear (both are refused by
	 * guardObservedReadOnly). Retry once through ensureStarted — the subprocess
	 * may have exited while we were following someone else's session — then
	 * release the lock either way and let the status strip report the truth.
	 */
	async restoreOwnRpcView(epoch: number): Promise<boolean> {
		let restored = await this.refreshSnapshot({ epoch, allowRestoring: true });
		if (!restored && !this.disposed && !this.observingId && !this.attached && epoch === this.viewEpoch) {
			try {
				await this.ensureStarted();
			} catch {
				// reported by ensureStarted itself
			}
			if (!this.disposed && !this.observingId && !this.attached && epoch === this.viewEpoch) {
				restored = await this.refreshSnapshot({ epoch, allowRestoring: true });
			}
		}
		if (this.disposed || this.observingId || this.attached || epoch !== this.viewEpoch) return false;
		this.observationRestoring = false;
		this.pushStatus();
		return restored;
	}

	private readonly composerAttachments = new ComposerAttachments();

	private attachmentSession(sessionId: string): void {
		const current = this.attached ? this.attached.sessionId ?? path.basename(this.attached.sessionPath, ".jsonl") : this.state?.sessionId;
		if (this.disposed || this.observingId || !current || current !== sessionId) throw new Error("The attachment belongs to a different or unavailable session.");
	}

	async createAttachment(sessionId: string, attachment: ComposerAttachment, reply: (message: HostToWebview) => void): Promise<void> {
		try {
			this.attachmentSession(sessionId);
			await this.composerAttachments.create(sessionId, attachment);
			this.attachmentSession(sessionId);
			reply({ type: "attachmentCreated", sessionId, id: attachment.id });
		} catch (error) {
			reply({ type: "attachmentCreated", sessionId, id: attachment.id, error: error instanceof Error ? error.message : String(error) });
		}
	}

	async openAttachment(sessionId: string, id: string): Promise<void> {
		this.attachmentSession(sessionId);
		await this.composerAttachments.open(sessionId, id);
	}

	async prompt(payload: PromptPayload, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): Promise<void> {
		try {
			if (payload.attachments?.length) {
				this.attachmentSession(payload.sessionId ?? "");
				const epoch = this.viewEpoch;
				const expanded = await this.composerAttachments.expand(payload);
				const recallText = expanded.recallText;
				this.attachmentSession(payload.sessionId ?? "");
				if (epoch !== this.viewEpoch) throw new Error("The viewed session changed before the prompt could be sent.");
				if (this.composeMessageText(expanded).length > 200_000) throw new Error("Expanded prompt exceeds 200,000 characters. Shorten the attachments before sending.");
				await this.sendPrompt(expanded, reply, recallText);
			} else await this.sendPrompt(payload, reply);
		} catch (error) {
			this.rejectPrompt(payload, error instanceof Error ? error.message : String(error), reply);
		}
	}

	rejectPrompt(payload: PromptPayload, error: string, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): void {
		reply({ type: "promptRejected", error, clientRequestId: payload.clientRequestId });
	}

	private async sendPrompt(payload: PromptPayload, reply: (message: HostToWebview) => void = (message) => this.broadcast(message), recallText?: string): Promise<void> {
		if (this.isCreatingSession()) {
			this.rejectPrompt(payload, "The new session is still being created — nothing was sent.", reply);
			return;
		}
		if (this.guardObservedReadOnly("sending a prompt")) {
			this.rejectPrompt(payload, "The observed session is read-only in this window.", reply);
			return;
		}
		const attached = this.attached;
		if (attached) {
			// The operator's words belong to the thread they were typed in. This is
			// the identity buildStatus() published for this attachment, which is
			// what the composer stamped onto the payload.
			const attachedId = attached.sessionId ?? path.basename(attached.sessionPath, ".jsonl");
			if (payload.sessionId && payload.sessionId !== attachedId) {
				this.rejectPrompt(payload, "This was typed in a different session than the one now on screen — nothing was sent. Your text is back in the box.", reply);
				this.pushStatus();
				return;
			}
			let sidecar: DaemonSidecar;
			try {
				sidecar = await this.ensureSidecar();
			} catch (err) {
				this.rejectPrompt(payload, err instanceof Error ? err.message : "daemon prompt failed", reply);
				return;
			}
			if (!this.isCurrentAttachment(attached)) {
				this.rejectPrompt(payload, "The viewed session changed before the prompt could be sent.", reply);
				return;
			}
			const text = this.composeMessageText(payload);
			const images = payload.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			// Attaching mid-turn never delivers agent_start, so `this.streaming`
			// alone would silently downgrade a queued follow-up into a steer.
			const behavior = this.effectiveStreaming() ? payload.streamingBehavior : "steer";
			try {
				await sidecar.prompt(attached.activeSessionId, text, behavior, images);
				if (!this.isCurrentAttachment(attached)) return;
				this.broadcast({ type: "promptAccepted", kind: "prompt", clientRequestId: payload.clientRequestId, ...(recallText === undefined ? {} : { recallText }) });
			} catch (err) {
				this.rejectPrompt(payload, err instanceof Error ? err.message : "daemon prompt failed", reply);
			}
			return;
		}
		if (this.isReattaching()) {
			this.rejectPrompt(payload, "The live session is reconnecting. Please wait for it to re-attach.", reply);
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) {
			this.rejectPrompt(payload, "Agent is unavailable.", reply);
			return;
		}
		// The RPC frame names no session: it lands on whichever thread the hidden
		// child currently holds. Our cached `state` is not proof of that — a
		// repaint that failed after switch_session leaves it naming the previous
		// thread — so ask the child itself before putting words in its mouth.
		if (payload.sessionId) {
			let liveId: string | undefined;
			try {
				const liveRes = await client.request({ type: "get_state" }, 30_000);
				if (!this.isCurrentRpcView(client, epoch)) {
					this.rejectPrompt(payload, "The viewed session changed before the prompt could be sent.", reply);
					return;
				}
				if (liveRes.success) {
					const live = liveRes.data as RpcSessionState;
					this.state = live;
					liveId = live?.sessionId;
				}
			} catch {
				// An unanswerable child fails the send below on its own terms.
			}
			if (liveId && liveId !== payload.sessionId) {
				this.rejectPrompt(payload, "This was typed in a different session than this window now holds — nothing was sent. The view has been resynced; send it again to post it here.", reply);
				void this.refreshSnapshot({});
				return;
			}
		}
		this.output.appendLine(`[prime-agent] prompt: session=${payload.sessionId ?? this.state?.sessionId ?? "?"} streaming=${this.streaming} behavior=${payload.streamingBehavior}`);
		this.debugLog.append(`prompt entered: streaming=${this.streaming} behavior=${payload.streamingBehavior}`);

		const text = this.composeMessageText(payload);
		const images = payload.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));

		let command: Record<string, unknown>;
		let kind: "prompt" | "steer" | "followUp";
		if (this.streaming && payload.streamingBehavior === "steer") {
			command = { type: "prompt", message: text, images, streamingBehavior: "steer" };
			kind = "steer";
		} else if (this.streaming && payload.streamingBehavior === "followUp") {
			command = { type: "prompt", message: text, images, streamingBehavior: "followUp" };
			kind = "followUp";
		} else {
			command = { type: "prompt", message: text, images };
			kind = "prompt";
		}

		try {
			const response = await client.request(command);
			if (!this.isCurrentRpcView(client, epoch)) return;
			this.debugLog.append(`prompt response: success=${response.success}`);
			this.output.appendLine(`[prime-agent] prompt response: success=${response.success}`);
			if (response.success) {
				this.broadcast({ type: "promptAccepted", kind, clientRequestId: payload.clientRequestId, ...(recallText === undefined ? {} : { recallText }) });
			} else {
				this.rejectPrompt(payload, response.error ?? "prompt rejected", reply);
			}
		} catch (err) {
			if (!this.isCurrentRpcView(client, epoch)) return;
			const error = err instanceof Error ? err.message : String(err);
			this.debugLog.append("prompt request failed");
			this.output.appendLine("[prime-agent] prompt request failed");
			this.rejectPrompt(payload, error, reply);
		}
	}

	composeMessageText(payload: PromptPayload): string {
		let text = payload.text;
		const includeSnippets = vscode.workspace.getConfiguration("brief").get<boolean>("sendSelectionSnippet", true);
		for (const sel of payload.selections) {
			if (includeSnippets && sel.text) {
				text += `\n\n<attachment file="${sel.path}" lines="${sel.startLine}-${sel.endLine}">\n${sel.text}\n</attachment>`;
			} else {
				text += ` (${sel.path} lines ${sel.startLine}-${sel.endLine})`;
			}
		}
		return text;
	}

	async abort(): Promise<void> {
		if (this.guardObservedReadOnly("stopping a run")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.abort(attached.activeSessionId);
			} catch (err) {
				if (!this.isCurrentAttachment(attached)) return;
				this.output.appendLine(`[prime-agent] attached abort failed: ${String(err)}`);
				// Silence here means the operator keeps clicking Stop on a run that
				// is still going, with no way to know the request never left us.
				this.broadcast({
					type: "notice",
					level: "error",
					text: `Could not stop the run: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
			return;
		}
		if (this.isReattaching()) {
			this.broadcast({ type: "notice", level: "warning", text: "The live session is reconnecting; Stop is unavailable until it re-attaches." });
			return;
		}
		if (!this.client?.running) return;
		try {
			await this.client.request({ type: "abort" }, 10_000);
		} catch (err) {
			this.output.appendLine(`[prime-agent] abort failed: ${String(err)}`);
			// Same reason as the attached branch: a failed stop that only reaches
			// the output log leaves the operator clicking Stop on a live run.
			this.broadcast({
				type: "notice",
				level: "error",
				text: `Could not stop the run: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	/** Prepare an independent blank worker without navigating or stopping the source. */
	async initializeBlankFrom(source: SessionController): Promise<void> {
		if (source.guardObservedReadOnly("starting a new session")) throw new Error("The source session is read-only or restoring.");
		const epoch = source.viewEpoch;
		const attached = source.attached;
		const state = attached ? source.rentedState : source.state;
		const model = state?.model;
		const thinkingLevel = state?.thinkingLevel;
		const sidecar = await this.connectDaemon();
		let cwd = source.workspaceRoot;
		if (attached) {
			const sessions = await source.listSessions(sidecar);
			const session = sessions.find((entry) => entry.activeSessionId === attached.activeSessionId);
			if (!session?.cwd) throw new Error("Could not determine the source session working directory.");
			cwd = session.cwd;
		}
		if (source.disposed || source.viewEpoch !== epoch || source.attached !== attached) throw new Error("The source session changed.");
		if (!cwd) throw new Error("Open a workspace folder before starting Brief.");
		const created = await sidecar.createResident({ cwd,
			...(model ? { provider: model.provider, model: model.id } : {}),
			...(thinkingLevel ? { thinking: thinkingLevel } : {}),
		});
		const activeSessionId = created.activeSessionId!;
		try {
			if (this.disposed || source.disposed) throw new Error("Chat is closed.");
			if (!(await this.attachViaDaemon(activeSessionId, created.sessionFile ?? "", this.viewEpoch))) {
				throw new Error(this.lastDaemonAttachError ?? "Could not attach to the new session.");
			}
		} catch (error) {
			// Only the new, unused worker is stopped. The source is never detached.
			await sidecar.request({ type: "kill", activeSessionId }, 30_000).catch((cleanupError) => {
				this.output.appendLine(`Could not stop unused new session ${activeSessionId}: ${String(cleanupError)}`);
			});
			throw error;
		}
	}

	async newSession(): Promise<void> {
		if (this.creatingSessionEpoch === this.viewEpoch) return;
		if (this.guardObservedReadOnly("starting a new session")) return;
		this.broadcast({ type: "newThread" });
		const previousAttachment = this.attached;
		const previousMessages = this.cachedMessages;
		const epoch = this.beginNavigation();
		const observedAtStart = this.observingId;
		this.beginCreatingSession();
		// Create a separate resident worker so the previous session keeps running.
		try {
			if (!this.workspaceRoot) throw new Error("Open a workspace folder before starting Brief.");
			const sidecar = await this.connectDaemon();
			if (this.disposed || epoch !== this.viewEpoch) {
				this.abortCreatingSession(previousAttachment, previousMessages, epoch);
				return;
			}
			const created = await sidecar.createResident({ cwd: this.workspaceRoot });
			if (this.disposed || epoch !== this.viewEpoch) {
				this.abortCreatingSession(previousAttachment, previousMessages, epoch);
				return;
			}
			if (!(await this.detachFromDaemon(previousAttachment)) || epoch !== this.viewEpoch) return;
			if (!(await this.clearObservation(observedAtStart, epoch))) return;
			this.returnTargets = [];
			const attached = await this.attachViaDaemon(created.activeSessionId!, created.sessionFile ?? "", epoch);
			if (!attached && epoch === this.viewEpoch) {
				this.creatingSessionEpoch = null;
				this.broadcast({ type: "notice", level: "error", text: "New session failed: could not attach to the new worker." });
				this.observationRestoring = true;
				this.pushStatus();
				void this.restoreAfterObservationClosed(epoch);
			}
		} catch (err) {
			if (!this.disposed && epoch === this.viewEpoch) {
				this.broadcast({ type: "notice", level: "error", text: `New session failed: ${err instanceof Error ? err.message : String(err)}` });
				this.abortCreatingSession(previousAttachment, previousMessages, epoch);
			}
		}
	}

	/**
	 * `betweenTurnsOnly` is the threshold trigger's contract. Both transports run
	 * AgentSession.compact() without skipAbort, which aborts whatever is in flight
	 * and schedules no continuation — firing it mid-run would swallow the prompt
	 * the operator just sent, with nothing to resend it. Re-checked after every
	 * await because a turn can start while we are connecting.
	 */

	/** Say the true thing about a compact request that did not answer in time. */
	/**
	 * Turn a compaction failure the operator cannot act on into one they can.
	 *
	 * Two of them are about the model rather than the thread, and both are worth
	 * naming because the fix is the same gesture — pick another model — and the
	 * raw provider text says nothing about that:
	 *
	 * - A refusal is the model declining this thread's content. Measured on a
	 *   real 6,500-message thread: claude-opus-5 refused it in ~2s through two
	 *   different providers, while claude-sonnet-5 and a non-Anthropic model
	 *   summarized the very same content without complaint. Retrying the same
	 *   model just reproduces it.
	 * - "prompt is too long" is a context window smaller than the thread, not a
	 *   fault in the request (claude-haiku-4-5 rejected 484,555 tokens against a
	 *   200,000 ceiling on that same thread).
	 */
	static compactFailureHint = compactFailureHint;
	static pickCompactionFallback = pickCompactionFallback;
	static rosterStatus = rosterStatus;
	static isTransientWorkerAttachError = isTransientWorkerAttachError;

	/** Models already asked to summarize THIS thread, so a retry cannot loop. */
	compactionModelsTried = new Set<string>();

	/** Host-issued one-shot recoveries offered on a notice; see `runNoticeAction`. */
	noticeActions = new Map<string, () => Promise<void>>();

	/** Compact once with `model`, then put the operator's model back. */

	/**
	 * Fork the session from the (N-th) user message — mirrors /fork: resolves
	 * the entryId via get_fork_messages order alignment with user rows.
	 */
	/** Rename the active session: daemon set_session_name on attached mode, RPC otherwise. */
	currentSessionName(): string | undefined {
		const named = this.rentedState?.sessionName ?? this.state?.sessionName;
		return this.sessionChromeLabel(named) || undefined;
	}

	async promptRenameSession(isStillSelected: () => boolean): Promise<void> {
		if (this.guardObservedReadOnly("renaming a session")) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const name = await vscode.window.showInputBox({
			title: "Rename session", value: this.currentSessionName() ?? "",
			prompt: "Name this session", placeHolder: "Session name", ignoreFocusOut: true,
		});
		if (name === undefined || this.disposed || epoch !== this.viewEpoch || attached !== this.attached || !isStillSelected()) return;
		await this.renameSession(name);
	}

	async renameSession(name: string): Promise<void> {
		if (this.guardObservedReadOnly("renaming a session")) return;
		const trimmed = name.trim();
		// The daemon refuses an empty name ("Session name cannot be empty"), on the
		// attached path and the RPC one alike, so a cleared box can only ever have
		// produced a failed round-trip and an error notice — under a message that
		// claimed the name had been cleared. Emptying the field means "leave it
		// alone", which is also what the operator's Escape does.
		if (!trimmed) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.request({ type: "set_session_name", activeSessionId: attached.activeSessionId, name: trimmed }, 15_000);
				if (!this.isCurrentAttachment(attached)) return;
				if (this.rentedState) this.rentedState.sessionName = trimmed;
				this.pushStatus();
				this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
				this.savedCatalog = null;
				void this.listHistory();
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) return;
		try {
			const response = await client.request({ type: "set_session_name", name: trimmed }, 30_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (response.success) {
				if (this.state) this.state.sessionName = trimmed;
				this.pushStatusLight();
				this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
				this.savedCatalog = null;
				void this.listHistory();
			} else {
				this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${response.error ?? "unknown error"}` });
			}
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch)) {
				this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
	}

	/** Rename any history session: live sessions go through their owner; offline files get a session_info entry. */
	async renameHistorySession(sessionPath: string, sessionId: string, name: string): Promise<void> {
		if (this.guardObservedReadOnly("renaming a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		sessionPath = session.path;
		sessionId = session.id;
		// History rows carry the session-file uuid, never the 12-char attach
		// handle — comparing only the handle sent the operator to the "rename it
		// from the terminal" refusal for the session they are browsing.
		if (
			(!this.attached && this.state?.sessionId === sessionId) ||
			this.attached?.sessionId === sessionId ||
			(this.attached?.sessionPath !== undefined && normalizeFsPath(this.attached.sessionPath) === normalizeFsPath(sessionPath))
		) {
			await this.renameSession(name);
			return;
		}
		const trimmed = name.trim();
		// A session being live elsewhere is not a reason to refuse: the daemon
		// brokers renames for any client, and `rename_saved_session` is keyed by
		// path so it needs no attach handle. "Close it there first" is the sentence
		// the operator rejected outright.
		try {
			const sidecar = await this.ensureSidecar();
			await sidecar.request({ type: "rename_saved_session", sessionPath, name: trimmed }, 15_000);
			this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			this.savedCatalog = null;
			void this.listHistory();
			return;
		} catch (err) {
			// Daemon down, or it has no record of this file — fall through to the
			// file append, which is exactly what the daemon does for an offline row.
			if (await isSessionActive(sessionPath)) {
				this.broadcast({
					type: "notice",
					level: "error",
					text: `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
				});
				return;
			}
		}
		const result = await renameSessionOffline(sessionPath, session.fileId, name);
		if (result.ok) {
			this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			this.savedCatalog = null;
			void this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${result.error ?? "unknown error"}` });
		}
	}

	async forkFromUser(ordinal?: number, isStillSelected: () => boolean = () => true): Promise<{ sessionFile: string; sessionId: string; text: string } | undefined> {
		if (this.guardObservedReadOnly("forking")) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const client = this.client;
		const current = () => isStillSelected() && !this.disposed && epoch === this.viewEpoch && this.attached === attached
			&& !this.observingId && !this.observationRestoring && (attached ? this.isCurrentAttachment(attached) : client ? this.isCurrentRpcView(client, epoch) : this.client === null && !this.isReattaching());
		const idle = () => !this.effectiveStreaming() && !this.compacting && !this.retrying;
		if (!idle()) { this.showErrorNotice("Wait for the current run to finish before forking."); return; }
		try {
			const sessionFile = this.viewedSessionPath();
			if (!sessionFile || (!attached && !client?.running)) throw new Error("The current session is unavailable.");
			let messages: Array<{ entryId: string; text: string }>;
			if (attached) {
				const sidecar = await this.ensureSidecar();
				if (!current()) return;
				const result = await sidecar.request<{ messages?: Array<{ entryId: string; text: string }> }>({ type: "get_user_messages_for_forking", activeSessionId: attached.activeSessionId }, 30_000);
				messages = result.messages ?? [];
			} else {
				const result = await client!.request({ type: "get_fork_messages" }, 30_000);
				if (!result.success) throw new Error(result.error ?? "Could not read forkable messages.");
				messages = (result.data as { messages?: Array<{ entryId: string; text: string }> })?.messages ?? [];
			}
			if (!current()) return;
			if (!messages.length) { this.broadcast({ type: "notice", level: "info", text: "No forkable user messages in this session." }); return; }
			const inspected = await this.forkFile(sessionFile);
			if (!current()) return;
			const byId = new Map(messages.map(message => [message.entryId, message]));
			const choices = inspected.messages.flatMap(entry => {
				const message = byId.get(entry.entryId);
				return message ? [message] : [];
			});
			if (!choices.length) { this.broadcast({ type: "notice", level: "info", text: "No forkable user messages on the current branch." }); return; }
			let selected: { entryId: string; text: string } | undefined;
			if (ordinal !== undefined) {
				const entry = inspected.messages.filter(entry => entry.visible)[ordinal];
				selected = entry ? byId.get(entry.entryId) : undefined;
				if (!selected) throw new Error("This message cannot be forked with its attachments intact.");
			} else {
				selected = (await vscode.window.showQuickPick(choices.map((message, index) => ({ label: `${index + 1}. ${excerpt(message.text, 0, 35)}`, message })), { title: "Fork session from user message", ignoreFocusOut: true }))?.message;
			}
			if (!selected || !current()) return;
			if (!idle()) throw new Error("Wait for the current run to finish before forking.");
			const fork = await this.forkFile(sessionFile, selected.entryId, inspected.revision);
			if (!current() || !idle()) { await fs.unlink(fork.sessionFile); return; }
			return fork;
		} catch (error) {
			if (current()) this.showErrorNotice(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}

	/**
	 * Messages of the session on screen — the attached one via the daemon, our
	 * own RPC session otherwise. Export and copy must never quietly hand over a
	 * different (usually empty) conversation under the header they can see.
	 */
	async messagesForExport(): Promise<{ messages: Array<Record<string, unknown>>; state: RpcSessionState | null } | null> {
		if (this.guardObservedReadOnly("exporting or copying this conversation")) return null;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const client = this.client;
		const current = () => this.isCurrentExportView(epoch, attached, client);
		try {
			if (this.isReattaching()) throw new Error("The live session is reconnecting. Please wait for it to re-attach.");
			if (attached) {
				const sidecar = await this.ensureSidecar();
				if (!current()) return null;
				const messages = await sidecar.getMessages(attached.activeSessionId);
				if (!current()) return null;
				return { messages, state: this.rentedState };
			}
			if (!client?.running) throw new Error("The session is not connected.");
			const response = await client.request({ type: "get_messages" }, 90_000);
			if (!current()) return null;
			if (!response.success) throw new Error(response.error ?? "Could not load messages");
			const messages = (response.data as { messages?: Array<Record<string, unknown>> })?.messages;
			if (!Array.isArray(messages)) throw new Error("The runtime returned no message list.");
			return { messages, state: this.state };
		} catch (err) {
			if (!this.disposed && epoch === this.viewEpoch && this.attached === attached && this.client === client) {
				this.showErrorNotice(`Could not load messages: ${err instanceof Error ? err.message : String(err)}`);
			}
			return null;
		}
	}

	/** Copy only the latest completed assistant body, not transcript formatting. */
	async copyLastReply(): Promise<void> {
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const client = this.client;
		const current = () => this.isCurrentExportView(epoch, attached, client);
		try {
			const source = await this.messagesForExport();
			if (!source || !current()) return;
			// Runtime get_messages contains message_end records; streamingMessage is separate.
			for (let i = source.messages.length - 1; i >= 0; i -= 1) {
				const message = source.messages[i];
				if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
				const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
					? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
				if (!text.trim()) continue;
				await vscode.env.clipboard.writeText(text);
				if (current()) this.broadcast({ type: "notice", level: "info", text: "Last reply copied as Markdown." });
				return;
			}
			this.broadcast({ type: "notice", level: "info", text: "No completed reply with text to copy." });
		} catch (err) {
			if (current()) this.showErrorNotice(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Copy the whole conversation as Markdown (same summarization as file export). */
	async copyConversation(): Promise<void> {
		const source = await this.messagesForExport();
		if (!source) return;
		const md = buildMarkdownExport(source.messages, true, source.state as unknown as { model?: { provider?: string; id?: string } | null; sessionName?: string } | null);
		await vscode.env.clipboard.writeText(md);
		this.broadcast({ type: "notice", level: "info", text: "Conversation copied as Markdown." });
	}

	/**
	 * Identity of the thread the operator is looking at. Everything per-thread
	 * (draft, compact override, auto-compact ownership) keys on this — while
	 * attached, the RPC session behind us is a different thread entirely.
	 */
	sessionKey(): string {
		if (this.attached) return this.attached.sessionId ?? this.attached.activeSessionId;
		return this.state?.sessionId ?? this.rpcFileStem() ?? "none";
	}

	/**
	 * Identity of the RPC session when the agent reports only a file. It must be
	 * the jsonl STEM, not the path: this value is what the webview echoes back on
	 * `draftChanged`, and the host rejects anything that is not an identifier — so
	 * a path-keyed session silently persisted no drafts at all.
	 */
	rpcFileStem(): string | undefined {
		const file = this.state?.sessionFile;
		if (!file) return undefined;
		const stem = path.basename(file, ".jsonl");
		return /^[A-Za-z0-9_-]+$/.test(stem) ? stem : undefined;
	}

	// ---- sticky composer drafts (per session, survive view reloads) ----

	draftKey(): string {
		return `brief-draft:${this.sessionKey()}`;
	}

	private readonly draftRevisions = new Map<string, number>();
	private readonly attachmentDrafts = new Map<string, { key: string; draft: { text: string; attachments: ComposerAttachment[] } }>();

	async persistDraft(text: string, sessionId: string, attachmentDraft?: { text: string; attachments: ComposerAttachment[] }): Promise<void> {
		if (sessionId !== this.sessionKey()) return;
		// Capture the outgoing session's key before attachment reads yield.
		const key = this.draftKey();
		if (attachmentDraft?.attachments.length) this.attachmentDrafts.set(sessionId, { key, draft: attachmentDraft });
		else this.attachmentDrafts.delete(sessionId);
		await this.saveDraft(text, sessionId, key, attachmentDraft);
	}

	private async saveDraft(text: string, sessionId: string, key: string, attachmentDraft?: { text: string; attachments: ComposerAttachment[] }): Promise<void> {
		const revision = (this.draftRevisions.get(sessionId) ?? 0) + 1;
		this.draftRevisions.set(sessionId, revision);
		try {
			if (attachmentDraft) text = await this.composerAttachments.draftText(sessionId, attachmentDraft);
			if (text.length > 200_000) throw new Error("Draft exceeds 200,000 characters; shorten it before saving.");
			if (revision !== this.draftRevisions.get(sessionId)) return;
			await this.context.globalState.update(key, text.trim() ? text : undefined);
		} catch (error) {
			// Pending/missing attachments must not replace a previously saved draft.
			this.output.appendLine(`Draft was not saved: ${String(error)}`);
		}
	}

	restoreDraft(): void {
		const text = this.context.globalState.get<string>(this.draftKey());
		this.broadcast({ type: "draft", text: text ?? "" });
	}

	// ---- auto-compact threshold (per session, client-side trigger) ----

	thresholdKey(): string {
		return `brief-ct:${this.sessionKey()}`;
	}

	compactThreshold(): number | null {
		return this.context.globalState.get<number | null>(this.thresholdKey(), null);
	}

	setCompactThreshold(percent: number | null): void {
		if (this.guardObservedReadOnly("changing the compaction threshold")) return;
		// Floor 20% is the operator's own constraint. The ceiling matches
		// defaultCompactPercent()'s: the agent's own default is ~94% on a 262k
		// window, and refusing anything above 80 made that default unreachable —
		// the slider pinned at 80 while the readout said 94.
		if (percent !== null && (percent < 20 || percent > 97)) return;
		void this.context.globalState.update(this.thresholdKey(), percent ?? undefined);
		this.broadcast({ type: "compactThreshold", percent, defaultPercent: this.defaultCompactPercent() });
		this.pushStatus();
	}

	/** Effective agent default: prime-agent compacts when ~reserveTokens (16384) of the window remain. */
	defaultCompactPercent(): number | null {
		const cw = this.lastUsage.contextWindow;
		if (!cw || cw <= 0) return null;
		const percent = Math.ceil(((cw - 16_384) / cw) * 100);
		return Math.max(20, Math.min(97, percent));
	}

	historyRefreshTimer: NodeJS.Timeout | null = null;
		/** Debounced history refresh after rename-affecting signals (CLI or other clients). */

	/** Current chat session file, when the host knows it. */

	autoCompactSent = false;

	async exportChat(): Promise<void> {
		if (this.guardObservedReadOnly("exporting this conversation")) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const client = this.client;
		try {
			const picked = await vscode.window.showQuickPick(
				[
					{ label: "Markdown, tool calls summarized", detail: "Compact .md for humans — one line per tool call", mode: "md-tools" },
					{ label: "Markdown, without tool calls", detail: "Conversation only (.md)", mode: "md-clean" },
				],
				{ title: "Export chat" },
			);
			if (!picked || !this.isCurrentExportView(epoch, attached, client)) return;
			await this.exportMarkdown(picked.mode === "md-tools");
		} catch (err) {
			if (this.isCurrentExportView(epoch, attached, client)) this.showErrorNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Export/copy may read a running session, but never a hidden or replacement view. */
	private isCurrentExportView(epoch: number, attached: AttachRef | null, client: RpcClient | null): boolean {
		return !this.disposed && epoch === this.viewEpoch && !this.observingId && !this.observationRestoring &&
			!this.isCreatingSession() && !this.isReattaching() && this.attached === attached &&
			(attached ? this.isCurrentAttachment(attached) : this.client === client);
	}

	/** Export the current transcript as Markdown, generated client-side. */
	async exportMarkdown(includeTools: boolean): Promise<void> {
		if (this.guardObservedReadOnly("exporting this conversation")) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const client = this.client;
		const current = () => this.isCurrentExportView(epoch, attached, client);
		try {
			const source = await this.messagesForExport();
			if (!source || !current()) return;
			// Freeze the document before opening any save/overwrite dialogs.
			const md = buildMarkdownExport(source.messages, includeTools, source.state);
			const target = vscode.Uri.file(path.join(this.workspaceRoot, `brief-session-${Date.now()}.md`));
			const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { Markdown: ["md"] } });
			if (!picked || !current()) return;
			let exists = false;
			try {
				await vscode.workspace.fs.stat(picked);
				exists = true;
			} catch (err) {
				if ((err as { code?: string }).code !== "FileNotFound") throw err;
			}
			if (!current()) return;
			if (exists) {
				const replace = await vscode.window.showWarningMessage(`Replace ${picked.fsPath}?`, { modal: true }, "Replace");
				if (replace !== "Replace" || !current()) return;
			}
			await vscode.workspace.fs.writeFile(picked, Buffer.from(md, "utf8"));
			if (current()) void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
		} catch (err) {
			if (current()) this.showErrorNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private guardSettingsChange(action: string): boolean {
		const state = this.attached ? this.rentedState : this.state;
		if (this.guardObservedReadOnly(action)) {
			this.pushStatusLight();
			return true;
		}
		if (this.effectiveStreaming() || this.compacting || this.retrying || state?.isCompacting) {
			this.broadcast({ type: "notice", level: "warning", text: `Wait for the current run to finish before ${action}.` });
			this.pushStatusLight();
			return true;
		}
		return false;
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		if (this.guardSettingsChange("changing the model")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached) || this.guardSettingsChange("changing the model")) return;
				await sidecar.request({ type: "set_model", activeSessionId: attached.activeSessionId, provider, modelId }, 30_000);
				if (!this.isCurrentAttachment(attached)) return;
				const state = await sidecar.getState(attached.activeSessionId);
				if (this.isCurrentAttachment(attached)) this.rentedState = state as RpcSessionState;
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				if (this.isCurrentAttachment(attached)) this.pushStatusLight();
			}
			return;
		}
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) {
			this.broadcast({ type: "notice", level: "error", text: "The session is not connected." });
			this.pushStatusLight();
			return;
		}
		try {
			const response = await client.request({ type: "set_model", provider, modelId });
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (!response.success) throw new Error(response.error ?? "unknown error");
			const state = await client.request({ type: "get_state" }, 30_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (!state.success) throw new Error(state.error ?? "Could not refresh session settings");
			this.state = state.data as RpcSessionState;
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch)) this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			if (this.isCurrentRpcView(client, epoch)) this.pushStatusLight();
		}
	}

	async setThinkingLevel(level: string): Promise<void> {
		if (this.guardSettingsChange("changing the thinking level")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached) || this.guardSettingsChange("changing the thinking level")) return;
				await sidecar.request({ type: "set_thinking_level", activeSessionId: attached.activeSessionId, level }, 30_000);
				if (!this.isCurrentAttachment(attached)) return;
				const state = await sidecar.getState(attached.activeSessionId);
				if (this.isCurrentAttachment(attached)) this.rentedState = state as RpcSessionState;
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `set_thinking_level failed: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				if (this.isCurrentAttachment(attached)) this.pushStatusLight();
			}
			return;
		}
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) {
			this.broadcast({ type: "notice", level: "error", text: "The session is not connected." });
			this.pushStatusLight();
			return;
		}
		try {
			const response = await client.request({ type: "set_thinking_level", level });
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (!response.success) throw new Error(response.error ?? "unknown error");
			const state = await client.request({ type: "get_state" }, 30_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (!state.success) throw new Error(state.error ?? "Could not refresh session settings");
			this.state = state.data as RpcSessionState;
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch)) this.broadcast({ type: "notice", level: "error", text: `set_thinking_level failed: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			if (this.isCurrentRpcView(client, epoch)) this.pushStatusLight();
		}
	}

	sendCachedModels(): void {
		const models = this.context.globalState.get<RpcModel[]>(MODEL_CACHE_KEY, []);
		if (models.length > 0) this.broadcast({ type: "models", models });
	}

	private async publishModels(models: RpcModel[]): Promise<void> {
		this.broadcast({ type: "models", models });
		await this.context.globalState.update(MODEL_CACHE_KEY, models);
	}

	async listModels({ startAgent = true }: { startAgent?: boolean } = {}): Promise<boolean> {
		if (this.guardObservedReadOnly("listing models")) return false;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return false;
				const data = await sidecar.request<{ models?: RpcModel[] }>(
					{ type: "get_available_models", activeSessionId: attached.activeSessionId },
					60_000,
				);
				if (!this.isCurrentAttachment(attached)) return false;
				await this.publishModels(data.models ?? []);
				return true;
			} catch {
				if (startAgent && this.isCurrentAttachment(attached)) {
					this.broadcast({ type: "notice", level: "error", text: "Could not list attached-session models." });
				}
			}
			return false;
		}
		const epoch = this.viewEpoch;
		if (startAgent) await this.ensureStarted();
		const client = this.client;
		if (!client?.running || !this.isCurrentRpcView(client, epoch)) return false;
		const response = await client.request({ type: "get_available_models" }, 60_000);
		if (!this.isCurrentRpcView(client, epoch)) return false;
		if (response.success) {
			// Forwarded verbatim: the payload is the agent's whole Model object, and
			// the webview needs the fields this cast used to hide (thinkingLevelMap).
			const data = response.data as { models?: RpcModel[] };
			await this.publishModels(data.models ?? []);
			return true;
		}
		return false;
	}

	/**
	 * The slash catalog is a property of the agent BUILD, not of the session on
	 * screen, and the webview asks for it again every time a session boundary
	 * discards its copy. So it must answer in exactly the states the old guards
	 * refused: while attached to a daemon session, while observing, and while a
	 * restore is in flight — those are precisely when a boundary just happened.
	 * guardObservedReadOnly() also had no business here: it exists to refuse
	 * MUTATIONS on a read-only view, and it made a harmless catalog query pop an
	 * operator-facing "that session is read-only" warning.
	 */
	async listCommands(): Promise<void> {
		await this.ensureStarted();
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				const data = await sidecar.request<{ commands?: RpcSlashCommand[] }>(
					{ type: "get_commands", activeSessionId: attached.activeSessionId },
					30_000,
				);
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "commands", commands: data.commands ?? [] });
			} catch {
				// The composer can still send plain prompts when command discovery fails.
			}
			return;
		}
		const client = this.client;
		if (!client?.running || this.disposed) return;
		const response = await client.request({ type: "get_commands" }, 30_000);
		if (this.client !== client || this.disposed) return;
		if (response.success) {
			const data = response.data as { commands?: RpcSlashCommand[] };
			this.broadcast({ type: "commands", commands: data.commands ?? [] });
		}
	}

	// ------------------------------------------------------------------
	// Session deletion (same conventions as the CLI: trash-first + artifacts)
	// ------------------------------------------------------------------

	async deleteSessionByPath(sessionPath: string, sessionId: string): Promise<void> {
		if (this.guardObservedReadOnly("deleting a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		sessionPath = session.path;
		sessionId = session.id;
		const fileId = session.fileId;
		// The attached session is one the operator is in, so it earns the honest
		// refusal rather than "close it there first" — the sentence #19 rejected.
		if ((!this.attached && sessionId === this.state?.sessionId) || sessionId === this.attached?.sessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "You can't delete the session you're in. Start a new one first." });
			return;
		}
		// The CLI refuses to delete a resident session too (delete_saved_session:
		// "Cannot delete the currently active session") — but it offers Archive for
		// exactly this case, so say that instead of stranding the operator.
		if (await isSessionActive(sessionPath)) {
			this.broadcast({
				type: "notice",
				level: "warning",
				text: "That session is live in another client — archive it instead, or stop it there first.",
			});
			return;
		}
		const result = await deleteSession(sessionPath, fileId);
		if (result.ok) {
			const method = result.method === "trash" ? "moved to Trash" : "deleted";
			this.broadcast({ type: "notice", level: "info", text: `Session ${method} (artifacts removed).` });
			this.forgetHistoryRow(sessionPath);
			this.savedCatalog = null;
			await this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Could not delete session: ${result.error ?? "unknown error"}` });
		}
	}

	// ------------------------------------------------------------------
	// Favorite models (persisted in globalState)
	// ------------------------------------------------------------------

	favorites(): ModelRef[] {
		return this.context.globalState.get<ModelRef[]>("brief.favoriteModels", []);
	}

	sendFavorites(): void {
		this.broadcast({ type: "favorites", favorites: this.favorites() });
	}

	async toggleFavoriteModel(provider: string, modelId: string): Promise<void> {
		const current = this.favorites();
		const exists = current.some((f) => f.provider === provider && f.modelId === modelId);
		const next = exists
			? current.filter((f) => !(f.provider === provider && f.modelId === modelId))
			: [...current, { provider, modelId }];
		await this.context.globalState.update("brief.favoriteModels", next);
		this.sendFavorites();
	}

	/** Daemon catalog when it answers, on-disk scan when it does not. */

	/** Drop a row from the replay cache so a deleted session never flashes back. */

	/** Stop a live session from the history view (daemon abort on its active id). */
	async stopSession(sessionPath: string, sessionId: string): Promise<void> {
		if (this.guardObservedReadOnly("stopping a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		try {
			const sidecar = await this.ensureSidecar();
			const resident = (await this.listSessions(sidecar)).find(
				(row) =>
					row.activeSessionId &&
					(row.sessionId === session.id || (row.sessionFile && normalizeFsPath(row.sessionFile) === normalizeFsPath(session.path))),
			);
			if (!resident?.activeSessionId) {
				this.broadcast({ type: "notice", level: "warning", text: "That session is no longer running." });
				return;
			}
			await sidecar.abort(resident.activeSessionId);
			this.broadcast({ type: "notice", level: "info", text: "Stop requested for that session." });
			void this.listHistory();
		} catch (err) {
			this.broadcast({ type: "notice", level: "error", text: `Could not stop the session: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	/** Archive only changes Brief's history classification, never the runtime. */
	async archiveSession(sessionPath: string, sessionId: string): Promise<void> {
		const target = normalizeFsPath(sessionPath);
		const row = (this.actionHistory ?? this.lastHistory)?.find(
			(row) => row.id === sessionId && normalizeFsPath(row.path) === target,
		);
		if (!row || row.running || (row.status !== "idle" && row.status !== "inactive")) {
			this.paintHistory();
			return;
		}
		this.markHistoryArchived(row.path);
	}

	async pickModelQuickPick(): Promise<void> {
		if (this.guardObservedReadOnly("choosing a model")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				const [modelData, state] = await Promise.all([
					sidecar.request<{ models?: RpcModel[] }>({ type: "get_available_models", activeSessionId: attached.activeSessionId }, 60_000),
					sidecar.getState(attached.activeSessionId),
				]);
				if (!this.isCurrentAttachment(attached)) return;
				this.rentedState = state as RpcSessionState;
				const models = modelData.models ?? [];
				const current = this.rentedState.model;
				const picked = await vscode.window.showQuickPick(
					models.map((model) => ({
						label: `${model.provider}/${model.id}`,
						description: model.id === current?.id && model.provider === current?.provider ? "(current)" : model.name,
						model,
					})),
					{ title: "Select model", placeHolder: `${models.length} models available` },
				);
				// Native quick-picks may stay open while the user navigates. A choice
				// made for the old attached session must never retarget the new view.
				if (!picked || !this.isCurrentAttachment(attached)) return;
				await this.setModel(picked.model.provider, picked.model.id);
			} catch (err) {
				if (this.isCurrentAttachment(attached)) {
					this.broadcast({ type: "notice", level: "error", text: `Could not list attached-session models: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch) || this.observationRestoring) return;
		const response = await client.request({ type: "get_available_models" }, 60_000);
		if (!this.isCurrentRpcView(client, epoch) || this.observationRestoring) return;
		if (!response.success) {
			this.broadcast({ type: "notice", level: "error", text: `Could not list models: ${response.error ?? "unknown error"}` });
			return;
		}
		const models = (response.data as { models?: Array<{ provider: string; id: string; name?: string; contextWindow?: number }> }).models ?? [];
		const current = this.state?.model;
		const picked = await vscode.window.showQuickPick(
			models.map((model) => ({
				label: `${model.provider}/${model.id}`,
				description: model.id === current?.id && model.provider === current?.provider ? "(current)" : model.name,
				model,
			})),
			{ title: "Select model", placeHolder: `${models.length} models available` },
		);
		if (picked && this.isCurrentRpcView(client, epoch) && !this.observationRestoring) {
			await this.setModel(picked.model.provider, picked.model.id);
		}
	}

	async pickThinkingQuickPick(): Promise<void> {
		if (this.guardObservedReadOnly("choosing a thinking level")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				const state = (await sidecar.getState(attached.activeSessionId)) as RpcSessionState;
				if (!this.isCurrentAttachment(attached)) return;
				this.rentedState = state;
				const levels = supportedThinkingLevels(state.model) ?? THINKING_LEVELS.slice(0, 5);
				const current = state.thinkingLevel ?? "off";
				const picked = await vscode.window.showQuickPick(
					levels.map((level) => ({ label: level, description: level === current ? "(current)" : undefined })),
					{ title: "Select thinking level" },
				);
				if (!picked || !this.isCurrentAttachment(attached)) return;
				await this.setThinkingLevel(picked.label);
			} catch (err) {
				if (this.isCurrentAttachment(attached)) {
					this.broadcast({ type: "notice", level: "error", text: `Could not load attached-session thinking levels: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch) || this.observationRestoring) return;
		// Same source as the brain popout: offering a level the model rejects only
		// buys the operator a silent clamp to something they did not pick.
		const levels = supportedThinkingLevels(this.state?.model) ?? THINKING_LEVELS.slice(0, 5);
		const current = this.state?.thinkingLevel ?? "off";
		const picked = await vscode.window.showQuickPick(
			levels.map((level) => ({ label: level, description: level === current ? "(current)" : undefined })),
			{ title: "Select thinking level" },
		);
		if (picked && this.isCurrentRpcView(client, epoch) && !this.observationRestoring) {
			await this.setThinkingLevel(picked.label);
		}
	}

	/** Attach to a resident session read-only through the daemon observe channel. */

	
	// ----------------------------------------------------------------
	// Daemon sidecar: attached live sessions (terminal parity)
	// ----------------------------------------------------------------

	/** One re-attach attempt for the dropped view. Never run concurrently with itself. */
	reattaching: Promise<void> | null = null;

	reattachTimer: NodeJS.Timeout | null = null;
	ownerIdCache: { sessionFile: string; id: string | undefined; at: number } | null = null;
	childrenTimer: ReturnType<typeof setTimeout> | null = null;
	childrenRefreshInFlight = false;
	childrenRefreshPending = false;
	lastChildrenRefreshMs = 0;

	previousChildIds: Set<string> | null = null;
	lastChildrenPayload: string | null = null;

	/** Route daemon events for the attached session into the normal pipeline. */

	/** Effective model/status snapshot accounting for daemon-attached sessions. */

	// ------------------------------------------------------------------
	// Snapshot / status
	// ------------------------------------------------------------------

	/**
	 * `keepDraft` is for refreshes the operator did not ask for. restoreDraft()
	 * pushes the host's copy of the composer text, which the webview applies
	 * unconditionally — fine after a navigation, wrong when a background event
	 * (auto-compaction, or another client compacting a shared session) lands
	 * while someone is mid-sentence, because the host's copy is up to one debounce
	 * stale and applying it moves the caret to the end.
	 */
	async refreshSnapshot(options: { epoch?: number; allowRestoring?: boolean; keepDraft?: boolean } = {}): Promise<boolean> {
		if (this.isCreatingSession()) {
			this.pushStatus();
			return false;
		}
		// Hiding and re-showing the view reloads the webview, which asks for a
		// fresh snapshot. Our own background RPC client is still running, so
		// without this branch the attached transcript is repainted with the
		// background session's (usually empty) messages and its sticky draft,
		// while the header keeps naming the terminal session.
		const attached = this.attached;
		if (attached) {
			const id = attached.activeSessionId;
			try {
				const sidecar = await this.ensureSidecar();
				const [messages, state] = await Promise.all([sidecar.getMessages(id), sidecar.getState(id)]);
				if (!this.isCurrentAttachment(attached)) return false;
				this.cachedMessages = messages as AgentMessage[];
				this.rentedState = state as RpcSessionState;
			} catch {
				// daemon busy — repaint from what we already hold rather than blank
			}
			if (!this.isCurrentAttachment(attached)) return false;
			await this.fetchAttachedStats();
			if (!this.isCurrentAttachment(attached)) return false;
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.rentedState,
				status: this.buildStatus(),
				steerDefault: vscode.workspace.getConfiguration("brief").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
			});
			if (options.keepDraft !== true) this.restoreDraft();
			this.pushStatus();
			this.repaintChildrenStrip();
			return true;
		}
		if (this.observingId) {
			// A reconstructed webview needs the observed transcript too. The RPC
			// session below is intentionally hidden, so never repaint it here.
			this.broadcast({ type: "observedSession", sessionId: this.observingId, messages: this.cachedMessages });
			this.pushStatusLight();
			return true;
		}
		const client = this.client;
		const epoch = options.epoch ?? this.viewEpoch;
		const allowRestoring = options.allowRestoring === true;
		if (!client?.running || !this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
		try {
			const [messagesRes, stateRes] = await Promise.all([
				client.request({ type: "get_messages" }, 60_000),
				client.request({ type: "get_state" }, 30_000),
			]);
			if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
			if (!messagesRes.success || !stateRes.success) {
				this.output.appendLine(`[prime-agent] snapshot failed: ${messagesRes.error ?? stateRes.error ?? "agent rejected snapshot request"}`);
				return false;
			}
			// A complete snapshot proves the agent is answering this view.
			this.reachable = true;
			this.cachedMessages = ((messagesRes.data as { messages?: AgentMessage[] })?.messages ?? []) as AgentMessage[];
			this.state = stateRes.data as RpcSessionState;
			const stats = await this.fetchStatsText(allowRestoring);
			if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
			const steerDefault = vscode.workspace
				.getConfiguration("brief")
				.get<"steer" | "followUp">("defaultStreamingBehavior", "steer");
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.state,
				status: this.buildStatus(stats),
				steerDefault,
			});
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch, allowRestoring)) this.output.appendLine(`[prime-agent] snapshot failed: ${String(err)}`);
			return false;
		}
		if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
		if (options.keepDraft !== true) this.restoreDraft();
		this.pushStatus();
		this.repaintChildrenStrip();
		return true;
	}

	/**
	 * A full repaint means someone is looking at an empty strip — a reloaded
	 * webview keeps no children of its own. Drop the change filter so the next
	 * refresh is allowed through even when the roster itself hasn't moved.
	 */
	repaintChildrenStrip(): void {
		this.lastChildrenPayload = null;
		this.scheduleChildrenRefresh();
	}

	async refreshStateAndStats(): Promise<void> {
		// Attached events describe the daemon session, not our RPC subprocess.
		if (this.attached) {
			await this.refreshAttachedState();
			return;
		}
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) return;
		try {
			const stateRes = await client.request({ type: "get_state" }, 30_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			this.reachable = true;
			if (stateRes.success) this.state = stateRes.data as RpcSessionState;
		} catch {
			// keep previous state
		}
		if (this.isCurrentRpcView(client, epoch)) this.pushStatus();
	}

	/** Manual, read-only query. Never use the status refresh helpers: they can compact. */
	async queryStatistics(kind: StatisticsKind, requestId: number, reply: (message: HostToWebview) => void): Promise<void> {
		const epoch = this.viewEpoch;
		const client = this.client;
		const sidecar = this.sidecar;
		const attached = this.attached;
		const observed = this.observingId;
		const current = () => !this.disposed && epoch === this.viewEpoch && this.client === client &&
			this.sidecar === sidecar && this.attached === attached && this.observingId === observed &&
			!this.observationRestoring && !this.isCreatingSession() && !this.isReattaching() &&
			(!attached || this.isCurrentAttachment(attached));
		if (!current()) {
			if (!this.disposed) reply({ type: "statistics", kind, requestId, error: "Session is changing. Try again when it is ready." });
			return;
		}
		try {
			let stats: RpcSessionStats;
			let state = attached ? this.rentedState : observed ? null : this.state;
			if (attached || observed) {
				if (!sidecar?.connected) throw new Error("No available connection for this session.");
				const target = attached?.activeSessionId ?? observed!;
				stats = await sidecar.getSessionStats(target);
				if (!current()) return;
				// Legacy observation has no cached target state; never read the hidden RPC state.
				if (observed) state = await sidecar.getState(target) as RpcSessionState;
			} else {
				if (!client?.running) throw new Error("No available connection for this session.");
				const response = await client.request({ type: "get_session_stats" }, 30_000);
				if (!response.success) throw new Error(response.error || "Runtime rejected the statistics query.");
				stats = response.data as RpcSessionStats;
			}
			if (!current()) return;
			if (!stats || typeof stats !== "object" || Array.isArray(stats)) throw new Error("Runtime did not provide statistics.");
			const number = (value: unknown, suffix = "") => typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "未提供";
			const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : "未提供";
			const running = Boolean(state?.isStreaming || state?.isCompacting || (!observed && (this.streaming || this.compacting)));
			const rows: StatisticsSnapshot["rows"] = [];
			let scope: string;
			if (kind === "usage") {
				scope = "Runtime cumulative usage in the current branch's retained messages; compaction can remove earlier usage. May include child usage attributed by runtime; Brief does not aggregate children. USD estimate, not a final provider bill.";
				rows.push(
					{ label: "Input tokens", value: number(stats.tokens?.input) },
					{ label: "Output tokens", value: number(stats.tokens?.output) },
					{ label: "Cache read tokens", value: number(stats.tokens?.cacheRead) },
					{ label: "Cache write tokens", value: number(stats.tokens?.cacheWrite) },
					{ label: "Total tokens", value: number(stats.tokens?.total) },
					{ label: "Cost (USD)", value: number(stats.cost) },
				);
			} else if (kind === "context") {
				scope = "Runtime estimate of current model context, not cumulative usage. After compaction, used tokens may be unknown until the next response. No context tree or child aggregation.";
				rows.push(
					{ label: "Context used tokens", value: number(stats.contextUsage?.tokens) },
					{ label: "Context window", value: number(stats.contextUsage?.contextWindow) },
					{ label: "Context used", value: number(stats.contextUsage?.percent, "%") },
				);
			} else {
				scope = "Current session state and runtime counts of the current branch's retained messages; counts can change after compaction. No child message aggregation.";
				rows.push(
					{ label: "Name", value: text(state?.sessionName) },
					{ label: "ID", value: text(state?.sessionId ?? attached?.sessionId ?? observed) },
					{ label: "Working directory", value: text(state?.cwd ?? (!attached && !observed ? this.workspaceRoot : undefined)) },
					{ label: "Model", value: state?.model ? `${state.model.provider}/${state.model.id}` : "未提供" },
					{ label: "Thinking level", value: text(state?.thinkingLevel) },
					{ label: "Running", value: running ? "Yes" : state?.isStreaming === false ? "No" : "未提供" },
					{ label: "Read-only", value: observed ? "Yes" : "No" },
					{ label: "User messages", value: number(stats.userMessages) },
					{ label: "Assistant messages", value: number(stats.assistantMessages) },
					{ label: "Tool calls", value: number(stats.toolCalls) },
					{ label: "Total messages", value: number(stats.totalMessages) },
				);
			}
			reply({ type: "statistics", kind, requestId, snapshot: { queriedAt: new Date().toISOString(), scope, rows,
				running } });
		} catch (error) {
			if (current()) reply({ type: "statistics", kind, requestId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	lastStatsText = "";
	statsTimer: NodeJS.Timeout | null = null;
	statsFetching = false;

	/** Broadcast the status immediately using cached stats (cheap, per-event). */
	pushStatusLight(): void {
		this.broadcast({ type: "status", status: this.buildStatus(this.lastStatsText) });
	}

	async fetchStatsText(allowRestoring = false): Promise<string> {
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) return "";
		try {
			const res = await client.request({ type: "get_session_stats" }, 30_000);
			if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return "";
			this.reachable = true;
			if (!res.success) return "";
			const data = res.data as {
				tokens?: { total?: number };
				cost?: number;
				contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
			};
			this.lastUsage = {
				usageTotal: data.tokens?.total,
				costUsd: data.cost,
				contextTokens: data.contextUsage?.tokens ?? null,
				contextWindow: data.contextUsage?.contextWindow,
				contextPercent: data.contextUsage?.percent ?? null,
			};
			const parts: string[] = [];
			if (data.tokens?.total != null) parts.push(`${formatNumber(data.tokens.total)} tokens`);
			if (data.cost != null && data.cost > 0) parts.push(`$${data.cost.toFixed(4)}`);
			if (data.contextUsage && data.contextUsage.percent != null) parts.push(`${data.contextUsage.percent}% of context`);
			// These numbers are always the background RPC session's, which is a
			// different thread from the one on screen whenever we are attached.
			this.maybeTriggerAutoCompact(
				data.contextUsage?.percent ?? null,
				this.state?.sessionId ?? this.state?.sessionFile ?? "none",
			);
			return parts.join(" · ");
		} catch {
			return "";
		}
	}

	/**
	 * Same numbers, sourced from the daemon for the session actually on screen.
	 * fetchStatsText() would answer for our idle background session, so the gauge
	 * would read ~2% while the terminal session sits at 88%.
	 */
	async fetchAttachedStats(): Promise<string> {
		const attached = this.attached;
		if (!attached || !this.sidecar?.connected) return this.lastStatsText;
		try {
			const data = (await this.sidecar.getSessionStats(attached.activeSessionId)) as {
				tokens?: { total?: number };
				cost?: number;
				contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
			};
			if (!this.isCurrentAttachment(attached)) return this.lastStatsText;
			this.lastUsage = {
				usageTotal: data.tokens?.total,
				costUsd: data.cost,
				contextTokens: data.contextUsage?.tokens ?? null,
				contextWindow: data.contextUsage?.contextWindow,
				contextPercent: data.contextUsage?.percent ?? null,
			};
			const parts: string[] = [];
			if (data.tokens?.total != null) parts.push(`${formatNumber(data.tokens.total)} tokens`);
			if (data.cost != null && data.cost > 0) parts.push(`$${data.cost.toFixed(4)}`);
			if (data.contextUsage && data.contextUsage.percent != null) parts.push(`${data.contextUsage.percent}% of context`);
			this.maybeTriggerAutoCompact(data.contextUsage?.percent ?? null, this.sessionKey());
			this.lastStatsText = parts.join(" · ");
			return this.lastStatsText;
		} catch {
			return this.lastStatsText;
		}
	}

	lastUsage: { usageTotal?: number; costUsd?: number; contextTokens?: number | null; contextWindow?: number; contextPercent?: number | null } = {};

	/** True while the session on screen is busy, whoever started the turn. */
	effectiveStreaming(): boolean {
		if (this.attached) return this.streaming || (this.rentedState?.isStreaming ?? false);
		return this.streaming || (this.state?.isStreaming ?? false);
	}

	sessionChromeLabel(sessionName?: string): string {
		return deriveSessionLabel({ name: sessionName, firstPrompt: firstUserPrompt(this.cachedMessages) }) || this.firstPromptLabel;
	}

	buildStatus(statsText = this.lastStatsText): StatusSnapshot {
		const composerToolbar = this.composerToolbar();
		if (this.isCreatingSession()) {
			const st = (this.rentedState ?? this.state) as RpcSessionState | null;
			const model = st?.model ?? null;
			const label = model ? `${model.provider}/${model.id}` : "Agent";
			return { composerToolbar,
				connected: this.reachable || Boolean(this.attached) || Boolean(this.sidecar?.connected),
				streaming: false,
				compacting: false,
				retrying: false,
				restoring: true,
				modelLabel: label,
				thinkingLevel: st?.thinkingLevel ?? "off",
				availableThinkingLevels: supportedThinkingLevels(model),
				sessionLabel: "",
				statsText: "",
				statusText: "creating session…",
				modelProvider: model?.provider,
				modelId: model?.id,
				observingId: null,
				compactThresholdPercent: null,
				compactDefaultPercent: this.defaultCompactPercent(),
				liveTranscript: this.liveTranscript(),
				streamToolOutput: this.streamToolOutput(),
				showUsageDetails: this.showUsageDetails(),
				showThoughtProcess: this.showThoughtProcess(),
			};
		}
		if (this.observingId) {
			const observed = this.observedSession;
			return { composerToolbar,
				connected: true,
				streaming: false,
				compacting: false,
				retrying: false,
					restoring: false,
				modelLabel: "observed session",
				thinkingLevel: "off",
				availableThinkingLevels: null,
				sessionFile: observed?.sessionPath,
				sessionId: observed?.sessionId ?? this.observingId,
				sessionLabel: this.sessionChromeLabel(),
				statsText,
				statusText: "watching another live session (read-only)",
				observingId: this.observingId,
				compactThresholdPercent: this.compactThreshold(),
				compactDefaultPercent: this.defaultCompactPercent(),
				liveTranscript: this.liveTranscript(),
				streamToolOutput: this.streamToolOutput(),
				showUsageDetails: this.showUsageDetails(),
				showThoughtProcess: this.showThoughtProcess(),
			};
		}
		if (this.isReattaching()) {
			const attempt = this.attachAttempt!;
			const state = this.rentedState;
			const model = state?.model ?? null;
			return { composerToolbar,
				connected: false,
				streaming: false,
				compacting: false,
				retrying: false,
				restoring: true,
				modelLabel: model ? `${model.provider}/${model.id}` : "attached session",
				thinkingLevel: state?.thinkingLevel ?? "off",
				availableThinkingLevels: supportedThinkingLevels(model),
				sessionName: state?.sessionName,
				sessionLabel: this.sessionChromeLabel(state?.sessionName),
				sessionFile: attempt.sessionPath,
				sessionId: attempt.sessionId ?? path.basename(attempt.sessionPath, ".jsonl"),
				statsText,
				statusText: "reconnecting to shared session…",
				modelProvider: model?.provider,
				modelId: model?.id,
				observingId: this.observingId,
				compactThresholdPercent: this.compactThreshold(),
				compactDefaultPercent: this.defaultCompactPercent(),
				liveTranscript: this.liveTranscript(),
				streamToolOutput: this.streamToolOutput(),
				showUsageDetails: this.showUsageDetails(),
				showThoughtProcess: this.showThoughtProcess(),
				...this.lastUsage,
			};
		}
		if (this.attached) {
			const st = this.rentedState as (RpcSessionState & { model?: RpcSessionState["model"] }) | null;
			const model = st?.model ?? null;
			const label = model ? `${model.provider}/${model.id}` : "attached session";
			const switching = this.attachedEpoch !== this.viewEpoch || this.observationRestoring;
			// Attaching mid-turn never delivers agent_start, so the local flags alone
			// would report idle: no running label, no Stop, no queue/steer toggle.
			const streaming = this.streaming || (st?.isStreaming ?? false);
			const compacting = this.compacting || (st?.isCompacting ?? false);
			return { composerToolbar,
				connected: true,
				streaming,
				awaitingInput: this.awaitingInput && !streaming && !compacting,
				compacting,
				retrying: this.retrying,
				restoring: switching,
				modelLabel: label,
				thinkingLevel: st?.thinkingLevel ?? "off",
				availableThinkingLevels: supportedThinkingLevels(model),
				sessionName: st?.sessionName,
				sessionLabel: this.sessionChromeLabel(st?.sessionName),
				sessionFile: this.attached.sessionPath,
				// History rows key on the jsonl stem. Falling back to the 12-char
				// attach handle here would leave the row for the session on screen
				// unmarked and clickable — the daemon id and the file id are
				// different namespaces and never compare equal.
				sessionId: this.attached.sessionId ?? path.basename(this.attached.sessionPath, ".jsonl"),
				statsText,
				// This label overwrites the running/live word in the header, so it has
				// to carry the running state itself or the run becomes invisible.
				statusText: switching
					? "switching sessions…"
					: compacting
					? "compacting"
					: streaming
						? "running"
						: "opened",
				modelProvider: model?.provider,
				modelId: model?.id,
				observingId: this.observingId,
				compactThresholdPercent: this.compactThreshold(),
				compactDefaultPercent: this.defaultCompactPercent(),
				liveTranscript: this.liveTranscript(),
				streamToolOutput: this.streamToolOutput(),
				showUsageDetails: this.showUsageDetails(),
				showThoughtProcess: this.showThoughtProcess(),
				...this.lastUsage,
			};
		}
		const model = this.state?.model;
		const modelLabel = model ? `${model.provider}/${model.id}` : "no model";
		return {
			// Reachability, never process liveness: a spawn that failed or an agent
			// that never answers must read "offline" and refuse prompts, not paint a
			// green dot over a prompt that will time out 120s later.
			connected: this.reachable,
			streaming: this.streaming || (this.state?.isStreaming ?? false),
			awaitingInput: this.awaitingInput && !(this.streaming || (this.state?.isStreaming ?? false)),
			compacting: this.compacting || (this.state?.isCompacting ?? false),
			retrying: this.retrying,
			restoring: this.startingPromise !== null || this.observationRestoring,
			modelLabel,
			thinkingLevel: this.state?.thinkingLevel ?? "off",
			availableThinkingLevels: supportedThinkingLevels(model),
			sessionName: this.state?.sessionName,
			sessionLabel: this.sessionChromeLabel(this.state?.sessionName),
			sessionFile: this.state?.sessionFile,
			// Same derivation as sessionKey(): the identity the webview sends back
			// with a draft has to be the identity the draft is stored under.
			sessionId: this.state?.sessionId ?? this.rpcFileStem(),
			statsText,
			statusText: this.observationRestoring ? "restoring your session…" : this.extensionStatusText,
			modelProvider: model?.provider,
			modelId: model?.id,
			observingId: this.observingId,
			compactThresholdPercent: this.compactThreshold(),
			compactDefaultPercent: this.defaultCompactPercent(),
				liveTranscript: this.liveTranscript(),
				streamToolOutput: this.streamToolOutput(),
				showUsageDetails: this.showUsageDetails(),
				showThoughtProcess: this.showThoughtProcess(),
			...this.lastUsage,
		};
	}

	/**
	 * Push status with fresh stats, throttled: at most one stats RPC in flight and
	 * at most one refresh per second. Streaming turns generate hundreds of events,
	 * so callers use pushStatusLight() on the hot path and this on transitions.
	 */
	pushStatus(): void {
		if (this.disposed) return;
		if (this.statsTimer) return;
		this.statsTimer = setTimeout(() => {
			this.statsTimer = null;
			if (this.disposed) return;
			// While attached, the RPC subprocess's stats belong to a session the
			// operator is not looking at — ask the daemon about the one they are.
			const attached = this.attached;
			const epoch = this.viewEpoch;
			const attachedStats = attached && this.sidecar?.connected;
			if (this.statsFetching || (!attachedStats && !this.client?.running)) {
				this.pushStatusLight();
				return;
			}
			this.statsFetching = true;
			void (attachedStats ? this.fetchAttachedStats() : this.fetchStatsText())
				.then((stats) => {
					if (this.disposed || epoch !== this.viewEpoch || this.attached !== attached) return;
					if (stats) this.lastStatsText = stats;
					this.broadcast({ type: "status", status: this.buildStatus() });
				})
				.finally(() => {
					this.statsFetching = false;
				});
		}, 250);
	}

	// ------------------------------------------------------------------
	// Editor context helpers
	// ------------------------------------------------------------------

	/** Lightweight directory listing for @-folder mentions. Pruned, capped, fuzzy. */
}

Object.assign(SessionController.prototype, historyCatalogMethods, daemonAttachMethods, compactMethods, workspaceMethods);
