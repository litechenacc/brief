/** Installed SDK gate. No daemon, model, prompt, or user session/config mutation.
 * Run PRIME_AGENT_SDK=/path/to/prime-agent/dist/index.js node test/fork-runtime-live.mjs */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
const sdk = process.env.PRIME_AGENT_SDK;
assert(sdk, "PRIME_AGENT_SDK must name the installed SDK; missing runtime is not a pass");
const { SessionManager } = await import(pathToFileURL(sdk).href);
const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const vscode = require("vscode");
vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === "command" ? join(dirname(sdk), "bundle", "cli.js") : fallback });
const { SessionController } = require("../dist/controller.cjs");
const memory = { get: (_key, fallback) => fallback, update: async () => {} };
const c = new SessionController({ globalState: memory, workspaceState: memory }, { appendLine() {} });
const dir = mkdtempSync(join(tmpdir(), "brief-fork-live-"));
try {
 const manager = SessionManager.create(dir, dir);
 const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
 const second = manager.appendMessage({ role: "user", content: [{ type: "text", text: "se" }, { type: "text", text: "cond" }], timestamp: 2 });
 const image = manager.appendMessage({ role: "user", content: [{ type: "text", text: "image" }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 3 });
 manager.flushNow();
 const source = manager.getSessionFile(), before = readFileSync(source);
 const inspect = await c.forkFile(source);
 assert.deepEqual(inspect.messages.map(m => m.entryId), [first, second, image]);
 for (const [id, expected, draft] of [[first, [], "first"], [second, ["first"], "second"]]) {
  const fork = await c.forkFile(source, id, inspect.revision);
  assert.notEqual(fork.sessionFile, source);
  assert.equal(fork.text, draft);
  const reopened = SessionManager.open(fork.sessionFile);
  assert.deepEqual(reopened.buildSessionContext().messages.map(m => m.content), expected);
  assert.equal(reopened.getHeader().parentSession, source);
  assert.equal(reopened.getSessionId(), fork.sessionId);
  assert.deepEqual(readFileSync(source), before, "source bytes unchanged");
 }
 // forkFrom drops git_state entries and relinks their children.
 const gitManager = SessionManager.create(dir, dir);
 gitManager.appendMessage({ role: "user", content: "before git", timestamp: 1 });
 gitManager.appendGitState({ branch: "test" });
 const afterGit = gitManager.appendMessage({ role: "user", content: "after git", timestamp: 2 });
 gitManager.flushNow();
 const gitSource = gitManager.getSessionFile(), gitBefore = readFileSync(gitSource);
 const gitInspect = await c.forkFile(gitSource);
 const gitFork = await c.forkFile(gitSource, afterGit, gitInspect.revision);
 assert.deepEqual(SessionManager.open(gitFork.sessionFile).buildSessionContext().messages.map(m => m.content), ["before git"]);
 assert.deepEqual(readFileSync(gitSource), gitBefore);
 const count = readdirSync(dir).length;
 await assert.rejects(c.forkFile(source, image, inspect.revision), /attachments cannot be fully restored/);
 assert.equal(readdirSync(dir).length, count, "blocked image creates nothing");
 await assert.rejects(c.forkFile(source, second, "stale"), /source conversation changed/);
 assert.deepEqual(readFileSync(source), before);
 // Different branch and compaction: visible ID mapping never guesses by text.
 manager.branch(first);
 const alternate = manager.appendMessage({ role: "user", content: "alternate", timestamp: 4 });
 manager.appendCompaction("summary", alternate, 100);
 manager.flushNow();
 const current = await c.forkFile(source);
 assert.deepEqual(current.messages, [{ entryId: first, visible: false }, { entryId: alternate, visible: true }]);
 console.log("PASS installed SDK: source bytes, first-message persistence, reopened branch boundary, draft, attachment block, revision and compaction ID mapping");
} finally { c.dispose(); rmSync(dir, { recursive: true, force: true }); }
