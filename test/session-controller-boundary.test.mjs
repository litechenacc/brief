/**
 * Host-side authority regressions. The webview may be compromised, so syntactic
 * message validation is not enough: session actions must still resolve against
 * host-issued catalog/child capabilities before they touch disk or the daemon.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
vscodeStub.FileType = { File: 1, Directory: 2 };
const { SessionController } = require("../dist/controller.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-controller-boundary-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "boundary", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const memory = new Map();
const state = { get: (key, fallback) => (memory.has(key) ? memory.get(key) : fallback), update: (key, value) => { memory.set(key, value); return Promise.resolve(); } };
const posts = [];
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: state, workspaceState: state },
	{ append: () => {}, appendLine: () => {} },
);
controller.attach({ post: (message) => posts.push(message) });

const cachedModels = [{ provider: "cached-provider", id: "cached-model" }];
memory.set("brief.availableModels", cachedModels);
controller.sendCachedModels();
check("cached models are available before runtime discovery", posts.at(-1)?.type === "models" && posts.at(-1)?.models === cachedModels);

const cachedModelsEnsureStarted = controller.ensureStarted;
controller.ensureStarted = async () => {};
controller.client = { running: true, request: async () => ({ success: true, data: { models: [{ provider: "live-provider", id: "live-model" }] } }) };
await controller.listModels();
check("successful model discovery replaces the cache", memory.get("brief.availableModels")?.[0]?.id === "live-model");
controller.ensureStarted = cachedModelsEnsureStarted;
controller.client = null;
posts.length = 0;

const validPath = path.join(workdir, "valid-session.jsonl");
const forgedPath = path.join(workdir, "forged-session.jsonl");
fs.writeFileSync(validPath, '{"type":"session","id":"root"}\n');
fs.writeFileSync(forgedPath, '{"type":"session","id":"forged"}\n');
controller.actionHistory = [{
	id: "valid-session",
	path: validPath,
	cwd: workdir,
	timestamp: new Date().toISOString(),
	inWorkspace: true,
}];

let abortedId = null;
const sidecar = {
	connected: true,
	list: async () => [{
		id: "valid-session",
		sessionId: "valid-session",
		activeSessionId: "daemon-live-handle",
		sessionFile: validPath,
		cwd: workdir,
		lifecycle: "live",
	}],
	abort: async (id) => { abortedId = id; },
	dispose: () => {},
};
controller.sidecar = sidecar;

await controller.stopSession(validPath, "valid-session");
check("history Stop resolves UUID to the daemon active handle", abortedId === "daemon-live-handle", String(abortedId));

// Recent daemon builds expose a runtime/session UUID that can differ from the
// JSONL filename stem. The capability must retain the runtime identity for
// routing but derive the stem for an offline mutation, rather than rejecting a
// perfectly valid catalog row as a forged path.
const differingPath = path.join(workdir, "file-stem.jsonl");
fs.writeFileSync(differingPath, '{"type":"session","id":"root"}\n');
controller.actionHistory = [{
	id: "runtime-session-uuid",
	path: differingPath,
	cwd: workdir,
	timestamp: new Date().toISOString(),
	inWorkspace: true,
}];
controller.lastHistory = controller.actionHistory;
controller.sidecar = {
	connected: true,
	request: async () => { throw new Error("offline row"); },
	list: async () => [],
	dispose: () => {},
};
await controller.renameHistorySession(differingPath, "runtime-session-uuid", "renamed from catalog");
check(
	"history actions accept a daemon UUID that differs from the JSONL filename",
	fs.readFileSync(differingPath, "utf8").includes('"name":"renamed from catalog"'),
	fs.readFileSync(differingPath, "utf8"),
);
controller.actionHistory = [{
	id: "valid-session",
	path: validPath,
	cwd: workdir,
	timestamp: new Date().toISOString(),
	inWorkspace: true,
}];
controller.lastHistory = controller.actionHistory;

posts.length = 0;
let switchRequests = 0;
controller.attached = { activeSessionId: "daemon-live-handle", sessionPath: validPath, sessionId: "valid-session" };
controller.attachedEpoch = controller.viewEpoch;
controller.client = { running: true, request: async () => { switchRequests += 1; return { success: true }; } };
await controller.switchSession(validPath, "valid-session");
check("resuming the already attached history row leaves its daemon attachment intact", switchRequests === 0 && controller.attached?.activeSessionId === "daemon-live-handle", JSON.stringify(posts));
controller.attached = null;
controller.attachedEpoch = null;
controller.client = null;

let resolveReattach;
const reattachPromise = new Promise((resolve) => { resolveReattach = resolve; });
controller.attachAttempt = { activeSessionId: "stale-live-handle", sessionPath: validPath, sessionId: "valid-session" };
controller.sidecar = {
	connected: true,
	attach: async () => reattachPromise,
	detach: async () => {},
	dispose: () => {},
};
const reconnect = controller.ensureSidecar();
await Promise.resolve();
controller.viewEpoch += 1; // a newer navigation landed while attach was in flight
controller.attachAttempt = null;
resolveReattach({ snapshot: { messages: [] } });
await reconnect;
check("late reattach cannot overwrite a newer navigation", controller.attached === null);

// A failed attach can fall back to a read-only observe view while the socket's
// prior reconnect is already awaiting its attach reply. Observation owns the
// display: it must cancel that reconnect, and the late reply must release its
// daemon registration instead of installing a writable attachment underneath.
const originalObserveDetach = controller.detachFromDaemon;
let releaseObserveRaceAttach;
const observeRaceAttach = new Promise((resolve) => { releaseObserveRaceAttach = resolve; });
let observeRaceDetachCalls = 0;
const observeRaceAttempt = { activeSessionId: "observe-race-live", sessionPath: validPath, sessionId: "observe-race-session" };
controller.attached = null;
controller.attachedEpoch = null;
controller.attachAttempt = observeRaceAttempt;
controller.attachAttemptEpoch = controller.viewEpoch;
controller.observingId = null;
controller.observedSession = null;
controller.observationRestoring = false;
controller.sidecar = {
	connected: true,
	attach: async () => observeRaceAttach,
	detach: async () => { observeRaceDetachCalls += 1; },
	dispose: () => {},
};
controller.client = {
	running: true,
	request: async (command) => command.type === "observe" ? { success: true, data: { messages: [] } } : { success: true, data: {} },
};
const observeRaceReconnect = controller.ensureSidecar();
await new Promise((resolve) => setImmediate(resolve));
const priorAttachment = { activeSessionId: "prior-live", sessionPath: validPath, sessionId: "valid-session" };
controller.attached = priorAttachment;
controller.attachedEpoch = controller.viewEpoch;
controller.detachFromDaemon = async () => {
	controller.attached = null;
	controller.attachedEpoch = null;
	return true;
};
const observed = await controller.startObserving("observe-race-live", priorAttachment, controller.viewEpoch, validPath, null);
controller.detachFromDaemon = originalObserveDetach;
check(
	"successful observation cancels its pending reconnect intent",
	observed === true && controller.attachAttempt === null && controller.attachAttemptEpoch === null,
	JSON.stringify({ observed, attachAttempt: controller.attachAttempt, attachAttemptEpoch: controller.attachAttemptEpoch }),
);
releaseObserveRaceAttach({ snapshot: { messages: [] } });
await observeRaceReconnect;
check(
	"a late reconnect cannot install an attachment beneath an observed session",
	controller.attached === null && controller.observingId === "observe-race-live" && observeRaceDetachCalls === 1,
	JSON.stringify({ attached: controller.attached, observingId: controller.observingId, observeRaceDetachCalls }),
);

// Cancellation is necessary but not sufficient: an attach reply already in
// flight must independently check the observed mode before it claims the view.
let releaseObservedReattach;
const observedReattach = new Promise((resolve) => { releaseObservedReattach = resolve; });
let observedReattachDetaches = 0;
const observedAttempt = { activeSessionId: "observed-reconnect-live", sessionPath: validPath, sessionId: "observed-reconnect-session" };
controller.attached = null;
controller.attachedEpoch = null;
controller.attachAttempt = observedAttempt;
controller.attachAttemptEpoch = controller.viewEpoch;
controller.sidecar = {
	connected: true,
	attach: async () => observedReattach,
	detach: async () => { observedReattachDetaches += 1; },
	dispose: () => {},
};
const observedReconnect = controller.ensureSidecar();
await new Promise((resolve) => setImmediate(resolve));
releaseObservedReattach({ snapshot: { messages: [] } });
await observedReconnect;
check(
	"reattach completion refuses to claim a read-only observed view",
	controller.attached === null && controller.observingId === "observe-race-live" && observedReattachDetaches === 1,
	JSON.stringify({ attached: controller.attached, observingId: controller.observingId, observedReattachDetaches }),
);
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.observingId = null;
controller.observedSession = null;
controller.observationRestoring = false;
controller.client = null;

posts.length = 0;
controller.attached = { activeSessionId: "closed-live-handle", sessionPath: validPath, sessionId: "valid-session" };
controller.attachedEpoch = controller.viewEpoch;
controller.sidecar = { connected: true, dispose: () => {} };
controller.client = { running: true, request: async (command) => {
	if (command.type === "get_messages") return { success: true, data: { messages: [] } };
	if (command.type === "get_state") return { success: true, data: {} };
	if (command.type === "get_session_stats") return { success: true, data: {} };
	return { success: true };
} };
controller.onDaemonEvent({ type: "session_closed", activeSessionId: "closed-live-handle" });
check("closed attached session keeps controls restoring until the RPC snapshot replaces it", controller.observationRestoring === true);
await new Promise((resolve) => setTimeout(resolve, 0));
check("closed attached session restores the background snapshot before controls re-enable", controller.observationRestoring === false && posts.some((message) => message.type === "snapshot"));
controller.client = null;

posts.length = 0;
await controller.deleteSessionByPath(forgedPath, "forged-session");
check("forged matching JSONL path is not deleted", fs.existsSync(forgedPath));
check("forged history action reports an unavailable capability", posts.some((message) => message.type === "notice" && /no longer available/.test(message.text)), JSON.stringify(posts));

posts.length = 0;
await controller.browseChild("forged-child-reference");
check("forged child handle is rejected before daemon attach", posts.some((message) => message.type === "notice" && /Invalid subagent reference/.test(message.text)), JSON.stringify(posts));

posts.length = 0;
controller.observingId = "another-client-session";
await controller.abort();
await controller.prompt({ text: "do not route this", images: [], selections: [], streamingBehavior: "steer", clientRequestId: "prompt-boundary" });
check("observed session cannot be aborted through a stale webview", abortedId === "daemon-live-handle");
check("observed prompt is rejected with its exact client request id", posts.some((message) => message.type === "promptRejected" && message.clientRequestId === "prompt-boundary"), JSON.stringify(posts));

// Pickers must source attached-session data from the daemon, never from the
// hidden background RPC session. They also stay bound to the view that opened
// the native picker while a user may navigate before choosing an item.
const originalQuickPick = vscodeStub.window.showQuickPick;
const pickerCommands = [];
const hiddenRpcCommands = [];
const attachedPicker = { activeSessionId: "attached-picker-A", sessionPath: validPath, sessionId: "valid-session" };
controller.observingId = null;
controller.observationRestoring = false;
controller.attached = attachedPicker;
controller.attachedEpoch = controller.viewEpoch;
controller.rentedState = {
	model: { provider: "attached-provider", id: "attached-model", thinkingLevelMap: { off: "off", low: "low", high: "high" } },
	thinkingLevel: "high",
};
controller.client = {
	running: true,
	request: async (command) => {
		hiddenRpcCommands.push(command);
		throw new Error("attached picker must not query the hidden RPC session");
	},
};
controller.sidecar = {
	connected: true,
	request: async (command) => {
		pickerCommands.push(command);
		if (command.type === "get_available_models") {
			return { models: [{ provider: "attached-provider", id: "attached-model", name: "Attached model" }] };
		}
		if (command.type === "set_model" || command.type === "set_thinking_level") return {};
		throw new Error(`unexpected attached picker command: ${command.type}`);
	},
	getState: async () => ({
		model: { provider: "attached-provider", id: "attached-model", thinkingLevelMap: { off: "off", low: "low", high: "high" } },
		thinkingLevel: "high",
	}),
	dispose: () => {},
};
vscodeStub.window.showQuickPick = async (items) => items.find((item) => item.label === "low") ?? items[0];
await controller.pickModelQuickPick();
await controller.pickThinkingQuickPick();
check(
	"attached pickers query and mutate only the attached daemon session",
	hiddenRpcCommands.length === 0 &&
		pickerCommands.some((command) => command.type === "get_available_models" && command.activeSessionId === attachedPicker.activeSessionId) &&
		pickerCommands.some((command) => command.type === "set_model" && command.activeSessionId === attachedPicker.activeSessionId) &&
		pickerCommands.some((command) => command.type === "set_thinking_level" && command.activeSessionId === attachedPicker.activeSessionId && command.level === "low"),
	JSON.stringify(pickerCommands),
);

pickerCommands.length = 0;
let releaseAttachedPicker;
vscodeStub.window.showQuickPick = () => new Promise((resolve) => { releaseAttachedPicker = resolve; });
const staleAttachedPick = controller.pickModelQuickPick();
await new Promise((resolve) => setImmediate(resolve));
controller.attached = { activeSessionId: "attached-picker-B", sessionPath: validPath, sessionId: "other-session" };
controller.attachedEpoch = controller.viewEpoch;
releaseAttachedPicker({ model: { provider: "attached-provider", id: "attached-model" } });
await staleAttachedPick;
check(
	"attached picker discards a selection after navigation",
	!pickerCommands.some((command) => command.type === "set_model"),
	JSON.stringify(pickerCommands),
);

let releaseRpcPicker;
const rpcPickerCommands = [];
controller.attached = null;
controller.attachedEpoch = null;
controller.state = { sessionId: "rpc-picker-A", model: { provider: "rpc-provider", id: "rpc-model" } };
controller.client = {
	running: true,
	request: async (command) => {
		rpcPickerCommands.push(command);
		if (command.type === "get_available_models") return { success: true, data: { models: [{ provider: "rpc-provider", id: "rpc-model" }] } };
		if (command.type === "set_model") return { success: true };
		return { success: true, data: {} };
	},
};
vscodeStub.window.showQuickPick = () => new Promise((resolve) => { releaseRpcPicker = resolve; });
const staleRpcPick = controller.pickModelQuickPick();
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 1;
controller.state = { sessionId: "rpc-picker-B", model: { provider: "rpc-provider", id: "new-model" } };
releaseRpcPicker({ model: { provider: "rpc-provider", id: "rpc-model" } });
await staleRpcPick;
check(
	"RPC picker discards a selection after navigation",
	!rpcPickerCommands.some((command) => command.type === "set_model"),
	JSON.stringify(rpcPickerCommands),
);

let observedPickerCalls = 0;
controller.observingId = "observed-picker-session";
controller.client = { running: true, request: async () => { observedPickerCalls += 1; return { success: true, data: {} }; } };
await controller.pickModelQuickPick();
await controller.pickThinkingQuickPick();
check("observed pickers remain read-only and do not query the hidden RPC session", observedPickerCalls === 0);
vscodeStub.window.showQuickPick = originalQuickPick;
controller.client = null;
controller.observingId = null;

// A lexical workspace-prefix check is not an authority boundary: VS Code will
// open a symlink target outside the folder. Selection forwarding is especially
// sensitive because it reads the target and sends the text back to the webview.
if (process.platform !== "win32") {
	const secretPath = path.join(os.tmpdir(), `prime-agent-secret-${process.pid}.txt`);
	const linkedPath = path.join(workdir, "workspace-link.txt");
	fs.writeFileSync(secretPath, "TOP-SECRET\n");
	fs.symlinkSync(secretPath, linkedPath);
	const priorEditor = vscodeStub.window.activeTextEditor;
	vscodeStub.window.activeTextEditor = {
		document: { uri: { fsPath: linkedPath, scheme: "file" }, getText: () => "TOP-SECRET\n", languageId: "plaintext" },
		selection: { isEmpty: false, start: { line: 0 }, end: { line: 0 } },
	};
	check("workspace symlink selections cannot expose an external target", controller.getActiveSelection() === null);
	check("user-clicked symlink paths can open in the editor without forwarding contents", (await controller.resolveWorkspaceUri("workspace-link.txt"))?.fsPath === linkedPath);
	vscodeStub.window.activeTextEditor = priorEditor;
	fs.unlinkSync(secretPath);
}

// File-link navigation is editor-only and permits explicit paths outside the workspace.
const priorStat = vscodeStub.workspace.fs.stat;
const priorOpen = vscodeStub.workspace.openTextDocument;
const priorShow = vscodeStub.window.showTextDocument;
const priorExecute = vscodeStub.commands.executeCommand;
const editorPaths = [];
const editorCommands = [];
vscodeStub.commands.executeCommand = async (command, uri) => {
	editorCommands.push(command);
	editorPaths.push(uri.fsPath);
};
vscodeStub.workspace.fs.stat = async () => ({ type: 1 });
vscodeStub.workspace.openTextDocument = async (uri) => { editorPaths.push(uri.fsPath); return {}; };
vscodeStub.window.showTextDocument = async () => ({});
await controller.openFile("./AGENTS.md");
await controller.openFile(path.join(os.tmpdir(), "absolute-link.md"));
await controller.openFile("../parent-link.md");
check("relative and absolute file links open in the VS Code editor", JSON.stringify(editorPaths) === JSON.stringify([
	path.join(workdir, "AGENTS.md"), path.join(os.tmpdir(), "absolute-link.md"), path.resolve(workdir, "../parent-link.md"),
]), JSON.stringify(editorPaths));
for (const target of ["command:evil", "javascript:evil", "https://example.com", "//server/share", "bad\0path", "#heading"]) {
	await controller.openFile(target);
}
check("file opens reject URI schemes, network paths and invalid paths", editorPaths.length === 3);
// Binary links must use the native opener, never openTextDocument.
vscodeStub.workspace.openTextDocument = async () => { throw new Error("binary file"); };
await controller.openFile("media/design-drafts/preview.png");
check("PNG links use the native VS Code editor selector", editorCommands.at(-1) === "vscode.open"
	&& editorPaths.at(-1) === path.join(workdir, "media/design-drafts/preview.png"));
const textPaths = [];
let revealedRange;
const textEditor = { revealRange: (range) => { revealedRange = range; } };
vscodeStub.workspace.openTextDocument = async (uri) => { textPaths.push(uri.fsPath); return {}; };
vscodeStub.window.showTextDocument = async () => textEditor;
await controller.openFile("src/app.ts", 3, 5);
check("line links still select and reveal the requested text range", textPaths[0] === path.join(workdir, "src/app.ts")
	&& textEditor.selection?.start.line === 2 && textEditor.selection?.end.line === 4 && revealedRange?.start.line === 2);
posts.length = 0;
vscodeStub.workspace.fs.stat = async () => { throw new Error("not found"); };
await controller.openFile("missing.md");
check("missing file links show an error notice", posts.some((m) => m.type === "notice" && m.level === "error" && m.text.includes("missing.md")));
vscodeStub.workspace.fs.stat = priorStat;
vscodeStub.workspace.openTextDocument = priorOpen;
vscodeStub.window.showTextDocument = priorShow;
vscodeStub.commands.executeCommand = priorExecute;

// Every operation that waits for process startup must remain owned by the view
// that initiated it. Otherwise a prompt begun on A can be delivered to B when
// an explicit navigation happens while startup is still pending.
posts.length = 0;
const originalEnsureStarted = controller.ensureStarted;
let releaseStartup;
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.client = null;
controller.ensureStarted = () => new Promise((resolve) => { releaseStartup = resolve; });
const staleStartupPrompt = controller.prompt({
	text: "must stay on the original view",
	images: [],
	selections: [],
	streamingBehavior: "steer",
	clientRequestId: "startup-race-prompt",
});
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 1;
const newViewPromptCommands = [];
controller.client = {
	running: true,
	request: async (command) => {
		newViewPromptCommands.push(command);
		return { success: true, data: {} };
	},
};
releaseStartup();
await staleStartupPrompt;
check(
	"a startup-delayed prompt cannot target a newer RPC view",
	newViewPromptCommands.length === 0 && posts.some((message) => message.type === "promptRejected" && message.clientRequestId === "startup-race-prompt"),
	JSON.stringify({ commands: newViewPromptCommands, posts }),
);
controller.ensureStarted = originalEnsureStarted;

// Restart kills the foreground daemon worker and resumes the same transcript.
const restartPath = validPath;
const restartCommands = [];
const originalConnectDaemon = controller.connectDaemon;
const originalAttachViaDaemon = controller.attachViaDaemon;
controller.attached = { activeSessionId: "restart-old", sessionPath: restartPath, sessionId: "valid-session" };
controller.attachedEpoch = controller.viewEpoch;
controller.connectDaemon = async () => ({
	request: async (command) => { restartCommands.push(command); },
	createResident: async (options) => {
		restartCommands.push({ type: "create", ...options });
		return { activeSessionId: "restart-new", sessionFile: restartPath };
	},
});
controller.attachViaDaemon = async (activeSessionId, sessionPath) => {
	restartCommands.push({ type: "attach", activeSessionId, sessionPath });
	controller.attached = { activeSessionId, sessionPath, sessionId: "valid-session" };
	return true;
};
await controller.restart();
check(
	"Restart kills the current worker then resumes the same JSONL",
	restartCommands[0]?.type === "kill" && restartCommands[0]?.activeSessionId === "restart-old" &&
		restartCommands[1]?.type === "create" && restartCommands[1]?.sessionPath === restartPath &&
		restartCommands[2]?.type === "attach" && restartCommands[2]?.activeSessionId === "restart-new",
	JSON.stringify(restartCommands),
);
controller.connectDaemon = originalConnectDaemon;
controller.attachViaDaemon = originalAttachViaDaemon;
controller.attached = null;
controller.attachedEpoch = null;

// Extension UI requests are also native dialogs. Once the foreground changes,
// an approval must turn into a cancellation for the original RPC session.
const originalShowInformationMessage = vscodeStub.window.showInformationMessage;
let releaseConfirmDialog;
const dialogResponses = [];
const dialogClient = {
	running: true,
	sendRaw: (message) => dialogResponses.push(message),
};
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.client = dialogClient;
vscodeStub.window.showInformationMessage = () => new Promise((resolve) => { releaseConfirmDialog = resolve; });
const pendingDialog = controller.onExtensionUiRequest(dialogClient, {
	type: "extension_ui_request",
	id: "dialog-race",
	method: "confirm",
	title: "Confirm",
	message: "Do the original-session action?",
});
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 1;
releaseConfirmDialog("Yes");
await pendingDialog;
check(
	"an extension dialog approval is cancelled after navigation",
	dialogResponses.length === 1 && dialogResponses[0].cancelled === true && dialogResponses[0].confirmed === undefined,
	JSON.stringify(dialogResponses),
);
vscodeStub.window.showInformationMessage = originalShowInformationMessage;

// Native dialogs are another await boundary. A Markdown export must not operate
// on whichever session happens to be current after the picker closes.
posts.length = 0;
const originalShowSaveDialog = vscodeStub.window.showSaveDialog;
const exportStartEpoch = controller.viewEpoch;
let releaseSaveDialog;
const oldViewExportCommands = [];
const newViewExportCommands = [];
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.client = {
	running: true,
	request: async (command) => {
		oldViewExportCommands.push(command);
		return { success: true };
	},
};
vscodeStub.window.showSaveDialog = () => new Promise((resolve) => { releaseSaveDialog = resolve; });
const staleExport = controller.exportMarkdown(true);
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch = exportStartEpoch + 1;
controller.client = {
	running: true,
	request: async (command) => {
		newViewExportCommands.push(command);
		return { success: true };
	},
};
releaseSaveDialog({ fsPath: path.join(workdir, "stale-export.md"), scheme: "file" });
await staleExport;
check(
	"an export dialog response is discarded after navigation",
	oldViewExportCommands.length === 1 && oldViewExportCommands[0]?.type === "get_messages" && newViewExportCommands.length === 0,
	JSON.stringify({ oldViewExportCommands, newViewExportCommands }),
);
vscodeStub.window.showSaveDialog = originalShowSaveDialog;

// An old attach may need a second RPC to fetch its transcript. If that RPC
// rejects after B has become current, its catch path must not blank B's cache.
const originalEnsureSidecar = controller.ensureSidecar;
const originalRefreshAttachedState = controller.refreshAttachedState;
const originalFetchAttachedStats = controller.fetchAttachedStats;
const originalScheduleChildrenRefresh = controller.scheduleChildrenRefresh;
let rejectOldAttachMessages;
const oldAttachMessages = new Promise((_resolve, reject) => { rejectOldAttachMessages = reject; });
const oldAttachSidecar = {
	connected: true,
	list: async () => [],
	attach: async () => ({ snapshot: { state: { sessionId: "old-attach-session" } } }),
	detach: async () => {},
	getMessages: async () => oldAttachMessages,
	getState: async () => ({}),
	getSessionStats: async () => ({}),
	dispose: () => {},
};
controller.ensureSidecar = async () => oldAttachSidecar;
controller.refreshAttachedState = async () => {};
controller.fetchAttachedStats = async () => "";
controller.scheduleChildrenRefresh = () => {};
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
const oldAttachEpoch = controller.viewEpoch;
const staleAttach = controller.attachViaDaemon("old-attach-active", validPath, oldAttachEpoch);
await new Promise((resolve) => setImmediate(resolve));
const newerAttachment = { activeSessionId: "new-attach-active", sessionPath: validPath, sessionId: "new-attach-session" };
const newerTranscript = [{ role: "assistant", text: "newer transcript must survive" }];
controller.attached = newerAttachment;
controller.cachedMessages = newerTranscript;
controller.viewEpoch += 1;
controller.attachedEpoch = controller.viewEpoch;
rejectOldAttachMessages(new Error("old attach transcript unavailable"));
const staleAttachResult = await staleAttach;
check(
	"a stale attach transcript failure cannot clear the newer view",
	staleAttachResult === false && controller.attached === newerAttachment && controller.cachedMessages === newerTranscript,
	JSON.stringify({ staleAttachResult, attached: controller.attached, cachedMessages: controller.cachedMessages }),
);
controller.ensureSidecar = originalEnsureSidecar;
controller.refreshAttachedState = originalRefreshAttachedState;
controller.fetchAttachedStats = originalFetchAttachedStats;
controller.scheduleChildrenRefresh = originalScheduleChildrenRefresh;

// A navigation begins before its history lookup finishes. That intent must
// invalidate a reconnect attempt from a socket drop, so a timer cannot
// resurrect the old attached session beneath the newly selected view.
const originalResolveHistorySession = controller.resolveHistorySession;
let releaseHistoryResolution;
const pendingHistoryResolution = new Promise((resolve) => { releaseHistoryResolution = resolve; });
let staleReconnectAttaches = 0;
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = { activeSessionId: "reconnect-old-active", sessionPath: validPath, sessionId: "valid-session" };
controller.attachAttemptEpoch = controller.viewEpoch;
controller.sidecar = {
	connected: true,
	attach: async () => {
		staleReconnectAttaches += 1;
		return { snapshot: { messages: [] } };
	},
	detach: async () => {},
	dispose: () => {},
};
controller.resolveHistorySession = () => pendingHistoryResolution;
const explicitNavigation = controller.switchSession(validPath, "valid-session");
await new Promise((resolve) => setImmediate(resolve));
await controller.ensureSidecar();
check(
	"explicit navigation cancels a stale reconnect attempt",
	controller.attachAttempt === null && controller.attachAttemptEpoch === null && staleReconnectAttaches === 0,
	JSON.stringify({ attachAttempt: controller.attachAttempt, attachAttemptEpoch: controller.attachAttemptEpoch, staleReconnectAttaches }),
);
controller.viewEpoch += 1;
releaseHistoryResolution({ id: "valid-session", path: validPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true });
await explicitNavigation;
controller.resolveHistorySession = originalResolveHistorySession;

// A parent release begun by Browse must finish before Back can re-attach that
// same daemon handle. Otherwise the late release unregisters the fresh parent.
const originalQueuedEnsureSidecar = controller.ensureSidecar;
const originalQueuedFetchStats = controller.fetchAttachedStats;
const originalQueuedRefreshState = controller.refreshAttachedState;
const originalQueuedChildrenRefresh = controller.scheduleChildrenRefresh;
let releaseParentDetach;
let parentAttachCalls = 0;
const queuedSidecar = {
	connected: true,
	list: async () => [],
	detach: async () => new Promise((resolve) => { releaseParentDetach = resolve; }),
	attach: async () => {
		parentAttachCalls += 1;
		return { snapshot: { state: { sessionId: "parent-session" }, messages: [] } };
	},
	getState: async () => ({ sessionId: "parent-session" }),
	getSessionStats: async () => ({}),
	dispose: () => {},
};
controller.sidecar = queuedSidecar;
controller.ensureSidecar = async () => queuedSidecar;
controller.fetchAttachedStats = async () => "";
controller.refreshAttachedState = async () => {};
controller.scheduleChildrenRefresh = () => {};
controller.attached = null;
controller.attachedEpoch = null;
controller.pendingDaemonDetaches.clear();
const releasingParent = controller.detachDaemonSession(queuedSidecar, "parent-live-handle");
await new Promise((resolve) => setImmediate(resolve));
const waitingParentAttach = controller.attachViaDaemon("parent-live-handle", validPath, controller.viewEpoch);
await new Promise((resolve) => setImmediate(resolve));
check("a parent attach waits for an in-flight release of the same daemon handle", parentAttachCalls === 0, String(parentAttachCalls));
releaseParentDetach();
await releasingParent;
await waitingParentAttach;
check("the parent attach proceeds only after the old release completes", parentAttachCalls === 1, String(parentAttachCalls));
controller.ensureSidecar = originalQueuedEnsureSidecar;
controller.fetchAttachedStats = originalQueuedFetchStats;
controller.refreshAttachedState = originalQueuedRefreshState;
controller.scheduleChildrenRefresh = originalQueuedChildrenRefresh;

// Attach snapshots may omit a UUID and reveal it later in get_state. The
// displayed identity must stay fixed so the webview does not clear a draft in
// the middle of that one attached session.
const originalIdentityEnsureSidecar = controller.ensureSidecar;
const originalIdentityFetchStats = controller.fetchAttachedStats;
const originalIdentityRefreshState = controller.refreshAttachedState;
const originalIdentityChildrenRefresh = controller.scheduleChildrenRefresh;
const identitySidecar = {
	connected: true,
	list: async () => [],
	attach: async () => ({ snapshot: { state: {}, messages: [] } }),
	getState: async () => ({ sessionId: "late-daemon-uuid" }),
	getSessionStats: async () => ({}),
	detach: async () => {},
	dispose: () => {},
};
controller.sidecar = identitySidecar;
controller.ensureSidecar = async () => identitySidecar;
controller.fetchAttachedStats = async () => "";
controller.refreshAttachedState = async function () {
	const attached = this.attached;
	const state = await identitySidecar.getState(attached.activeSessionId);
	if (this.isCurrentAttachment(attached)) this.rentedState = state;
};
controller.scheduleChildrenRefresh = () => {};
controller.attached = null;
controller.attachedEpoch = null;
const identityEpoch = controller.viewEpoch;
await controller.attachViaDaemon("identity-live-handle", validPath, identityEpoch);
await new Promise((resolve) => setImmediate(resolve));
check("an attached session keeps one stable webview identity when get_state reveals its UUID", controller.attached?.sessionId === "valid-session", JSON.stringify(controller.attached));
controller.ensureSidecar = originalIdentityEnsureSidecar;
controller.fetchAttachedStats = originalIdentityFetchStats;
controller.refreshAttachedState = originalIdentityRefreshState;
controller.scheduleChildrenRefresh = originalIdentityChildrenRefresh;

// --- choosing a model to retry a refused compaction --------------------------
// Name-free on purpose: a refusal is one model's verdict on one thread, so the
// only thing checkable up front is whether a candidate could hold the thread.
// Synthetic names here — if this ever starts depending on a real model id, it
// has overfitted and these fixtures will not save it.
{
	const pick = SessionController.pickCompactionFallback;
	const current = { provider: "vendor-a", id: "big", contextWindow: 1_000_000 };
	const catalogue = [
		current,
		{ provider: "vendor-a", id: "small", contextWindow: 200_000 },
		{ provider: "vendor-b", id: "roomy", contextWindow: 2_000_000 },
		{ provider: "vendor-b", id: "equal", contextWindow: 1_000_000 },
	];
	const none = new Set();
	check("the roomiest qualifying model wins and skips the current one",
		pick(catalogue, current, none)?.id === "roomy",
		JSON.stringify(pick(catalogue, current, none)));
	check("a smaller window and already-tried models are skipped",
		pick(catalogue, current, new Set(["vendor-b/roomy"]))?.id === "equal",
		JSON.stringify(pick(catalogue, current, new Set(["vendor-b/roomy"]))));
	check("nothing qualifying means no offer",
		pick(catalogue, current, new Set(["vendor-b/roomy", "vendor-b/equal"])) === null);
	check("an empty catalogue yields no offer", pick([], current, none) === null);
}

// --- the offer is a host-issued capability, not a webview-composed one -------
{
	const notices = [];
	const originalBroadcast = controller.broadcast;
	controller.broadcast = (message) => { if (message.type === "notice") notices.push(message); };
	let ran = 0;
	const offered = controller.offerNoticeAction("Compact with something", async () => { ran += 1; });
	check("an offered action carries an opaque id", typeof offered.id === "string" && offered.id.length > 20, offered.id);
	await controller.runNoticeAction("not-an-offer-we-made");
	check("a forged notice action is ignored", ran === 0, String(ran));
	await controller.runNoticeAction(offered.id);
	check("the host's own action runs", ran === 1, String(ran));
	await controller.runNoticeAction(offered.id);
	check("an action is one-shot", ran === 1, String(ran));
	controller.broadcast = originalBroadcast;
}

// --- compaction failures the operator can act on -----------------------------
// A refusal and a context overflow are both about the model, not the thread,
// and the raw provider text never says so. Measured on a real 6,500-message
// thread: claude-opus-5 refused it through two providers while claude-sonnet-5
// summarized the same content fine, and claude-haiku-4-5 rejected 484,555
// tokens against its 200,000 ceiling.
{
	const notices = [];
	const originalBroadcast = controller.broadcast;
	const originalStillRunning = controller.compactionStillRunning;
	controller.broadcast = (message) => { if (message.type === "notice") notices.push(message); };
	controller.compactionStillRunning = async () => false;

	await controller.reportCompactFailure("Turn prefix summarization failed: Model refused to respond (refusal)");
	check("a refusal keeps the provider detail and tells the operator to switch",
		/Model refused to respond/.test(notices.at(-1)?.text ?? "") && /switch model/i.test(notices.at(-1)?.text ?? ""),
		notices.at(-1)?.text);

	await controller.reportCompactFailure("Summarization failed: prompt is too long: 484555 tokens > 200000 maximum");
	check("a context overflow points at a bigger window", /bigger window/i.test(notices.at(-1)?.text ?? ""), notices.at(-1)?.text);

	await controller.reportCompactFailure("Summarization failed: Provider overloaded");
	check("an unrelated failure gets no invented advice",
		(notices.at(-1)?.text ?? "") === "Compaction failed: Summarization failed: Provider overloaded", notices.at(-1)?.text);

	// A refusal that has somewhere to go carries the offer with it.
	controller.compactionStillRunning = async () => false;
	const originalFetchModels = controller.fetchAvailableModels;
	const originalSetModel = controller.setModel;
	const originalCompact = controller.compact;
	controller.state = { model: { provider: "vendor-a", id: "big", contextWindow: 1_000_000 } };
	controller.fetchAvailableModels = async () => ([
		{ provider: "vendor-a", id: "big", contextWindow: 1_000_000 },
		{ provider: "vendor-b", id: "roomy", contextWindow: 2_000_000, name: "Roomy" },
		{ provider: "vendor-c", id: "tiny", contextWindow: 100_000 },
	]);
	notices.length = 0;
	await controller.reportCompactFailure("Turn prefix summarization failed: Model refused to respond (refusal)");
	const offer = notices.at(-1);
	check("a refusal offers a retry with the roomiest model",
		offer?.action?.label === "Compact with Roomy", JSON.stringify(offer?.action));

	// Running it swaps the model, compacts, and puts the operator's model back.
	const calls = [];
	controller.setModel = async (provider, id) => { calls.push(`set:${provider}/${id}`); };
	controller.compact = async () => { calls.push("compact"); };
	await controller.runNoticeAction(offer.action.id);
	check("the retry compacts with the offered model then restores the original",
		calls.join(" > ") === "set:vendor-b/roomy > compact > set:vendor-a/big", calls.join(" > "));

	// A second refusal must not re-offer the model that just refused.
	notices.length = 0;
	await controller.reportCompactFailure("Turn prefix summarization failed: Model refused to respond (refusal)");
	check("a model already tried is not offered again",
		notices.at(-1)?.action?.label !== "Compact with Roomy", notices.at(-1)?.action?.label ?? "(no offer)");

	// Nothing roomy enough left: report the failure without an offer we cannot honour.
	controller.fetchAvailableModels = async () => ([{ provider: "vendor-c", id: "tiny", contextWindow: 100_000 }]);
	notices.length = 0;
	await controller.reportCompactFailure("Turn prefix summarization failed: Model refused to respond (refusal)");
	check("no viable model means no button, and the text says what to do",
		!notices.at(-1)?.action && /switch model/i.test(notices.at(-1)?.text ?? ""), JSON.stringify(notices.at(-1)));

	controller.fetchAvailableModels = originalFetchModels;
	controller.setModel = originalSetModel;
	controller.compact = originalCompact;
	controller.state = null;
	controller.compactionModelsTried.clear();
	controller.broadcast = originalBroadcast;
	controller.compactionStillRunning = originalStillRunning;
}

// History rank freezes while a session is running, and operator archive is
// an overlay — daemon lifecycle "archived" is not the same thing.
{
	const live = path.join(workdir, "hist-live.jsonl");
	const other = path.join(workdir, "hist-other.jsonl");
	fs.writeFileSync(live, '{"type":"session","id":"root"}\n');
	fs.writeFileSync(other, '{"type":"session","id":"root"}\n');
	const older = "2026-01-01T00:00:00.000Z";
	const newer = "2026-01-02T00:00:00.000Z";
	const catalog = [
		{
			sessionId: "hist-live",
			sessionFile: live,
			cwd: workdir,
			sessionName: "running chat",
			created: older,
			modified: newer,
			lastActivityAt: newer,
			lifecycle: "live",
			activeSessionId: "live-handle",
			rosterStatus: "running",
		},
		{
			sessionId: "hist-other",
			sessionFile: other,
			cwd: workdir,
			sessionName: "waiting chat",
			created: older,
			modified: older,
			lastActivityAt: older,
			lifecycle: "live",
			rosterStatus: "idle",
		},
	];
	let rows = controller.rowsFromCatalog(catalog);
	check("a first-seen running session keeps its catalog time as the frozen rank",
		rows.find((r) => r.id === "hist-live")?.sortMs === Date.parse(newer));
	const frozen = rows.find((r) => r.id === "hist-live")?.sortMs;
	catalog[0] = { ...catalog[0], modified: "2026-01-03T00:00:00.000Z", lastActivityAt: "2026-01-03T00:00:00.000Z" };
	rows = controller.rowsFromCatalog(catalog);
	check("mid-turn catalog activity does not reshuffle a running row",
		rows.find((r) => r.id === "hist-live")?.sortMs === frozen, String(rows.find((r) => r.id === "hist-live")?.sortMs));
	catalog[0] = { ...catalog[0], rosterStatus: "idle", activeSessionId: "live-handle" };
	rows = controller.rowsFromCatalog(catalog);
	check("finishing a turn advances the rank past older idle rows",
		rows[0]?.id === "hist-live" && (rows[0]?.sortMs ?? 0) >= (rows[1]?.sortMs ?? 0),
		rows.map((r) => `${r.id}:${r.sortMs}`).join("|"));
	check("a finished row the operator has not opened is unread",
		rows.find((r) => r.id === "hist-live")?.unreadComplete === true);
	controller.markHistoryArchived(live);
	rows = controller.rowsFromCatalog(catalog);
	check("operator archive flags the row instead of dropping it",
		rows.find((r) => r.id === "hist-live")?.archived === true);
	controller.lastHistory = rows;
	controller.actionHistory = rows;
	await controller.unarchiveSession(live, "hist-live");
	check("the history action removes an operator archive overlay",
		controller.rowsFromCatalog(catalog).find((r) => r.id === "hist-live")?.archived !== true);

	controller.markHistoryArchived(live);
	const previousAttached = controller.attached;
	const previousAttachedEpoch = controller.attachedEpoch;
	controller.attached = { activeSessionId: "live-handle", sessionPath: live, sessionId: "hist-live" };
	controller.attachedEpoch = controller.viewEpoch;
	posts.length = 0;
	controller.onAgentEvent({ type: "message_start", message: { role: "user", text: "continue archived work" } });
	check("a received prompt moves its session out of Archive",
		!controller.historyArchived.has(controller.historyPathKey(live)) &&
		!memory.get("brief.historyUi")?.archived.includes(controller.historyPathKey(live)) &&
		posts.some((message) => message.type === "history"),
		JSON.stringify(posts));
	controller.attached = previousAttached;
	controller.attachedEpoch = previousAttachedEpoch;
	check("daemon lifecycle archived without the overlay stays in the active list",
		controller.rowsFromCatalog([{
			sessionId: "hist-other",
			sessionFile: other,
			cwd: workdir,
			sessionName: "daemon archived",
			created: older,
			modified: older,
			lifecycle: "archived",
			rosterStatus: "inactive",
		}]).some((r) => r.id === "hist-other" && r.archived !== true));
	const parentWithRunningChild = controller.rowsFromCatalog([
		{ ...catalog[1], rosterStatus: "idle", activeSessionId: "parent-handle" },
		{
			sessionId: "hist-child",
			activeSessionId: "child-handle",
			parentActiveSessionId: "parent-handle",
			rlmDepth: 1,
			rosterStatus: "running",
		},
	])[0];
	check("a running subagent classifies its history parent as running",
		parentWithRunningChild?.status === "running" && parentWithRunningChild.running === false,
		JSON.stringify(parentWithRunningChild));
}

{
	const idlePath = path.join(workdir, "hist-archive-now.jsonl");
	fs.writeFileSync(idlePath, '{"type":"session","id":"root"}\n');
	controller.lastHistory = [{
		id: "hist-archive-now",
		path: idlePath,
		cwd: workdir,
		timestamp: new Date().toISOString(),
		inWorkspace: true,
	}];
	controller.actionHistory = controller.lastHistory;
	controller.sidecar = { connected: true, list: async () => [], request: async () => ({}), dispose: () => {} };
	posts.length = 0;
	let refreshes = 0;
	controller.scheduleHistoryRefresh = () => { refreshes += 1; };
	const pending = controller.archiveSession(idlePath, "hist-archive-now");
	const painted = posts.find((m) => m.type === "history");
	check("archive paints the overlay before the file write finishes",
		painted?.sessions?.find((r) => r.id === "hist-archive-now")?.archived === true,
		JSON.stringify(painted?.sessions?.map((r) => ({ id: r.id, archived: r.archived }))));
	await pending;
	check("successful archive coalesces the catalog refresh", refreshes === 1, String(refreshes));
	check("successful archive does not toast",
		!posts.some((m) => m.type === "notice" && String(m.text ?? "").includes("Session archived")),
		JSON.stringify(posts.filter((m) => m.type === "notice")));
}

{
	const currentPath = path.join(workdir, "hist-current-archive.jsonl");
	const nextPath = path.join(workdir, "hist-next-archive.jsonl");
	fs.writeFileSync(currentPath, '{"type":"session","id":"root"}\n');
	fs.writeFileSync(nextPath, '{"type":"session","id":"root"}\n');
	controller.attached = { activeSessionId: "current-archive-live", sessionPath: currentPath, sessionId: "hist-current-archive" };
	controller.lastHistory = [
		{ id: "hist-current-archive", path: currentPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true, sortMs: 10 },
		{ id: "hist-next-archive", path: nextPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true, sortMs: 20 },
	];
	controller.actionHistory = controller.lastHistory;
	let killed = false;
	let switched;
	controller.sidecar = {
		connected: true,
		list: async () => killed ? [] : [{ sessionFile: currentPath, activeSessionId: "current-archive-live" }],
		request: async (request) => { if (request.type === "kill") killed = true; return {}; },
		dispose: () => {},
	};
	controller.switchSession = async (sessionPath, sessionId) => {
		switched = { sessionPath, sessionId };
		controller.attached = { activeSessionId: "next-archive-live", sessionPath, sessionId };
	};
	await controller.archiveSession(currentPath, "hist-current-archive");
	check("current archive opens the newest remaining session and stops the archived worker",
		killed && switched?.sessionPath === nextPath && switched?.sessionId === "hist-next-archive", JSON.stringify({ killed, switched }));

	const emptyPath = path.join(workdir, "hist-current-archive-empty.jsonl");
	fs.writeFileSync(emptyPath, '{"type":"session","id":"root"}\n');
	controller.attached = { activeSessionId: "current-archive-empty-live", sessionPath: emptyPath, sessionId: "hist-current-archive-empty" };
	controller.lastHistory = [{ id: "hist-current-archive-empty", path: emptyPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true }];
	controller.actionHistory = controller.lastHistory;
	killed = false;
	let created = false;
	controller.sidecar = {
		connected: true,
		list: async () => killed ? [] : [{ sessionFile: emptyPath, activeSessionId: "current-archive-empty-live" }],
		request: async (request) => { if (request.type === "kill") killed = true; return {}; },
		dispose: () => {},
	};
	controller.newSession = async () => {
		created = true;
		controller.attached = { activeSessionId: "new-archive-live", sessionPath: path.join(workdir, "new-archive.jsonl"), sessionId: "new-archive" };
	};
	await controller.archiveSession(emptyPath, "hist-current-archive-empty");
	check("current archive creates a new session when no history remains", killed && created, JSON.stringify({ killed, created }));

	const failedPath = path.join(workdir, "hist-current-archive-failed.jsonl");
	fs.writeFileSync(failedPath, '{"type":"session","id":"root"}\n');
	controller.attached = { activeSessionId: "current-archive-failed-live", sessionPath: failedPath, sessionId: "hist-current-archive-failed" };
	controller.lastHistory = [
		{ id: "hist-current-archive-failed", path: failedPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true },
		{ id: "hist-next-after-failed", path: nextPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true },
	];
	controller.actionHistory = controller.lastHistory;
	let touchedAfterFailedSwitch = false;
	controller.sidecar = { connected: true, list: async () => { touchedAfterFailedSwitch = true; return []; }, dispose: () => {} };
	controller.switchSession = async () => {};
	posts.length = 0;
	await controller.archiveSession(failedPath, "hist-current-archive-failed");
	check("a failed current-session switch leaves the worker and transcript untouched",
		!touchedAfterFailedSwitch && fs.readFileSync(failedPath, "utf8") === '{"type":"session","id":"root"}\n' &&
		posts.some((m) => m.type === "notice" && m.level === "warning"), JSON.stringify(posts));
}

// The last lifecycle fixture intentionally leaves a lightweight RPC stand-in
// installed; dispose() owns a real client's stop() method, so remove it first.
controller.client = null;
controller.dispose();
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? "\nPASS session-controller boundary" : `\n${failed} session-controller boundary checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
