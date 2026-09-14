import { Window } from "happy-dom";
import { buildSync } from "esbuild";
import assert from "node:assert/strict";
const window = new Window({ url: "https://webview.local" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "FileReader"]) globalThis[name] = name === "window" ? window : window[name];
const built = buildSync({ entryPoints: ["webview/composer.ts"], bundle: true, platform: "browser", format: "esm", write: false });
const { Composer } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const creates = [], sends = [], drafts = [], opens = [], drops = [];
const c = new Composer({ onSend: (...args) => sends.push(args), onStop() {}, onSearchFiles() {}, onDropWorkspaceUris: (uris) => drops.push(uris), onPickImage() {}, onAttachSelection() {}, onAttachActiveFile() {}, onSetModel() {}, onSetThinking() {}, onToggleFavorite() {}, onOpenFile() {}, onDraftChanged: (...args) => drafts.push(args), onNewSession() {}, onCreateAttachment: (a) => creates.push(a), onOpenAttachment: (id) => opens.push(id) });
document.body.append(c.root); c.setEnabled(true); c.setModels([]);
const textarea = c.root.querySelector("textarea");
function paste(text) { const event = new window.Event("paste", { cancelable: true }); Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => text } }); textarea.dispatchEvent(event); return event; }
function type(start, end, value, inputType = "insertText") {
 textarea.setSelectionRange(start, end);
 textarea.dispatchEvent(new window.InputEvent("beforeinput", { inputType, data: value, cancelable: true }));
 const from = textarea.selectionStart, to = textarea.selectionEnd;
 textarea.value = textarea.value.slice(0, from) + value + textarea.value.slice(to);
 textarea.setSelectionRange(from + value.length, from + value.length);
 textarea.dispatchEvent(new window.InputEvent("input", { inputType, data: value }));
}
function undo(redo = false) { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: redo, cancelable: true })); }
const long = "a".repeat(1001);
c.setText("left right"); textarea.setSelectionRange(5, 5); paste(long);
assert.equal(textarea.value, "left [Text 1]right"); assert.equal(creates.length, 1);
c.send(); assert.equal(sends.length, 0, "pending blocks send");
c.attachmentCreated(creates[0].id); c.flushDraft(); assert.equal(drafts.at(-1)[0], "left " + long + "right"); assert.equal(drafts.at(-1)[1].text, textarea.value);
type(0, 0, "!"); assert.equal(c.captureViewState().draft.attachments[0].start, 6);
type(8, 9, "x"); assert.equal(textarea.value, "!left xright"); assert.equal(c.root.querySelectorAll(".attachment-card").length, 0);
undo(); assert.equal(c.root.querySelectorAll(".attachment-card").length, 1); assert.equal(textarea.value, "!left [Text 1]right");
undo(true); assert.equal(c.root.querySelectorAll(".attachment-card").length, 0); undo();
const view = c.captureViewState(); c.resetForSessionBoundary(); c.restoreViewState(view); assert.equal(c.root.querySelectorAll(".attachment-card").length, 1);
c.root.querySelector(".attachment-open").click(); assert.equal(opens.at(-1), creates[0].id);
c.send(); const sent = sends.at(-1); assert.equal(sent[0], "!left [Text 1]right"); assert.equal(sent[3][0].start, 6);
assert.equal(c.restoreRejectedPayload(...sent), true); assert.equal(c.root.querySelectorAll(".attachment-card").length, 1);
c.resetForSessionBoundary(); c.setText("[Text 1]"); c.send(); assert.equal(sends.at(-1)[0], "[Text 1]"); assert.equal(sends.at(-1)[3].length, 0);
c.setText("ab"); textarea.setSelectionRange(1, 1); c.beginImagePick(1); type(0, 0, "!"); c.imagePicked(1, [{data: "YQ==", mimeType:"image/png"}]);
const image = creates.at(-1); assert.equal(image.kind, "image"); c.attachmentCreated(image.id); assert.equal(c.captureViewState().draft.attachments[0].start, 2);
c.flushDraft(); assert.equal(drafts.at(-1)[0], "!ab");
c.beginImagePick(2); c.resetForSessionBoundary(); c.imagePicked(2, [{data:"YQ==",mimeType:"image/png"}]); assert.equal(textarea.value, "");
const short = paste("a".repeat(1000)); assert.equal(short.defaultPrevented, false);
paste(Array(11).fill("line").join("\n")); assert.equal(creates.at(-1).kind, "text");

// Equal literals do not transfer identity when replacing the tracked occurrence.
c.resetForSessionBoundary(); paste(long); c.attachmentCreated(creates.at(-1).id);
const marker = textarea.value; type(0, 0, marker); const owned = c.captureViewState().draft.attachments[0];
assert.equal(owned.start, marker.length);
type(owned.start, owned.end, marker); assert.equal(c.captureViewState().draft.attachments.length, 0);
undo(); assert.equal(c.captureViewState().draft.attachments.length, 1);
// A browser word delete without beforeinput cannot leave a partial marker shell.
textarea.value = textarea.value.slice(0, marker.length + 2); textarea.dispatchEvent(new window.InputEvent("input", {inputType:"deleteWordBackward"}));
assert.equal(textarea.value, marker); assert.equal(c.captureViewState().draft.attachments.length, 0); undo();
// IME candidate updates are one undo unit and do not consume Enter as Send.
c.resetForSessionBoundary(); type(0, 0, "prefix "); paste(long); c.attachmentCreated(creates.at(-1).id);
const imeOriginal = textarea.value; textarea.setSelectionRange(9, 9); textarea.dispatchEvent(new window.CompositionEvent("compositionstart"));
type(textarea.selectionStart, textarea.selectionEnd, "中", "insertCompositionText");
type(7, 8, "中文", "insertCompositionText"); textarea.dispatchEvent(new window.CompositionEvent("compositionend"));
assert.equal(textarea.value, "prefix 中文"); undo(); assert.equal(textarea.value, imeOriginal); assert.equal(c.captureViewState().draft.attachments.length, 1);
// Stash restores tracked identities, not just marker-looking text.
c.setText("/stash"); c.send(); assert.equal(textarea.value, ""); c.setText("/stash"); c.send(); assert.equal(textarea.value, imeOriginal); assert.equal(c.captureViewState().draft.attachments.length, 1);
// Plain typing before/after attachments stays in the same undo stack.
c.resetForSessionBoundary(); type(0,0,"before"); paste(long); c.attachmentCreated(creates.at(-1).id); type(textarea.value.length, textarea.value.length,"after");
undo(); assert.ok(!textarea.value.endsWith("after")); undo(); assert.equal(textarea.value,"before"); undo(); assert.equal(textarea.value,"");

// Reserve FileReader slots before work starts; completion order cannot reorder images.
c.resetForSessionBoundary(); const readers = []; const NativeFileReader = globalThis.FileReader;
globalThis.FileReader = class { constructor() { readers.push(this); } readAsDataURL() {} };
const filesEvent = new window.Event("paste", {cancelable: true}); Object.defineProperty(filesEvent,"clipboardData", {value:{files:[{type:"image/png",name:"first"},{type:"image/png",name:"second"}],getData:()=>""}}); textarea.dispatchEvent(filesEvent);
const placeholders = textarea.value; type(0,0,"lead ");
readers[1].result = "data:image/png;base64,Yg=="; readers[1].onload(); readers[0].result = "data:image/png;base64,YQ=="; readers[0].onload();
for (const a of creates.slice(-2)) c.attachmentCreated(a.id);
const ordered = c.captureViewState().draft.attachments; assert.deepEqual(ordered.map(a=>a.image.name),["first","second"]); assert.equal(ordered[0].start,5); assert.equal(textarea.value,"lead " + placeholders);
// A read completing after a session boundary cannot create into the new session.
textarea.dispatchEvent(filesEvent); const staleReader = readers.at(-1), beforeStale = creates.length; c.resetForSessionBoundary(); staleReader.result="data:image/png;base64,YQ=="; staleReader.onload(); assert.equal(creates.length,beforeStale); assert.equal(textarea.value,"");
globalThis.FileReader = NativeFileReader;

c.resetForSessionBoundary(); c.setModels([]); c.beginImagePick(90);
const beforeTextOnly = creates.length;
c.setModels([{provider:"test",id:"text",name:"text",input:["text"]}]); c.setModel("test/text","test","text");
c.imagePicked(90,[{data:"YQ==",mimeType:"image/png"}]); assert.equal(creates.length,beforeTextOnly); assert.equal(textarea.value,"");
assert.ok(c.root.querySelector(".composer-hint").textContent.includes("text-only"));

c.resetForSessionBoundary(); c.setText("keep draft"); const beforeInvalid = creates.length;
assert.equal(paste("a".repeat(200_001)).defaultPrevented,true); paste("a".repeat(1001) + "\0");
assert.equal(creates.length,beforeInvalid); assert.equal(textarea.value,"keep draft");
c.resetForSessionBoundary(); for (let index=0;index<64;index++) paste(long);
const beforeLimit=creates.length, limitDraft=textarea.value; paste(long); assert.equal(creates.length,beforeLimit); assert.equal(textarea.value,limitDraft);

c.resetForSessionBoundary(); paste("a".repeat(120_000)); c.attachmentCreated(creates.at(-1).id); c.flushDraft();
const aggregateDraft = textarea.value, beforeAggregate = creates.length, validPosts = drafts.length;
paste("b".repeat(100_000)); c.flushDraft(); assert.equal(textarea.value,aggregateDraft); assert.equal(creates.length,beforeAggregate); assert.ok(drafts.slice(validPosts).every(args=>args[0].length<=200_000));
textarea.setSelectionRange(0,textarea.value.length); paste("c".repeat(150_000)); assert.equal(creates.length,beforeAggregate+1); c.attachmentCreated(creates.at(-1).id); c.flushDraft(); assert.equal(drafts.at(-1)[0],"c".repeat(150_000));
c.setText("x".repeat(200_001)); const beforeOversizeDraft= drafts.length; c.flushDraft(); assert.equal(drafts.length,beforeOversizeDraft);
c.setText("null\0draft"); c.flushDraft(); assert.equal(drafts.length,beforeOversizeDraft);

// Cancel restores only the replaced selection, preserving edits around its tracked slot.
c.resetForSessionBoundary(); c.setModels([]); c.setText("前 保留我 後"); textarea.setSelectionRange(2,5); c.beginImagePick(100);
type(0,0,"新增 "); c.imagePicked(100,[]); assert.equal(textarea.value,"新增 前 保留我 後");
// Selected attachment identity and its current readiness survive picker cancellation.
c.resetForSessionBoundary(); paste(long); const originalId=creates.at(-1).id;
const originalMarker=textarea.value; textarea.setSelectionRange(0,originalMarker.length); c.beginImagePick(101);
c.attachmentCreated(originalId); type(0,0,"surround "); c.imagePicked(101,[]);
assert.equal(textarea.value,"surround " + originalMarker);
const restoredSelection=c.captureViewState().draft.attachments; assert.equal(restoredSelection.length,1); assert.equal(restoredSelection[0].id,originalId); assert.equal(restoredSelection[0].status,"ready"); assert.equal(restoredSelection[0].start,9);
// Text-only refusal shares the same non-destructive cancellation path.
c.resetForSessionBoundary(); c.setText("保留我"); textarea.setSelectionRange(0,3); c.beginImagePick(102);
c.setModels([{provider:"test",id:"text",name:"text",input:["text"]}]); c.setModel("test/text","test","text");
c.imagePicked(102,[{data:"YQ==",mimeType:"image/png"}]); assert.equal(textarea.value,"保留我");

c.resetForSessionBoundary(); c.setModels([]); c.setText("保留我"); textarea.setSelectionRange(0,3); c.beginImagePick(103); c.imagePicked(103,[]);
undo(); const cancelledUndo = c.captureViewState().draft.attachments;
assert.equal(cancelledUndo.length,1); assert.equal(cancelledUndo[0].status,"error"); assert.ok(c.root.querySelector(".attachment-card").title.includes("cancelled"));
undo(true); assert.equal(textarea.value,"保留我"); assert.equal(c.captureViewState().draft.attachments.length,0);
undo(); c.root.querySelector(".attachment-card .chip-remove").click(); assert.equal(c.captureViewState().draft.attachments.length,0);
// Explorer URI drops are sent to the host; they do not become image attachments.
c.resetForSessionBoundary(); c.setModels([]);
const drop = new window.Event("drop", { cancelable: true });
Object.defineProperty(drop, "dataTransfer", { value: { getData: type => type === "text/uri-list" ? "file:///workspace/a.ts\r\n# ignored\r\nfile:///workspace/folder" : "", files: [] } });
textarea.dispatchEvent(drop);
assert.equal(drop.defaultPrevented, true);
assert.deepEqual(drops.at(-1), ["file:///workspace/a.ts", "file:///workspace/folder"]);
c.insertMentions([{ path: "a.ts", isDir: false }, { path: "folder", isDir: true }]);
assert.equal(textarea.value, "@a.ts @folder/ ");
c.send(); assert.equal(sends.at(-1)[0], "@a.ts @folder/");
console.log("PASS composer attachment invariants, offsets, image lifecycle, native undo, and Explorer drops");
window.happyDOM.abort();
