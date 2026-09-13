import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as esbuild from "esbuild";
const require = createRequire(import.meta.url);
const { vscodeStub: vscode } = require("./vscode-stub.cjs");
let opened;
vscode.workspace.openTextDocument = async (uri) => { opened = uri.fsPath; return { uri }; };
vscode.window.showWarningMessage = async () => "儲存這些附件並送出";
const ref = { id: "one", kind: "text", label: "Text 1", start: 2, end: 10, status: "ready", text: "cached" };
const payload = { text: "a [Text 1] z", images: [], selections: [], streamingBehavior: "steer", sessionId: "session", attachments: [ref] };

const { SessionController } = require("../dist/controller.cjs");
const memory = new Map();
const state = { get: (key, fallback) => memory.get(key) ?? fallback, update: async (key, value) => memory.set(key, value) };
let saveListener;
vscode.workspace.onDidSaveTextDocument = (listener) => { saveListener = listener; return { dispose() {} }; };
const controller = new SessionController({ globalState: state, workspaceState: state, subscriptions: [], extensionUri: { fsPath: process.cwd() } }, { appendLine() {}, append() {} });
controller.attached = { sessionId: "send-session", activeSessionId: "live", sessionPath: "/send-session.jsonl" };
controller.attachedEpoch = controller.viewEpoch;
const posts = []; controller.attach({ post: (message) => posts.push(message) });
let sent = [];
controller.ensureSidecar = async () => ({ prompt: async (...args) => sent.push(args) });
await controller.createAttachment("send-session", { ...ref, id: "send-ref" }, (message) => posts.push(message));
await controller.openAttachment("send-session", "send-ref");
const sendPath = opened;
let releaseSave;
const dirtyDoc = { uri: { fsPath: sendPath, scheme: "file" }, isDirty: true, save: () => new Promise((resolve) => { releaseSave = async () => { await fs.writeFile(sendPath, "NEW"); dirtyDoc.isDirty = false; resolve(true); }; }) };
let unrelatedSaves = 0;
const unrelatedDoc = { uri: { fsPath: "/unrelated-dirty.txt", scheme: "file" }, isDirty: true, save: async () => { unrelatedSaves++; return true; } };
vscode.workspace.textDocuments = [dirtyDoc, unrelatedDoc];
const sendPayload = { ...payload, sessionId: "send-session", clientRequestId: "send-request", attachments: [{ ...ref, id: "send-ref" }] };
const sending = controller.prompt(sendPayload);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sent.length, 0, "must await referenced save");
await releaseSave(); await sending;
assert.equal(sent[0][1], "a NEW z");
assert.equal(posts.find((post) => post.type === "promptAccepted").recallText, "a NEW z");
assert.equal(await controller.composerAttachments.draftText("send-session", { text: payload.text, attachments: sendPayload.attachments }), "a NEW z");
dirtyDoc.isDirty = true; sent = []; posts.length = 0;
const stale = controller.prompt(sendPayload);
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 2;
await releaseSave(); await stale;
assert.equal(sent.length, 0, "A to B to A must reject after save");
assert.ok(posts.some((post) => post.type === "promptRejected"));


// Outgoing async flush keeps A's captured key, even after navigation to B.
controller.sessionKey = () => "send-session";
controller.draftKey = () => `draft:${controller.sessionKey()}`;
const nativeDraftText = controller.composerAttachments.draftText.bind(controller.composerAttachments);
let finishRead;
controller.composerAttachments.draftText = () => new Promise((resolve) => { finishRead = resolve; });
const flush = controller.persistDraft("cached", "send-session", { text: payload.text, attachments: sendPayload.attachments });
controller.sessionKey = () => "other-session";
controller.viewEpoch++;
finishRead("outgoing latest"); await flush;
assert.equal(memory.get("draft:send-session"), "outgoing latest");
assert.equal(memory.get("draft:other-session"), undefined);
controller.composerAttachments.draftText = nativeDraftText;
await fs.writeFile(sendPath, "native save");
await saveListener({ uri: { scheme: "file", fsPath: sendPath } });
assert.equal(memory.get("draft:send-session"), "a native save z", "native Save refreshes sticky draft without composer input");
controller.sessionKey = () => "send-session";
await controller.persistDraft("", "send-session");
await fs.writeFile(sendPath, "must not resurrect");
await saveListener({ uri: { scheme: "file", fsPath: sendPath } });
assert.equal(memory.get("draft:send-session"), undefined, "native Save after clear cannot resurrect draft");
controller.attachedEpoch = controller.viewEpoch;
for (const choice of ["取消", "false", "throw", "missing"]) {
	posts.length = 0; sent = [];
	dirtyDoc.isDirty = choice !== "missing";
	vscode.window.showWarningMessage = async () => choice === "取消" ? "取消" : "儲存這些附件並送出";
	dirtyDoc.save = async () => { if (choice === "throw") throw new Error("save error"); return false; };
	if (choice === "missing") await fs.rm(sendPath);
	await controller.prompt(sendPayload);
	assert.equal(sent.length, 0);
	assert.ok(posts.some((post) => post.type === "promptRejected"), choice);
}

assert.equal(unrelatedSaves, 0, "daemon sends never save unrelated dirty documents");
controller.dispose();
console.log("PASS controller waits for save, sends newest content/recall, rejects stale epoch");

const build = await esbuild.build({ entryPoints: ["src/composer-attachments.ts"], bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false });
const mod = { exports: {} };
new Function("require", "module", "exports", build.outputFiles[0].text)(require, mod, mod.exports);
const store = new mod.exports.ComposerAttachments();
await store.create("owner", ref);
await assert.rejects(store.create("owner", ref), /already exists/);
await assert.rejects(store.open("forged", ref.id), /unavailable/);
await store.open("owner", ref.id);
const file = opened;
assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
assert.equal((await fs.stat((await import("node:path")).dirname(file))).mode & 0o777, 0o700);
await fs.writeFile(file, "latest");
assert.equal(await store.draftText("owner", { text: payload.text, attachments: [ref] }), "a latest z");
const secondStore = new mod.exports.ComposerAttachments();
assert.equal((await secondStore.expand({ ...payload, sessionId: "owner" })).text, "a latest z");
await fs.writeFile(file, "bad\0text");
await assert.rejects(store.expand({ ...payload, sessionId: "owner" }), /NUL/);
await assert.rejects(store.draftText("owner", { text: payload.text, attachments: [ref] }), /NUL/);
await fs.writeFile(file, "x".repeat(200_000));
await assert.rejects(store.expand({ ...payload, sessionId: "owner" }), /200,000/);
await fs.unlink(file); await fs.symlink("/etc/hosts", file);
await assert.rejects(store.expand({ ...payload, sessionId: "owner" }), /regular file/);
await fs.unlink(file);
const image = { id: "image", label: "Image 3", kind: "image", start: 0, end: 9, status: "ready", image: { data: "iVBORw0KGgo=", mimeType: "image/png" } };
await store.create("owner", image);
const expanded = await store.expand({ ...payload, sessionId: "owner", text: "[Image 3]", attachments: [image] });
assert.equal(expanded.text, "[Image 3 — attached image 1]");
assert.equal(expanded.images[0].data, "iVBORw0KGgo=");
assert.equal(await store.draftText("owner", { text: "[Image 3]", attachments: [image] }), "");
console.log("PASS owner capabilities, private tmp permissions, module lifetime, latest draft, symlink/size refusal, image ordinals");

// Own-RPC uses the same fake request boundary as crosswire.test.mjs.
const rpc = new SessionController({ globalState: state, workspaceState: state, subscriptions: [], extensionUri: { fsPath: process.cwd() } }, { appendLine() {}, append() {} });
const rpcPosts = [], rpcSent = [];
rpc.attach({ post: (message) => rpcPosts.push(message) });
let liveSessionId = "rpc-A";
rpc.client = { running: true, request: async (command) => {
	if (command.type === "get_state") return { success: true, data: { sessionId: liveSessionId, sessionFile: `/${liveSessionId}.jsonl` } };
	if (command.type === "prompt") rpcSent.push(command);
	return { success: true, data: {} };
} };
rpc.ensureStarted = async () => {};
rpc.state = { sessionId: "rpc-A", sessionFile: "/rpc-A.jsonl" };
rpc.attached = null; rpc.attachedEpoch = null; rpc.reachable = true;
await rpc.createAttachment("rpc-A", { ...ref, id: "rpc-ref" }, (message) => rpcPosts.push(message));
await rpc.openAttachment("rpc-A", "rpc-ref");
const rpcPath = opened;
const rpcPayload = { ...payload, sessionId: "rpc-A", clientRequestId: "rpc-request", attachments: [{ ...ref, id: "rpc-ref" }] };
let finishRpcSave;
const rpcDoc = { uri: { scheme: "file", fsPath: rpcPath }, isDirty: true, save: () => new Promise((resolve) => {
	finishRpcSave = async () => { await fs.writeFile(rpcPath, "RPC NEW"); rpcDoc.isDirty = false; resolve(true); };
}) };
vscode.workspace.textDocuments = [rpcDoc, unrelatedDoc];
vscode.window.showWarningMessage = async () => "儲存這些附件並送出";
const rpcSending = rpc.prompt(rpcPayload);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rpcSent.length, 0, "own-RPC waits for referenced save");
await finishRpcSave(); await rpcSending;
assert.equal(rpcSent.length, 1);
assert.equal(rpcSent[0].message, "a RPC NEW z");
assert.equal(rpcPosts.find((message) => message.type === "promptAccepted").recallText, "a RPC NEW z");
const navigateABA = () => {
	rpc.state = { sessionId: "rpc-B" }; liveSessionId = "rpc-B"; rpc.viewEpoch++;
	rpc.state = { sessionId: "rpc-A" }; liveSessionId = "rpc-A"; rpc.viewEpoch++;
};
rpcSent.length = 0; rpcPosts.length = 0; rpcDoc.isDirty = true;
const saveABA = rpc.prompt(rpcPayload);
await new Promise((resolve) => setImmediate(resolve));
navigateABA();
await finishRpcSave(); await saveABA;
assert.equal(rpcSent.length, 0, "own-RPC save ABA sends nothing");
assert.ok(rpcPosts.some((message) => message.type === "promptRejected" && message.clientRequestId === "rpc-request"));

// Delay the actual owned-file read, not the runtime fake, then navigate A→B→A.
const nodeFs = require("node:fs/promises");
const readFile = nodeFs.readFile;
let allowRead, enteredRead;
const readGate = new Promise((resolve) => { allowRead = resolve; });
const readEntered = new Promise((resolve) => { enteredRead = resolve; });
nodeFs.readFile = async (...args) => {
	if (args[0] === rpcPath) { enteredRead(); await readGate; }
	return readFile(...args);
};
rpcPosts.length = 0;
try {
	const readABA = rpc.prompt(rpcPayload);
	await readEntered;
	assert.equal(rpcSent.length, 0, "own-RPC waits for attachment read");
	navigateABA(); allowRead(); await readABA;
	assert.equal(rpcSent.length, 0, "own-RPC read ABA sends nothing");
	assert.ok(rpcPosts.some((message) => message.type === "promptRejected" && message.clientRequestId === "rpc-request"));
} finally { nodeFs.readFile = readFile; allowRead(); }
assert.equal(unrelatedSaves, 0, "neither daemon nor own-RPC saves unrelated dirty documents");
await fs.rm(rpcPath); rpc.client = null; rpc.dispose();
console.log("PASS own-RPC deferred save sends NEW, save/read ABA rejects, unrelated dirty documents never save");
