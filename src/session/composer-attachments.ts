import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComposerAttachment, PromptPayload } from "../shared/protocol.js";

function isAvif(data: Buffer): boolean {
	if (data.length < 16 || data.toString("ascii", 4, 8) !== "ftyp") return false;
	const end = Math.min(data.readUInt32BE(0), data.length);
	for (let offset = 8; offset + 4 <= end; offset += 4) {
		if (offset === 12) continue; // minor version, not a brand
		if (["avif", "avis"].includes(data.toString("ascii", offset, offset + 4))) return true;
	}
	return false;
}

type OwnedAttachment = { path: string; kind: "text" | "image"; mimeType?: string; ready: boolean };

/** Host-only capabilities. No path supplied by the webview is ever opened. */
const sessions = new Map<string, Map<string, OwnedAttachment>>();
let directory: Promise<string> | undefined;

export class ComposerAttachments {

	async create(sessionId: string, ref: ComposerAttachment): Promise<void> {
		let entries = sessions.get(sessionId);
		if (!entries) sessions.set(sessionId, entries = new Map());
		if (entries.has(ref.id)) throw new Error("Attachment already exists.");
		const dir = await (directory ??= fs.mkdtemp(path.join(os.tmpdir(), "brief-attachments-")).then((dir) => fs.realpath(dir)));
		const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif" };
		const file = path.join(dir, randomUUID() + (ref.kind === "text" ? ".txt" : extensions[ref.image!.mimeType]));
		if (entries.has(ref.id)) throw new Error("Attachment already exists.");
		const owned: OwnedAttachment = { path: file, kind: ref.kind, mimeType: ref.image?.mimeType, ready: false };
		entries.set(ref.id, owned);
		try { await fs.writeFile(file, ref.kind === "text" ? ref.text! : Buffer.from(ref.image!.data, "base64"), { flag: "wx", mode: 0o600 }); owned.ready = true; }
		catch (error) { entries.delete(ref.id); throw error; }
	}

	private get(sessionId: string, id: string): OwnedAttachment {
		const owned = sessions.get(sessionId)?.get(id);
		if (!owned?.ready) throw new Error("Attachment is unavailable for this session. Paste it again.");
		return owned;
	}

	async open(sessionId: string, id: string): Promise<void> {
		const owned = this.get(sessionId, id);
		const stat = await fs.lstat(owned.path);
		if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(owned.path) !== owned.path) throw new Error("Attachment path changed.");
		const uri = vscode.Uri.file(owned.path);
		if (owned.kind === "text") await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
		else await vscode.commands.executeCommand("vscode.open", uri);
	}

	referencesTextPath(sessionId: string, refs: ComposerAttachment[], filePath: string): boolean {
		return refs.some((ref) => {
			const file = sessions.get(sessionId)?.get(ref.id);
			return file?.kind === "text" && file.path === filePath;
		});
	}

	async draftText(sessionId: string, draft: { text: string; attachments: ComposerAttachment[] }): Promise<string> {
		let text = "", cursor = 0;
		for (const ref of draft.attachments) {
			if (ref.start < cursor || draft.text.slice(ref.start, ref.end) !== `[${ref.label}]`) throw new Error("Attachment marker is invalid.");
			const file = this.get(sessionId, ref.id);
			text += draft.text.slice(cursor, ref.start);
			if (file.kind === "text") {
				const stat = await fs.lstat(file.path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 800_000) throw new Error("Attachment cannot be read.");
				if (await fs.realpath(file.path) !== file.path) throw new Error("Attachment path changed.");
				const contents = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file.path));
				if (contents.includes("\0")) throw new Error("Text attachments cannot contain NUL characters.");
				text += contents;
			}
			cursor = ref.end;
			if (text.length > 200_000) throw new Error("Draft exceeds 200,000 characters.");
		}
		text += draft.text.slice(cursor);
		if (text.length > 200_000) throw new Error("Draft exceeds 200,000 characters.");
		return text;
	}

	async expand(payload: PromptPayload): Promise<PromptPayload & { recallText?: string }> {
		const refs = payload.attachments ?? [];
		if (!refs.length) return payload;
		if (!payload.sessionId) throw new Error("Attachment session is missing.");
		const owned = refs.map((ref) => {
			if (ref.status !== "ready") throw new Error("Wait for attachments to finish before sending.");
			const file = this.get(payload.sessionId!, ref.id);
			if (file.kind !== ref.kind) throw new Error("Attachment type does not match.");
			return file;
		});
		const textPaths = new Set(owned.filter((file) => file.kind === "text").map((file) => file.path));
		const dirty = (vscode.workspace.textDocuments ?? []).filter((doc) => doc.uri.scheme === "file" && textPaths.has(doc.uri.fsPath) && doc.isDirty);
		if (dirty.length) {
			const choice = await vscode.window.showWarningMessage("附件有尚未儲存的變更。", { modal: true }, "儲存這些附件並送出", "取消");
			if (choice !== "儲存這些附件並送出") throw new Error("已取消送出，附件變更尚未儲存。");
			for (const doc of dirty) if (!await doc.save() || doc.isDirty) throw new Error("附件儲存失敗，未送出。");
		}
		let text = "", recallText = "", cursor = 0;
		const images = [...payload.images];
		let imageBytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
		for (let index = 0; index < refs.length; index++) {
			const ref = refs[index], file = owned[index];
			if (ref.start < cursor || payload.text.slice(ref.start, ref.end) !== `[${ref.label}]`) throw new Error("Attachment marker is invalid.");
			text += payload.text.slice(cursor, ref.start);
			recallText += payload.text.slice(cursor, ref.start);
			const stat = await fs.lstat(file.path);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attachment is not a regular file.");
			if (stat.size > (file.kind === "text" ? 800_000 : 7 * 1024 * 1024)) throw new Error("Attachment is too large. Reduce its size before sending.");
			if (await fs.realpath(file.path) !== file.path) throw new Error("Attachment path changed.");
			const data = await fs.readFile(file.path);
			if (file.kind === "text") {
				const contents = new TextDecoder("utf-8", { fatal: true }).decode(data);
				if (contents.includes("\0")) throw new Error("Text attachments cannot contain NUL characters.");
				text += contents; recallText += contents;
			}
			else {
				const detected = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
					: data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
					: ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)) ? "image/gif"
					: data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
					: isAvif(data) ? "image/avif" : undefined;
				if (detected !== file.mimeType) throw new Error("Attachment image type does not match its contents.");
				imageBytes += data.length;
				if (!data.length || data.length > 7 * 1024 * 1024 || imageBytes > 16 * 1024 * 1024 || images.length >= 8) throw new Error("Image attachments exceed the size or count limit.");
				images.push({ data: data.toString("base64"), mimeType: file.mimeType! });
				text += `[${ref.label} — attached image ${images.length}]`;
			}
			cursor = ref.end;
			if (text.length > 200_000) throw new Error("Expanded prompt exceeds 200,000 characters. Shorten the attachments before sending.");
		}
		text += payload.text.slice(cursor);
		recallText += payload.text.slice(cursor);
		if (text.length > 200_000) throw new Error("Expanded prompt exceeds 200,000 characters. Shorten the attachments before sending.");
		return { ...payload, text, images, attachments: undefined, recallText };
	}
}
