/** Fork selection and transport boundaries. SDK/file checks live in fork-runtime-live.mjs. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const vscode = require("vscode");
const { SessionController } = require("../dist/controller.cjs");
const memory = { get: (_key, fallback) => fallback, update: async () => {} };
function make(transport) {
 const c = new SessionController({ globalState: memory, workspaceState: memory }, { append() {}, appendLine() {} });
 c.posts = []; c.broadcast = m => c.posts.push(m);
 c.state = { sessionFile: "/source.jsonl", sessionId: "source" };
 const calls = []; c.calls = calls;
 const messages = [{ entryId: "hidden", text: "other branch" }, { entryId: "first", text: "same" }, { entryId: "second", text: "same" }];
 const request = async m => { calls.push(m); if (c.failRead) throw new Error("read failed"); return transport === "daemon" ? { messages } : { success: true, data: { messages } }; };
 if (transport === "daemon") {
  c.attached = { activeSessionId: "source-worker", sessionId: "source", sessionPath: "/source.jsonl" }; c.attachedEpoch = c.viewEpoch;
  c.ensureSidecar = async () => ({ request });
 } else c.client = { running: true, request, stop() {} };
 c.forkFile = async (file, entryId, revision) => {
  calls.push({ type: "forkFile", file, entryId, revision });
  if (!entryId) return { revision: "hash", messages: [{ entryId: "first", visible: false }, { entryId: "image-only", visible: true }, { entryId: "second", visible: true }] };
  if (c.failCreate) throw new Error("attachments cannot be fully restored");
  return { sessionFile: "/fork.jsonl", sessionId: "fork", text: "selected draft" };
 };
 return c;
}
for (const transport of ["stdio", "daemon"]) {
 const c = make(transport);
 let picked;
 vscode.window.showQuickPick = async items => { picked = items; return items[1]; };
 const source = c.attached, state = c.state;
 assert.deepEqual(await c.forkFromUser(), { sessionFile: "/fork.jsonl", sessionId: "fork", text: "selected draft" });
 assert.equal(picked.length, 2, "exclude other branches");
 assert.match(picked[0].label, /^1\. /);
 assert.equal(c.calls.at(-1).entryId, "second", "duplicate text uses exact entry ID");
 assert.equal(c.attached, source); assert.equal(c.state, state);
 assert(!c.calls.some(m => ["fork", "prompt", "switch_session"].includes(m.type)), "never mutate source worker");
 c.calls.length = 0;
 await c.forkFromUser(1);
 assert.equal(c.calls.at(-1).entryId, "second", "button ordinal follows visible context, including image-only rows");
 assert.equal(await c.forkFromUser(0), undefined);
 assert.match(c.posts.at(-1).text, /attachments/);
 for (const flag of ["streaming", "compacting", "retrying", "observingId", "observationRestoring"]) {
  c.calls.length = 0; c[flag] = true; await c.forkFromUser(); c[flag] = flag === "observingId" ? null : false;
  assert.equal(c.calls.length, 0, flag);
 }
 vscode.window.showQuickPick = async () => undefined;
 c.calls.length = 0; assert.equal(await c.forkFromUser(), undefined);
 assert(!c.calls.some(m => m.type === "forkFile" && m.entryId));
 vscode.window.showQuickPick = async items => { c.viewEpoch++; return items[0]; };
 c.calls.length = 0; assert.equal(await c.forkFromUser(), undefined);
 assert(!c.calls.some(m => m.type === "forkFile" && m.entryId));
 c.attachedEpoch = c.viewEpoch;
 vscode.window.showQuickPick = async items => items[0];
 c.failRead = true; assert.equal(await c.forkFromUser(), undefined); assert.match(c.posts.at(-1).text, /read failed/); c.failRead = false;
 c.failCreate = true; assert.equal(await c.forkFromUser(), undefined); assert.match(c.posts.at(-1).text, /attachments/);
 c.dispose();
}
console.log("PASS fork selection, cancellation, source isolation and stdio/daemon read paths (mock)");
