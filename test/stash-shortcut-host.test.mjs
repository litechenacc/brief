import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const disposable = () => ({ dispose() {} });
const contexts = [];
let windowChanged;
const vscode = {
 window: { state: { focused: true }, onDidChangeWindowState: callback => { windowChanged = callback; return disposable(); } },
 commands: { executeCommand: async (...args) => { contexts.push(args); } },
 Uri: { joinPath: (_base, ...parts) => parts.join("/") },
};
const built = await build({ entryPoints: ["src/chat-view.ts"], bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false });
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(name => name === "vscode" ? vscode : require(name), module, module.exports);
const manager = new module.exports.ChatPanels({ extensionUri: "/extension", globalState: { get: () => [] } }, { appendLine() {} });
function view(editor) {
 let receive, change, dispose;
 const messages = [];
 const surface = {
  visible: true, active: true,
  webview: { cspSource: "test:", asWebviewUri: uri => uri, postMessage: async message => { messages.push(message); return true; }, onDidReceiveMessage: callback => { receive = callback; return disposable(); } },
  onDidChangeViewState: callback => { change = callback; return disposable(); },
  onDidChangeVisibility: callback => { change = callback; return disposable(); },
  onDidDispose: callback => { dispose = callback; return disposable(); },
 };
 const handle = manager.makeView(editor ? surface : undefined, editor ? undefined : surface);
 handle.tab = { view: handle, closed: false };
 return { handle, surface, messages, focus: focused => receive({ type: "composerFocusChanged", focused }), change: () => change(), close: () => dispose() };
}
const editor = view(true), sidebar = view(false);
const count = target => target.messages.filter(message => message.type === "stashOrRestoreDraft").length;
const context = () => contexts.at(-1)?.[2];
await manager.stashOrRestoreDraft();
assert.equal(count(editor), 0, "no focus does not open or target a chat");
editor.focus(true); assert.equal(context(), true);
await manager.stashOrRestoreDraft(); assert.equal(count(editor), 1);
sidebar.focus(true); editor.focus(false);
assert.equal(context(), true, "late blur from old view cannot clear new view's focus");
await manager.stashOrRestoreDraft(); assert.equal(count(sidebar), 1); assert.equal(count(editor), 1);
sidebar.surface.visible = false; sidebar.change();
assert.equal(context(), false);
await manager.stashOrRestoreDraft(); assert.equal(count(sidebar), 1);
sidebar.focus(true); assert.equal(context(), false, "hidden view cannot claim composer focus");
editor.focus(true); editor.surface.active = false; editor.change();
assert.equal(context(), false);
await manager.stashOrRestoreDraft(); assert.equal(count(editor), 1);
editor.surface.active = true; editor.focus(true);
vscode.window.state.focused = false; windowChanged({ focused: false });
assert.equal(context(), false);
await manager.stashOrRestoreDraft(); assert.equal(count(editor), 1);
vscode.window.state.focused = true; editor.focus(true);
editor.handle.transferring = true;
await manager.stashOrRestoreDraft(); assert.equal(count(editor), 1, "handoff cannot mutate the captured draft");
editor.handle.transferring = false;
sidebar.surface.visible = true; sidebar.focus(true); sidebar.close();
assert.equal(context(), false, "closing the focused sidebar clears context");
manager.dispose();
console.log("PASS stash shortcut host: editor/sidebar routing, old blur, hidden/inactive view, window blur, handoff, disposal");
