/** Native editor tabs: controller ownership, routing, history and restoration. */
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const dir = mkdtempSync(join(tmpdir(), "brief-editor-tabs-"));
const controllers = [];
const panels = [];
let chatLocation = "editor";
let sidebar;
let pickedSession;
let holdNextRestore = false;
let startGate;
const configurationUpdates = [];
const handoffState = {
	composer: { draft: { text: "carry draft", images: [{ data: "aGk=", mimeType: "image/png", name: "carry.png" }], selections: [{ path: "src/carried.ts", startLine: 1, endLine: 2, text: "carried selection", languageId: "typescript" }], accepted: [] }, stash: null,
		lastNonSlashDraft: { text: "carry draft", images: [], selections: [], accepted: [] }, selectionStart: 2, selectionEnd: 4, behavior: "steer" },
	transcript: { olderCount: 2, scrollTop: 42, stickToBottom: false, anchorIndex: 3, anchorOffset: 7, expandedBlocks: [] },
};
const disposable = (fn = () => {}) => ({ dispose: fn });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function event() {
	const listeners = new Set();
	return { subscribe(fn) { listeners.add(fn); return disposable(() => listeners.delete(fn)); }, fire(value) { for (const fn of listeners) fn(value); } };
}
function makePanel(editor = true) {
	const receive = event(), change = event(), close = event();
	const panel = {
		active: false, visible: true, disposed: false, reveals: 0, title: "",
		webview: { html: "", cspSource: "test:", messages: [], asWebviewUri: (uri) => uri.fsPath,
			postMessage(message) {
				this.messages.push(message);
				if (this.delivered !== false) queueMicrotask(() => {
					if (message.type === "captureViewState" && this.failCapture) {
						receive.fire({ type: "viewStateFailed", requestId: message.requestId, sessionId: message.sessionId, error: "Finish the pending prompt first" }); return;
					}
					if (message.type === "captureViewState") receive.fire({ type: "viewStateCaptured", requestId: message.requestId, sessionId: message.sessionId, state: handoffState });
					if (message.type === "restoreViewState" && holdNextRestore) { holdNextRestore = false; return; }
					if (message.type === "restoreViewState") receive.fire({ type: "viewStateRestored", requestId: message.requestId, sessionId: message.sessionId });
				});
				return Promise.resolve(this.delivered !== false);
			},
			onDidReceiveMessage: receive.subscribe },
		onDidChangeViewState: change.subscribe, onDidChangeVisibility: change.subscribe, onDidDispose: close.subscribe,
		show() { this.shows = (this.shows ?? 0) + 1; for (const p of panels) p.active = false; change.fire(); },
		reveal() { this.reveals++; this.activate(); },
		activate() { for (const p of panels) p.active = false; this.active = true; change.fire({ webviewPanel: this }); },
		dispose() { if (this.disposed) return; this.disposed = true; this.active = false; close.fire(); },
		send: receive.fire,
	};
	let html = "";
	Object.defineProperty(panel.webview, "html", { get: () => html, set(value) {
		html = value;
		if (value) queueMicrotask(() => receive.fire({ type: "ready" }));
	} });
	if (editor) panels.push(panel);
	return panel;
}
class Controller {
	constructor() { this.historyCompletedAt = new Map(); this.calls = []; this.disposed = false; controllers.push(this); }
	attach(sink) { this.sink = sink; return disposable(() => { this.detached = true; }); }
	async ensureStarted() { this.calls.push(["start"]); await startGate; }
	async setModel(provider, modelId) { this.calls.push(["setModel", provider, modelId]); }
	async switchSession(...args) { this.calls.push(["switch", ...args]); await this.switchGate; }
	async refreshSnapshot(...args) { this.calls.push(["snapshot", ...args]); await this.refreshGate; }
	sendCachedModels() { this.calls.push(["cachedModels"]); }
	async listModels() { await this.modelGate; } async listCommands() {} sendFavorites() {}
	async listHistory() { this.calls.push(["history"]); this.sink.post({ type: "history", sessions: [] }); }
	async resolveHistorySession(path, id) { this.calls.push(["resolve", path, id]); return this.historyGate ? await this.historyGate : path.startsWith("/known/") ? { path, id } : undefined; }
	async prompt(payload, reply) { this.calls.push(["prompt", payload]); reply({ type: "promptAccepted", clientRequestId: payload.clientRequestId }); }
	persistDraft(...args) { this.calls.push(["draft", ...args]); }
	markHistorySessionOpened(...args) { this.calls.push(["read", ...args]); }
	async abort() { this.calls.push(["abort"]); }
	newSession() { throw new Error("New tab must not replace an existing session"); }
	showErrorNotice(text) { throw new Error(text); }
	dispose() { this.disposed = true; }
}
const windowStateChange = event();
const stub = {
	ConfigurationTarget: { Workspace: 2 },
	workspace: { getConfiguration: () => ({ get: (key, fallback) => key === "chatLocation" ? chatLocation : fallback,
		update: async (key, value, target) => { configurationUpdates.push([key, value, target]); chatLocation = value; } }) },
	commands: { executeCommand: async (command) => {
		assert.equal(command, "brief.chat.focus");
		if (!sidebar || sidebar.disposed) { sidebar = makePanel(false); manager.resolveWebviewView(sidebar); }
	} },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	window: { state: { focused: true }, onDidChangeWindowState: windowStateChange.subscribe, showQuickPick: async (items) => items.find((item) => item.description === pickedSession), createWebviewPanel(type, title, column, options) {
		assert.equal(type, "brief.chatPanel"); assert.equal(options.retainContextWhenHidden, true);
		const panel = makePanel(); panel.activate(); return panel;
	} },
	Uri: { joinPath: (uri, ...parts) => ({ fsPath: join(uri.fsPath, ...parts) }) },
	ViewColumn: { Active: 1 },
};
let manager;
try {
	const bundle = join(dir, "tabs.cjs");
	await esbuild.build({ entryPoints: ["src/chat-view.ts"], outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent",
		plugins: [{ name: "controller-stub", setup(build) { build.onResolve({ filter: /session-controller\.js$/ }, () => ({ path: "test-controller", external: true })); } }] });
	Module._load = function (name, ...args) {
		if (name === "vscode") return stub;
		if (name === "test-controller") return { SessionController: Controller };
		return originalLoad.call(this, name, ...args);
	};
	const { ChatPanels } = require(bundle);
	manager = new ChatPanels({ extensionUri: { fsPath: process.cwd() }, globalState: { get: () => [{ provider: "cached", id: "cached-model</script>" }] } }, { appendLine() {} });
	let finishStart;
	startGate = new Promise((resolve) => { finishStart = resolve; });
	const opening = manager.newSession();
	await tick();
	const initialCache = panels[0].webview.html.match(/<script id="cached-models"[^>]*>(.*?)<\/script>/s)?.[1];
	assert.deepEqual(JSON.parse(initialCache), [{ provider: "cached", id: "cached-model</script>" }], "initial HTML includes safely escaped cache before ready/RPC");
	assert.ok(controllers[0].calls.some(([name]) => name === "cachedModels"), "cache arrives while startup is pending");
	assert.ok(controllers[0].calls.some(([name]) => name === "start"));
	assert.ok(!panels[0].webview.messages.some((message) => message.type === "setViewMoving" && message.moving),
		"a fresh chat must not make the cached model picker inert during startup");
	panels[0].send({ type: "setModel", provider: "cached", modelId: "cached-model" });
	await tick();
	assert.ok(!controllers[0].calls.some(([name]) => name === "setModel"), "model operation waits for runtime, not the picker UI");
	finishStart(); await opening; startGate = undefined;
	await tick();
	assert.ok(controllers[0].calls.filter(([name]) => name === "snapshot").every(([, options]) => options?.keepDraft === true),
		"new chat refreshes must not replace the draft typed during startup");
	assert.deepEqual(controllers[0].calls.find(([name]) => name === "setModel"), ["setModel", "cached", "cached-model"], "cached choice reaches the new runtime after startup");
	await manager.newSession();
	const [a, b] = panels, [ca, cb] = controllers;
	assert.notEqual(ca, cb);
	assert.deepEqual(a.iconPath, { light: { fsPath: join(process.cwd(), "media/tab-light.svg") }, dark: { fsPath: join(process.cwd(), "media/tab-dark.svg") } });
	assert.deepEqual(b.iconPath, { light: { fsPath: join(process.cwd(), "media/tab-light.svg") }, dark: { fsPath: join(process.cwd(), "media/tab-dark.svg") } });
	a.send({ type: "ready" }); b.send({ type: "ready" }); await tick();
	assert.equal(ca.calls.filter(([name]) => name === "start").length, 1);
	assert.equal(cb.calls.filter(([name]) => name === "start").length, 1);
	assert.ok(ca.calls.some(([name]) => name === "cachedModels") && cb.calls.some(([name]) => name === "cachedModels"),
		"new editor sessions paint cached models after their controllers bind");
	a.send({ type: "ready" }); await tick();
	assert.equal(ca.calls.filter(([name]) => name === "start").length, 1, "ready cannot create another session");
	ca.sink.post({ type: "status", status: { sessionId: "session-a", sessionFile: "/known/a.jsonl", sessionLabel: "Alpha" } });
	cb.sink.post({ type: "status", status: { sessionId: "session-b", sessionFile: "/known/b.jsonl", sessionLabel: "Beta" } });
	assert.equal(a.title, "Alpha"); assert.equal(b.title, "Beta");
	const publishReadSnapshot = (messages = [{ role: "assistant", stopReason: "stop", timestamp: 42 }]) => {
		ca.sink.post({ type: "snapshot", status: { sessionId: "session-a", sessionFile: "/known/a.jsonl" }, messages, state: null });
		return a.webview.messages.at(-1).readReceipt;
	};
	let receipt = publishReadSnapshot();
	a.send({ type: "chatRendered", receipt });
	assert.equal(ca.calls.filter(([name]) => name === "read").length, 0, "background editor cannot read");
	a.activate();
	assert.equal(a.webview.messages.at(-1).type, "requestReadReceipt", "native tab activation asks visible chat to acknowledge without input focus");
	stub.window.state.focused = false;
	a.send({ type: "chatRendered", receipt });
	assert.equal(ca.calls.filter(([name]) => name === "read").length, 0, "unfocused window cannot read");
	stub.window.state.focused = true;
	windowStateChange.fire({ focused: true });
	assert.equal(a.webview.messages.at(-1).type, "requestReadReceipt", "returning to the window asks active chat to acknowledge");
	a.send({ type: "chatRendered", receipt: { ...receipt, sessionId: "session-b" } });
	assert.equal(ca.calls.filter(([name]) => name === "read").length, 0, "wrong identity cannot read");
	a.send({ type: "chatRendered", receipt }); a.send({ type: "chatRendered", receipt });
	assert.deepEqual(ca.calls.filter(([name]) => name === "read"), [["read", "/known/a.jsonl", 42]], "successful display reads once");
	ca.historyCompletedAt.set("/known/a.jsonl", 100);
	await manager.openSession(ca, "/known/a.jsonl", "session-a");
	ca.historyCompletedAt.set("/known/a.jsonl", 200);
	const stale = receipt; receipt = publishReadSnapshot([]);
	assert.equal(receipt.completedAt, 100, "opening cutoff covers compacted history but excludes later completion");
	const firstCompacted = receipt;
	receipt = publishReadSnapshot([]);
	assert.equal(receipt.completedAt, 100, "consecutive snapshots retain opening cutoff until acknowledgement");
	a.send({ type: "chatRendered", receipt: firstCompacted });
	a.send({ type: "chatRendered", receipt: stale });
	assert.equal(ca.calls.filter(([name]) => name === "read").length, 1, "stale render cannot clear a newer completion");
	a.send({ type: "chatRendered", receipt });
	assert.equal(ca.calls.filter(([name]) => name === "read").length, 2);
	b.activate();

	const longTitle = "很長的對話標題用來確認原生分頁不再無限制變寬";
	ca.sink.post({ type: "status", status: { sessionId: "session-a", sessionFile: "/known/a.jsonl", sessionLabel: longTitle } });
	assert.equal(a.title, Array.from(longTitle).slice(0, 15).join("") + "…");
	assert.equal(Array.from(a.title).length, 16);
	assert.equal(a.webview.messages.at(-1).status.sessionLabel, longTitle, "only native tab display is shortened");
	ca.sink.post({ type: "status", status: { sessionId: "session-a", sessionFile: "/known/a.jsonl", sessionLabel: "Alpha" } });
	assert.equal(a.webview.messages.filter((message) => message.type === "status").length, 3);
	assert.equal(b.webview.messages.filter((message) => message.type === "status").length, 1);
	a.send({ type: "prompt", payload: { text: "only alpha", images: [], selections: [], streamingBehavior: "steer", sessionId: "session-a", clientRequestId: "alpha-1" } });
	b.send({ type: "draftChanged", text: "beta draft", sessionId: "session-b" }); await tick();
	assert.equal(ca.calls.find(([name]) => name === "prompt")[1].text, "only alpha");
	assert.ok(!cb.calls.some(([name]) => name === "prompt"));
	assert.ok(!ca.calls.some(([name]) => name === "draft"));
	assert.deepEqual(cb.calls.find(([name]) => name === "draft"), ["draft", "beta draft", "session-b", undefined]);
	assert.ok(a.webview.messages.some((m) => m.clientRequestId === "alpha-1"));
	assert.ok(!b.webview.messages.some((m) => m.clientRequestId === "alpha-1"));
	const snapshotsBefore = ca.calls.filter(([name]) => name === "snapshot").length;
	const htmlBefore = a.webview.html;
	a.activate(); await tick();
	assert.equal(ca.calls.filter(([name]) => name === "snapshot").length, snapshotsBefore, "normal reveal keeps retained transcript/scroll");
	assert.equal(a.webview.html, htmlBefore);
	a.webview.delivered = false; ca.sink.post({ type: "focusComposer" }); await tick();
	a.webview.delivered = true; a.activate(); await tick();
	assert.deepEqual(ca.calls.at(-1), ["snapshot", { keepDraft: true }], "missed update triggers draft-preserving catch-up");
	a.activate(); await tick();
	assert.equal(ca.calls.filter(([name]) => name === "snapshot").length, snapshotsBefore + 1, "missed-update flag clears after catch-up");
	a.activate(); await manager.run((c) => c.abort());
	assert.equal(ca.calls.filter(([name]) => name === "abort").length, 1);
	a.active = false; await manager.run((c) => c.abort());
	assert.equal(ca.calls.filter(([name]) => name === "abort").length, 2, "source editor commands use last chat");
	b.activate(); const captured = manager.run((c) => c.abort()); a.activate(); await captured;
	assert.equal(cb.calls.filter(([name]) => name === "abort").length, 1, "command target captured before await");
	let finishLongAction;
	const longActionGate = new Promise((resolve) => { finishLongAction = resolve; });
	let longActionStarted = false, longActionFinished = false;
	a.activate();
	const longAction = manager.run(async (controller) => {
		assert.equal(controller, ca); longActionStarted = true;
		await longActionGate; longActionFinished = true;
	});
	await tick();
	assert.ok(longActionStarted && !longActionFinished);
	b.activate();
	const abortsBeforeConcurrentCommand = cb.calls.filter(([name]) => name === "abort").length;
	const concurrentAbort = manager.run((controller) => controller.abort());
	await tick();
	assert.equal(cb.calls.filter(([name]) => name === "abort").length, abortsBeforeConcurrentCommand + 1,
		"tab A pending action must not block tab B Stop");
	assert.equal(longActionFinished, false);
	finishLongAction(); await Promise.all([longAction, concurrentAbort]);
	assert.equal(longActionFinished, true);
	const revealsBeforeResume = a.reveals;
	b.send({ type: "switchSession", path: "/known/a.jsonl", sessionId: "session-a" }); await tick();
	assert.equal(panels.length, 2); assert.equal(a.reveals, revealsBeforeResume + 1);
	assert.equal(a.webview.messages.at(-1).type, "focusComposer", "history resume reveals chat rather than retained history view");
	b.send({ type: "switchSession", path: "/forged/a.jsonl", sessionId: "session-a" }); await tick();
	assert.equal(a.reveals, revealsBeforeResume + 1, "already-open history still validates path");
	let resolveHistory;
	cb.historyGate = new Promise((resolve) => { resolveHistory = resolve; });
	b.send({ type: "switchSession", path: "/known/c.jsonl", sessionId: "session-c" });
	b.send({ type: "switchSession", path: "/known/c.jsonl", sessionId: "session-c" });
	await tick(); resolveHistory({ path: "/known/c.jsonl", id: "session-c" }); await tick();
	assert.equal(panels.length, 3, "concurrent resume deduplicates before target ready");
	const c = panels[2], cc = controllers[2]; c.send({ type: "ready" }); await tick();
	assert.deepEqual(cc.calls.find(([name]) => name === "switch"), ["switch", "/known/c.jsonl", "session-c"]);
	assert.ok(!cb.calls.some(([name]) => name === "switch"), "history preserves source session");
	const beforeNew = a.webview.messages.length;
	a.send({ type: "newSession" }); await tick();
	assert.equal(panels.length, 4); assert.ok(a.webview.messages.slice(beforeNew).every((message) => message.type === "history"), "new tab only updates history in existing chats");
	panels[3].send({ type: "ready" }); await tick();
	assert.ok(controllers[3].calls.some(([name]) => name === "start"));
	c.activate(); b.dispose();
	assert.ok(cb.disposed && cb.detached); assert.ok(!ca.disposed && !cc.disposed);
	await manager.run((ctrl) => ctrl.abort());
	assert.equal(cc.calls.filter(([name]) => name === "abort").length, 1, "background close preserves focus");
	c.dispose(); for (const p of panels) p.active = false;
	await manager.run((ctrl) => ctrl.abort());
	assert.ok(controllers[3].calls.some(([name]) => name === "abort"), "closed last tab falls back to live tab");
	const restored = makePanel();
	await manager.deserializeWebviewPanel(restored, { session: { sessionId: "session-r", sessionFile: "/known/r.jsonl" } });
	assert.deepEqual(restored.iconPath, { light: { fsPath: join(process.cwd(), "media/tab-light.svg") }, dark: { fsPath: join(process.cwd(), "media/tab-dark.svg") } });
	const cr = controllers.at(-1);
	let resolveModels;
	cr.modelGate = new Promise((resolve) => { resolveModels = resolve; });
	restored.send({ type: "ready" }); restored.send({ type: "ready" }); await tick();
	assert.ok(cr.calls.some(([name]) => name === "cachedModels"), "cached models paint before live discovery finishes");
	restored.send({ type: "abort" }); await tick();
	assert.ok(cr.calls.some(([name]) => name === "abort"), "pending model discovery cannot block Stop");
	resolveModels(); await tick();
	assert.equal(cr.calls.filter(([name]) => name === "switch").length, 1);
	assert.deepEqual(cr.calls.find(([name]) => name === "switch"), ["switch", "/known/r.jsonl", "session-r"]);
	assert.ok(!cr.calls.some(([name]) => name === "start"));
	const count = controllers.length, duplicate = makePanel();
	await manager.deserializeWebviewPanel(duplicate, { session: { sessionId: "session-r", sessionFile: "/known/r.jsonl" } });
	assert.ok(duplicate.disposed); assert.equal(controllers.length, count);
	for (const state of [undefined, {}, { session: { sessionId: "x" } }, { session: { sessionId: 9, sessionFile: "/known/r.jsonl" } }]) {
		const invalid = makePanel(); await manager.deserializeWebviewPanel(invalid, state); assert.ok(invalid.disposed);
	}
	assert.equal(controllers.length, count, "invalid restore cannot create or attach another session");
	// Move only the selected session. Its controller and live runtime survive both directions.
	a.activate();
	const startsBeforeMove = ca.calls.filter(([name]) => name === "start").length;
	const abortsBeforeMove = ca.calls.filter(([name]) => name === "abort").length;
	const controllerCountBeforeMove = controllers.length;
	const otherPanel = panels[3], otherMessagesBefore = otherPanel.webview.messages.length;
	let finishSlowRefresh;
	ca.refreshGate = new Promise((resolve) => { finishSlowRefresh = resolve; });
	const refreshCountBeforeMove = ca.calls.filter(([name]) => name === "snapshot").length;
	const slowMove = manager.useLocation("sidebar");
	await tick();
	assert.equal(ca.calls.filter(([name]) => name === "snapshot").length, refreshCountBeforeMove + 1, "handoff reached its slow target refresh");
	assert.equal(sidebar.webview.messages.filter((message) => message.type === "setViewMoving").at(-1)?.moving, true,
		"target is frozen while its snapshot refresh is pending");
	assert.ok(!a.disposed, "source stays open until target snapshot and restore complete");
	finishSlowRefresh(); await slowMove;
	assert.equal(sidebar.webview.messages.filter((message) => message.type === "setViewMoving").at(-1)?.moving, false,
		"handoff finally unfreezes target after successful restore");
	assert.equal(chatLocation, "sidebar");
	assert.deepEqual(configurationUpdates.at(-1), ["chatLocation", "sidebar", stub.ConfigurationTarget.Workspace]);
	assert.ok(a.disposed, "editor source closes only after sidebar restoration");
	assert.ok(!ca.disposed && !ca.detached, "moving retains controller connection");
	assert.equal(controllers.length, controllerCountBeforeMove);
	assert.ok(sidebar.webview.messages.some((message) => message.type === "restoreViewState" && message.sessionId === "session-a"));
	await manager.run((controller) => assert.equal(controller, ca));
	assert.ok(!otherPanel.disposed); assert.equal(otherPanel.webview.messages.length, otherMessagesBefore);
	await manager.toggleLocation();
	const movedEditor = panels.at(-1);
	assert.equal(chatLocation, "editor");
	assert.deepEqual(movedEditor.iconPath, { light: { fsPath: join(process.cwd(), "media/tab-light.svg") }, dark: { fsPath: join(process.cwd(), "media/tab-dark.svg") } });
	assert.equal(controllers.length, controllerCountBeforeMove + 1, "history uses a catalog controller without starting a runtime");
	const catalog = controllers.at(-1);
	assert.deepEqual(catalog.calls, [["history"]]);
	assert.ok(sidebar.webview.html, "moving to editor keeps the sidebar rendered");
	assert.deepEqual(sidebar.webview.messages.filter(m => m.type === "setHistoryMode").at(-1), { type: "setHistoryMode", enabled: true });
	assert.equal(sidebar.webview.messages.filter(m => m.type === "historySelection").at(-1).sessionId, "session-a");
	restored.activate();
	assert.equal(sidebar.webview.messages.filter(m => m.type === "historySelection").at(-1).sessionId, "session-r");
	otherPanel.activate();
	assert.equal(sidebar.webview.messages.filter(m => m.type === "historySelection").at(-1).sessionId, undefined);
	movedEditor.send({ type: "viewFocused" });
	assert.equal(sidebar.webview.messages.filter(m => m.type === "historySelection").at(-1).sessionId, "session-a");
	const panelCount = panels.length;
	sidebar.send({ type: "switchSession", path: "/known/a.jsonl", sessionId: "session-a" }); await tick();
	assert.equal(panels.length, panelCount);
	assert.ok(movedEditor.reveals > 0, "sidebar history focuses the existing editor");
	assert.equal(catalog.calls.some(([name]) => name === "start" || name === "switch"), false);
	assert.equal(ca.calls.filter(([name]) => name === "start").length, startsBeforeMove);
	assert.equal(ca.calls.filter(([name]) => name === "abort").length, abortsBeforeMove);
	assert.deepEqual(movedEditor.webview.messages.find((message) => message.type === "restoreViewState").state, handoffState);
	assert.ok(!otherPanel.disposed); assert.equal(otherPanel.webview.messages.length, otherMessagesBefore);
	await manager.useLocation("sidebar");
	const panelsBeforeSidebarNew = panels.length;
	await manager.newSession();
	const sidebarNewController = controllers.at(-1);
	assert.equal(panels.length, panelsBeforeSidebarNew, "New follows sidebar setting without creating an editor");
	assert.notEqual(sidebarNewController, ca); assert.ok(!ca.disposed && !ca.detached, "replacing sidebar retains previous session");
	sidebarNewController.sink.post({ type: "status", status: { sessionId: "sidebar-new", sessionFile: "/known/sidebar-new.jsonl" } });
	await manager.run((controller) => assert.equal(controller, sidebarNewController));
	pickedSession = "session-a";
	await manager.switchSidebarSession();
	assert.ok(!sidebarNewController.disposed && !ca.disposed, "sidebar switch parks rather than closes the displaced session");
	await manager.run((controller) => assert.equal(controller, ca));
	otherPanel.activate();
	sidebar.send({ type: "draftChanged", text: "background draft", sessionId: "session-a" });
	sidebar.send({ type: "ready" }); await tick();
	await manager.run((controller) => assert.equal(controller, controllers[3], "background draft/ready must not steal command focus"));
	sidebar.send({ type: "viewFocused" });
	await manager.run((controller) => assert.equal(controller, ca, "explicit sidebar focus routes commands despite active editor panel"));
	otherPanel.send({ type: "draftChanged", text: "background editor draft", sessionId: "other-session" }); await tick();
	await manager.run((controller) => assert.equal(controller, ca, "background editor draft must not steal sidebar focus"));
	const panelsBeforeHistory = panels.length;
	otherPanel.activate();
	const sidebarShowsBefore = sidebar.shows;
	otherPanel.send({ type: "switchSession", path: "/known/a.jsonl", sessionId: "session-a" }); await tick();
	assert.equal(panels.length, panelsBeforeHistory);
	assert.ok(sidebar.shows > sidebarShowsBefore, "history reveals the existing sidebar location");
	assert.equal(sidebar.webview.messages.at(-1).type, "focusComposer");
	assert.ok(!otherPanel.disposed, "history does not move the source editor");
	sidebar.dispose();
	assert.ok(!ca.disposed && !ca.detached, "sidebar disposal detaches view, not session");
	await manager.focus();
	await manager.run((controller) => assert.equal(controller, ca));
	assert.equal(ca.calls.filter(([name]) => name === "start").length, startsBeforeMove);
	// Failed handoff must unlock and retain its source, not create a second runtime.
	sidebar.webview.failCapture = true;
	await assert.rejects(manager.useLocation("editor"), /Finish the pending prompt first/);
	assert.ok(!ca.disposed && !ca.detached);
	assert.ok(panels.at(-1).disposed, "failed capture closes the unused target editor");
	assert.equal(chatLocation, "sidebar", "failed handoff must not change location setting");
	assert.equal(sidebar.webview.messages.at(-1).type, "releaseViewState");
	await manager.run((controller) => assert.equal(controller, ca));
	sidebar.webview.failCapture = false;
	holdNextRestore = true;
	const moving = manager.useLocation("editor");
	const rejectedMove = assert.rejects(moving, /closed/);
	await tick();
	const closingTarget = panels.at(-1);
	assert.ok(closingTarget.webview.messages.some((message) => message.type === "restoreViewState"));
	assert.ok(!ca.disposed, "runtime stays attached while awaiting target restore ACK");
	closingTarget.dispose();
	await rejectedMove;
	assert.equal(chatLocation, "sidebar", "closed target must not change location setting");
	assert.ok(!ca.disposed && !ca.detached, "closing target during restore rolls back without closing session");
	await manager.run((controller) => assert.equal(controller, ca));
	chatLocation = "editor";
	const editorsBeforeNew = panels.length;
	await manager.newSession();
	assert.equal(panels.length, editorsBeforeNew + 1, "New follows editor setting");
	assert.notEqual(controllers.at(-1), ca);
	// A restored webview's first snapshot must settle before handoff captures its UI.
	const loadingRestored = makePanel();
	const restoredAdmission = manager.deserializeWebviewPanel(loadingRestored, { session: { sessionId: "restored-loading", sessionFile: "/known/restored-loading.jsonl" } });
	const loadingController = controllers.at(-1);
	let finishInitialRefresh, finishInitialModels;
	loadingController.refreshGate = new Promise((resolve) => { finishInitialRefresh = resolve; });
	loadingController.modelGate = new Promise((resolve) => { finishInitialModels = resolve; });
	await restoredAdmission; await tick();
	assert.ok(loadingController.calls.some(([name]) => name === "snapshot"), "restored initial snapshot is pending");
	loadingRestored.activate();
	let restoredMoveFinished = false;
	const restoredMove = manager.useLocation("sidebar").then(() => { restoredMoveFinished = true; });
	await tick();
	assert.equal(loadingRestored.webview.messages.some((message) => message.type === "captureViewState"), false,
		"move must wait for initial restored snapshot before capturing source state");
	assert.ok(!loadingRestored.disposed && !restoredMoveFinished);
	finishInitialRefresh();
	await tick();
	assert.equal(restoredMoveFinished, true, "catalog discovery must not delay handoff after the core snapshot settles");
	await restoredMove;
	const carriedRestore = sidebar.webview.messages.filter((message) => message.type === "restoreViewState" && message.sessionId === "restored-loading").at(-1);
	assert.equal(sidebar.webview.messages.filter((message) => message.type === "restoreViewState" && message.sessionId === "restored-loading").length, 1, "target restores carried state exactly once");
	assert.deepEqual(carriedRestore?.state, handoffState, "initial ready handler must not consume the state meant for the target");
	assert.equal(carriedRestore.state.composer.draft.images[0].name, "carry.png");
	assert.equal(carriedRestore.state.composer.draft.selections[0].path, "src/carried.ts");
	assert.ok(loadingRestored.disposed && !loadingController.disposed);
	finishInitialModels(); await tick();
	manager.dispose();
	assert.ok(controllers.every((controller) => controller.disposed && controller.detached));
	// Opening the sidebar in editor mode must not allocate a chat runtime or steal focus.
	chatLocation = "editor";
	manager = new ChatPanels({ extensionUri: { fsPath: process.cwd() }, globalState: { get: () => [{ provider: "cached", id: "cached-model</script>" }] } }, { appendLine() {} });
	const beforeCatalog = controllers.length;
	sidebar = makePanel(false);
	manager.resolveWebviewView(sidebar); await tick();
	assert.equal(controllers.length, beforeCatalog + 1);
	assert.deepEqual(controllers.at(-1).calls, [["history"]]);
	assert.ok(sidebar.webview.messages.some(m => m.type === "setHistoryMode" && m.enabled));
	const catalogController = controllers.at(-1);
	sidebar.send({ type: "chatRendered", receipt: { sessionId: "old", path: "/known/old.jsonl", revision: 1, completedAt: 42 } }); await tick();
	assert.ok(!catalogController.calls.some(([name]) => name === "read"), "history-only sidebar cannot acknowledge chat");
	const beforeResume = panels.length;
	sidebar.send({ type: "switchSession", path: "/known/old.jsonl", sessionId: "old" }); await tick();
	assert.equal(panels.length, beforeResume + 1, "history opens unopened sessions in editor");
	assert.deepEqual(controllers.at(-1).calls.find(([name]) => name === "switch"), ["switch", "/known/old.jsonl", "old"]);
	await manager.newSession();
	const draftPanel = panels.at(-1), draftController = controllers.at(-1);
	const latestHistory = () => sidebar.webview.messages.filter((message) => message.type === "history").at(-1).sessions;
	let entry = latestHistory().find((row) => row.isNew);
	assert.ok(entry, "new tab appears in history before runtime identity exists");
	const tabCount = panels.length;
	sidebar.send({ type: "switchSession", path: entry.path, sessionId: entry.id }); await tick();
	assert.equal(panels.length, tabCount, "provisional entry focuses its existing tab");
	draftController.sink.post({ type: "status", status: { sessionId: "draft", sessionFile: "/known/draft.jsonl" } });
	assert.equal(latestHistory().filter((row) => row.isNew).length, 1, "runtime identity replaces provisional entry");
	catalogController.sink.post({ type: "history", sessions: [{ id: "draft", path: "/known/draft.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), inWorkspace: true, status: "running", running: true }] });
	assert.equal(latestHistory().find((row) => row.id === "draft")?.running, true, "new marker must not override catalog running state before acceptance");
	catalogController.sink.post({ type: "history", sessions: [] });
	draftController.sink.post({ type: "promptAccepted", kind: "prompt" });
	assert.equal(latestHistory().find((row) => row.id === "draft")?.isNew, false, "daemon broadcast acceptance clears new marker");
	draftController.sink.post({ type: "status", status: { sessionId: "draft", sessionFile: "/known/draft.jsonl", connected: true, streaming: true, historyRunning: true } });
	assert.equal(latestHistory().find((row) => row.id === "draft")?.running, true, "daemon-accepted new session turns red");
	const historyPaints = () => sidebar.webview.messages.filter((message) => message.type === "history").length;
	const paintsBeforeTokens = historyPaints();
	for (let token = 0; token < 20; token++) {
		draftController.sink.post({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "token" } } });
		draftController.sink.post({ type: "status", status: { sessionId: "draft", sessionFile: "/known/draft.jsonl", connected: true, streaming: true, historyRunning: true } });
	}
	assert.equal(historyPaints(), paintsBeforeTokens, "token updates must not rebuild history buttons during a click");
	sidebar.send({ type: "switchSession", path: "/known/old.jsonl", sessionId: "old" }); await tick();
	assert.ok(!draftController.calls.some(([name]) => name === "abort"), "history navigation does not stop the streaming session");
	assert.ok(panels.some((panel) => panel.active && panel !== draftPanel), "history can focus another editor while tokens arrive");
	// Use another unsent tab to cover close-without-send independently.
	await manager.newSession();
	const unsentPanel = panels.at(-1);
	controllers.at(-1).sink.post({ type: "status", status: { sessionId: "unsent", sessionFile: "/known/unsent.jsonl" } });
	unsentPanel.dispose();
	assert.ok(!latestHistory().some((row) => row.id === "unsent"), "closing unsent tab removes entry");
	await manager.newSession();
	const sentPanel = panels.at(-1), sentController = controllers.at(-1);
	sentController.sink.post({ type: "status", status: { sessionId: "sent", sessionFile: "/known/sent.jsonl" } });
	sentPanel.send({ type: "prompt", payload: { text: "Keep this session", images: [], selections: [], streamingBehavior: "steer" } }); await tick();
	assert.equal(latestHistory().find((row) => row.id === "sent")?.isNew, false, "accepted prompt clears new marker");
	const sentStatus = { sessionId: "sent", sessionFile: "/known/sent.jsonl", connected: true, streaming: true, historyRunning: true };
	sentController.sink.post({ type: "status", status: sentStatus });
	assert.equal(latestHistory().find((row) => row.id === "sent")?.status, "running", "newly submitted entry follows runtime before catalog catches up");
	sentController.sink.post({ type: "status", status: { ...sentStatus, historyRunning: false } });
	assert.equal(latestHistory().find((row) => row.id === "sent")?.running, false, "authoritative idle clears red despite stale streaming");
	sentController.sink.post({ type: "status", status: { ...sentStatus, historyRunning: null } });
	assert.equal(latestHistory().find((row) => row.id === "sent")?.status, undefined, "unknown runtime does not keep red");
	sentPanel.dispose();
	assert.ok(latestHistory().some((row) => row.id === "sent"), "closing submitted tab retains history entry");
	console.log("PASS native editor session tabs");
} finally {
	manager?.dispose(); Module._load = originalLoad; rmSync(dir, { recursive: true, force: true });
}
