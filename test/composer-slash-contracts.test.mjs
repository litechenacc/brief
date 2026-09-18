import { Window } from "happy-dom";
import { buildSync } from "esbuild";
import assert from "node:assert/strict";
const window = new Window({ url: "https://webview.local" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "FileReader"]) globalThis[name] = name === "window" ? window : window[name];
const built = buildSync({ entryPoints: ["webview/composer.ts"], bundle: true, platform: "browser", format: "esm", write: false });
const { Composer } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const calls = [];
const c = new Composer({ onSend: () => calls.push("send"), onStop() {}, onSearchFiles() {}, onPickImage() {}, onAttachSelection() {}, onAttachActiveFile() {}, onSetModel: (...args) => calls.push(["model", ...args]), onSetThinking: level => calls.push(["thinking", level]), onToggleFavorite() {}, onOpenFile() {}, onDraftChanged() {}, onNewSession: () => calls.push("new"), onCreateAttachment() {}, onOpenAttachment() {}, onLogin() {} });
document.body.append(c.root);
const textarea = c.root.querySelector("textarea");
// Connecting views accept drafts before the first authoritative session identity.
const startupImage = { mimeType: "image/png", data: "YQ==", name: "startup.png" };
const startupSelection = { path: "startup.ts", startLine: 1, endLine: 1, text: "selected", languageId: "typescript" };
const startupAttachment = { id: "startup-text", kind: "text", label: "Text 1", status: "ready", start: 0, end: 8, text: "attached", image: undefined };
c.restoreRejectedPayload("[Text 1] startup draft", [startupImage], [startupSelection], [startupAttachment]);
const startupDraft = c.captureViewState().draft;
c.stashDraft();
assert.equal(textarea.value, "");
c.setSessionIdentity("startup");
c.setSessionIdentity("startup");
c.stashDraft();
assert.deepEqual(c.captureViewState().draft, startupDraft, "first identity preserves startup text and all attachment representations");
c.stashDraft();
c.resetForSessionBoundary(); c.setSessionIdentity("other");
assert.equal(c.captureViewState().stash, null, "startup stash does not leak to another session");
c.resetForSessionBoundary(); c.setSessionIdentity("startup"); c.stashDraft();
assert.deepEqual(c.captureViewState().draft, startupDraft, "startup stash survives a round-trip session switch");
c.resetForSessionBoundary(); c.setEnabled(true); c.setSessionIdentity("a");
const models = [{ provider: "p", id: "one", name: "First", reasoning: true }, { provider: "q", id: "one", name: "Second", reasoning: true }, { provider: "p", id: "two", name: "Third", reasoning: false }];
c.setModels(models); c.setModel("First", "p", "one");
function input(text) { textarea.value = text; textarea.setSelectionRange(text.length, text.length); textarea.dispatchEvent(new window.Event("input")); }
function command(text) { input(text); c.send(); }
function close() { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }
function row(label) { return [...document.querySelectorAll(".dropdown-item")].find(el => el.textContent.includes(label)); }
input("draft"); command("/model FIRST"); assert.deepEqual(calls.at(-1), ["model", "p", "one"]); assert.equal(textarea.value, "draft");
// A reasoning model: the picked model's own capabilities are painted from the catalog
// immediately, and the host's matching status is what settles the pick.
command("/model Q/ONE"); assert.deepEqual(calls.at(-1), ["model", "q", "one"]); c.setModel("q/one", "q", "one");
for (const query of ["", "one", "unknown"]) { const n = calls.length; command(`/model ${query}`); assert.equal(document.querySelector(".dropdown-search").value, query); assert.equal(calls.length, n); close(); assert.equal(textarea.value, "draft"); }
command("/model"); c.setStreaming(true); const n = calls.length; row("p/two").click(); assert.equal(calls.length, n); assert.equal(textarea.value, "draft");
for (const block of [() => c.setStreaming(true), () => c.setBusy(true), () => c.setObserving(true)]) {
 c.setStreaming(false); c.setBusy(false); c.setObserving(false); block();
 for (const text of ["/model p/two", "/effort high", "/thinking high"]) { const count = calls.length; command(text); assert.equal(calls.length, count); assert.equal(textarea.value, text); }
}
c.setStreaming(false); c.setBusy(false); c.setObserving(false);
input("draft"); c.setThinking("off", null); const noLevels = calls.length; command("/effort high"); assert.equal(calls.length, noLevels); assert.equal(document.querySelector(".dropdown"), null); assert.match(c.root.querySelector(".composer-hint").textContent, /not available/);
c.setThinking("max", ["off", "max"]);
for (const alias of ["effort", "thinking"]) { command(`/${alias} max`); assert.deepEqual(calls.at(-1), ["thinking", "max"]); command(`/${alias}`); assert.equal(document.querySelectorAll(".dropdown-item").length, 2); close(); }
c.setModel("Third", "p", "two"); command("/thinking"); assert.match(c.root.querySelector(".composer-hint").textContent, /does not support/); assert.equal(textarea.value, "draft");
c.setModel("First", "p", "one");
// Shortcut treats literal slash input as the draft and never parses it.
input("/model literal"); c.stashDraft(); assert.equal(textarea.value, ""); assert.match(c.root.querySelector(".composer-hint").textContent, /Closing or reloading may discard/); textarea.focus(); assert.equal(c.isFocused(), true); c.root.querySelector("button").focus(); assert.equal(c.isFocused(), false); c.stashDraft(); assert.equal(textarea.value, "/model literal");
c.stashDraft(); input("another"); c.stashDraft(); assert.equal(textarea.value, "another");
command("/stash forbidden"); assert.equal(textarea.value, "/stash forbidden");
input(""); c.stashDraft(); assert.equal(textarea.value, "/model literal");
input(""); command("/stash\nnext-line draft"); assert.equal(textarea.value, ""); command("/stash"); assert.equal(textarea.value, "next-line draft");
// All attachment representations round-trip, including marker ranges after prefix removal.
const image = { mimeType: "image/png", data: "YQ==", name: "a.png" };
const selection = { path: "file.ts", startLine: 1, endLine: 2, text: "selected" };
const attachment = { id: "text-a", kind: "text", label: "Text 1", status: "ready", start: 0, end: 8, text: "attached", image: undefined };
c.setDraft(""); c.restoreRejectedPayload("[Text 1]", [image], [selection], [attachment]);
const draft = c.captureViewState().draft; c.stashDraft(); assert.equal(c.captureViewState().draft.attachments.length, 0); c.stashDraft(); assert.deepEqual(c.captureViewState().draft, draft);
c.stashDraft(); c.resetForSessionBoundary(); c.setSessionIdentity("b"); input("B"); c.stashDraft();
c.resetForSessionBoundary(); c.setSessionIdentity("a"); c.stashDraft(); assert.deepEqual(c.captureViewState().draft, draft);
c.resetForSessionBoundary(); c.setSessionIdentity("b"); c.stashDraft(); assert.equal(textarea.value, "B");
for (const alias of ["new", "clear"]) { input("preserved"); command(`/${alias} nope`); assert.equal(textarea.value, `/${alias} nope`); command(`/${alias}`); assert.equal(calls.at(-1), "new"); assert.equal(textarea.value, "preserved"); command(`/${alias}\nbody`); assert.equal(textarea.value, "body"); }
assert.equal(calls.includes("send"), false);
for (const alias of ["goal", "autonomous"]) {
 const count = calls.length;
 command(`/${alias}\nbody`);
 assert.equal(calls.length, count + 1); assert.equal(calls.at(-1), "send"); assert.equal(document.querySelector(".dropdown"), null);
 const prefix = alias === "goal" ? "goa" : "auto";
 input(`/${prefix}\nkeep body`); textarea.setSelectionRange(prefix.length + 1, prefix.length + 1);
 textarea.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowLeft" }));
 assert.ok(c.root.querySelector(".ac-item"));
 const before = calls.length;
 textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
 assert.equal(calls.length, before); assert.equal(document.querySelector(".dropdown"), null); assert.equal(textarea.value, `/${alias}\nkeep body`);
}
await window.happyDOM.abort();
console.log("PASS composer slash contracts, settings gates, attachment stashes and session isolation");
