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
check("startup attaches the remembered live worker", live.actions.length === 1 && live.actions[0].type === "attach" && live.actions[0].activeSessionId === "live-active", JSON.stringify(live.actions));

const deadMemory = new Map([["brief-foreground-session", { sessionId: "remembered", sessionFile: livePath }]]);
const dead = controllerFor(deadMemory, []);
await dead.controller.start();
check("startup resumes an inactive remembered JSONL", dead.actions[0]?.type === "create" && dead.actions[0]?.sessionPath === livePath && dead.actions[1]?.type === "attach", JSON.stringify(dead.actions));

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
check("workspaceState persists and restores the foreground identity", restored.rememberedSession?.sessionId === "persisted-id" && restored.rememberedSession?.sessionFile === livePath, JSON.stringify(restored.rememberedSession));

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
