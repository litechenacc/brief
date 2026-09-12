import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "brief-startup-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root, scheme: "file" }, name: "startup", index: 0 }];
const output = { append: () => {}, appendLine: () => {} };
function context(memory = new Map()) {
	const state = {
		get: (key, fallback) => memory.has(key) ? memory.get(key) : fallback,
		update: (key, value) => { memory.set(key, value); return Promise.resolve(); },
	};
	return { subscriptions: [], extensionUri: { fsPath: root }, globalState: state, workspaceState: state };
}
function controllerFor(memory, rows) {
	const controller = new SessionController(context(memory), output);
	const actions = [];
	const sidecar = {
		createResident: async (options) => {
			actions.push({ type: "create", ...options });
			return { activeSessionId: "created-active", sessionId: "created-session", sessionFile: options.sessionPath ?? path.join(root, "created-session.jsonl") };
		},
	};
	controller.connectDaemon = async () => sidecar;
	controller.listSessions = async () => rows;
	controller.attachViaDaemon = async (activeSessionId, sessionFile) => {
		actions.push({ type: "attach", activeSessionId, sessionFile });
		controller.attached = { activeSessionId, sessionPath: sessionFile, sessionId: activeSessionId };
		return true;
	};
	return { controller, actions };
}

const livePath = path.join(root, "remembered.jsonl");
fs.writeFileSync(livePath, "{}\n");
const daemonless = new SessionController(context(new Map()), output);
let connectAttempts = 0;
let supervisorStarts = 0;
daemonless.ensureSidecar = async () => {
	connectAttempts += 1;
	if (connectAttempts === 1) throw new Error("socket missing");
	return { connected: true };
};
daemonless.startDaemonSupervisor = async () => { supervisorStarts += 1; };
await daemonless.connectDaemon();
check("a missing daemon socket starts the supervisor then reconnects", supervisorStarts === 1 && connectAttempts === 2, JSON.stringify({ supervisorStarts, connectAttempts }));
const liveMemory = new Map([["brief-foreground-session", { sessionId: "remembered", sessionFile: livePath }]]);
const live = controllerFor(liveMemory, [{ activeSessionId: "live-active", sessionId: "remembered", sessionFile: livePath }]);
await live.controller.start();
check("startup ignores the workspace singleton even when its worker is live", live.actions.length === 2 && live.actions[0].type === "create" && !live.actions[0].sessionPath && live.actions[1].activeSessionId === "created-active", JSON.stringify(live.actions));

const deadMemory = new Map([["brief-foreground-session", { sessionId: "remembered", sessionFile: livePath }]]);
const dead = controllerFor(deadMemory, []);
await dead.controller.start();
check("startup does not resume an inactive workspace singleton", dead.actions[0]?.type === "create" && !dead.actions[0]?.sessionPath && dead.actions[1]?.type === "attach", JSON.stringify(dead.actions));

const fresh = controllerFor(new Map(), []);
await fresh.controller.start();
check("startup creates a fresh resident session when nothing is remembered", fresh.actions[0]?.type === "create" && !("sessionPath" in fresh.actions[0]) && fresh.actions[1]?.type === "attach", JSON.stringify(fresh.actions));
check("a successful daemon attach marks the runtime reachable", fresh.controller.reachable === true, String(fresh.controller.reachable));

const history = new SessionController(context(new Map()), output);
const historyActions = [];
history.resolveHistorySession = async () => ({ id: "remembered", fileId: "remembered", path: livePath, cwd: root, timestamp: "", inWorkspace: true });
history.connectDaemon = async () => ({
	createResident: async (options) => { historyActions.push({ type: "create", ...options }); return { activeSessionId: "history-active", sessionFile: livePath }; },
});
history.listSessions = async () => [];
history.attachViaDaemon = async (activeSessionId, sessionFile) => { historyActions.push({ type: "attach", activeSessionId, sessionFile }); history.attached = { activeSessionId, sessionPath: sessionFile }; return true; };
history.client = { running: true, request: async () => { historyActions.push({ type: "rpc" }); throw new Error("RPC must not be used"); } };
await history.switchSession(livePath, "remembered");
check("inactive History resume uses daemon create plus attach, not RPC switch_session", historyActions[0]?.type === "create" && historyActions[0]?.sessionPath === livePath && historyActions[1]?.type === "attach" && !historyActions.some((action) => action.type === "rpc"), JSON.stringify(historyActions));

const persistedMemory = new Map();
const persisted = new SessionController(context(persistedMemory), output);
await persisted.persistForegroundSession("persisted-id", livePath);
const restored = new SessionController(context(persistedMemory), output);
check("session target stays panel-local rather than writing workspaceState", persisted.rememberedSession?.sessionId === "persisted-id" && restored.rememberedSession === null && !persistedMemory.has("brief-foreground-session"));

const failedResume = controllerFor(new Map(), []);
failedResume.controller.resolveHistorySession = async () => null;
await failedResume.controller.switchSession(livePath, "missing-id");
await failedResume.controller.ensureStarted();
check("ready after failed history resume stays locked and does not create a blank session", failedResume.actions.length === 0 && failedResume.controller.observationRestoring && failedResume.controller.rememberedSession?.sessionId === "missing-id");
failedResume.controller.dispose();

const newTab = controllerFor(liveMemory, []);
await newTab.controller.newSession();
check("newSession on a fresh panel creates only one resident", newTab.actions.filter((action) => action.type === "create").length === 1 && newTab.actions.filter((action) => action.type === "attach").length === 1, JSON.stringify(newTab.actions));

const beforeReady = historyActions.length;
await history.ensureStarted();
check("ready after history binding does not start or replace that session", historyActions.length === beforeReady && history.attached.activeSessionId === "history-active");

const late = controllerFor(new Map(), []);
let finishConnect;
late.controller.connectDaemon = () => new Promise((resolve) => { finishConnect = resolve; });
const lateStart = late.controller.start();
late.controller.dispose();
finishConnect({ createResident: async () => { late.actions.push({ type: "create" }); } });
await lateStart;
check("closing a panel during startup does not create a resident", late.actions.length === 0);

const isolated = controllerFor(liveMemory, []);
isolated.controller.attachViaDaemon = async () => {
	isolated.controller.attached = { activeSessionId: "other-panel", sessionPath: livePath };
	return true;
};
await isolated.controller.start();
isolated.controller.sidecar = { connected: true, dispose: () => {} };
isolated.controller.dispose();
check("closing another panel leaves the first panel attachment intact", live.controller.attached?.activeSessionId === "created-active" && !live.controller.disposed);

const sharedMemory = new Map();
const sharedContext = context(sharedMemory);
const panelA = new SessionController(sharedContext, output);
const panelB = new SessionController(sharedContext, output);
panelA.markHistoryArchived("/history/a.jsonl");
panelB.markHistoryArchived("/history/b.jsonl");
check("two panels preserve each other's archive overlays", sharedMemory.get("brief.historyUi").archived.length === 2 && panelB.historyArchived.has("/history/a.jsonl"));
panelA.markHistoryWaitingForUser("/history/a.jsonl");
panelB.markHistoryWaitingForUser("/history/b.jsonl");
panelA.markHistorySessionOpened("/history/b.jsonl");
panelB.persistHistoryUiState();
const sharedHistory = sharedMemory.get("brief.historyUi");
check("another panel cannot restore a cleared unread marker or lose rank times", sharedHistory.unread.includes("/history/a.jsonl") && !sharedHistory.unread.includes("/history/b.jsonl") && Object.keys(sharedHistory.sortMs).length === 2);
panelB.historyWasRunning.add("/history/b.jsonl");
panelA.markHistorySessionOpened("/history/b.jsonl");
panelB.decorateHistoryRow({ id: "history-b", path: "/history/b.jsonl", cwd: "/history", timestamp: new Date().toISOString(), inWorkspace: true, status: "idle" });
check("a stale refresh in another panel cannot turn an opened session green again", !panelB.historyUnreadComplete.has("/history/b.jsonl"));
panelA.lastHistory = [];
panelA.forgetHistoryRow("/history/a.jsonl");
panelB.persistHistoryUiState();
check("forgetting a history overlay survives another panel's save", !sharedMemory.get("brief.historyUi").archived.includes("/history/a.jsonl") && !panelB.historySortMs.has("/history/a.jsonl"));
panelA.state = { sessionId: "draft-a" };
panelB.state = { sessionId: "draft-b" };
panelA.persistDraft("draft A", "draft-a");
panelB.persistDraft("draft B", "draft-b");
panelA.persistDraft("", "draft-a");
check("per-session draft keys do not overwrite another panel's draft", !sharedMemory.get("brief-draft:draft-a") && sharedMemory.get("brief-draft:draft-b") === "draft B");
const otherWorkspace = new SessionController(context(new Map()), output);
check("history overlays do not leak to another workspace", otherWorkspace.historyArchived.size === 0);
const titlePosts = [];
panelA.attach({ post: (message) => titlePosts.push(message) });
panelA.lastHistory = [{ id: "history-b", path: "/history/b.jsonl", cwd: "/history", timestamp: new Date().toISOString(), inWorkspace: true }];
panelA.historyUnreadComplete.add("/history/b.jsonl");
panelA.markHistorySessionOpened("/history/b.jsonl");
check("opening a finished session immediately repaints it as read",
	titlePosts.some((message) => message.type === "history" && message.sessions[0]?.unreadComplete === false));
titlePosts.length = 0;
panelA.cachedMessages = [];
panelA.onAgentEvent({ type: "message_start", message: { role: "user", content: "# 修復登入流程\n請先檢查錯誤訊息" } });
check("first accepted prompt immediately labels an empty session", titlePosts.filter((message) => message.type === "status").at(-1)?.status.sessionLabel === "修復登入流程");
panelA.onAgentEvent({ type: "message_end", message: { role: "user", content: "第二個問題" } });
check("later prompts do not replace the first-prompt title", panelA.sessionChromeLabel() === "修復登入流程");
check("an explicit session name wins over the prompt-derived title", panelA.sessionChromeLabel("自訂名稱") === "自訂名稱");
panelA.resetViewedSessionState();
check("navigation clears the previous live prompt title", panelA.sessionChromeLabel() === "");
panelA.cachedMessages = [{ role: "user", content: "歷史中的第一則prompt" }];
panelA.onAgentEvent({ type: "message_start", message: { role: "user", content: "新追問" } });
check("resumed sessions keep their historical first prompt title", panelA.sessionChromeLabel() === "歷史中的第一則prompt");
panelA.dispose();
panelB.dispose();
otherWorkspace.dispose();

let disposedSidecar = false;
let daemonCommands = 0;
restored.sidecar = { connected: true, dispose: () => { disposedSidecar = true; }, request: async () => { daemonCommands += 1; } };
restored.dispose();
check("disposing for Reload Window disconnects without killing the worker", disposedSidecar && daemonCommands === 0);

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`\n${failed} startup lifecycle checks FAILED`);
	process.exit(1);
}
console.log("\nPASS startup lifecycle checks");
