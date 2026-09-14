import assert from "node:assert/strict";
import { build } from "esbuild";
import { Window } from "happy-dom";

const parserBuild = await build({ entryPoints: ["src/webview-message.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { parseWebviewMessage } = await import(`data:text/javascript;base64,${Buffer.from(parserBuild.outputFiles[0].text).toString("base64")}`);
const uiBuild = await build({ entryPoints: ["webview/main.ts"], bundle: true, format: "iife", platform: "browser", write: false });
function view(savedState) {
 const window = new Window({ url: "https://webview.local/" });
 window.document.body.innerHTML = '<div id="app"></div>';
 const posted = [];
 const writes = [];
 window.acquireVsCodeApi = () => ({ postMessage: m => posted.push(m), getState: () => savedState, setState: state => { savedState = state; writes.push(state); } });
 window.eval(uiBuild.outputFiles[0].text);
 return { window, document: window.document, posted, writes, send: data => window.dispatchEvent(new window.MessageEvent("message", { data })) };
}
const status = { connected: true, streaming: false, compacting: false, retrying: false, restoring: false, modelLabel: "p/m", thinkingLevel: "off", statsText: "", sessionId: "s1" };
const persisted = view({ historyFolds: { archive: true } });
const identity = { ...status, sessionFile: "/workspace/s1.jsonl" };
persisted.send({ type: "status", status: identity });
for (let i = 0; i < 20; i++) persisted.send({ type: "status", status: { ...identity, streaming: i % 2 === 0 } });
assert.equal(persisted.writes.length, 1, "unchanged session identity is persisted only once across 21 status updates");
persisted.send({ type: "status", status: { ...identity, sessionFile: "/moved/s1.jsonl" } });
persisted.send({ type: "status", status: { ...identity, sessionId: "s2" } });
assert.equal(persisted.writes.length, 3, "path and session identity changes each persist");
assert.deepEqual(structuredClone(persisted.writes.at(-1)), { historyFolds: { archive: true }, session: { sessionId: "s2", sessionFile: identity.sessionFile, isNew: false } });
persisted.send({ type: "status", status });
assert.equal(persisted.writes.length, 3, "incomplete status does not erase persisted identity");
await persisted.window.happyDOM.close();
const messages = Array.from({ length: 420 }, (_, i) => ({ role: "user", content: `history-${i}` }));
const source = view();
source.send({ type: "snapshot", messages, state: null, status });
source.document.querySelector(".earlier-load").click();
const input = source.document.querySelector("textarea");
input.value = "draft text";
input.setSelectionRange(2, 7);
input.dispatchEvent(new source.window.Event("input"));
source.send({ type: "insertSelection", selection: { path: "src/main.ts", startLine: 1, endLine: 2, text: "code", languageId: "typescript" } });
source.send({ type: "captureViewState", requestId: "nonce-1", sessionId: "s1" });
const captured = source.posted.at(-1);
assert.equal(captured.type, "viewStateCaptured");
assert.equal(captured.state.transcript.olderCount, 170);
assert.equal(captured.state.composer.draft.text, "draft text");
assert.equal(captured.state.composer.draft.selections.length, 1);
assert.equal(source.document.getElementById("app").inert, true);
assert.deepEqual(structuredClone(parseWebviewMessage(captured)), structuredClone(captured));
source.send({ type: "releaseViewState", requestId: "wrong-nonce", sessionId: "s1" });
assert.equal(source.document.getElementById("app").inert, true);
source.send({ type: "releaseViewState", requestId: "nonce-1", sessionId: "s1" });
assert.equal(source.document.getElementById("app").inert, false);
assert.equal(input.value, "draft text", "timeout release preserves original draft");

// Once the host accepted a prompt, its eventual transcript echo must not prevent
// the running session from yielding the sidebar to another session.
const acceptedPrompt = view();
acceptedPrompt.send({ type: "snapshot", messages: [], state: null, status });
const acceptedInput = acceptedPrompt.document.querySelector("textarea");
acceptedInput.value = "switch while running";
acceptedInput.dispatchEvent(new acceptedPrompt.window.Event("input"));
acceptedInput.dispatchEvent(new acceptedPrompt.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const sent = acceptedPrompt.posted.find((message) => message.type === "prompt");
acceptedPrompt.send({ type: "promptAccepted", clientRequestId: sent.payload.clientRequestId });
acceptedPrompt.send({ type: "captureViewState", requestId: "accepted-prompt", sessionId: "s1" });
assert.equal(acceptedPrompt.posted.at(-1).type, "viewStateCaptured", "an accepted running prompt does not block session switching");
await acceptedPrompt.window.happyDOM.close();

const state = structuredClone(captured.state);
state.composer.draft.images = [{ data: "aGVsbG8=", mimeType: "image/png", name: "image.png" }];
state.composer.stash = structuredClone(state.composer.draft);
state.composer.stash.text = "stashed text";
state.composer.draft.accepted = ["src/main.ts"];
const target = view();
target.send({ type: "restoreViewState", requestId: "restore-early", sessionId: "s1", state });
assert.equal(target.posted.at(-1).type, "viewStateFailed");
target.send({ type: "setViewMoving", moving: true });
assert.equal(target.document.getElementById("app").inert, true);
target.send({ type: "snapshot", messages: [...messages, { role: "user", content: "new tail" }], state: null, status });
target.send({ type: "restoreViewState", requestId: "restore-1", sessionId: "s1", state });
assert.equal(target.posted.at(-1).type, "viewStateRestored");
assert.equal(target.document.getElementById("app").inert, true, "snapshot and restore cannot unlock the moving target");
target.send({ type: "captureViewState", requestId: "capture-2", sessionId: "s1" });
const restored = target.posted.at(-1);
assert.equal(restored.type, "viewStateCaptured");
assert.deepEqual(structuredClone(restored.state.composer), state.composer, "draft, attachments, caret, accepted paths and stash roundtrip");
assert.equal(restored.state.transcript.olderCount, 170, "earlier window survives a longer refreshed snapshot");

for (const mutate of [
 s => { s.composer.draft.images = Array(9).fill(state.composer.draft.images[0]); },
 s => { s.composer.stash.text = "x".repeat(200001); },
 s => { s.composer.draft.images[0].data = "bad-base64"; },
 s => { s.composer.draft.selections[0].endLine = 0; },
 s => { s.transcript.scrollTop = Infinity; },
 s => { s.transcript.olderCount = 1000001; },
 s => { s.composer.draft.accepted = Array(257).fill("x"); },
]) {
 const bad = structuredClone(state); mutate(bad);
 assert.equal(parseWebviewMessage({ ...captured, state: bad }), undefined);
}
assert.equal(parseWebviewMessage({ ...captured, requestId: "../nonce" }), undefined);
assert.equal(parseWebviewMessage({ type: "viewStateRestored", requestId: "n", sessionId: "" }).sessionId, "");
const sanitized = parseWebviewMessage({ ...captured, state: { ...state, arbitrary: { secret: "drop" } } });
assert.equal(sanitized.state.arbitrary, undefined);

// A sidebar surface can show another session before releasing its old capture.
target.send({ type: "snapshot", messages: [], state: null, status: { ...status, sessionId: "s2" } });
target.send({ type: "releaseViewState", requestId: "capture-2", sessionId: "s1" });
assert.equal(target.document.getElementById("app").inert, true, "capture release cannot clear the target moving lock");
target.send({ type: "setViewMoving", moving: false });
assert.equal(target.document.getElementById("app").inert, false, "release uses captured identity, not the newly displayed session");

// An unresolved optimistic prompt is not discarded or transplanted.
source.send({ type: "releaseViewState", requestId: "nonce-1", sessionId: "s1" });
input.value = "pending prompt";
input.dispatchEvent(new source.window.Event("input"));
input.dispatchEvent(new source.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
assert.equal(source.posted.filter(m => m.type === "prompt").at(-1)?.payload.text, "pending prompt");
source.send({ type: "captureViewState", requestId: "pending-move", sessionId: "s1" });
assert.equal(source.posted.at(-1).type, "viewStateFailed");
assert.match(source.posted.at(-1).error, /pending/);
assert.equal(source.document.getElementById("app").inert, false);
const beforeFocus = source.posted.length;
input.dispatchEvent(new source.window.FocusEvent("focusin", { bubbles: true }));
assert.ok(source.posted.slice(beforeFocus).some((message) => message.type === "viewFocused"));
assert.deepEqual(parseWebviewMessage({ type: "viewFocused", ignored: true }), { type: "viewFocused" });
const history = view();
history.send({ type: "setHistoryMode", enabled: true });
history.send({ type: "history", sessions: [{ id: "old", path: "/known/old.jsonl", cwd: "/workspace", timestamp: new Date().toISOString(), name: "Old chat", inWorkspace: true }] });
assert.equal(history.document.querySelector(".chat-view").style.display, "none");
assert.equal(history.document.querySelector(".status-strip").style.display, "none");
assert.equal(history.document.querySelector(".boot-splash"), null, "history stays unobstructed without a boot splash");
history.document.querySelector(".history-resume").click();
assert.equal(history.posted.at(-1).type, "switchSession");
assert.equal(history.document.querySelector(".history-view").style.display, "");
assert.equal(history.document.querySelector(".history-view").classList.contains("refreshing"), false);
history.send({ type: "focusComposer" });
assert.equal(history.document.querySelector(".chat-view").style.display, "none");
history.send({ type: "setHistoryMode", enabled: false });
assert.equal(history.document.querySelector(".chat-view").style.display, "");
assert.equal(history.document.querySelector(".history-view").style.display, "none");
await history.window.happyDOM.close();
await source.window.happyDOM.close();
await target.window.happyDOM.close();
console.log("PASS view state bounded protocol, transfer, history window, rollback and pending-send guard");
