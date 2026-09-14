import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { vscodeStub: vscode } = require("./vscode-stub.cjs");
vscode.CancellationTokenSource = class {
 token = { isCancellationRequested: false };
 cancel() { this.token.isCancellationRequested = true; }
 dispose() {}
};
vscode.FileType = { File: 1, Directory: 2 };
vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace") }];
const { SessionController } = require("../dist/controller.cjs");
const controller = () => Object.assign(Object.create(SessionController.prototype), {
 disposed: false, viewEpoch: 1, attached: null, observingId: null,
 workspaceRelativePath: uri => uri.fsPath.replace("/workspace/", ""),
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const file = name => vscode.Uri.file(`/workspace/${name}`);

// Native results reach the view before a slow directory listing completes.
{
 const c = controller(), posts = [], listing = deferred(), started = deferred();
 vscode.workspace.findFiles = async () => [file("a.ts")];
 vscode.workspace.fs.readDirectory = async uri => {
  if (uri.fsPath === "/workspace") { started.resolve(); return listing.promise; }
  return [];
 };
 const search = c.searchFiles("", 1, m => posts.push(m));
 await started.promise;
 assert.deepEqual(posts.map(m => [m.pending, m.files]), [[true, [{ path: "a.ts", isDir: false }]]]);
 listing.resolve([["empty", vscode.FileType.Directory]]);
 await search;
 assert.equal(posts.length, 2);
 assert.equal(posts[1].pending, false);
 assert(posts[1].files.some(f => f.path === "empty" && f.isDir), "empty folders remain available");
}
// Supersession cancels native work and suppresses its late response.
{
 const c = controller(), old = deferred(), posts = []; let oldToken;
 vscode.workspace.findFiles = async (pattern, exclude, max, token) => {
  if (pattern.includes("old")) { oldToken = token; return old.promise; }
  return [file("new.ts")];
 };
 vscode.workspace.fs.readDirectory = async () => [];
 const first = c.searchFiles("old", 1, m => posts.push(m));
 await c.searchFiles("new", 2, m => posts.push(m));
 assert.equal(oldToken.isCancellationRequested, true);
 old.resolve([file("old.ts")]); await first;
 assert.deepEqual(posts.map(m => m.requestId), [2, 2]);
}
// Cancellation during a read prevents visiting returned children.
{
 const c = controller(), listing = deferred(), started = deferred(), reads = [], posts = [];
 let firstRead = true;
 vscode.workspace.findFiles = async () => [];
 vscode.workspace.fs.readDirectory = async uri => {
  reads.push(uri.fsPath);
  if (firstRead) { firstRead = false; started.resolve(); return listing.promise; }
  return [];
 };
 const first = c.searchFiles("old", 1, m => posts.push(m)); await started.promise;
 await c.searchFiles("new", 2, m => posts.push(m));
 listing.resolve([["child", vscode.FileType.Directory]]); await first;
 assert.deepEqual(reads, ["/workspace", "/workspace"]);
 assert.deepEqual(posts.map(m => [m.requestId, m.pending]), [[1, true], [2, true], [2, false]]);
}
// Folder errors preserve files; native failures still permit folder results.
{
 const c = controller(), posts = [];
 vscode.workspace.findFiles = async () => [file("kept.ts")];
 c.searchDirs = async () => { throw new Error("folder failure"); };
 await c.searchFiles("", 1, m => posts.push(m));
 assert.deepEqual(posts[1].files, [{ path: "kept.ts", isDir: false }]);
 assert.equal(posts[1].pending, false);
 vscode.workspace.findFiles = async () => { throw new Error("native failure"); };
 c.searchDirs = async () => ["empty"];
 posts.length = 0; await c.searchFiles("", 2, m => posts.push(m));
 assert.deepEqual(posts.map(m => [m.pending, m.files]), [[true, []], [false, [{ path: "empty", isDir: true }]]]);
}
// Navigation suppresses late results and stops directory recursion.
{
 const c = controller(), listing = deferred(), started = deferred(), posts = [], reads = [];
 vscode.workspace.findFiles = async () => [];
 vscode.workspace.fs.readDirectory = async uri => { reads.push(uri.fsPath); started.resolve(); return listing.promise; };
 const search = c.searchFiles("", 1, m => posts.push(m)); await started.promise;
 c.viewEpoch += 1;
 listing.resolve([["child", vscode.FileType.Directory]]); await search;
 assert.equal(posts.length, 1);
 assert.deepEqual(reads, ["/workspace"]);
}
// Explorer drop URIs resolve to bounded workspace-relative file/folder mentions.
{
	const c = controller();
	vscode.Uri.parse = value => {
		const url = new URL(value);
		return { scheme: url.protocol.slice(0, -1), fsPath: decodeURIComponent(url.pathname) };
	};
	vscode.workspace.fs.stat = async uri => ({ type: uri.fsPath.endsWith("/folder") ? vscode.FileType.Directory : vscode.FileType.File });
	c.workspaceRelativePath = uri => uri.fsPath.startsWith("/workspace/") ? uri.fsPath.slice("/workspace/".length) : null;
	const files = await c.resolveDroppedWorkspaceUris([
		"file:///workspace/a.ts", "file:///workspace/folder", "file:///workspace/a.ts", "https://example.com/nope",
	]);
	assert.deepEqual(files, [{ path: "a.ts", isDir: false }, { path: "folder", isDir: true }]);
}

console.log("PASS workspace search progressive results, cancellation, folders, failures, navigation, and Explorer drops");
