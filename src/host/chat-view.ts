/** Sessions own controllers; editor panels and the native sidebar are replaceable views. */
import { unlink } from "node:fs/promises";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isSessionActive } from "../session/session-actions.js";
import { randomBytes } from "node:crypto";
import { loginPrimeAgent, logoutPrimeAgent } from "../runtime/prime-auth.js";
import { applyPrimeCodexReset, queryPrimeQuota } from "../runtime/prime-quota.js";
import { completedMessageTime } from "../session/session-completion.js";
import * as vscode from "vscode";
import type { ChatReadReceipt, ChatViewState, HostToWebview, RecentSession, WebviewToHost } from "../shared/protocol.js";
import { SessionController } from "../session/session-controller.js";
import { locateAgent, type LocatedAgent } from "../runtime/agent-locator.js";
import { normalizeFsPath } from "../session/recent-sessions.js";
export { parseWebviewMessage } from "../shared/webview-message.js";
import { parseWebviewMessage } from "../shared/webview-message.js";

declare const BRIEF_BUILD_REV: string | undefined;
const WEBVIEW_REV = typeof BRIEF_BUILD_REV === "string" ? BRIEF_BUILD_REV : "dev";

type SessionReference = { sessionId: string; sessionFile: string; isNew?: boolean };

type ChatLocation = "editor" | "sidebar";
type ChatTab = {
	controller: SessionController;
	session?: SessionReference;
	title: string;
	entry?: RecentSession;
	view?: ChatView;
	state?: ChatViewState;
	stateSessionId?: string;
	initialized?: Promise<void>;
	startupError?: Error;
	attachment: vscode.Disposable;
	closed: boolean;
};
type ChatView = {
	panel?: vscode.WebviewPanel;
	sidebar?: vscode.WebviewView;
	webview: vscode.Webview;
	tab?: ChatTab;
	ready: Promise<void>;
	loading?: Promise<void>;
	closed: boolean;
	missedMessages: boolean;
	readReceipt?: ChatReadReceipt;
	readRevision?: number;
	openingReadCutoff?: number;
	markReady: () => void;
	transferring: boolean;
	disposeBinding: () => void;
	pending: Map<string, { sessionId: string; resolve: (message: WebviewToHost) => void; reject: (error: Error) => void }>;
};

export class ChatPanels implements vscode.Disposable, vscode.WebviewPanelSerializer, vscode.WebviewViewProvider {
	static readonly viewType = "brief.chatPanel";
	private readonly tabs = new Set<ChatTab>();
	private focusedTab: ChatTab | undefined;
	private composerFocusedView: ChatView | undefined;
	private selectionEpoch = 0;
	private get lastActive(): ChatTab | undefined { return this.focusedTab; }
	private set lastActive(tab: ChatTab | undefined) {
		if (this.focusedTab !== tab) this.selectionEpoch++;
		this.focusedTab = tab;
		this.syncHistorySelection();
	}

	private syncHistorySelection(): void {
		if (this.sidebar && !this.sidebar.tab && !this.sidebar.closed) {
			void this.sidebar.webview.postMessage({ type: "historySelection", sessionId: this.lastActive?.session?.sessionId });
		}
	}
	private sidebar: ChatView | undefined;
	private sidebarSession: ChatTab | undefined;
	private historyController: SessionController | undefined;
	private historyAttachment: vscode.Disposable | undefined;
	private sidebarResolved: (() => void) | undefined;
	private operations: Promise<unknown> = Promise.resolve();
	private movingView: ChatView | undefined;
	private disposed = false;
	private readonly loginAbort = new AbortController();
	private historyRows: RecentSession[] = [];

	private historyMessage(): HostToWebview {
		const entries = [...this.tabs].flatMap((tab) => tab.entry ? [tab.entry] : []);
		const rows = new Map(this.historyRows.map((row) => [normalizeFsPath(row.path), row]));
		for (const entry of entries) {
			const key = normalizeFsPath(entry.path);
			const saved = rows.get(key);
			rows.set(key, saved ? { ...saved, isNew: entry.isNew } : entry);
		}
		return { type: "history", sessions: [...rows.values()] };
	}

	private markTabSubmitted(tab: ChatTab): void {
		if (!tab.entry) return;
		tab.entry.isNew = false;
		this.paintTabHistory();
	}

	private paintTabHistory(): void {
		const message = this.historyMessage();
		if (this.sidebar && !this.sidebar.tab && !this.sidebar.closed) void this.sidebar.webview.postMessage(message);
		for (const tab of this.tabs) {
			if (tab.view && !tab.view.closed) void tab.view.webview.postMessage(message);
		}
	}


	private readonly windowFocus: vscode.Disposable;
	private readonly configuration: vscode.Disposable;

	constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
		this.configuration = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("brief.fontSize") || event.affectsConfiguration("brief.markdownTheme") || event.affectsConfiguration("brief.primeTheme")) this.broadcastUiSettings();
		});
		this.windowFocus = vscode.window.onDidChangeWindowState((state) => {
			if (!state.focused) { this.setComposerFocus(undefined); return; }
			for (const tab of this.tabs) {
				if (tab.view) this.requestReadReceipt(tab.view);
			}
		});
	}

	private locatedAgent: Promise<LocatedAgent> | undefined;
	private resolveAgent(): Promise<LocatedAgent> {
		if (!this.locatedAgent) { const command = vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent"); this.locatedAgent = locateAgent(command.trim() || "prime-agent", line => this.output.appendLine(line)); }
		return this.locatedAgent;
	}
	private async uiSettings(): Promise<HostToWebview> {
		const config = vscode.workspace.getConfiguration("brief");
		const markdownTheme = config.get<"vscode-vanilla" | "vscode" | "prime-current" | "prime">("markdownTheme", "vscode-vanilla");
		const message: HostToWebview = { type: "uiSettings", fontSize: config.get<number>("fontSize", 13), markdownTheme };
		if (markdownTheme === "prime" || markdownTheme === "prime-current") message.markdownColors = await this.primeMarkdownColors(markdownTheme === "prime-current" ? undefined : config.get<string>("primeTheme", ""));
		return message;
	}
	private async primeMarkdownColors(themeRef?: string): Promise<Record<string, string>> {
		const agentDir = process.env.PRIME_AGENT_DIR?.trim().replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".prime", "agent"); let selected = themeRef;
		if (!selected) for (const file of [join(agentDir, "settings.json"), join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", ".prime", "agent", "settings.json")]) { try { const value = JSON.parse(readFileSync(file, "utf8")); if (typeof value.theme === "string") selected = value.theme; } catch { } }
		selected ||= "dark"; const candidates = [selected, join(agentDir, "themes", `${selected}.json`), join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", ".prime", "agent", "themes", `${selected}.json`)];
		for (const [directory] of await this.primeThemeDirectories()) candidates.push(join(directory, `${selected}.json`)); let raw: any;
		for (const candidate of candidates) { try { raw = JSON.parse(readFileSync(candidate.startsWith("/") ? candidate : resolve(candidate), "utf8")); break; } catch { } } if (!raw?.colors) return {};
		const vars = raw.vars ?? {}; const color = (value: unknown): string => { if (typeof value === "number") { const ansi16 = [[0,0,0],[128,0,0],[0,128,0],[128,128,0],[0,0,128],[128,0,128],[0,128,128],[192,192,192],[128,128,128],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]]; const rgb = value < 16 ? ansi16[value] : value < 232 ? (() => { const n = value - 16; return [n / 36, n / 6, n].map(v => [0,95,135,175,215,255][Math.floor(v) % 6]); })() : [8 + (value - 232) * 10, 8 + (value - 232) * 10, 8 + (value - 232) * 10]; return `rgb(${rgb.join(",")})`; } if (typeof value !== "string") return "inherit"; return value.startsWith("#") ? value : color(vars[value]); };
		return Object.fromEntries(["mdHeading","mdLink","mdLinkUrl","mdCode","mdCodeBlock","mdCodeBlockBorder","mdQuote","mdQuoteBorder","mdHr","mdListBullet"].map(key => [key, color(raw.colors[key])]));
	}
	private async primeThemeDirectories(): Promise<Array<[string, string]>> {
		const agentDir = process.env.PRIME_AGENT_DIR?.trim().replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".prime", "agent"); const directories: Array<[string, string]> = [[join(agentDir, "themes"), "User theme"]]; const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (workspace) directories.push([join(workspace, ".prime", "agent", "themes"), "Project theme"]);
		let directory = dirname(realpathSync((await this.resolveAgent()).command)); for (;;) { const theme = join(directory, "modes", "interactive", "theme"); try { readdirSync(theme); directories.push([theme, "Built-in theme"]); break; } catch { } const parent = dirname(directory); if (parent === directory) break; directory = parent; } return directories;
	}

	broadcastUiSettings(): void {
		void this.uiSettings().then(message => {
			if (this.sidebar && !this.sidebar.closed) void this.sidebar.webview.postMessage(message);
			for (const tab of this.tabs) if (tab.view && !tab.view.closed) void tab.view.webview.postMessage(message);
		});
	}

	async adjustFontSize(delta: number): Promise<void> {
		const config = vscode.workspace.getConfiguration("brief");
		const current = config.get<number>("fontSize", 13);
		await config.update("fontSize", current + delta, vscode.ConfigurationTarget.Global);
	}

	async selectPrimeTheme(): Promise<void> {
		const config = vscode.workspace.getConfiguration("brief");
		type ThemeChoice = vscode.QuickPickItem & { value: "vscode-vanilla" | "vscode" | "prime-current" | "prime"; theme?: string };
		const items: ThemeChoice[] = [
			{ label: "$(symbol-color) VS Code Vanilla", description: "Use the original inherited Markdown styling", value: "vscode-vanilla" },
			{ label: "$(symbol-color) VS Code", description: "Use the current VS Code color theme", value: "vscode" },
			{ label: "$(paintcan) Prime current theme", description: "Follow the theme in Prime Agent settings", value: "prime-current" },
		];
		for (const theme of await this.primeThemeChoices()) items.push({
			label: `$(paintcan) ${theme.name}`,
			description: theme.source,
			detail: theme.path,
			value: "prime",
			theme: theme.name,
		});
		const choice = await vscode.window.showQuickPick(items, { placeHolder: "Select a Markdown color theme" });
		if (!choice) return;
		if (choice.value === "prime" && choice.theme) await config.update("primeTheme", choice.theme, vscode.ConfigurationTarget.Global);
		await config.update("markdownTheme", choice.value, vscode.ConfigurationTarget.Global);
	}

	private async primeThemeChoices(): Promise<Array<{ name: string; path: string; source: string }>> { const choices: Array<{ name: string; path: string; source: string }> = []; const seen = new Set<string>(); for (const [directory, source] of await this.primeThemeDirectories()) { let files: string[]; try { files = readdirSync(directory); } catch { continue; } for (const file of files.filter(entry => entry.endsWith(".json") && entry !== "theme-schema.json").sort()) { const name = file.slice(0, -5); if (!seen.has(name)) { seen.add(name); choices.push({ name, path: join(directory, file), source }); } } } return choices; }

	private requestReadReceipt(view: ChatView): void {
		if (view.readReceipt && !view.closed && !view.transferring && vscode.window.state.focused &&
			(view.panel ? view.panel.visible && view.panel.active : view.sidebar?.visible)) {
			void view.webview.postMessage({ type: "requestReadReceipt" });
		}
	}

	private location(): ChatLocation {
		return vscode.workspace.getConfiguration("brief").get<ChatLocation>("chatLocation", "editor");
	}

	/**
	 * Queue depth for the webview. `enqueue` serializes every action, so a click
	 * admitted behind a slow head (a session switch can hold the queue for a
	 * minute) looks like a dead control. `waiting` counts actions admitted but not
	 * started; one of them is free to run as soon as the queue is empty, so only
	 * the ones behind a running action are reported as pending.
	 */
	private waitingOperations = 0;
	private runningOperations = 0;
	private operationsBusy = false;

	private pendingOperationCount(): number {
		return this.runningOperations > 0 ? this.waitingOperations : Math.max(0, this.waitingOperations - 1);
	}

	private publishViewBusy(): void {
		const pending = this.pendingOperationCount();
		// Publish the wait appearing and ending only: per-keystroke `draftChanged`
		// traffic must not repaint every open view.
		if ((pending > 0) === this.operationsBusy) return;
		this.operationsBusy = pending > 0;
		const message: HostToWebview = { type: "viewBusy", pending };
		if (this.sidebar && !this.sidebar.tab && !this.sidebar.closed) void this.sidebar.webview.postMessage(message);
		for (const tab of this.tabs) {
			if (tab.view && !tab.view.closed) void tab.view.webview.postMessage(message);
		}
	}

	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		this.waitingOperations++;
		this.publishViewBusy();
		const result = this.operations.then(() => {
			this.waitingOperations--;
			if (this.disposed) { this.publishViewBusy(); throw new Error("Chat is closed."); }
			this.runningOperations++;
			this.publishViewBusy();
			return Promise.resolve().then(action).finally(() => {
				this.runningOperations--;
				this.publishViewBusy();
			});
		});
		this.operations = result.catch(() => {});
		return result;
	}

	async newSession(): Promise<void> {
		const tab = await this.enqueue(async () => {
			const tab = this.create();
			await this.move(tab, this.location());
			return tab;
		});
		// Runtime startup belongs to this tab, not the shared view-mutation queue.
		await tab.view?.loading;
	}

	private async newComposerSession(source: ChatTab): Promise<void> {
		await this.enqueue(async () => {
			if (source.closed) return;
			const controller = new SessionController(this.context, this.output);
			let tab: ChatTab | undefined;
			try {
				await controller.initializeBlankFrom(source.controller);
				if (source.closed || this.disposed) throw new Error("Chat is closed.");
				tab = this.create(undefined, controller);
				tab.initialized = Promise.resolve();
				await this.move(tab, "editor");
			} catch (error) {
				if (tab) { tab.view?.panel?.dispose(); if (!tab.closed) this.close(tab); }
				else controller.dispose();
				if (!source.closed) { this.lastActive = source; if (source.view) await this.reveal(source.view); }
				throw error;
			}
		});
	}

	private async newForkSession(source: ChatTab, ordinal?: number): Promise<void> {
		const epoch = this.selectionEpoch;
		const sourceEpoch = source.controller.viewEpoch;
		const sourceAttachment = source.controller.attached;
		const current = () => !this.disposed && !source.closed && epoch === this.selectionEpoch
			&& sourceEpoch === source.controller.viewEpoch && sourceAttachment === source.controller.attached;
		const fork = await source.controller.forkFromUser(ordinal, current);
		if (!fork) return;
		const cleanupFile = async () => {
			// A failed attach can leave a resident worker. Never unlink a leased file.
			if (await isSessionActive(fork.sessionFile)) {
				this.output.appendLine(`Unused fork is still active; retained ${fork.sessionFile}`);
				return;
			}
			await unlink(fork.sessionFile).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		};
		await this.enqueue(async () => {
			if (!current()) { await cleanupFile(); return; }
			const controller = new SessionController(this.context, this.output);
			let tab: ChatTab | undefined;
			let draftKey: string | undefined;
			try {
				await controller.switchSession(fork.sessionFile, fork.sessionId);
				if (!current()) throw new Error("The source session changed before the fork opened.");
				if (!controller.attached || controller.observingId) throw new Error("Could not attach to the forked session.");
				draftKey = controller.draftKey();
				await this.context.globalState.update(draftKey, fork.text);
				if (!current()) throw new Error("The source session changed before the fork opened.");
				tab = this.create(undefined, controller);
				tab.initialized = Promise.resolve();
				await this.move(tab, "editor");
			} catch (error) {
				const unused = controller.attached ?? controller.attachAttempt;
				if (unused) {
					await controller.sidecar?.request({ type: "kill", activeSessionId: unused.activeSessionId }, 30_000).catch(cleanupError => {
						this.output.appendLine(`Could not stop unused fork: ${String(cleanupError)}`);
					});
				}
				if (draftKey) await Promise.resolve(this.context.globalState.update(draftKey, undefined)).catch(cleanupError => this.output.appendLine(`Could not clear unused fork draft: ${String(cleanupError)}`));
				await cleanupFile().catch(cleanupError => this.output.appendLine(`Could not remove unused fork file: ${String(cleanupError)}`));
				if (tab) { tab.view?.panel?.dispose(); if (!tab.closed) this.close(tab); }
				else controller.dispose();
				// Navigation is cancellation, not a failure; never pull focus back.
				if (!current()) return;
				if (!source.closed) { this.lastActive = source; if (source.view) await this.reveal(source.view); }
				throw error;
			}
		});
	}

	async focus(): Promise<void> {
		const selected = this.lastActive;
		const tab = await this.enqueue(async () => {
			const tab = selected && !selected.closed ? selected : this.create();
			await this.move(tab, this.location());
			return tab;
		});
		await this.initialize(tab);
		if (tab.view && !tab.closed && this.lastActive === tab) await tab.view.webview.postMessage({ type: "focusComposer" });
	}

	async useLocation(location: ChatLocation): Promise<void> {
		const selected = this.lastActive;
		await this.enqueue(async () => {
			await this.move(selected && !selected.closed ? selected : this.create(), location);
			await vscode.workspace.getConfiguration("brief").update("chatLocation", location, vscode.ConfigurationTarget.Workspace);
		});
	}

	async toggleLocation(): Promise<void> {
		const current = this.lastActive?.view;
		await this.useLocation((current ? current.panel ? "editor" : "sidebar" : this.location()) === "editor" ? "sidebar" : "editor");
	}

	async switchSidebarSession(): Promise<void> {
		const items = [...this.tabs].filter((tab) => !tab.closed).map((tab) => ({ label: tab.title, description: tab.session?.sessionId, tab }));
		const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a session for Brief sidebar" });
		if (picked) await this.enqueue(async () => { if (!picked.tab.closed) await this.move(picked.tab, "sidebar"); });
	}

	private setComposerFocus(view: ChatView | undefined): void {
		this.composerFocusedView = view;
		void vscode.commands.executeCommand("setContext", "brief.composerFocus", Boolean(view));
	}

	async stashOrRestoreDraft(): Promise<void> {
		const view = this.composerFocusedView;
		if (!view || this.disposed || view.closed || view.transferring || !view.tab || view.tab.closed ||
			view.tab.view !== view || !vscode.window.state.focused ||
			!(view.panel ? view.panel.visible && view.panel.active : view.sidebar?.visible)) return;
		await view.webview.postMessage({ type: "stashOrRestoreDraft" });
	}

	async run(action: (controller: SessionController) => Promise<void> | void, reveal = false): Promise<void> {
		const selected = this.lastActive;
		const target = await this.enqueue(async () => {
			const target = selected && !selected.closed ? selected : this.create();
			if (!target.view) await this.move(target, this.location());
			else if (reveal) await this.reveal(target.view);
			return target;
		});
		await this.initialize(target);
		if (!target.closed) await action(target.controller);
	}

	async promptRenameSession(controller: SessionController): Promise<void> {
		const epoch = this.selectionEpoch;
		await controller.promptRenameSession(() => !this.disposed && epoch === this.selectionEpoch);
	}

	async openSidebarHistory(): Promise<void> {
		await this.enqueue(async () => {
			const view = await this.sidebarView();
			await this.wait(view.ready);
			// A bound sidebar keeps its chat and draft underneath the existing History overlay.
			if (view.tab) view.tab.controller.showHistoryView();
			else await this.showSidebarHistory(view);
		});
	}

	private async openSession(source: SessionController, sessionFile: string, sessionId: string): Promise<void> {
		const draft = [...this.tabs].find((tab) => tab.entry?.isNew && !tab.session && tab.entry.id === sessionId && tab.entry.path === sessionFile);
		if (draft) {
			await this.enqueue(async () => {
				if (draft.closed) return;
				if (draft.view) { this.lastActive = draft; await this.reveal(draft.view); }
				else await this.move(draft, this.location());
			});
			return;
		}
		const openEntry = [...this.tabs].find((tab) => tab.entry?.isNew && tab.session?.sessionId === sessionId && tab.session.sessionFile === sessionFile)?.entry;
		const session = openEntry ?? await source.resolveHistorySession(sessionFile, sessionId);
		if (!session || source.disposed) return;
		await this.enqueue(async () => {
			if (source.disposed) return;
			const existing = [...this.tabs].find((tab) => tab.session?.sessionId === session.id ||
				(tab.session && normalizeFsPath(tab.session.sessionFile) === normalizeFsPath(session.path)));
			if (existing?.view) {
				existing.view.openingReadCutoff = existing.controller.historyCompletedAt.get(normalizeFsPath(session.path)) ?? 0;
				this.lastActive = existing;
				await this.reveal(existing.view);
				await this.initialize(existing);
				await existing.controller.refreshSnapshot({ keepDraft: true });
				await existing.view.webview.postMessage({ type: "focusComposer" });
			} else await this.move(existing ?? this.create({ sessionId: session.id, sessionFile: session.path }), this.location());
		});
	}

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
		const session = (state as { session?: Partial<SessionReference> } | null)?.session;
		if (!session || typeof session.sessionId !== "string" || !session.sessionId ||
			typeof session.sessionFile !== "string" || !session.sessionFile || this.disposed ||
			[...this.tabs].some((tab) => tab.session?.sessionId === session.sessionId)) {
			panel.dispose(); return;
		}
		const previous = this.lastActive;
		const tab = this.create({ sessionId: session.sessionId, sessionFile: session.sessionFile, isNew: session.isNew === true });
		this.bind(tab, this.makeView(panel));
		if (!panel.active && previous) this.lastActive = previous;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		if (this.disposed) return;
		this.sidebar?.disposeBinding();
		this.sidebar = this.makeView(undefined, view);
		if (this.sidebarResolved) this.sidebarResolved();
		else {
			// Opening the native view directly also has a usable session.
			void this.enqueue(async () => {
				if (this.sidebar && !this.sidebar.tab && this.location() === "sidebar") await this.move(this.sidebarSession ?? this.create(), "sidebar");
			}).catch((error) => this.output.appendLine(String(error)));
		}
	}

	private history(): SessionController {
		if (!this.historyController) {
			this.historyController = new SessionController(this.context, this.output);
			this.historyAttachment = this.historyController.attach({ post: (message) => {
				if (message.type === "history") { this.historyRows = message.sessions; message = this.historyMessage(); }
				if (this.sidebar && !this.sidebar.tab && !this.sidebar.closed) void this.sidebar.webview.postMessage(message);
			} });
		}
		return this.historyController;
	}

	private async showSidebarHistory(view: ChatView): Promise<void> {
		await view.webview.postMessage({ type: "setHistoryMode", enabled: true });
		await this.history().listHistory();
		this.syncHistorySelection();
	}

	private create(session?: SessionReference, controller = new SessionController(this.context, this.output)): ChatTab {
		const tab: ChatTab = { controller, session, title: "New Session", closed: false, attachment: { dispose() {} } };
		if (!session || session.isNew) {
			const id = session?.sessionId ?? `new-${getNonce()}`;
			tab.entry = { id, path: session?.sessionFile ?? id, cwd: controller.workspaceRoot, timestamp: new Date().toISOString(), inWorkspace: true, isNew: true, status: "idle" };
		}
		this.tabs.add(tab);
		this.paintTabHistory();
		this.lastActive = tab;
		tab.attachment = controller.attach({ post: (message) => {
			if (tab.closed || tab.startupError) return;
			if (message.type === "promptAccepted" || (message.type === "snapshot" && message.messages.some(item => item.role === "user"))) this.markTabSubmitted(tab);
			if (message.type === "history") { this.historyRows = message.sessions; message = this.historyMessage(); }
			if (message.type === "snapshot" || message.type === "status") {
				message = { ...message, status: { ...message.status, isNewSession: tab.entry?.isNew === true } };
				const status = message.status;
				if (tab.view && tab.session && status.sessionId && status.sessionId !== tab.session.sessionId) {
					tab.view.readReceipt = undefined;
					tab.view.openingReadCutoff = undefined;
				}
				if (status.sessionId && status.sessionFile) tab.session = { sessionId: status.sessionId, sessionFile: status.sessionFile };
				const label = (status.sessionLabel ?? status.sessionName)?.trim() || (status.sessionId ? `Session ${status.sessionId.slice(0, 8)}` : "New Session");
				if (tab.entry) {
					const previousEntry = JSON.stringify(tab.entry);
					if (tab.session) { tab.entry.id = tab.session.sessionId; tab.entry.path = tab.session.sessionFile; }
					tab.entry.name = status.sessionLabel ?? status.sessionName;
					// Until the catalog contains this session, use the same runtime
					// verdict as the chat lamp. Submission alone is not execution.
					const running = status.historyRunning !== undefined
						? status.historyRunning === true
						: status.connected && (status.streaming || status.compacting || status.retrying);
					tab.entry.running = !!running;
					tab.entry.status = status.historyRunning === null ? undefined : running ? "running" : status.connected ? "idle" : "inactive";
					tab.entry.unreadComplete = status.unreadComplete;
					// Token statuses must not rebuild history buttons between pointerdown
					// and click. Only publish when the row itself changed.
					if (JSON.stringify(tab.entry) !== previousEntry) this.paintTabHistory();
				}
				tab.title = label;
				this.updateTitle(tab);
				if (this.lastActive === tab) this.syncHistorySelection();
			}
			if (message.type === "history") {
				this.paintTabHistory();
				return;
			}
			const view = tab.view;
			if (view && tab.session && ((message.type === "snapshot" && message.status.sessionId === tab.session.sessionId && !message.status.restoring) || (message.type === "event" && message.event.type === "agent_end"))) {
				const messages = message.type === "snapshot" ? message.messages : message.event.type === "agent_end" ? message.event.messages : [];
				view.readReceipt = {
					sessionId: tab.session.sessionId, path: tab.session.sessionFile,
					completedAt: Math.max(completedMessageTime(messages ?? []), message.type === "snapshot" ? view.openingReadCutoff ?? 0 : 0), revision: view.readRevision = (view.readRevision ?? 0) + 1,
				};
				message = { ...message, readReceipt: view.readReceipt };
			}
			if (view && !view.closed) void view.webview.postMessage(message).then(
				(delivered) => { if (!delivered) view.missedMessages = true; }, () => { view.missedMessages = true; });
		} });
		return tab;
	}

	private updateTitle(tab: ChatTab): void {
		const characters = Array.from(tab.title);
		if (tab.view?.panel) tab.view.panel.title = characters.length > 16 ? `${characters.slice(0, 15).join("")}…` : tab.title;
		if (tab.view?.sidebar) tab.view.sidebar.title = "Brief";
	}

	private bind(tab: ChatTab, view: ChatView): void {
		tab.view = view;
		view.tab = tab;
		view.openingReadCutoff = tab.session ? tab.controller.historyCompletedAt.get(normalizeFsPath(tab.session.sessionFile)) ?? 0 : 0;
		if (view.sidebar) this.sidebarSession = tab;
		else if (this.sidebarSession === tab) this.sidebarSession = undefined;
		this.lastActive = tab;
		this.updateTitle(tab);
	}

	private async initialize(tab: ChatTab): Promise<void> {
		if (tab.startupError) throw tab.startupError;
		const view = tab.view;
		if (!view) throw new Error("Session has no view.");
		await this.wait(view.ready);
		if (view.closed || tab.closed) throw new Error("Chat view was closed.");
		await (tab.initialized ??= tab.session
			? tab.controller.switchSession(tab.session.sessionFile, tab.session.sessionId, tab.session.isNew === true)
			: tab.controller.ensureStarted());
		if (tab.startupError) throw tab.startupError;
	}

	/** Bound a fresh tab's initial runtime and snapshot without locking view mutations. */
	private loadFreshView(tab: ChatTab, view: ChatView): Promise<void> {
		const id = getNonce();
		const started = Date.now();
		const log = (phase: string) => this.output.appendLine(`[startup] ${new Date().toISOString()} id=${id} phase=${phase} elapsedMs=${Date.now() - started}`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		log("bound");
		const work = (async () => {
			await this.initialize(tab);
			if (tab.closed || tab.startupError || tab.view !== view || view.closed) return;
			log("initialized");
			await tab.controller.refreshSnapshot({ keepDraft: tab.entry?.isNew === true });
			if (!tab.closed && !tab.startupError) log("snapshot");
		})();
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				// A create request may already have succeeded remotely. Never retry it.
				tab.startupError = new Error("Brief startup timed out after 120s. Check Session History before opening another session.");
				tab.attachment.dispose();
				tab.controller.dispose();
				log("timeout");
				if (!view.closed && tab.view === view) void view.webview.postMessage({ type: "notice", level: "error", text: tab.startupError.message });
				reject(tab.startupError);
			}, 120_000);
		});
		const loading = Promise.race([work, deadline]).finally(() => clearTimeout(timer));
		void loading.then(async () => {
			if (tab.closed || tab.startupError || tab.view !== view || view.closed) return;
			await Promise.all([tab.controller.listModels(), tab.controller.listCommands()]);
			tab.controller.sendFavorites();
		}).catch((error) => {
			if (!tab.closed && !tab.startupError) tab.controller.showErrorNotice(`Operation failed: ${String(error)}`);
		});
		return loading;
	}

	private makeView(panel?: vscode.WebviewPanel, sidebar?: vscode.WebviewView): ChatView {
		const webview = (panel ?? sidebar!).webview;
		if (panel) panel.iconPath = {
			light: vscode.Uri.joinPath(this.context.extensionUri, "media", "tab-light.svg"),
			dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "tab-dark.svg"),
		};
		if (sidebar) sidebar.title = "Brief";
		webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
		let ready!: () => void;
		const view: ChatView = { panel, sidebar, webview, closed: false, missedMessages: false, pending: new Map(), markReady: () => ready(), transferring: false, disposeBinding: () => {}, ready: new Promise((resolve) => { ready = resolve; }) };
		const receiver = webview.onDidReceiveMessage((raw: unknown) => {
			const message = parseWebviewMessage(raw);
			if (!message) { view.tab?.controller.showErrorNotice("Ignored an invalid webview message."); return; }
			if (message.type === "composerFocusChanged") {
				if (message.focused && !view.closed && !view.transferring && view.tab && !view.tab.closed &&
					view.tab.view === view && vscode.window.state.focused &&
					(view.panel ? view.panel.visible && view.panel.active : view.sidebar?.visible)) {
					this.lastActive = view.tab;
					this.setComposerFocus(view);
				} else if (this.composerFocusedView === view) this.setComposerFocus(undefined);
				return;
			}
			if (message.type === "viewStateCaptured" || message.type === "viewStateRestored" || message.type === "viewStateFailed") {
				const pending = view.pending.get(message.requestId);
				if (pending && pending.sessionId === message.sessionId) {
					if (message.type === "viewStateFailed") pending.reject(new Error(message.error)); else pending.resolve(message);
				}
				return;
			}
			// Login must work even when the agent cannot start without credentials.
			if (message.type === "login") {
				if (view.closed || view.transferring || view.tab?.closed) return;
				const tab = view.tab;
				void (async () => {
					try {
						const saved = await loginPrimeAgent({
							command: vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent"),
							cwd: tab?.controller.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir(),
							helperPath: vscode.Uri.joinPath(this.context.extensionUri, "dist", "prime-auth-helper.mjs").fsPath,
							signal: this.loginAbort.signal,
						});
						// Prime reloads shared credentials when listing available models.
						if (saved && !this.disposed && tab && !tab.closed) await tab.controller.listModels();
					} catch {
						if (!this.disposed) void vscode.window.showErrorMessage("Could not complete Prime Agent login. Please retry.");
					}
				})();
				return;
			}
			if (message.type === "logout") {
				if (view.closed || view.transferring || view.tab?.closed) return;
				void (async () => {
					let removed: boolean;
					try {
						removed = await logoutPrimeAgent({
							command: vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent"),
							cwd: view.tab?.controller.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir(),
							helperPath: vscode.Uri.joinPath(this.context.extensionUri, "dist", "prime-auth-helper.mjs").fsPath,
							signal: this.loginAbort.signal,
						});
					} catch {
						if (!this.disposed) void vscode.window.showErrorMessage("Could not remove the saved Prime Agent credential. Please retry.");
						return;
					}
					if (!removed || this.disposed || view.closed || view.transferring) return;
					// Use this view's current tab, not the tab selected when the picker opened.
					const tab = view.tab;
					if (!tab || tab.closed) return;
					try {
						if (await tab.controller.listModels({ startAgent: false })) return;
					} catch { /* Never display runtime errors that may contain credentials. */ }
					if (!this.disposed) void vscode.window.showErrorMessage("The saved credential was removed, but the model list could not be refreshed. No agent was started or restarted.");
				})();
				return;
			}
			if (message.type === "openSidebarHistory") {
				if (!view.closed && !view.transferring) void this.openSidebarHistory().catch((error) => {
					(view.tab?.controller ?? this.history()).showErrorNotice(`Could not open Session History: ${String(error)}`);
				});
				return;
			}
			if (message.type === "applyCodexReset") {
				const target = view.tab;
				void applyPrimeCodexReset({
					command: vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent"),
					cwd: target?.controller.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir(),
					helperPath: vscode.Uri.joinPath(this.context.extensionUri, "dist", "prime-quota-helper.mjs").fsPath,
					signal: this.loginAbort.signal,
				}).then((result) => {
					if (!view.closed && !view.transferring && view.tab === target) {
						void view.webview.postMessage({ type: "codexResetResult", requestId: message.requestId, result });
					}
				});
				return;
			}
			if (message.type === "queryQuota") {
				const target = view.tab;
				const reply = (response: HostToWebview): void => {
					if (!view.closed && !view.transferring && view.tab === target) void view.webview.postMessage(response);
				};
				void queryPrimeQuota({
					command: vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent"),
					cwd: target?.controller.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir(),
					helperPath: vscode.Uri.joinPath(this.context.extensionUri, "dist", "prime-quota-helper.mjs").fsPath,
					signal: this.loginAbort.signal,
				}).then((snapshot) => reply({ type: "quota", requestId: message.requestId, snapshot }),
					() => reply({ type: "quota", requestId: message.requestId, error: "Could not query quota. Check brief.command, Node.js, and your existing login." }));
				return;
			}
			// Read-only queries must not initialize a tab or start a worker.
			if (message.type === "queryStatistics") {
				if (view.closed || view.transferring || view.tab?.closed) return;
				const target = view.tab;
				const reply = (response: HostToWebview) => {
					if (!view.closed && !view.transferring && view.tab === target) void view.webview.postMessage(response);
				};
				if (!target) reply({ type: "statistics", kind: message.kind, requestId: message.requestId, error: "No available session connection." });
				else void handleMessage(message, target.controller, reply);
				return;
			}
			if (message.type === "ready") { view.markReady(); void this.uiSettings().then(message => view.webview.postMessage(message)); }
			const tab = view.tab;
			if (view.sidebar && !tab && !view.closed && !view.transferring) {
				void (async () => {
					if (message.type === "ready") { if (!this.sidebarResolved && this.location() === "editor") await this.showSidebarHistory(view); return; }
					if (message.type === "newSession") { await this.newSession(); return; }
					if (message.type === "switchSession") { await this.openSession(this.history(), message.path, message.sessionId); return; }
					if (["requestHistory", "searchHistory", "renameHistorySession", "stopSession", "archiveSession", "unarchiveSession", "deleteSession"].includes(message.type)) {
						await handleMessage(message, this.history(), (reply) => { void view.webview.postMessage(reply); });
					}
				})().catch((error) => this.history().showErrorNotice(String(error)));
				return;
			}
			if (!tab || view.closed || tab.closed) return;
			if (message.type === "chatRendered") {
				const receipt = view.readReceipt;
				if (!view.transferring && tab.view === view && vscode.window.state.focused &&
					(view.panel ? view.panel.visible && view.panel.active : view.sidebar?.visible) &&
					receipt && receipt.revision === message.receipt.revision && receipt.sessionId === message.receipt.sessionId &&
					receipt.path === message.receipt.path && tab.session?.sessionId === receipt.sessionId) {
					view.readReceipt = undefined;
					view.openingReadCutoff = undefined;
					tab.controller.markHistorySessionOpened(receipt.path, receipt.completedAt);
				}
				return;
			}
			if (message.type === "viewFocused") { this.lastActive = tab; return; }
			if (message.type === "ready") {
				if (view.transferring) return;
				tab.controller.sendCachedModels();
				view.loading = (view.loading ?? Promise.resolve()).catch(() => {}).then(async () => {
					await this.initialize(tab);
					if (!view.closed && !tab.closed && tab.view === view) await tab.controller.refreshSnapshot({ keepDraft: tab.entry?.isNew === true });
				});
				void view.loading.then(async () => {
					if (view.closed || tab.closed || tab.view !== view) return;
					await Promise.all([tab.controller.listModels(), tab.controller.listCommands()]);
					tab.controller.sendFavorites();
				}).catch((error) => tab.controller.showErrorNotice(`Operation failed: ${String(error)}`));
				return;
			}
			void (async () => {
				if (message.type === "newSession") { await this.newSession(); return; }
				await this.initialize(tab);
				if (view.closed || tab.closed || tab.view !== view) return;
				if (message.type === "promptRenameSession") { await this.promptRenameSession(tab.controller); return; }
				if (message.type === "newSessionFromCurrent") { await this.newComposerSession(tab); return; }
				if (message.type === "forkSession" || message.type === "forkFromUser") { await this.newForkSession(tab, message.type === "forkFromUser" ? message.ordinal : undefined); return; }
				if (message.type === "switchSession") { await this.openSession(tab.controller, message.path, message.sessionId); return; }
				await handleMessage(message, tab.controller, (reply) => {
					if (reply.type === "promptAccepted" && tab.entry) {
						if (message.type === "prompt") tab.entry.firstPrompt = message.payload.text;
						this.markTabSubmitted(tab);
					}
					if (!view.closed && tab.view === view) void view.webview.postMessage(reply);
				});
			})().catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				if (message.type === "prompt") void view.webview.postMessage({ type: "promptRejected", clientRequestId: message.payload.clientRequestId, error: detail });
				if (message.type === "createAttachment") void view.webview.postMessage({ type: "attachmentCreated", sessionId: message.sessionId, id: message.attachment.id, error: detail });
				tab.controller.showErrorNotice(`Operation failed: ${detail}`);
			});
		});
		const visibility = panel ? panel.onDidChangeViewState(() => {
			if ((!panel.active || !panel.visible) && this.composerFocusedView === view) this.setComposerFocus(undefined);
			if (panel.active && view.tab) this.lastActive = view.tab;
			this.refreshVisible(view);
			this.requestReadReceipt(view);
		}) : sidebar!.onDidChangeVisibility(() => {
			if (!sidebar!.visible && this.composerFocusedView === view) this.setComposerFocus(undefined);
			this.refreshVisible(view);
			this.requestReadReceipt(view);
		});
		view.disposeBinding = () => {
			if (view.closed) return;
			if (this.composerFocusedView === view) this.setComposerFocus(undefined);
			view.closed = true; view.markReady(); receiver.dispose(); visibility.dispose();
			for (const pending of view.pending.values()) pending.reject(new Error("Chat view was closed."));
			view.pending.clear();
			const tab = view.tab;
			if (tab?.view === view) {
				tab.view = undefined;
				if (panel && (!view.transferring || this.movingView !== view)) this.close(tab);
			}
			if (this.sidebar === view) this.sidebar = undefined;
			disposal.dispose();
		};
		const disposal = (panel ?? sidebar!).onDidDispose(() => view.disposeBinding());
		webview.html = buildHtml(webview, this.context.extensionUri, this.context.globalState.get("brief.availableModels", []));
		return view;
	}

	private refreshVisible(view: ChatView): void {
		const tab = view.tab;
		if (view.transferring || !(view.panel ?? view.sidebar)?.visible || !tab?.initialized || !view.missedMessages) return;
		view.missedMessages = false;
		view.loading = (view.loading ?? tab.initialized).then(async () => {
			if (tab.view === view && !view.closed) await tab.controller.refreshSnapshot({ keepDraft: true });
		});
		void view.loading.catch((error) => tab.controller.showErrorNotice(`Could not refresh session: ${String(error)}`));
	}

	private async reveal(view: ChatView): Promise<void> {
		if (view.panel) view.panel.reveal(undefined, false);
		else { view.sidebar?.show(false); await vscode.commands.executeCommand("brief.chat.focus"); }
	}

	private async sidebarView(): Promise<ChatView> {
		if (!this.sidebar) {
			const resolved = new Promise<void>((resolve) => { this.sidebarResolved = resolve; });
			try { await vscode.commands.executeCommand("brief.chat.focus"); await this.wait(resolved); }
			finally { this.sidebarResolved = undefined; }
		}
		if (!this.sidebar || this.sidebar.closed) throw new Error("Brief sidebar is unavailable.");
		await this.reveal(this.sidebar);
		return this.sidebar;
	}

	private async move(tab: ChatTab, location: ChatLocation): Promise<void> {
		if (tab.closed) return;
		const source = tab.view;
		if (source && (source.panel ? "editor" : "sidebar") === location) {
			this.lastActive = tab; await this.reveal(source); return;
		}
		let target: ChatView | undefined;
		let displaced: ChatTab | undefined;
		let switched = false;
		const captures: { view: ChatView; tab: ChatTab; requestId: string; sessionId: string }[] = [];
		if (source) source.transferring = true;
		try {
			target = location === "sidebar" ? await this.sidebarView() : this.makeView(vscode.window.createWebviewPanel(
				ChatPanels.viewType, "New Session", vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] }));
			this.movingView = target;
			target.transferring = true;
			await this.wait(target.ready);
			if (target.closed || tab.closed || (source && source.closed)) throw new Error("Chat view was closed.");
			displaced = target.tab;
			// A fresh view can use cached model choices while its runtime starts.
			// Only freeze input when transferring an existing conversation.
			if ((source || displaced) && !await target.webview.postMessage({ type: "setViewMoving", moving: true })) throw new Error("Could not reach chat view.");
			for (const current of [source, displaced ? target : undefined]) {
				if (!current?.tab) continue;
				if (current.loading) await this.wait(current.loading);
				await this.initialize(current.tab);
				const requestId = getNonce(), sessionId = current.tab.session?.sessionId ?? "";
				captures.push({ view: current, tab: current.tab, requestId, sessionId });
				const response = await this.request(current, { type: "captureViewState", requestId, sessionId });
				if (response.type !== "viewStateCaptured") throw new Error("Invalid view state response.");
				if ((current.tab.session?.sessionId ?? "") !== sessionId) throw new Error("The session changed. Try moving it again.");
				current.tab.state = response.state;
				current.tab.stateSessionId = sessionId;
			}
			if (target.closed || tab.closed || (source && source.closed)) throw new Error("Chat view was closed.");
			switched = true;
			if (displaced) displaced.view = undefined;
			if (source) source.tab = undefined;
			this.bind(tab, target);
			await target.webview.postMessage({ type: "setHistoryMode", enabled: false });
			if (displaced && tab.entry?.isNew === true && !tab.initialized) {
				await target.webview.postMessage({ type: "newThread" });
				await target.webview.postMessage({ type: "setViewMoving", moving: false });
			}
			tab.controller.sendCachedModels();
			if (!source && !displaced && !tab.state) {
				target.loading = this.loadFreshView(tab, target);
				return;
			}
			await this.initialize(tab);
			await tab.controller.refreshSnapshot({ keepDraft: tab.entry?.isNew === true });
			if (tab.state) await this.restore(target, tab, tab.state);
			if (target.closed || tab.closed) throw new Error("Chat view was closed.");
			tab.state = undefined;
			if (source?.panel) source.panel.dispose();
			else if (source) { await this.showSidebarHistory(source); }
			void Promise.all([tab.controller.listModels(), tab.controller.listCommands()]).then(() => tab.controller.sendFavorites())
				.catch((error) => tab.controller.showErrorNotice(String(error)));
		} catch (error) {
			if (target?.tab === tab) { target.tab = undefined; if (tab.view === target) tab.view = undefined; }
			if (source && !source.closed && !tab.closed) {
				this.bind(tab, source);
				if (switched) {
					try { await tab.controller.refreshSnapshot({ keepDraft: true }); if (tab.state) await this.restore(source, tab, tab.state); tab.state = undefined; }
					catch (rollbackError) { this.output.appendLine(`Could not refresh original chat: ${String(rollbackError)}`); }
				} else tab.state = undefined;
			}
			if (switched && displaced && target && !target.closed && !displaced.closed) {
				this.bind(displaced, target);
				try { await displaced.controller.refreshSnapshot(); if (displaced.state) await this.restore(target, displaced, displaced.state); displaced.state = undefined; }
				catch (rollbackError) { this.output.appendLine(`Could not restore sidebar: ${String(rollbackError)}`); }
			}
			if (target?.panel && target !== source) target.panel.dispose();
			if (target?.sidebar && !target.tab && !target.closed) await this.showSidebarHistory(target);
			throw error;
		} finally {
			if (source) source.transferring = false;
			if (target) target.transferring = false;
			if (target && !target.closed) void target.webview.postMessage({ type: "setViewMoving", moving: false });
			this.movingView = undefined;
			for (const capture of captures) if (!capture.view.closed) {
				void capture.view.webview.postMessage({ type: "releaseViewState", requestId: capture.requestId, sessionId: capture.sessionId });
			}
		}
	}

	private async request(view: ChatView, message: Extract<HostToWebview, { type: "captureViewState" | "restoreViewState" }>): Promise<WebviewToHost> {
		const response = new Promise<WebviewToHost>((resolve, reject) => { view.pending.set(message.requestId, { sessionId: message.sessionId, resolve, reject }); });
		void response.catch(() => {});
		try {
			if (view.closed || !await view.webview.postMessage(message)) throw new Error("Could not reach chat view.");
			return await this.wait(response);
		} finally { view.pending.delete(message.requestId); }
	}

	private async restore(view: ChatView, tab: ChatTab, state: ChatViewState): Promise<void> {
		if (tab.stateSessionId !== (tab.session?.sessionId ?? "")) {
			tab.state = undefined;
			throw new Error("The session changed. Try moving it again.");
		}
		const response = await this.request(view, { type: "restoreViewState", requestId: getNonce(), sessionId: tab.session?.sessionId ?? "", state });
		if (response.type !== "viewStateRestored") throw new Error("Invalid view restore response.");
	}

	private async wait<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Chat view did not respond. Try again.")), 10000); })]); }
		finally { clearTimeout(timer); }
	}

	private close(tab: ChatTab): void {
		tab.closed = true; tab.attachment.dispose(); tab.controller.dispose(); this.tabs.delete(tab);
		if (tab.entry?.isNew) this.historyRows = this.historyRows.filter((row) => row.path !== tab.entry!.path);
		else if (tab.entry && !this.historyRows.some((row) => row.path === tab.entry!.path)) this.historyRows.push(tab.entry);
		this.paintTabHistory();
		if (this.sidebarSession === tab) this.sidebarSession = undefined;
		if (this.lastActive === tab) this.lastActive = [...this.tabs].at(-1);
	}

	dispose(): void {
		this.disposed = true;
		this.setComposerFocus(undefined);
		this.loginAbort.abort();
		this.windowFocus.dispose();
		this.configuration.dispose();
		this.historyAttachment?.dispose();
		this.historyController?.dispose();
		this.sidebar?.disposeBinding();
		this.movingView?.panel?.dispose();
		for (const tab of [...this.tabs]) { tab.view?.panel?.dispose(); if (!tab.closed) this.close(tab); }
	}
}

async function handleMessage(message: WebviewToHost, controller: SessionController, reply: (message: HostToWebview) => void): Promise<void> {
	switch (message.type) {
		case "queryStatistics":
			await controller.queryStatistics(message.kind, message.requestId, reply);
			return;
		case "createAttachment":
			await controller.createAttachment(message.sessionId, message.attachment, reply);
			return;
		case "openAttachment":
			await controller.openAttachment(message.sessionId, message.id);
			return;
		case "prompt":
			try {
				await controller.prompt(message.payload, reply);
			} catch (err) {
				controller.showErrorNotice(`Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		case "abort":
			await controller.abort();
			return;
		case "compact":
			await controller.compact(message.instructions);
			return;
		case "exportChat":
			await controller.exportChat();
			return;
		case "browseChild":
			await controller.browseChild(message.browseRef);
			return;
		case "noticeAction":
			await controller.runNoticeAction(message.id);
			return;
		case "renameSession":
			await controller.renameSession(message.name);
			return;
		case "renameHistorySession":
			await controller.renameHistorySession(message.path, message.sessionId, message.name);
			return;
		case "stopSession":
			await controller.stopSession(message.path, message.sessionId);
			return;
		case "archiveSession":
			await controller.archiveSession(message.path, message.sessionId);
			return;
		case "unarchiveSession":
			await controller.unarchiveSession(message.path, message.sessionId);
			return;
		case "backToParent":
			await controller.backToParent();
			return;
		case "copyConversation":
			await controller.copyConversation();
			return;
		case "copyLastReply":
			await controller.copyLastReply();
			return;
		case "dismissInstallPrompt":
			await controller.dismissInstallPrompt();
			return;
		case "draftChanged":
			await controller.persistDraft(message.text, message.sessionId, message.attachmentDraft);
			return;
		case "setCompactThreshold":
			controller.setCompactThreshold(message.percent);
			return;
		case "restart":
			await controller.restart();
			await controller.refreshSnapshot();
			return;
		case "requestState":
			await controller.refreshSnapshot();
			return;
		case "requestModels":
			await controller.listModels();
			return;
		case "requestCommands":
			await controller.listCommands();
			return;
		case "requestHistory":
			await controller.listHistory();
			return;
		case "searchHistory":
			await controller.searchHistory(message.query);
			return;
		case "setModel":
			await controller.setModel(message.provider, message.modelId);
			return;
		case "setThinkingLevel":
			await controller.setThinkingLevel(message.level);
			return;
		case "stopObserving":
			await controller.stopObserving();
			return;
		case "deleteSession":
			await controller.deleteSessionByPath(message.path, message.sessionId);
			return;
		case "searchFiles":
			await controller.searchFiles(message.query, message.requestId, reply);
			return;
		case "dropWorkspaceUris": {
			const epoch = controller.viewEpoch, attached = controller.attached, observingId = controller.observingId;
			const files = await controller.resolveDroppedWorkspaceUris(message.uris);
			const current = !controller.disposed && epoch === controller.viewEpoch && attached === controller.attached && observingId === controller.observingId;
			// The webview keeps a pending entry per request id until this reply lands;
			// dropping it here left that entry waiting forever.
			reply({ type: "droppedWorkspaceUrisResolved", requestId: message.requestId, files: current ? files : [] });
			return;
		}
		case "openFile":
			await controller.openFile(message.path, message.startLine, message.endLine);
			return;
		case "pickImage":
			await controller.pickImages(message.requestId, reply);
			return;
		case "attachActiveFile": {
			const file = controller.getActiveFilePath();
			if (file) reply({ type: "insertMention", path: file });
			else reply({ type: "notice", level: "warning", text: "No active editor file to attach." });
			return;
		}
		case "attachSelection": {
			const selection = controller.getActiveSelection();
			if (selection) reply({ type: "insertSelection", selection });
			else reply({ type: "notice", level: "warning", text: "No editor selection in this workspace to attach." });
			return;
		}
		case "pickModel":
			await controller.pickModelQuickPick();
			return;
		case "pickThinkingLevel":
			await controller.pickThinkingQuickPick();
			return;
		case "toggleFavoriteModel":
			await controller.toggleFavoriteModel(message.provider, message.modelId);
			return;
		case "openExternal":
			try {
				const uri = vscode.Uri.parse(message.url, true);
				// Must stay in step with markdown.ts' ALLOWED_LINK_PROTOCOLS: a link
				// the transcript renders as clickable and the host then refuses is
				// just an error notice where an opened page was promised.
				if (uri.scheme !== "https" && uri.scheme !== "http" && uri.scheme !== "mailto") {
					throw new Error("unsupported link scheme");
				}
				await vscode.env.openExternal(uri);
			} catch {
				controller.showErrorNotice("Blocked an unsupported external link.");
			}
			return;
	}
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, models: import("../shared/protocol.js").RpcModel[]): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.css"));
	const nonce = getNonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${styleUri}?v=${WEBVIEW_REV}" rel="stylesheet" />
	<title>Brief</title>
</head>
<body>
	<div id="app"></div>
	<script id="cached-models" type="application/json" nonce="${nonce}">${JSON.stringify(models).replace(/</g, "\\u003c")}</script>
	<script nonce="${nonce}" src="${scriptUri}?v=${WEBVIEW_REV}"></script>
</body>
</html>`;
}

function getNonce(): string {
	// A CSP nonce is a security token: Math.random() is not a source of those.
	return randomBytes(24).toString("base64url");
}
