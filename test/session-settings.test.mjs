/** Blank-worker inheritance and authoritative settings on both transports. No live prompts. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");
const memory = { get: (_key, fallback) => fallback, update: async () => {} };
function make() {
 const c = new SessionController({ globalState: memory, workspaceState: memory }, { append() {}, appendLine() {} });
 c.posts = []; c.broadcast = (message) => c.posts.push(message);
 c.pushStatusLight = () => c.posts.push({ type: "status", state: c.attached ? c.rentedState : c.state });
 return c;
}
const initial = { model: { provider: "provider", id: "old" }, thinkingLevel: "low" };
for (const transport of ["stdio", "daemon"]) {
 for (const [method, args, command] of [["setModel", ["provider", "new"], "set_model"], ["setThinkingLevel", ["high"], "set_thinking_level"]]) {
  const c = make(), calls = [];
  let failure, thrown;
  const authoritative = { model: { provider: "provider", id: "actual" }, thinkingLevel: "medium" };
  const request = async (message) => {
   calls.push(message);
   if (message.type === "get_state") return { success: true, data: authoritative };
   if (thrown) throw new Error("transport failed");
   if (failure) { if (transport === "daemon") throw new Error("rejected"); return { success: false, error: "rejected" }; }
   return { success: true };
  };
  c.state = structuredClone(initial);
  if (transport === "stdio") c.client = { running: true, request };
  else {
   c.attached = { activeSessionId: "source" }; c.attachedEpoch = c.viewEpoch;
   c.rentedState = structuredClone(initial);
   c.ensureSidecar = async () => ({ request, getState: async () => authoritative });
  }
  for (const flag of ["streaming", "compacting", "retrying", "observationRestoring"]) {
   c[flag] = true; await c[method](...args); c[flag] = false;
   assert.equal(calls.length, 0, `${transport} ${method} blocks ${flag}`);
   assert.equal(c.posts.at(-1).type, "status");
  }
  const viewed = transport === "daemon" ? c.rentedState : c.state;
  viewed.isStreaming = true; await c[method](...args); delete viewed.isStreaming;
  assert.equal(calls.length, 0, "backend running flag blocks changes");
  c.observingId = "readonly"; await c[method](...args); c.observingId = null;
  assert.equal(calls.length, 0, "observed view never mutates");
  failure = true; c.posts = []; await c[method](...args);
  assert.ok(c.posts.some((p) => p.type === "notice" && p.text.includes("rejected")));
  assert.deepEqual(c.posts.at(-1).state, initial);
  failure = false; thrown = true; c.posts = []; await c[method](...args);
  assert.ok(c.posts.some((p) => p.type === "notice" && p.text.includes("transport failed")));
  assert.deepEqual(c.posts.at(-1).state, initial);
  thrown = false; await c[method](...args);
  assert.deepEqual(c.posts.at(-1).state, authoritative, "display backend result, not requested value");
  const mutation = calls.find((call) => call.type === command);
  assert.equal(mutation.activeSessionId, transport === "daemon" ? "source" : undefined);
  c.client = null; c.dispose();
 }
}
for (const transport of ["stdio", "daemon"]) {
 const source = make(), target = make(), calls = [];
 source.state = structuredClone(initial); source.streaming = true;
 source.cachedMessages = [{ role: "user", content: "original conversation" }];
 if (transport === "daemon") {
  source.attached = { activeSessionId: "original" }; source.attachedEpoch = source.viewEpoch;
  source.rentedState = structuredClone(initial);
 }
 const original = source.cachedMessages;
 const sidecar = {
  list: async () => [{ activeSessionId: "original", cwd: "/source/elsewhere" }],
  createResident: async (options) => { calls.push(["create", options]); return { activeSessionId: "new", sessionFile: "/new.jsonl" }; },
  request: async (message) => { calls.push(["request", message]); return {}; }
 };
 target.connectDaemon = async () => sidecar;
 target.attachViaDaemon = async (...args) => { calls.push(["attach", ...args]); return true; };
 await target.initializeBlankFrom(source);
 assert.deepEqual(calls[0], ["create", { cwd: transport === "daemon" ? "/source/elsewhere" : source.workspaceRoot, provider: "provider", model: "old", thinking: "low" }]);
 assert.deepEqual(calls[1], ["attach", "new", "/new.jsonl", 0]);
 assert.equal(calls.length, 2, "inherit through creation config, never global-mutating settings commands");
 assert.equal(source.cachedMessages, original); assert.equal(source.streaming, true);
 assert.deepEqual(source.posts, [], "source receives no reset, status, or draft replacement");
 target.attachViaDaemon = async () => false;
 await assert.rejects(target.initializeBlankFrom(source), /attach/);
 assert.deepEqual(calls.at(-1)[1], { type: "kill", activeSessionId: "new" });
 assert.equal(source.streaming, true); assert.equal(source.cachedMessages, original);
 sidecar.createResident = async () => { throw new Error("creation failed"); };
 await assert.rejects(target.initializeBlankFrom(source), /creation failed/);
 assert.deepEqual(source.posts, []);
 source.dispose(); target.dispose();
}
const { DaemonSidecar } = require("../dist/daemon-sidecar.cjs");
const wireCalls = [];
const wire = Object.create(DaemonSidecar.prototype);
wire.request = async (message) => { wireCalls.push(message); return { activeSessionId: "created" }; };
await wire.createResident({ cwd: "/source", provider: "provider", model: "chosen", thinking: "high" });
assert.deepEqual(wireCalls[0], { type: "create", lifecycle: "resident", config: { cwd: "/source", provider: "provider", model: "chosen", thinking: "high" } });
console.log("PASS blank session and settings contracts (stdio + daemon)");
