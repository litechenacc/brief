/**
 * Non-prompt live slash runtime gate. Run: node test/slash-runtime-live.mjs
 * Uses actual source RpcClient + DaemonSidecar; never sends inference, bash,
 * extension commands, or shutdown. Missing runtime/auth/daemon is a nonzero
 * BLOCKED result, not a skip/pass. Only test-created sessions are mutated.
 * This tests runtime new_session, NOT the host initializeBlankFrom or /new UI.
 * agentDir MUST be isolated too: runtime setters persist model/thinking defaults.
 * Copies auth and model cache read-only from the operator into a private temp
 * directory; no settings, extensions, skills, or session history are copied.
 * Never writes user/global settings outside that private test agentDir.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brief-slash-runtime-"));
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
const allowed = new Set(["get_state", "get_messages", "get_available_models", "set_model", "set_thinking_level", "new_session"]);
function safeCommand(command) { assert(allowed.has(command.type), `not a non-prompt command: ${command.type}`); }
async function rpcRequest(command) {
  safeCommand(command);
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
    stdin: { contents: 'export { RpcClient } from "./src/rpc-client.ts"; export { DaemonSidecar } from "./src/daemon-sidecar.ts"; export { supportedThinkingLevels } from "./src/session-logic.ts";', resolveDir: path.resolve(new URL("..", import.meta.url).pathname), loader: "ts" },
    bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
  });
  const { RpcClient, DaemonSidecar, supportedThinkingLevels } = createRequire(import.meta.url)(outfile);
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

  async function exercise(label, request) {
    stage = `${label} model catalog`;
    const before = await request({ type: "get_state" });
    assert.equal((await request({ type: "get_messages" })).messages.length, 0);
    const models = (await request({ type: "get_available_models" })).models;
    if (!Array.isArray(models) || models.length < 2) blocked(`${label}: fewer than two authenticated available models`);
    const target = models.find(m => m.reasoning === true && `${m.provider}/${m.id}` !== `${before.model?.provider}/${before.model?.id}` && supportedThinkingLevels(m)?.length > 1);
    if (!target) blocked(`${label}: no alternate reasoning model with selectable levels`);
    stage = `${label} model switch`;
    await request({ type: "set_model", provider: target.provider, modelId: target.id });
    const switched = await request({ type: "get_state" });
    assert.equal(switched.model.provider, target.provider);
    assert.equal(switched.model.id, target.id);
    pass(`${label} model switch/readback`, `${target.provider}/${target.id}`);
    // Runtime supplies model capability metadata; the actual Brief helper
    // derives the picker choices. Verify EACH offered choice is not clamped.
    const levels = supportedThinkingLevels(switched.model);
    assert(levels?.length > 1);
    pass(`${label} available thinking levels`, levels.join(","));
    for (const level of levels) {
      stage = `${label} thinking ${level}`;
      await request({ type: "set_thinking_level", level });
      assert.equal((await request({ type: "get_state" })).thinkingLevel, level);
      pass(`${label} thinking set/readback`, level);
    }
    const settings = await request({ type: "get_state" });
    const persisted = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(persisted.defaultProvider, target.provider);
    assert.equal(persisted.defaultModel, target.id);
    assert.equal(persisted.defaultThinkingLevel, settings.thinkingLevel);
    pass(`${label} native setters persist GLOBAL defaults inside isolated agentDir`, "session-only scope unavailable; never run this gate against user agentDir");
    stage = `${label} blank new_session`;
    const created = await request({ type: "new_session" });
    assert.notEqual(created?.cancelled, true);
    const after = await request({ type: "get_state" });
    assert(after.sessionId && after.sessionId !== settings.sessionId, "new_session must change session identity");
    assert.equal((await request({ type: "get_messages" })).messages.length, 0);
    assert.equal(after.model.provider, target.provider);
    assert.equal(after.model.id, target.id);
    assert.equal(after.thinkingLevel, settings.thinkingLevel);
    assert(after.sessionFile?.startsWith(workRoot + path.sep), "new session file must stay isolated");
    pass(`${label} blank new session inherits model/thinking`, `thinking=${after.thinkingLevel}`);
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
    assert(ownIds.has(activeSessionId));
    return sidecar.request({ ...command, activeSessionId }, 25_000);
  });
  stage = "daemon fresh worker config inheritance";
  const source = await sidecar.getState(activeSessionId);
  const settingsFile = path.join(agentDir, "settings.json");
  const defaultsBefore = fs.readFileSync(settingsFile, "utf8");
  const freshDir = path.join(workRoot, "fresh-worker-sessions");
  fs.mkdirSync(freshDir);
  // Deliberately differ from the saved thinking default: creation must apply
  // its config without mutating defaults or the old worker.
  const thinking = supportedThinkingLevels(source.model).find(level => level !== source.thinkingLevel && level !== "off");
  assert(thinking);
  const fresh = await sidecar.request({ type: "create", lifecycle: "resident", config: {
    cwd: workRoot, agentDir, sessionDir: freshDir,
    provider: source.model.provider, model: source.model.id, thinking,
  } }, 30_000);
  const freshId = fresh?.activeSessionId ?? fresh?.id;
  assert(freshId && freshId !== activeSessionId);
  ownIds.add(freshId);
  const freshState = await sidecar.getState(freshId);
  assert.equal(freshState.model.provider, source.model.provider);
  assert.equal(freshState.model.id, source.model.id);
  assert.equal(freshState.thinkingLevel, thinking);
  assert.equal((await sidecar.getMessages(freshId)).length, 0);
  assert(freshState.sessionFile?.startsWith(freshDir + path.sep));
  assert.equal((await sidecar.getState(activeSessionId)).thinkingLevel, source.thinkingLevel);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), defaultsBefore);
  pass("daemon create config seeds blank worker model/thinking without changing global defaults or source", `thinking=${thinking}`);
} catch (error) {
  exitCode = 1;
  console.error(`${error.message.startsWith("BLOCKED:") ? "" : "FAIL "}${stage}: ${error.stack || error}`);
} finally {
  if (!await cleanup()) exitCode = 1;
  clearTimeout(watchdog);
}
console.log(`${exitCode ? "FAIL/BLOCKED" : "PASS"} slash-runtime-live (${checks} checks; no prompts/inference)`);
process.exit(exitCode);
