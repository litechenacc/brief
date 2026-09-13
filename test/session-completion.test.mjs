import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/session-completion.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { completedMessageTime, readSessionCompletion } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const final = (timestamp, stopReason = "stop") => ({ role: "assistant", stopReason, timestamp, content: [{ type: "text", text: "done" }] });
const entry = message => ({ type: "message", id: `m${message.timestamp}`, timestamp: "2099-01-01T00:00:00.000Z", message });
const jsonl = entries => entries.map(value => JSON.stringify(value)).join("\n") + "\n";
assert.equal(completedMessageTime([null, {}, final(10), final(20, "length")]), 20);
assert.equal(completedMessageTime([final(10), ...["toolUse", "error", "aborted", "unknown"].map(reason => final(30, reason)), { role: "assistant", timestamp: 40 }, { role: "user", timestamp: 50 }]), 10);
assert.equal(completedMessageTime([final(NaN), final(Infinity), final(-1), final(8.64e15 + 1), final("100")]), 0);
const dir = await mkdtemp(path.join(tmpdir(), "brief-completion-"));
const file = path.join(dir, "session.jsonl");
try {
 assert.equal(await readSessionCompletion(file), 0, "missing file is not completion");
 await writeFile(file, jsonl([{ type: "session", id: "s", timestamp: "2099-01-01" }, entry(final(100))]));
 assert.equal(await readSessionCompletion(file), 100, "restart recovers final reply using message timestamp, not outer entry time");
 assert.equal(await readSessionCompletion(file), completedMessageTime([final(100)]), "snapshot and file share one marker");
 assert.equal(await readSessionCompletion(file), 100, "unchanged cached result");
 await utimes(file, new Date(), new Date("2099-01-01"));
 assert.equal(await readSessionCompletion(file), 100, "mtime change is not completion");
 await appendFile(file, jsonl([{ type: "session_info", name: "renamed", timestamp: "2099-02-01" }, { type: "custom", customType: "rpc", timestamp: "2099-03-01" }, entry(final(200, "toolUse")), { type: "compaction", summary: "old turns compacted" }]) + "{torn line\n");
 assert.equal(await readSessionCompletion(file), 100, "metadata, tool calls, compaction and malformed lines do not count");
 await appendFile(file, jsonl([entry(final(300)), entry(final(400, "error")), entry(final(500, "aborted"))]));
 assert.equal(await readSessionCompletion(file), 300, "changed file recovers new final but excludes failure");
 const fork = path.join(dir, "fork.jsonl");
 await writeFile(fork, jsonl([{ type: "session", id: "fork", timestamp: "2099-05-01" }, entry(final(300))]));
 assert.equal(await readSessionCompletion(fork), 300, "fork retains inherited revision rather than fork creation time");
 await writeFile(file, jsonl([entry(final(25))]));
 assert.equal(await readSessionCompletion(file), 25, "file replacement invalidates cache");
 await rm(file);
 assert.equal(await readSessionCompletion(file), 0, "deleted file clears cache");
} finally {
 await rm(dir, { recursive: true, force: true });
}
console.log("session completion tests passed");
