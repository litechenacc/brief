/**
 * Activation harness: loads the bundled extension with a stub `vscode` module
 * and runs activate() to catch import-time and registration-time errors.
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const require = createRequire(process.cwd() + "/");

const disposables = [];
const registeredCommands = [];
const registeredViews = [];
const registeredSerializers = [];

const vscodeStub = {
	window: {
		registerWebviewPanelSerializer: (id, serializer) => {
			registeredSerializers.push({ id, serializer });
			return { dispose: () => {} };
		},
		createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }),
		registerWebviewViewProvider: (id) => {
			registeredViews.push(id);
			return { dispose: () => {} };
		},
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		showOpenDialog: async () => undefined,
		showSaveDialog: async () => undefined,
		showTextDocument: async () => ({}),
		createWebviewPanel: () => {
			throw new Error("not implemented in stub");
		},
		activeTextEditor: undefined,
	},
	workspace: {
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
		workspaceFolders: [{ uri: { fsPath: process.cwd(), scheme: "file" }, name: "stub", index: 0 }],
		findFiles: async () => [],
		asRelativePath: (uri) => (typeof uri === "string" ? uri : uri.fsPath),
		fs: { readFile: async () => new Uint8Array() },
	},
	commands: {
		registerCommand: (name) => {
			registeredCommands.push(name);
			return { dispose: () => {} };
		},
		executeCommand: async () => undefined,
	},
	env: { openExternal: async () => true },
	Uri: {
		file: (fsPath) => ({ fsPath, scheme: "file" }),
		joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/"), scheme: "file" }),
		parse: (value) => ({ fsPath: value, scheme: "https" }),
	},
	ViewColumn: { Active: 1 },
	ProgressLocation: { Notification: 15 },
	TextEditorRevealType: { InCenter: 1 },
	Disposable: class Disposable {
		constructor(fn) {
			this.fn = fn;
		}
		dispose() {
			this.fn?.();
		}
	},
	Position: class Position {
		constructor(line, character) {
			this.line = line;
			this.character = character;
		}
	},
	Range: class Range {
		constructor(start, end) {
			this.start = start;
			this.end = end;
		}
	},
	Selection: class Selection {
		constructor(start, end) {
			this.start = start;
			this.end = end;
		}
	},
};

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "vscode") return vscodeStub;
	return originalLoad.apply(this, [request, ...rest]);
};

const extension = require("./dist/extension.js");

const expectedCommands = [
	"brief.focusChat",
	"brief.openChat",
	"brief.useEditor",
	"brief.useSidebar",
	"brief.toggleChatLocation",
	"brief.switchSession",
	"brief.newSession",
	"brief.abort",
	"brief.compact",
	"brief.exportChat",
	"brief.restart",
	"brief.history",
	"brief.renameSession",
	"brief.addSelectionToChat",
	"brief.addActiveFileToChat",
];

const _mem = new Map();
const _state = { get: (k, d) => (_mem.has(k) ? _mem.get(k) : d), update: (k, v) => { if (v === undefined) _mem.delete(k); else _mem.set(k, v); return Promise.resolve(); } };
const context = {
	subscriptions: disposables,
	extensionUri: { fsPath: process.cwd(), scheme: "file" },
	globalState: _state,
	workspaceState: _state,
};

extension.activate(context);
console.log("activate() OK");
const missing = expectedCommands.filter((c) => !registeredCommands.includes(c));
if (missing.length > 0) {
	console.error("MISSING COMMANDS:", missing);
	process.exit(1);
}
if (registeredViews.length !== 1 || registeredViews[0] !== "brief.chat" || registeredSerializers.length !== 1 ||
	registeredSerializers[0].id !== "brief.chatPanel" ||
	typeof registeredSerializers[0].serializer.deserializeWebviewPanel !== "function") {
	console.error("Expected editor panel serializer and Brief sidebar provider");
	process.exit(1);
}
console.log(`commands registered: ${registeredCommands.length}/${expectedCommands.length}`);
extension.deactivate();
console.log("deactivate() OK");
console.log("PASS activation harness");

const { contributes: { menus } } = JSON.parse(readFileSync("package.json", "utf8"));
for (const title of ["editor/title", "view/title"]) {
	assert.ok(menus[title].every(({ command }) => !["brief.useEditor", "brief.useSidebar"].includes(command)),
		"location switching commands must not appear as title buttons");
}
assert.ok(menus["editor/title"].every(({ command }) => command !== "brief.history"));
assert.equal(menus["view/title"].find(({ command }) => command === "brief.history").when,
	"view == brief.chat && config.brief.chatLocation == sidebar",
	"workspace sessions button is only available in sidebar chat mode");
for (const command of ["brief.switchSession", "brief.renameSession", "brief.compact", "brief.exportChat", "brief.restart"]) {
	assert.equal(menus["view/title"].find((item) => item.command === command).when,
		"view == brief.chat && config.brief.chatLocation == sidebar",
		`${command} is only available in sidebar chat mode, not the editor session list`);
}
assert.equal(menus["view/title"].find(({ command }) => command === "brief.newSession").when,
	"view == brief.chat", "new session remains available in both modes");
console.log("PASS title button visibility");
