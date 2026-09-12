/** Sessions own controllers; editor panels and the native sidebar are replaceable views. */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatViewState, HostToWebview, WebviewToHost } from "./protocol.js";
import { SessionController } from "./session-controller.js";
import { normalizeFsPath } from "./recent-sessions.js";
export { parseWebviewMessage } from "./webview-message.js";
import { parseWebviewMessage } from "./webview-message.js";

declare const BRIEF_BUILD_REV: string | undefined;
const WEBVIEW_REV = typeof BRIEF_BUILD_REV === "string" ? BRIEF_BUILD_REV : "dev";

type SessionReference = { sessionId: string; sessionFile: string };

type ChatLocation = "editor" | "sidebar";
type ChatTab = {
	controller: SessionController;
	session?: SessionReference;
	title: string;
	view?: ChatView;
	state?: ChatViewState;
	stateSessionId?: string;
	initialized?: Promise<void>;
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
	markReady: () => void;
	transferring: boolean;
	disposeBinding: () => void;
	pending: Map<string, { sessionId: string; resolve: (message: WebviewToHost) => void; reject: (error: Error) => void }>;
};

export class ChatPanels implements vscode.Disposable, vscode.WebviewPanelSerializer, vscode.WebviewViewProvider {
	static readonly viewType = "brief.chatPanel";
	private readonly tabs = new Set<ChatTab>();
	private focusedTab: ChatTab | undefined;
	private get lastActive(): ChatTab | undefined { return this.focusedTab; }
	private set lastActive(tab: ChatTab | undefined) {
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

	constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

	private location(): ChatLocation {
		return vscode.workspace.getConfiguration("brief").get<ChatLocation>("chatLocation", "editor");
	}

	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		const result = this.operations.then(() => {
			if (this.disposed) throw new Error("Chat is closed.");
			return action();
		});
		this.operations = result.catch(() => {});
		return result;
	}

	async newSession(): Promise<void> {
		await this.enqueue(async () => { await this.move(this.create(), this.location()); });
	}

	async focus(): Promise<void> {
		const selected = this.lastActive;
		await this.enqueue(async () => {
			const tab = selected && !selected.closed ? selected : this.create();
			await this.move(tab, this.location());
			await this.initialize(tab);
			if (tab.view && !tab.closed) await tab.view.webview.postMessage({ type: "focusComposer" });
		});
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

	async run(action: (controller: SessionController) => Promise<void> | void, reveal = false): Promise<void> {
		const selected = this.lastActive;
		const target = await this.enqueue(async () => {
			const target = selected && !selected.closed ? selected : this.create();
			if (!target.view) await this.move(target, this.location());
			else if (reveal) await this.reveal(target.view);
			await this.initialize(target);
			return target;
		});
		if (!target.closed) await action(target.controller);
	}

	private async openSession(source: SessionController, sessionFile: string, sessionId: string): Promise<void> {
		const session = await source.resolveHistorySession(sessionFile, sessionId);
		if (!session || source.disposed) return;
		await this.enqueue(async () => {
			if (source.disposed) return;
			const existing = [...this.tabs].find((tab) => tab.session?.sessionId === session.id ||
				(tab.session && normalizeFsPath(tab.session.sessionFile) === normalizeFsPath(session.path)));
			if (existing?.view) {
				this.lastActive = existing;
				await this.reveal(existing.view);
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
		const tab = this.create({ sessionId: session.sessionId, sessionFile: session.sessionFile });
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

	private create(session?: SessionReference): ChatTab {
		const controller = new SessionController(this.context, this.output);
		const tab: ChatTab = { controller, session, title: "New Session", closed: false, attachment: { dispose() {} } };
		this.tabs.add(tab);
		this.lastActive = tab;
		tab.attachment = controller.attach({ post: (message) => {
			if (tab.closed) return;
			if (message.type === "snapshot" || message.type === "status") {
				const status = message.status;
				if (status.sessionId && status.sessionFile) tab.session = { sessionId: status.sessionId, sessionFile: status.sessionFile };
				const label = (status.sessionLabel ?? status.sessionName)?.trim() || (status.sessionId ? `Session ${status.sessionId.slice(0, 8)}` : "New Session");
				tab.title = label;
				this.updateTitle(tab);
				if (this.lastActive === tab) this.syncHistorySelection();
			}
			if (message.type === "history" && this.sidebar && !this.sidebar.tab && !this.sidebar.closed) {
				void this.sidebar.webview.postMessage(message);
			}
			const view = tab.view;
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
		if (view.sidebar) this.sidebarSession = tab;
		else if (this.sidebarSession === tab) this.sidebarSession = undefined;
		this.lastActive = tab;
		this.updateTitle(tab);
	}

	private async initialize(tab: ChatTab): Promise<void> {
		const view = tab.view;
		if (!view) throw new Error("Session has no view.");
		await this.wait(view.ready);
		if (view.closed || tab.closed) throw new Error("Chat view was closed.");
		await (tab.initialized ??= tab.session ? tab.controller.switchSession(tab.session.sessionFile, tab.session.sessionId) : tab.controller.ensureStarted());
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
			if (message.type === "viewStateCaptured" || message.type === "viewStateRestored" || message.type === "viewStateFailed") {
				const pending = view.pending.get(message.requestId);
				if (pending && pending.sessionId === message.sessionId) {
					if (message.type === "viewStateFailed") pending.reject(new Error(message.error)); else pending.resolve(message);
				}
				return;
			}
			if (message.type === "ready") view.markReady();
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
			if (message.type === "viewFocused") { this.lastActive = tab; return; }
			if (message.type === "ready") {
				if (view.transferring) return;
				tab.controller.sendCachedModels();
				view.loading = (view.loading ?? Promise.resolve()).catch(() => {}).then(async () => {
					await this.initialize(tab);
					if (!view.closed && !tab.closed && tab.view === view) await tab.controller.refreshSnapshot();
				});
				void view.loading.then(async () => {
					if (view.closed || tab.closed || tab.view !== view) return;
					await Promise.all([tab.controller.listModels(), tab.controller.listCommands()]);
					tab.controller.sendFavorites();
				}).catch((error) => tab.controller.showErrorNotice(`Operation failed: ${String(error)}`));
				return;
			}
			void (async () => {
				await this.initialize(tab);
				if (view.closed || tab.closed || tab.view !== view) return;
				if (message.type === "newSession") { await this.newSession(); return; }
				if (message.type === "switchSession") { await this.openSession(tab.controller, message.path, message.sessionId); return; }
				await handleMessage(message, tab.controller, (reply) => {
					if (!view.closed && tab.view === view) void view.webview.postMessage(reply);
				});
			})().catch((error) => tab.controller.showErrorNotice(`Operation failed: ${String(error)}`));
		});
		const visibility = panel ? panel.onDidChangeViewState(() => {
			if (panel.active && view.tab) this.lastActive = view.tab;
			this.refreshVisible(view);
		}) : sidebar!.onDidChangeVisibility(() => {
			this.refreshVisible(view);
		});
		view.disposeBinding = () => {
			if (view.closed) return;
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
		webview.html = buildHtml(webview, this.context.extensionUri);
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
			if (!await target.webview.postMessage({ type: "setViewMoving", moving: true })) throw new Error("Could not reach chat view.");
			displaced = target.tab;
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
			await this.initialize(tab);
			await tab.controller.refreshSnapshot();
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
		if (this.sidebarSession === tab) this.sidebarSession = undefined;
		if (this.lastActive === tab) this.lastActive = [...this.tabs].at(-1);
	}

	dispose(): void {
		this.disposed = true;
		this.historyAttachment?.dispose();
		this.historyController?.dispose();
		this.sidebar?.disposeBinding();
		this.movingView?.panel?.dispose();
		for (const tab of [...this.tabs]) { tab.view?.panel?.dispose(); if (!tab.closed) this.close(tab); }
	}
}

async function handleMessage(message: WebviewToHost, controller: SessionController, reply: (message: HostToWebview) => void): Promise<void> {
	switch (message.type) {
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
		case "forkFromUser":
			await controller.forkFromUser(message.ordinal);
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
		case "markSessionUnread":
			await controller.markHistoryUnread(message.path, message.sessionId);
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
		case "dismissInstallPrompt":
			await controller.dismissInstallPrompt();
			return;
		case "draftChanged":
			controller.persistDraft(message.text, message.sessionId);
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
		case "openFile":
			await controller.openFile(message.path, message.startLine, message.endLine);
			return;
		case "pickImage":
			await controller.pickImages(message.requestId, reply);
			return;
		case "attachActiveFile": {
			const file = controller.getActiveFilePath();
			if (file) reply({ type: "insertMention", path: file });
			return;
		}
		case "attachSelection": {
			const selection = controller.getActiveSelection();
			if (selection) reply({ type: "insertSelection", selection });
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

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
	<script nonce="${nonce}" src="${scriptUri}?v=${WEBVIEW_REV}"></script>
</body>
</html>`;
}

function getNonce(): string {
	// A CSP nonce is a security token: Math.random() is not a source of those.
	return randomBytes(24).toString("base64url");
}
