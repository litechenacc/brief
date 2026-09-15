/** Read-only statistics: host transport, scope, missing values and stale results. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");
const built = await esbuild.build({ entryPoints: ["src/shared/webview-message.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { parseWebviewMessage } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
for (const kind of ["usage", "context", "session"]) {
 assert.deepEqual(parseWebviewMessage({ type: "queryStatistics", kind, requestId: 0, payload: "ignored" }), { type: "queryStatistics", kind, requestId: 0 });
}
for (const extra of [{ kind: "other" }, { requestId: -1 }, { requestId: 0.5 }, { requestId: NaN }, { requestId: Infinity }, { requestId: "1" }, { requestId: Number.MAX_SAFE_INTEGER + 1 }]) {
 assert.equal(parseWebviewMessage({ type: "queryStatistics", kind: "usage", requestId: 1, ...extra }), undefined);
}
const memory = { get: (_key, fallback) => fallback, update: async () => {} };
function fixture() {
 const controller = new SessionController({ subscriptions: [], globalState: memory, workspaceState: memory }, { appendLine() {}, append() {} });
 const posts = [], calls = [];
 const reply = message => posts.push(message);
 for (const method of ["ensureStarted", "ensureSidecar", "compact", "maybeTriggerAutoCompact", "fetchStatsText", "fetchAttachedStats", "broadcast"]) controller[method] = () => { throw new Error(`Forbidden ${method}`); };
 controller.state = { sessionId: "rpc-id", sessionName: "RPC name", cwd: "/rpc", model: { provider: "p", id: "m" }, thinkingLevel: "off", isStreaming: false };
 controller.client = { running: true, request: async request => { calls.push(request); return { success: true, data: data }; } };
 return { controller, posts, calls, reply };
}
let data = { tokens: { input: 0, output: 2, cacheRead: 3, cacheWrite: 4, total: 9 }, cost: 0, contextUsage: { tokens: null, contextWindow: 100, percent: null }, userMessages: 0, assistantMessages: 2, toolCalls: 0, totalMessages: 2 };
const value = (post, label) => post.snapshot.rows.find(row => row.label === label)?.value;
{
 const { controller: c, posts, calls, reply } = fixture();
 for (const [id, kind] of ["usage", "context", "session"].entries()) await c.queryStatistics(kind, id, reply);
 assert.deepEqual(calls, Array(3).fill({ type: "get_session_stats" }));
 assert.equal(value(posts[0], "Cost (USD)"), "0");
 assert.equal(value(posts[0], "Input tokens"), "0");
 assert.equal(value(posts[0], "Total tokens"), "9");
 assert.match(posts[0].snapshot.scope, /retained messages.*compaction.*child usage/);
 assert.equal(value(posts[1], "Context used tokens"), "未提供");
 assert.equal(value(posts[1], "Context used"), "未提供");
 assert.equal(value(posts[2], "ID"), "rpc-id");
 assert.equal(value(posts[2], "Working directory"), "/rpc");
 assert.equal(value(posts[2], "Running"), "No");
 assert.equal(value(posts[2], "Tool calls"), "0");
 assert.ok(Number.isFinite(Date.parse(posts[0].snapshot.queriedAt)));
 assert.equal(c.lastStatsText, "");
 assert.deepEqual(c.lastUsage, {});
 data = { contextUsage: { tokens: 0, contextWindow: 0, percent: 0 } };
 await c.queryStatistics("usage", 4, reply);
 assert.ok(posts.at(-1).snapshot.rows.every(row => row.value === "未提供"));
 await c.queryStatistics("context", 5, reply);
 assert.equal(value(posts.at(-1), "Context used"), "0%");
 c.streaming = true;
 await c.queryStatistics("session", 6, reply);
 assert.equal(posts.at(-1).snapshot.running, true);
 assert.equal(value(posts.at(-1), "Running"), "Yes");
 for (const response of [async () => ({ success: false, error: "rejected" }), async () => { throw new Error("offline"); }, async () => ({ success: true, data: null })]) {
  c.client.request = response;
  await c.queryStatistics("usage", 7, reply);
  assert.ok(posts.at(-1).error);
  assert.equal(posts.at(-1).snapshot, undefined);
 }
 for (const client of [null, { running: false }]) {
  c.client = client;
  await c.queryStatistics("usage", 8, reply);
  assert.match(posts.at(-1).error, /No available connection/);
 }
}
{
 const { controller: c, posts, reply, calls } = fixture();
 c.attached = { activeSessionId: "daemon-target", sessionId: "daemon-id", sessionPath: "/daemon/session" };
 c.attachedEpoch = c.viewEpoch;
 c.rentedState = { sessionId: "daemon-id", cwd: "/daemon", isStreaming: true };
 const targets = [];
 c.sidecar = { connected: true, getSessionStats: async id => { targets.push(id); return data; }, getState: async id => { targets.push(`state:${id}`); return { sessionId: "observed-id", cwd: "/observed", isStreaming: false }; } };
 await c.queryStatistics("session", 1, reply);
 assert.equal(value(posts.at(-1), "ID"), "daemon-id");
 assert.equal(posts.at(-1).snapshot.running, true);
 c.attached = null; c.attachedEpoch = null; c.observingId = "observed-target"; c.streaming = true; c.compacting = true;
 await c.queryStatistics("session", 2, reply);
 assert.equal(value(posts.at(-1), "Read-only"), "Yes");
 assert.equal(posts.at(-1).snapshot.running, false, "observation ignores hidden RPC run flags");
 assert.equal(value(posts.at(-1), "Working directory"), "/observed");
 assert.equal(value(posts.at(-1), "ID"), "observed-id");
 assert.deepEqual(targets, ["daemon-target", "observed-target", "state:observed-target"]);
 assert.deepEqual(calls, []);
 c.sidecar.getSessionStats = async () => { throw new Error("daemon failure"); };
 await c.queryStatistics("context", 3, reply);
 assert.equal(posts.at(-1).error, "daemon failure");
 c.sidecar.connected = false;
 await c.queryStatistics("usage", 4, reply);
 assert.match(posts.at(-1).error, /No available connection/);
}
for (const daemon of [false, true]) for (const reject of [false, true]) for (const change of ["epoch", "client", "attachment", "sidecar", "observed", "disposed"]) {
 const { controller: c, posts, reply } = fixture();
 let finish;
 const pending = new Promise((resolve, fail) => { finish = () => reject ? fail(new Error("late failure")) : resolve(daemon ? data : { success: true, data }); });
 if (daemon) {
  c.attached = { activeSessionId: "old", sessionId: "old", sessionPath: "/old" }; c.attachedEpoch = c.viewEpoch;
  c.sidecar = { connected: true, getSessionStats: () => pending };
 } else c.client.request = () => pending;
 const query = c.queryStatistics("usage", 10, reply);
 if (change === "epoch") c.viewEpoch++;
 if (change === "client") c.client = null;
 if (change === "attachment") c.attached = { activeSessionId: "new" };
 if (change === "sidecar") c.sidecar = {};
 if (change === "observed") c.observingId = "new";
 if (change === "disposed") c.disposed = true;
 finish(); await query;
 assert.equal(posts.length, 0, `${daemon}/${reject}/${change} suppresses stale result`);
}
console.log("PASS statistics host: parser, RPC/daemon, read-only observation, missing/zero, errors, races and no side effects");

// Exercise the real view receiver: background/focused views cannot redirect replies,
// and queries never pass through initialize(), even on a tab that has not started.
{
 const disposable = () => ({ dispose() {} });
 const vscode = { window: { state: { focused: true }, onDidChangeWindowState: () => disposable() }, commands: { executeCommand: async () => {} }, Uri: { joinPath: (_base, ...parts) => parts.join("/") } };
 const compiled = await esbuild.build({ entryPoints: ["src/host/chat-view.ts"], bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false });
 const module = { exports: {} };
 new Function("require", "module", "exports", compiled.outputFiles[0].text)(name => name === "vscode" ? vscode : require(name), module, module.exports);
 const manager = new module.exports.ChatPanels({ extensionUri: "/extension", globalState: memory }, { appendLine() {} });
 manager.initialize = () => { throw new Error("Query started a worker"); };
 function view(editor) {
  let receive;
  const messages = [];
  const surface = { visible: true, active: true, webview: { cspSource: "test:", asWebviewUri: uri => uri, postMessage: async message => { messages.push(message); return true; }, onDidReceiveMessage: callback => { receive = callback; return disposable(); } }, onDidChangeViewState: () => disposable(), onDidChangeVisibility: () => disposable(), onDidDispose: () => disposable() };
  const handle = manager.makeView(editor ? surface : undefined, editor ? undefined : surface);
  return { handle, messages, send: message => receive(message) };
 }
 const first = view(true), second = view(false);
 for (const [target, id] of [[first, "first"], [second, "second"]]) {
  target.handle.tab = { view: target.handle, closed: false, controller: { queryStatistics: async (kind, requestId, reply) => reply({ type: "statistics", kind, requestId, error: id }) } };
 }
 manager.lastActive = second.handle.tab;
 first.send({ type: "queryStatistics", kind: "usage", requestId: 1 });
 assert.equal(first.messages.at(-1).error, "first");
 assert.equal(second.messages.length, 0);
 second.send({ type: "queryStatistics", kind: "session", requestId: 2 });
 assert.equal(second.messages.at(-1).error, "second");
 const empty = view(false);
 empty.send({ type: "queryStatistics", kind: "usage", requestId: 3 });
 assert.match(empty.messages.at(-1).error, /No available session/);
 let finish;
 first.handle.tab.controller.queryStatistics = async (kind, requestId, reply) => { await new Promise(resolve => { finish = resolve; }); reply({ type: "statistics", kind, requestId, error: "late" }); };
 first.send({ type: "queryStatistics", kind: "usage", requestId: 4 });
 first.handle.tab = second.handle.tab;
 finish(); await Promise.resolve(); await Promise.resolve();
 assert.equal(first.messages.length, 1, "view rebinding discards late response");
 manager.dispose();
}
console.log("PASS statistics originating view routing without session initialization");
