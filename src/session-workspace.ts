/**
 * Workspace editor helpers: file search, image pick, open-at-line.
 * Assigned onto SessionController.prototype — no extra class layer.
 */
import { isFilePath } from "./file-link.js";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileSearchItem, HostToWebview, ImageAttachment } from "./protocol.js";
import type { SessionController } from "./session-controller.js";

export const workspaceMethods = {
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
	const epoch = this.viewEpoch;
	const attached = this.attached;
	const observingId = this.observingId;
	const config = vscode.workspace.getConfiguration("brief");
	const configuredMax = config.get<number>("maxFileSearchResults", 40);
	const max = Math.max(1, Math.min(100, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : 40));
	const trimmed = query.trim().slice(0, 512);
	// This is a filename filter, not a glob-expression input. Drop glob syntax
	// before building the VS Code glob so a hostile webview cannot widen an
	// otherwise bounded search into an unexpectedly expensive one.
	const literal = trimmed.replace(/[{}\[\]*?!\\]/g, "");
	const pattern = literal ? `**/*${literal.replace(/[\s]+/g, "*")}*` : "**/*";
	const exclude = "**/{node_modules,.git,dist,out,.turbo,.next,coverage}/**";
	try {
		const uris = await vscode.workspace.findFiles(pattern, exclude, max);
		if (this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId !== observingId) return;
		const files = uris.map((uri) => this.workspaceRelativePath(uri)).filter((file): file is string => file !== null);
		const dirs = await this.searchDirs(trimmed, Math.max(8, Math.floor(max / 4)));
		if (this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId !== observingId) return;
		const combined = [
			...dirs.map((path) => ({ path, isDir: true })),
			...files.map((path) => ({ path, isDir: false })),
		].sort((a, b) => a.path.localeCompare(b.path));
		reply({ type: "fileSearchResults", requestId, files: combined });
	} catch {
		if (!this.disposed && epoch === this.viewEpoch && this.attached === attached && this.observingId === observingId) {
			reply({ type: "fileSearchResults", requestId, files: [] });
		}
	}
},

async searchDirs(this: SessionController, query: string, max: number): Promise<string[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return [];
	const out: string[] = [];
	const prune = new Set(["node_modules", ".git", "dist", "out", ".turbo", ".next", "coverage", ".vscode-test"]);
	const needle = query.toLowerCase();
	const visit = async (relDir: string, uri: vscode.Uri, depth: number): Promise<void> => {
			if (out.length >= max || depth > 5) return;
			let entries: [string, vscode.FileType][];
			try {
				entries = await vscode.workspace.fs.readDirectory(uri);
			} catch {
				return;
			}
			for (const [name, type] of entries) {
				if (type !== vscode.FileType.Directory || name.startsWith(".") || prune.has(name)) continue;
				const rel = relDir ? `${relDir}/${name}` : name;
				if ((needle === "" || rel.toLowerCase().includes(needle)) && out.length < max) {
					out.push(rel);
				}
				await visit(rel, vscode.Uri.joinPath(uri, name), depth + 1);
				if (out.length >= max) return;
			}
	};
	await visit("", folder.uri, 0);
	return out;
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
