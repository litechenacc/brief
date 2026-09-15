/**
 * Non-inference statistics gate: node test/statistics-runtime-live.mjs
 * Uses Brief source clients and an EXISTING daemon (missing = BLOCKED).
 * Only private agentDir/session fixtures are changed. Auth/cache are copied;
 * user settings/history are never opened. No prompt or compaction is sent.
 * Seed format: installed prime-agent 0.9.4 SessionManager JSONL version 3.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brief-statistics-runtime-"));
fs.chmodSync(workRoot, 0o700);
const agentDir = path.join(workRoot, "agent");
fs.mkdirSync(agentDir, { mode: 0o700 });
const sourceAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR || path.join(os.homedir(), ".prime", "agent");
const ownIds = new Set();
let rpc;
let sidecar;
let checks = 0;
let cleanupPromise;
let stage = "build";
function pass(name, detail = "") {
  checks++;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function blocked(message) { throw new Error(`BLOCKED: ${message}`); }
const allowed = new Set(["get_state", "get_messages", "get_session_stats", "switch_session"]);
function safeCommand(command) { assert(allowed.has(command.type), `not a non-prompt command: ${command.type}`); }
async function rpcRequest(command) {
  safeCommand(command);
  if (command.type === "switch_session") assert(command.sessionPath.startsWith(workRoot + path.sep));
  const result = await rpc.request(command, 25_000);
  assert(result.success, `${command.type}: ${result.error}`);
  return result.data;
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let ok = true;
    for (const activeSessionId of ownIds) {
      try { await sidecar.request({ type: "kill", activeSessionId }, 5_000); }
      catch (error) { ok = false; console.error(`FAIL owned session cleanup ${activeSessionId}: ${error.message}`); }
    }
    sidecar?.dispose();
    rpc?.stop();
    // Keep RpcClient's bounded SIGKILL fallback alive before deleting its files.
    if (rpc) await new Promise(resolve => setTimeout(resolve, 1700));
    if (ok) fs.rmSync(workRoot, { recursive: true, force: true });
    else console.error(`Cleanup incomplete; isolated files retained at ${workRoot}`);
    return ok;
  })();
  return cleanupPromise;
}
const watchdog = setTimeout(() => {
  console.error(`FAIL watchdog at ${stage}; owned sessions: ${[...ownIds].join(",")}`);
  const force = setTimeout(() => process.exit(2), 15_000);
  void cleanup().finally(() => { clearTimeout(force); process.exit(2); });
}, 120_000);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    const force = setTimeout(() => process.exit(2), 15_000);
    void cleanup().finally(() => { clearTimeout(force); process.exit(2); });
  });
}

let exitCode = 0;
try {
  for (const name of ["auth.json", "prime-inference-models-cache.json"]) {
    const source = path.join(sourceAgentDir, name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(agentDir, name));
      fs.chmodSync(path.join(agentDir, name), 0o600);
    }
  }
  const outfile = path.join(workRoot, "clients.cjs");
  esbuild.buildSync({
    stdin: { contents: 'export { RpcClient } from "./src/runtime/rpc-client.ts"; export { DaemonSidecar } from "./src/runtime/daemon-sidecar.ts";', resolveDir: path.resolve(new URL("..", import.meta.url).pathname), loader: "ts" },
    bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
  });
  const { RpcClient, DaemonSidecar } = createRequire(import.meta.url)(outfile);
  sidecar = new DaemonSidecar();
  stage = "existing daemon connection";
  try { await sidecar.connect(8_000); }
  catch (error) { blocked(`existing daemon unavailable: ${error.message}`); }
  pass("actual daemon sidecar handshake", `revision=${sidecar.hello?.schemaRevision}`);

  const rpcSessionDir = path.join(workRoot, "rpc-sessions");
  fs.mkdirSync(rpcSessionDir);
  rpc = new RpcClient({
    command: process.env.PRIME_AGENT_COMMAND || "prime-agent", cwd: workRoot,
    args: ["--session-dir", rpcSessionDir],
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
  });
  stage = "stdio runtime startup";
  rpc.start();
  try { await rpcRequest({ type: "get_state" }); }
  catch (error) { blocked(`stdio runtime unavailable: ${error.message}`); }
  pass("actual stdio RpcClient startup");

  // Fixtures include an off-branch assistant with deliberately huge usage.
  // The selected leaf is the last entry, whose parent bypasses that assistant.
  function fixture(label, model, compacted) {
    assert(model?.provider && model?.id && model.contextWindow > 0, "runtime model with context window required");
    const timestamp = new Date().toISOString();
    const sessionId = randomUUID();
    const entry = (id, parentId, data) => ({ id, parentId, timestamp, ...data });
    const assistant = (amount, totalTokens) => ({ role: "assistant", content: [{ type: "text", text: "fixture" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: amount, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } } });
    const entries = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: workRoot, rlmDepth: 0 },
      entry("user0001", null, { type: "message", message: { role: "user", content: "fixture", timestamp: Date.now() } }),
      entry("off00001", "user0001", { type: "message", message: assistant(900000, 900090) }),
      entry("used0001", "user0001", { type: "message", message: assistant(10, 75) }),
    ];
    // Retain the known assistant but replace the earlier user with a summary.
    // No inference is used to produce the compaction marker.
    if (compacted) entries.push(entry("compact1", "used0001", { type: "compaction",
      summary: "fixture summary", firstKeptEntryId: "used0001", tokensBefore: 75 }));
    const file = path.join(workRoot, `${label}-${compacted ? "compacted" : "branch"}.jsonl`);
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    return file;
  }
  async function exercise(label, request) {
    async function query(expectedMessages, expectedUser, expectedUsage, contextTokens) {
      stage = `${label} statistics read-only query`;
      const before = await request({ type: "get_state" });
      const messages = await request({ type: "get_messages" });
      assert(before.sessionFile?.startsWith(workRoot + path.sep));
      const readFile = () => fs.existsSync(before.sessionFile) ? fs.readFileSync(before.sessionFile, "utf8") : null;
      const bytes = readFile();
      const stats = await request({ type: "get_session_stats" });
      assert.equal(stats.sessionId, before.sessionId);
      assert.equal(stats.sessionFile, before.sessionFile);
      assert.equal(stats.totalMessages, expectedMessages);
      assert.equal(before.messageCount, expectedMessages);
      assert.equal(stats.userMessages, expectedUser);
      assert.equal(stats.assistantMessages, expectedUsage ? 1 : 0);
      assert.equal(stats.toolCalls, 0);
      assert.equal(stats.toolResults, 0);
      assert.deepEqual(stats.tokens, expectedUsage ? { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
      assert.equal(stats.cost, expectedUsage ? 1 : 0);
      assert.equal(stats.contextUsage.tokens, contextTokens);
      assert.equal(stats.contextUsage.contextWindow, before.model.contextWindow);
      assert.equal(stats.contextUsage.percent, contextTokens === null ? null : contextTokens / before.model.contextWindow * 100);
      assert.deepEqual(await request({ type: "get_session_stats" }), stats);
      assert.deepEqual(await request({ type: "get_messages" }), messages);
      assert.deepEqual(await request({ type: "get_state" }), before);
      assert.equal(readFile(), bytes, "statistics must not append or rewrite the session");
      pass(`${label} ${expectedUsage ? contextTokens === null ? "compacted unknown context" : "active branch usage and separate context total" : "blank zero usage/context"}; queries preserve state/messages/file`);
      return before;
    }
    const blank = await query(0, 0, false, 0);
    for (const compacted of [false, true]) {
      stage = `${label} load owned fixture`;
      const sessionPath = fixture(label, blank.model, compacted);
      await request({ type: "switch_session", sessionPath });
      await query(2, compacted ? 0 : 1, true, compacted ? null : 75);
    }
  }
  await exercise("stdio", rpcRequest);

  stage = "isolated daemon resident create";
  const sessionDir = path.join(workRoot, "daemon-sessions");
  fs.mkdirSync(sessionDir);
  const summary = await sidecar.request({ type: "create", lifecycle: "resident", config: { cwd: workRoot, agentDir, sessionDir } }, 30_000);
  const activeSessionId = summary?.activeSessionId ?? summary?.id;
  assert(activeSessionId, "owned create must return id");
  ownIds.add(activeSessionId);
  assert(summary.sessionFile?.startsWith(workRoot + path.sep));
  const attached = await sidecar.attach(activeSessionId);
  assert.equal(attached.snapshot?.messages?.length, 0);
  pass("daemon attaches isolated blank resident");
  await exercise("daemon", command => {
    safeCommand(command);
    if (command.type === "switch_session") assert(command.sessionPath.startsWith(workRoot + path.sep));
    assert(ownIds.has(activeSessionId));
    return sidecar.request({ ...command, activeSessionId }, 25_000);
  });
} catch (error) {
  exitCode = 1;
  console.error(`${error.message.startsWith("BLOCKED:") ? "" : "FAIL "}${stage}: ${error.stack || error}`);
} finally {
  if (!await cleanup()) exitCode = 1;
  clearTimeout(watchdog);
}
console.log(`${exitCode ? "FAIL/BLOCKED" : "PASS"} statistics-runtime-live (${checks} checks; no prompts/inference)`);
process.exit(exitCode);
