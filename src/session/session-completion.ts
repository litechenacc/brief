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

/** The prompt the session received last, in the same message-timestamp terms.
 * A prompt is what wakes a session: the completion follow-up a finished task
 * arms arrives as one, so this marker answers "has that task been received?".
 */
export function promptedMessageTime(messages: readonly unknown[]): number {
	let latest = 0;
	for (const value of messages) {
		if (!value || typeof value !== "object") continue;
		const message = value as Record<string, unknown>;
		if (message.role !== "user") continue;
		const timestamp = message.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > latest && timestamp <= 8.64e15) latest = timestamp;
	}
	return latest;
}

/** Stable transcript markers, both in message-timestamp terms. */
export interface SessionMarks {
	/** Latest terminal reply: the last turn that finished. */
	completed: number;
	/** Latest user message: the last prompt the session received. */
	prompted: number;
}

const cache = new Map<string, { signature: string; marks: SessionMarks }>();

/** File metadata only invalidates the read cache; it never signals completion.
 * Scan all entries so metadata chatter, branches and compaction cannot hide an
 * earlier completed reply. A snapshot compacted past that reply can return 0;
 * callers retain their previously observed marker rather than moving backward.
 */
export async function readSessionMarks(sessionPath: string): Promise<SessionMarks | undefined> {
	try {
		const info = await stat(sessionPath);
		if (!info.isFile()) return undefined;
		const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		const previous = cache.get(sessionPath);
		if (previous?.signature === signature) return previous.marks;
		const marks: SessionMarks = { completed: 0, prompted: 0 };
		const stream = createReadStream(sessionPath, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				let entry;
				try { entry = JSON.parse(line); } catch { continue; }
				if (entry?.type !== "message") continue;
				marks.completed = Math.max(marks.completed, completedMessageTime([entry.message]));
				marks.prompted = Math.max(marks.prompted, promptedMessageTime([entry.message]));
			}
		} finally {
			lines.close();
			stream.destroy();
		}
		cache.set(sessionPath, { signature, marks });
		return marks;
	} catch {
		cache.delete(sessionPath);
		return undefined;
	}
}
