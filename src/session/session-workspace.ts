/**
 * Workspace editor helpers: file search, image pick, open-at-line.
 * Assigned onto SessionController.prototype — no extra class layer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePrimeAuthRuntime } from "../runtime/prime-auth-runtime.js";
import { isFilePath } from "./file-link.js";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileSearchItem, HostToWebview, ImageAttachment } from "../shared/protocol.js";
import type { SessionController } from "./session-controller.js";


/** Runs only SessionManager operations in the installed SDK, never an agent/model. */
const forkScript = `
import { pathToFileURL } from "node:url";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const [sdk, source, entryId, expected] = process.argv.slice(1);
const { SessionManager } = await import(pathToFileURL(sdk).href);
const fingerprint = () => createHash("sha256").update(readFileSync(source)).digest("hex");
const revision = fingerprint();
// In-memory loading cannot repair or migrate the source file on disk.
const manager = SessionManager.inMemory();
manager.setSessionFile(source);
const branch = manager.getBranch();
const visible = new Set(manager.buildSessionContext().messages);
const users = branch.filter(e => e.type === "message" && e.message.role === "user");
if (!entryId) {
 console.log(JSON.stringify({ revision, messages: users.map(e => ({ entryId: e.id, visible: visible.has(e.message) })) }));
} else {
 if (revision !== expected) throw new Error("The source conversation changed. Open Fork again.");
 const selected = users.find(e => e.id === entryId);
 if (!selected) throw new Error("The selected message is no longer on the current branch.");
 const content = selected.message.content;
 if (typeof content !== "string" && (!Array.isArray(content) || content.some(c => c.type !== "text" || typeof c.text !== "string"))) {
  throw new Error("Cannot fork this message: its attachments cannot be fully restored. Nothing was changed.");
 }
 const text = typeof content === "string" ? content : content.map(c => c.text).join("");
 if (text.length > 200000) throw new Error("The selected message exceeds the draft size limit.");
 let fork;
 try {
  fork = SessionManager.forkFrom(source, manager.getHeader().cwd, dirname(source));
  const parentId = fork.getEntry(entryId)?.parentId; // forkFrom re-links dropped git_state entries.
  if (parentId) fork.branch(parentId); else fork.resetLeaf();
  // The SDK copies the tree; persist the selected active leaf, not the old tail.
  fork.appendCustomEntry("brief_fork", { entryId });
  fork.flushNow(); // Also persist a first-message fork with no assistant history.
  if (fingerprint() !== revision) throw new Error("The source conversation changed. Open Fork again.");
  console.log(JSON.stringify({ sessionFile: fork.getSessionFile(), sessionId: fork.getSessionId(), text }));
 } catch (error) {
  if (fork?.getSessionFile()) unlinkSync(fork.getSessionFile());
  throw error;
 }
}
`;

const fileSearches = new WeakMap<SessionController, vscode.CancellationTokenSource>();

export const workspaceMethods = {
async forkFile(this: SessionController, sessionFile: string, entryId?: string, revision?: string): Promise<{ revision: string; messages: Array<{ entryId: string; visible: boolean }>; sessionFile: string; sessionId: string; text: string }> {
 const runtime = await resolvePrimeAuthRuntime({ command: vscode.workspace.getConfiguration("brief").get<string>("command", "prime-agent"), cwd: this.workspaceRoot });
 try {
  const { stdout } = await promisify(execFile)(runtime.node, ["--input-type=module", "-e", forkScript, runtime.sdk, sessionFile, entryId ?? "", revision ?? ""], { cwd: this.workspaceRoot, env: runtime.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
 } catch (error) {
  const stderr = (error as { stderr?: string }).stderr ?? "";
  const detail = stderr.match(/Error: ([^\n]+)/)?.[1];
  throw new Error(detail ?? "The installed Prime Agent SDK could not prepare the fork.");
 }
},

getActiveSelection(this: SessionController): { path: string; startLine: number; endLine: number; text: string; languageId: string } | null {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return null;
	const doc = editor.document;
	if (!this.isInWorkspaceRoot(doc.uri)) return null;
	const sel = editor.selection;
	if (sel.isEmpty) return null;
	const text = doc.getText(sel);
	if (text.length > 100_000) return null;
	const relativePath = this.workspaceRelativePath(doc.uri);
	if (!relativePath) return null;
	return {
		path: relativePath,
		startLine: sel.start.line + 1,
		endLine: sel.end.line + 1,
		text,
		languageId: doc.languageId,
	};
},

getActiveFilePath(this: SessionController): string | null {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return null;
	return this.workspaceRelativePath(editor.document.uri);
},

async searchFiles(this: SessionController, query: string, requestId: number, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): Promise<void> {
	fileSearches.get(this)?.cancel();
	const source = new vscode.CancellationTokenSource();
	fileSearches.set(this, source);
	const epoch = this.viewEpoch;
	const attached = this.attached;
	const observingId = this.observingId;
	const current = (): boolean => !source.token.isCancellationRequested && !this.disposed
		&& epoch === this.viewEpoch && this.attached === attached && this.observingId === observingId;
	const config = vscode.workspace.getConfiguration("brief");
	const configuredMax = config.get<number>("maxFileSearchResults", 40);
	const max = Math.max(1, Math.min(100, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : 40));
	const trimmed = query.trim().slice(0, 512);
	// This is a filename filter, not a glob-expression input.
	const literal = trimmed.replace(/[{}\[\]*?!\\]/g, "");
	const pattern = literal ? `**/*${literal.replace(/[\s]+/g, "*")}*` : "**/*";
	const exclude = "**/{node_modules,.git,dist,out,.turbo,.next,coverage}/**";
	try {
		let files: FileSearchItem[] = [];
		try {
			const uris = await vscode.workspace.findFiles(pattern, exclude, max, source.token);
			if (!current()) return;
			files = uris.map((uri) => this.workspaceRelativePath(uri))
				.filter((file): file is string => file !== null).map((path) => ({ path, isDir: false }));
		} catch {
			if (!current()) return;
			// Directory completion remains useful if native file search fails.
		}
		files.sort((a, b) => a.path.localeCompare(b.path));
		reply({ type: "fileSearchResults", requestId, files, pending: true });
		let dirs: string[] = [];
		try {
			dirs = await this.searchDirs(trimmed, Math.max(8, Math.floor(max / 4)), source.token);
		} catch {
			// A folder failure must not discard already available files.
		}
		if (!current()) return;
		const combined = [
			...dirs.map((path) => ({ path, isDir: true })),
			...files,
		].sort((a, b) => a.path.localeCompare(b.path));
		reply({ type: "fileSearchResults", requestId, files: combined, pending: false });
	} finally {
		if (fileSearches.get(this) === source) fileSearches.delete(this);
		source.dispose();
	}
},

async searchDirs(this: SessionController, query: string, max: number, token?: vscode.CancellationToken): Promise<string[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return [];
	const epoch = this.viewEpoch;
	const attached = this.attached;
	const observingId = this.observingId;
	const stopped = (): boolean => !!token?.isCancellationRequested || this.disposed
		|| epoch !== this.viewEpoch || this.attached !== attached || this.observingId !== observingId;
	const out: string[] = [];
	const prune = new Set(["node_modules", ".git", "dist", "out", ".turbo", ".next", "coverage", ".vscode-test"]);
	const needle = query.toLowerCase();
	const visit = async (relDir: string, uri: vscode.Uri, depth: number): Promise<void> => {
		if (stopped() || out.length >= max || depth > 5) return;
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(uri);
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			if (stopped()) return;
			if (type !== vscode.FileType.Directory || name.startsWith(".") || prune.has(name)) continue;
			const rel = relDir ? `${relDir}/${name}` : name;
			if ((needle === "" || rel.toLowerCase().includes(needle)) && out.length < max) out.push(rel);
			await visit(rel, vscode.Uri.joinPath(uri, name), depth + 1);
			if (out.length >= max) return;
		}
	};
	await visit("", folder.uri, 0);
	return out;
},


async resolveDroppedWorkspaceUris(this: SessionController, uris: string[]): Promise<FileSearchItem[]> {
	const files: FileSearchItem[] = [];
	const seen = new Set<string>();
	for (const raw of uris) {
		try {
			const parsed = vscode.Uri.parse(raw);
			// Explorer sends vscode-remote: while this extension host accesses the
			// remote filesystem through file:. workspaceRelativePath() validates the
			// resulting local path with realpath containment below.
			const uri = parsed.scheme === "vscode-remote" ? vscode.Uri.file(parsed.fsPath) : parsed;
			if (uri.scheme !== "file") continue;
			const relative = this.workspaceRelativePath(uri);
			if (!relative) continue;
			const stat = await vscode.workspace.fs.stat(uri);
			const isDir = (stat.type & vscode.FileType.Directory) !== 0;
			if (!isDir && (stat.type & vscode.FileType.File) === 0) continue;
			const key = `${isDir ? "dir" : "file"}:${relative}`;
			if (!seen.has(key)) { seen.add(key); files.push({ path: relative, isDir }); }
		} catch {
			// Ignore malformed, unavailable, and non-workspace drag entries.
		}
	}
	return files;
},
async pickImages(this: SessionController, requestId: number, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): Promise<void> {
	const epoch = this.viewEpoch;
	const attached = this.attached;
	const observingId = this.observingId;
	const stillCurrent = (): boolean =>
		!this.disposed && epoch === this.viewEpoch && this.attached === attached && this.observingId === observingId && !this.observationRestoring;
	const uris = await vscode.window.showOpenDialog({
		canSelectMany: true,
		filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
		openLabel: "Attach image",
	});
	if (!uris || uris.length === 0) {
		if (stillCurrent()) reply({ type: "imagePicked", requestId, images: [] });
		return;
	}
	const mimeByExt: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
	};
	const MAX_IMAGES = 8;
	// Matches webview/image-fit.ts: the provider ceiling is measured on the
	// encoded payload, so the decoded cap must leave base64 headroom. The
	// webview resizes anything over this before it ever reaches the wire.
	const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
	const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
	const images: ImageAttachment[] = [];
	let totalBytes = 0;
	let skippedOversized = 0;
	for (const uri of uris.slice(0, MAX_IMAGES)) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > MAX_IMAGE_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
				skippedOversized += 1;
				continue;
			}
			const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
			images.push({
				data: Buffer.from(bytes).toString("base64"),
				mimeType: mimeByExt[ext] ?? "image/png",
				name: path.basename(uri.fsPath),
			});
			totalBytes += bytes.byteLength;
		} catch {
			// skip unreadable files
		}
	}
	if (!stillCurrent()) return;
	if (uris.length > MAX_IMAGES || skippedOversized > 0) {
		reply({ type: "notice", level: "warning", text: "Some images were skipped (maximum 8 images, 7 MiB each, 16 MiB total)." });
	}
	reply({ type: "imagePicked", requestId, images });
},

async openFile(this: SessionController, relPath: string, startLine?: number, endLine?: number): Promise<void> {
	const uri = await this.resolveWorkspaceUri(relPath);
	if (!uri) {
		this.broadcast({ type: "notice", level: "error", text: `Could not open ${relPath}` });
		return;
	}
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type === vscode.FileType.Directory) {
			await vscode.commands.executeCommand("revealInExplorer", uri);
			return;
		}
		if (startLine === undefined) {
			// Let VS Code choose the editor, including image and custom previews.
			await vscode.commands.executeCommand("vscode.open", uri);
			return;
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc);
		if (startLine !== undefined) {
			const start = new vscode.Position(Math.max(0, startLine - 1), 0);
			const end = endLine !== undefined ? new vscode.Position(Math.max(0, endLine - 1), 0) : start;
			editor.selection = new vscode.Selection(start, end);
			editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
		}
	} catch {
		this.broadcast({ type: "notice", level: "error", text: `Could not open ${relPath}` });
	}
},

async resolveWorkspaceUri(this: SessionController, relPath: string): Promise<vscode.Uri | null> {
	// Opening a user-clicked link does not forward file contents to the agent.
	// Absolute paths and parent-relative paths may intentionally leave the workspace.
	if (!isFilePath(relPath)) return null;
	if (!path.isAbsolute(relPath) && !this.workspaceRoot) return null;
	return vscode.Uri.file(path.resolve(this.workspaceRoot, relPath));
}
};
