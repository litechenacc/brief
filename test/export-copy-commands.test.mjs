/** Export/copy host tests. Runtime and VS Code dialogs are test doubles, not live runtime verification. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { vscodeStub: vscode } = require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");
vscode.env.clipboard = {};
const storage = { get: (_key, fallback) => fallback, update: async () => {} };
const controllers = [];
let writes, copied, notices, requests, saves, confirmations, infos;
const body = "  **Reply**\n\n```js\n  code();\n```\n";
const reply = (text, extra = {}) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], ...extra });
function setup(transport, messages = [reply(body)]) {
	writes = []; copied = []; notices = []; requests = []; saves = []; confirmations = []; infos = [];
	vscode.env.clipboard.writeText = async text => { copied.push(text); };
	vscode.window.showQuickPick = async items => items[0];
	vscode.window.showSaveDialog = async options => { saves.push(options); return vscode.Uri.file("/tmp/export-test.md"); };
	vscode.window.showWarningMessage = async (...args) => { confirmations.push(args); return "Replace"; };
	vscode.window.showInformationMessage = async text => { infos.push(text); };
	vscode.workspace.fs.stat = async () => { throw Object.assign(new Error("missing"), { code: "FileNotFound" }); };
	vscode.workspace.fs.writeFile = async (uri, bytes) => { writes.push({ uri, text: Buffer.from(bytes).toString() }); };
	const c = new SessionController({ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: storage, workspaceState: storage }, { appendLine() {} });
	controllers.push(c);
	c.broadcast = message => notices.push(message);
	c.ensureStarted = async () => { throw new Error("must not start a session"); };
	c.state = { sessionId: "source", sessionName: "source" };
	c.client = { running: true, stop() {}, request: async request => { requests.push(request); return { success: true, data: { messages } }; } };
	c.ensureSidecar = async () => ({ getMessages: async id => { requests.push({ type: "get_messages", activeSessionId: id }); return messages; } });
	if (transport === "daemon") {
		c.attached = { activeSessionId: "source-handle", sessionId: "source", sessionPath: "/source.jsonl" };
		c.attachedEpoch = c.viewEpoch;
		c.rentedState = c.state;
	}
	return c;
}
function noSuccess() { assert.equal(infos.length, 0); assert.equal(notices.some(n => /copied/.test(n.text)), false); }
function failed() { assert.equal(notices.some(n => n.level === "error"), true); noSuccess(); }
for (const transport of ["rpc", "daemon"]) {
	let c = setup(transport, [reply("old"), reply(body, { content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: body }, { type: "toolCall", name: "secret-tool" }] }), reply("", { content: [{ type: "toolCall" }] }), reply("   "), reply("unfinished", { stopReason: "aborted" }), reply("failed", { stopReason: "error" }), { role: "toolResult", content: "secret-result" }]);
	c.streaming = true;
	c.cachedMessages = [reply("wrong cached session")];
	await c.copyLastReply();
	assert.deepEqual(copied, [body]);
	assert.equal(requests[0].type, "get_messages");
	if (transport === "daemon") assert.equal(requests[0].activeSessionId, "source-handle");
	assert.match(notices.at(-1).text, /copied/);

	c = setup(transport, [reply("prior"), reply("completed pre-tool body", { stopReason: "toolUse" })]);
	await c.copyLastReply(); assert.deepEqual(copied, ["completed pre-tool body"]);
	for (const messages of [[], [reply("  ")], [{ role: "user", content: "not assistant" }]]) {
		c = setup(transport, messages); await c.copyLastReply();
		assert.equal(copied.length, 0); assert.match(notices.at(-1).text, /No completed reply/);
	}
	c = setup(transport); vscode.env.clipboard.writeText = async () => { throw new Error("clipboard unavailable"); };
	await c.copyLastReply(); failed();
	c = setup(transport); let complete;
	vscode.env.clipboard.writeText = () => new Promise(resolve => { complete = resolve; });
	const copying = c.copyLastReply();
	await new Promise(resolve => setImmediate(resolve));
	noSuccess(); complete(); await copying; assert.match(notices.at(-1).text, /copied/);

	const messages = [
		{ role: "user", content: [{ type: "text", text: "branch prompt" }, { type: "image", data: "image-secret" }] },
		reply("answer", { content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "reasoning" }, { type: "toolCall", id: "tc", name: "bash", arguments: { command: "echo summary" } }] }),
		{ role: "toolResult", toolCallId: "tc", toolName: "bash", content: [{ type: "text", text: "SECRET_RESULT" }] },
	];
	for (const mode of ["md-tools", "md-clean"]) {
		c = setup(transport, structuredClone(messages)); c.streaming = true;
		vscode.window.showQuickPick = async items => { assert.equal(items.length, 2); return items.find(item => item.mode === mode); };
		await c.exportChat();
		assert.equal(writes.length, 1); assert.equal(infos.length, 1); assert.equal(confirmations.length, 0);
		const md = writes[0].text;
		for (const text of ["branch prompt", "answer", "reasoning", "1 image(s) attached"]) assert.ok(md.includes(text));
		for (const text of ["SECRET_RESULT", "image-secret"]) assert.ok(!md.includes(text));
		assert.equal(md.includes("**bash**"), mode === "md-tools");
	}
	c = setup(transport, []); await c.exportMarkdown(false); assert.equal(writes.length, 1);
	c = setup(transport); vscode.window.showQuickPick = async () => undefined;
	await c.exportChat(); assert.equal(requests.length, 0); assert.equal(writes.length, 0);
	c = setup(transport); vscode.window.showSaveDialog = async () => undefined;
	await c.exportChat(); assert.equal(writes.length, 0); noSuccess();
	for (const answer of [undefined, "Replace"]) {
		c = setup(transport); vscode.workspace.fs.stat = async () => ({ type: 1 });
		vscode.window.showWarningMessage = async (...args) => { confirmations.push(args); return answer; };
		await c.exportChat(); assert.equal(confirmations.length, 1); assert.equal(confirmations[0][1].modal, true);
		assert.equal(writes.length, answer === "Replace" ? 1 : 0);
	}
	c = setup(transport); vscode.workspace.fs.writeFile = async () => { throw new Error("write denied"); };
	await c.exportChat(); failed();
	c = setup(transport); vscode.workspace.fs.stat = async () => { throw Object.assign(new Error("permission denied"), { code: "NoPermissions" }); };
	await c.exportChat(); failed(); assert.equal(writes.length, 0);
	const snapshot = [reply("snapshot")]; c = setup(transport, snapshot);
	vscode.window.showSaveDialog = async () => { snapshot.push(reply("later")); return vscode.Uri.file("/tmp/snapshot.md"); };
	await c.exportChat(); assert.ok(writes[0].text.includes("snapshot")); assert.ok(!writes[0].text.includes("later"));

	for (const method of ["exportChat", "copyLastReply"]) {
		c = setup(transport); c.observingId = "observed";
		await c[method](); assert.equal(requests.length, 0); assert.equal(copied.length + writes.length, 0); noSuccess();
		c = setup(transport);
		if (transport === "rpc") c.client.request = async () => ({ success: false, error: "read failure" });
		else c.ensureSidecar = async () => ({ getMessages: async () => { throw new Error("read failure"); } });
		await c[method](); failed(); assert.equal(copied.length + writes.length, 0);
		c = setup(transport);
		const navigate = async () => { c.viewEpoch++; return [reply("wrong session")]; };
		if (transport === "rpc") c.client.request = async () => ({ success: true, data: { messages: await navigate() } });
		else c.ensureSidecar = async () => ({ getMessages: navigate });
		await c[method](); assert.equal(copied.length + writes.length + saves.length, 0); noSuccess();
	}
	for (const stage of ["format", "save", "overwrite"]) {
		c = setup(transport);
		if (stage === "format") vscode.window.showQuickPick = async items => { c.viewEpoch++; return items[0]; };
		if (stage === "save") vscode.window.showSaveDialog = async () => { c.viewEpoch++; return vscode.Uri.file("/tmp/wrong.md"); };
		if (stage === "overwrite") {
			vscode.workspace.fs.stat = async () => ({ type: 1 });
			vscode.window.showWarningMessage = async () => { c.viewEpoch++; return "Replace"; };
		}
		await c.exportChat(); assert.equal(writes.length, 0); noSuccess();
	}
	console.log(`PASS export/copy ${transport}: bodies, read/write failures, snapshot, dialogs, read-only, navigation`);
}
let c = setup("rpc"); c.client = null; await c.copyLastReply(); failed();
c = setup("daemon"); c.ensureSidecar = async () => { c.viewEpoch++; return { getMessages: async () => { throw new Error("stale request"); } }; };
await c.copyLastReply(); assert.equal(copied.length + notices.length, 0);
for (const controller of controllers) controller.dispose();
console.log("PASS export/copy disconnected session and late daemon connection");
