import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Stable terminal-message time, shared by live snapshots and persisted JSONL.
 * This is a message revision marker, not the wall-clock time generation ended.
 */
export function completedMessageTime(messages: readonly unknown[]): number {
	let latest = 0;
	for (const value of messages) {
		if (!value || typeof value !== "object") continue;
		const message = value as Record<string, unknown>;
		if (message.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "length")) continue;
		const timestamp = message.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > latest && timestamp <= 8.64e15) latest = timestamp;
	}
	return latest;
}

const cache = new Map<string, { signature: string; completed: number }>();

/** File metadata only invalidates the read cache; it never signals completion.
 * Scan all entries so metadata chatter, branches and compaction cannot hide an
 * earlier completed reply. A snapshot compacted past that reply can return 0;
 * callers retain their previously observed marker rather than moving backward.
 */
export async function readSessionCompletion(sessionPath: string): Promise<number> {
	try {
		const info = await stat(sessionPath);
		if (!info.isFile()) return 0;
		const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		const previous = cache.get(sessionPath);
		if (previous?.signature === signature) return previous.completed;
		let completed = 0;
		const stream = createReadStream(sessionPath, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				let entry;
				try { entry = JSON.parse(line); } catch { continue; }
				if (entry?.type === "message") completed = Math.max(completed, completedMessageTime([entry.message]));
			}
		} finally {
			lines.close();
			stream.destroy();
		}
		cache.set(sessionPath, { signature, completed });
		return completed;
	} catch {
		cache.delete(sessionPath);
		return 0;
	}
}
