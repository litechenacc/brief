import assert from "node:assert/strict";
import { build } from "esbuild";
import { Window } from "happy-dom";

const built = await build({ entryPoints: ["webview/main.ts"], bundle: true, format: "iife", platform: "browser", write: false });
const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div>';
const posted = [];
const saved = [];
window.acquireVsCodeApi = () => ({ postMessage: m => posted.push(m), getState: () => undefined, setState: s => saved.push(s) });
window.eval(built.outputFiles[0].text);
const host = data => window.dispatchEvent(new window.MessageEvent("message", { data }));
const status = { connected: true, streaming: false, compacting: false, retrying: false, restoring: false, modelLabel: "p/m", thinkingLevel: "off", statsText: "", sessionId: "stats-a" };
host({ type: "snapshot", messages: [], state: null, status });
const input = document.querySelector("textarea");
const editText = value => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new window.Event("input", { bubbles: true })); };
const key = key => input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const command = value => { editText(value); key("Escape"); key("Enter"); };
const requests = () => posted.filter(m => m.type === "queryStatistics");
const card = kind => document.querySelector(`.statistics-card[data-kind="${kind}"]`);
const button = (kind, text) => [...card(kind).querySelectorAll("button")].find(b => b.textContent === text);
const reply = (request, snapshot, error) => host({ ...request, type: "statistics", snapshot, error });
const snapshot = (value = "0") => ({ queriedAt: "2026-07-17T10:00:00.000Z", scope: "Current session branch; runtime-reported, not a final provider bill.", rows: [{ label: "Input", value }, { label: "Cost (USD)", value: "$0.0000" }, { label: "Cache write", value: "Not provided" }], running: true });

assert.equal(document.querySelector(".statistics-shortcuts").hidden, true);
// Fixed catalog and deduplication do not depend on runtime commands.
host({ type: "commands", commands: ["usage", "context", "session"].map(name => ({ name, description: "runtime duplicate" })) });
for (const kind of ["usage", "context", "session"]) {
 editText(`/${kind}`);
 assert.equal([...document.querySelectorAll(".ac-label")].filter(e => e.textContent === `/${kind}`).length, 1);
 key("Tab");
 assert.equal(requests().at(-1).kind, kind);
 reply(requests().at(-1), snapshot());
 assert.match(card(kind).textContent, /Brief local information/);
 assert.match(card(kind).textContent, /2026-07-17T10:00:00.000Z/);
 assert.match(card(kind).textContent, /Not provided/);
 assert.match(card(kind).textContent, /\$0.0000/);
 assert.match(card(kind).textContent, /values may still increase/);
 assert.equal(card(kind).closest(".messages"), null, "not a transcript message");
}
assert.equal(document.querySelectorAll(".statistics-card").length, 3);
for (const kind of ["usage", "context", "session"]) {
 for (const value of [`/${kind} nope`, `/${kind}\n`, `/${kind}\nbody`, `/${kind}\r\nbody`]) {
  const before = requests().length;
  command(value);
  assert.equal(requests().length, before);
  assert.equal(input.value, value);
  assert.match(document.querySelector(".composer-hint").textContent, /without arguments on a single line/);
 }
 const before = requests().length;
 editText(`Explain /${kind}`); key("Tab");
 assert.equal(requests().length, before, "inline completion only inserts prompt text");
 assert.equal(input.value, `Explain /${kind} `);
}
// Draft and legacy attachments survive the query; no attachment goes in its wire payload.
host({ type: "draft", text: "preserved draft" });
host({ type: "insertSelection", selection: { path: "a.ts", startLine: 1, endLine: 2, text: "code", languageId: "typescript" } });
editText("preserved draft");
command("/usage");
assert.equal(input.value, "preserved draft");
assert.deepEqual(Object.keys(requests().at(-1)).sort(), ["kind", "requestId", "type"]);
// Pending owned attachments do not block read-only queries or disappear.
const paste = new window.Event("paste", { bubbles: true, cancelable: true });
paste.clipboardData = { files: [], getData: type => type === "text/plain" ? "large attached text\n".repeat(20) : "" };
input.dispatchEvent(paste);
const created = posted.findLast(m => m.type === "createAttachment");
assert.ok(created);
const attachedDraft = input.value;
command("/usage");
assert.equal(input.value, attachedDraft);
assert.equal(document.querySelectorAll(".composer-chips .compose-chip").length, 2);
host({ type: "attachmentCreated", sessionId: status.sessionId, id: created.attachment.id });
host({ type: "captureViewState", sessionId: status.sessionId, requestId: "statistics-transfer" });
const captured = posted.findLast(m => m.type === "viewStateCaptured");
assert.ok(captured, JSON.stringify(posted.slice(-5)));
assert.equal(captured.state.composer.draft.attachments[0].id, created.attachment.id);
assert.equal(captured.state.composer.draft.selections[0].text, "code");
assert.equal(JSON.stringify(captured.state).includes("Brief local information"), false);
host({ type: "releaseViewState", sessionId: status.sessionId, requestId: "statistics-transfer" });
const first = requests().at(-1);
button("usage", "Refresh").click();
const second = requests().at(-1);
reply(second, snapshot("22")); reply(first, snapshot("11"));
assert.equal(card("usage").querySelector("dd").textContent, "22", "latest refresh wins");
assert.equal(document.querySelectorAll('.statistics-card[data-kind="usage"]').length, 1);
button("usage", "Refresh").click(); reply(requests().at(-1), undefined, "Connection unavailable");
assert.match(card("usage").textContent, /Old snapshot — Connection unavailable/);
assert.equal(card("usage").querySelector("dd").textContent, "22");
assert.ok(card("usage").classList.contains("stale"));
assert.match(card("usage").textContent, /2026-07-17T10:00:00.000Z/);
let copied;
window.navigator.clipboard.writeText = async text => { copied = text; };
button("usage", "Copy").click();
await new Promise(resolve => setImmediate(resolve));
assert.match(copied, /Input: 22/); assert.match(copied, /Old snapshot/);
assert.match(document.querySelector(".notices").textContent, /Statistics snapshot copied/);
window.navigator.clipboard.writeText = async () => { throw new Error("Denied"); };
button("usage", "Copy").click();
await new Promise(resolve => setImmediate(resolve));
assert.match(document.querySelector(".notices").textContent, /Could not copy statistics/);
button("usage", "Refresh").click(); const closed = requests().at(-1);
button("usage", "Close").click(); reply(closed, snapshot("stale closed"));
assert.equal(card("usage"), null);
command("/usage"); const reopened = requests().at(-1);
reply(closed, snapshot("wrong")); assert.equal(card("usage").querySelector("dd"), null);
reply(reopened, undefined);
assert.match(card("usage").textContent, /No statistics snapshot was provided/);
assert.equal(button("usage", "Copy").disabled, true);
// An ordinary status update never auto-refreshes or overwrites a manual snapshot.
const beforeStatus = requests().length;
host({ type: "status", status: { ...status, streaming: true } });
assert.equal(requests().length, beforeStatus);
command("/context"); reply(requests().at(-1), snapshot("running"));
assert.equal(card("context").querySelector("dd").textContent, "running");
// Disabled composer keeps prompt editing blocked, with explicit local query buttons.
host({ type: "observedSession", sessionId: "observed", messages: [] });
assert.equal(input.disabled, true);
assert.equal(document.querySelector(".statistics-shortcuts").hidden, false);
assert.equal(document.querySelectorAll(".statistics-card").length, 0);
for (const b of document.querySelectorAll(".statistics-shortcuts button")) b.click();
assert.deepEqual(requests().slice(-3).map(r => r.kind), ["usage", "context", "session"]);
const oldSession = requests().at(-1);
host({ type: "snapshot", messages: [], state: null, status: { ...status, sessionId: "stats-b", connected: false } });
reply(oldSession, snapshot("wrong session"));
assert.equal(document.querySelectorAll(".statistics-card").length, 0);
const disconnected = document.querySelector('.statistics-shortcuts button');
disconnected.click(); reply(requests().at(-1), undefined, "No available connection.");
assert.match(card("usage").textContent, /No available connection/);
host({ type: "newThread" });
assert.equal(document.querySelectorAll(".statistics-card").length, 0);
assert.equal(posted.some(m => ["prompt", "restart", "abort", "compact"].includes(m.type)), false);
assert.equal(saved.some(s => JSON.stringify(s).includes("Brief local information")), false);
assert.equal(document.querySelectorAll(".pa-handler-error").length, 0);
await window.happyDOM.close();
console.log("PASS local statistics slash, cards, snapshot metadata, copy, errors, readonly/offline and request/session races");
