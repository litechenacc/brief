/**
 * Live, non-inference message acquisition for /export and /copy.
 * Run: node test/export-copy-runtime-live.mjs
 * Real SDK JSONL source + actual workspaceMethods.forkFile preparation, then
 * Brief RpcClient and DaemonSidecar startup. Only VS Code configuration is stubbed.
 * Does not validate live clipboard, Save Dialog, UI, or in-flight streaming.
 * Connects to an existing daemon; never starts/stops the daemon. Only sessions
 * created by this test are killed. Runtime files and agentDir stay private.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brief-export-copy-live-"));
fs.chmodSync(workRoot, 0o700);
const agentDir = path.join(workRoot, "agent");
fs.mkdirSync(agentDir, { mode: 0o700 });
const ownIds = new Set();
let rpc, sidecar, cleanupPromise;
let stage = "SDK discovery", checks = 0, exitCode = 0;
function pass(name) { checks++; console.log(`PASS ${name}`); }
function blocked(message) { throw new Error(`BLOCKED: ${message}`); }
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
    // Allow RpcClient's bounded SIGKILL fallback before removing its files.
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
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  const force = setTimeout(() => process.exit(2), 15_000);
  void cleanup().finally(() => { clearTimeout(force); process.exit(2); });
});

try {
  const command = process.env.PRIME_AGENT_COMMAND || "prime-agent";
  const executable = command.includes(path.sep) ? command : (process.env.PATH || "").split(path.delimiter)
    .map(dir => path.join(dir, command)).find(candidate => fs.existsSync(candidate));
  if (!executable) blocked("prime-agent executable not found");
  let sdkRoot = path.dirname(fs.realpathSync(executable));
  while (!fs.existsSync(path.join(sdkRoot, "dist/core/session-manager.js"))) {
    const parent = path.dirname(sdkRoot);
    if (parent === sdkRoot) blocked("installed SDK SessionManager not found next to prime-agent");
    sdkRoot = parent;
  }
  const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/session-manager.js")).href);
  const sourceAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR || path.join(os.homedir(), ".prime", "agent");
  // Read-only copies needed for normal runtime startup; never print credentials.
  for (const name of ["auth.json", "prime-inference-models-cache.json"]) {
    const source = path.join(sourceAgentDir, name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(agentDir, name));
      fs.chmodSync(path.join(agentDir, name), 0o600);
    }
  }
  const outfile = path.join(workRoot, "clients.cjs");
  esbuild.buildSync({
    stdin: { contents: 'export { RpcClient } from "./src/rpc-client.ts"; export { DaemonSidecar } from "./src/daemon-sidecar.ts"; export { buildMarkdownExport } from "./src/markdown-export.ts"; export { workspaceMethods } from "./src/session-workspace.ts";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent", external: ["vscode"],
  });
  const require = createRequire(import.meta.url);
  const { vscodeStub } = require("./vscode-stub.cjs");
  vscodeStub.workspace.getConfiguration = () => ({ get: (key, fallback) => key === "command" ? command : fallback });
  // forkFile resolves and imports the real installed SDK in its own process.
  // Its inherited agentDir must be isolated, just like the runtime workers.
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
  const { RpcClient, DaemonSidecar, buildMarkdownExport, workspaceMethods } = require(outfile);
  const user = text => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const assistant = (content, stopReason = "stop") => ({
    role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  });
  stage = "SDK fixture";
  const source = SessionManager.create(workRoot, path.join(workRoot, "source"));
  source.appendMessage(user("shared root"));
  const branchPoint = source.appendMessage(assistant([{ type: "text", text: "shared answer" }]));
  source.appendMessage(user("ABANDONED_USER_BRANCH"));
  source.appendMessage(assistant([{ type: "text", text: "ABANDONED_ASSISTANT_BRANCH" }]));
  source.branch(branchPoint);
  source.appendMessage(user("active branch question"));
  const body = "## Completed answer\n\n```ts\nconst answer = 42;\n```";
  source.appendMessage(assistant([{ type: "thinking", thinking: "PRIVATE_THINKING_FIXTURE" }, { type: "text", text: body }]));
  source.appendMessage(assistant([{ type: "toolCall", id: "fixture-tool", name: "bash", arguments: { command: "NEVER_EXECUTE_FIXTURE" } }], "toolUse"));
  source.appendMessage({ role: "toolResult", toolCallId: "fixture-tool", toolName: "bash",
    content: [{ type: "text", text: "FULL_TOOL_RESULT_FIXTURE" }], isError: false, timestamp: Date.now() });
  source.appendMessage(assistant([{ type: "thinking", thinking: "THINKING_ONLY_FIXTURE" }]));
  const expected = source.buildSessionContext().messages;
  const draft = "Selected user prompt to edit\n\n```ts\nconst next = 43;\n```";
  const selectedId = source.appendMessage(user(draft));
  source.appendMessage(assistant([{ type: "text", text: "AFTER_SELECTED_REPLY" }]));
  source.flushNow();
  const sourceFile = source.getSessionFile();
  const sourceBytes = fs.readFileSync(sourceFile);
  const sourceMessages = source.buildSessionContext().messages;
  assert(fs.readFileSync(sourceFile, "utf8").includes("ABANDONED_ASSISTANT_BRANCH"));
  assert(!JSON.stringify(expected).includes("ABANDONED_"));
  stage = "actual workspaceMethods.forkFile";
  const controller = { workspaceRoot: workRoot };
  const listing = await workspaceMethods.forkFile.call(controller, sourceFile);
  assert.match(listing.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(listing.messages.map(message => message.entryId), source.getBranch()
    .filter(entry => entry.type === "message" && entry.message.role === "user").map(entry => entry.id));
  assert(listing.messages.some(message => message.entryId === selectedId && message.visible));
  const rpcFork = await workspaceMethods.forkFile.call(controller, sourceFile, selectedId, listing.revision);
  const daemonFork = await workspaceMethods.forkFile.call(controller, sourceFile, selectedId, listing.revision);
  for (const fork of [rpcFork, daemonFork]) {
    assert.equal(fork.text, draft, "selected user body returns as draft without being sent");
    assert(fork.sessionFile.startsWith(workRoot + path.sep));
    assert.notEqual(fork.sessionId, source.getSessionId());
    const reopened = SessionManager.open(fork.sessionFile);
    assert.equal(reopened.getSessionId(), fork.sessionId);
    assert.deepEqual(reopened.buildSessionContext().messages, expected);
  }
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes);
  const rpcFixture = SessionManager.open(rpcFork.sessionFile);
  const daemonFixture = SessionManager.open(daemonFork.sessionFile);
  assert.notEqual(rpcFixture.getSessionId(), daemonFixture.getSessionId());
  pass("actual forkFile lists current branch, returns selected draft, persists preselected boundary and leaves source byte-identical");

  function verify(label, messages) {
    assert.deepEqual(messages, expected, `${label}: exact completed current-branch messages`);
    assert(!JSON.stringify(messages).includes("ABANDONED_"));
    const reply = messages.filter(message => message.role === "assistant")
      .findLast(message => message.content.some(part => part.type === "text" && part.text.trim()));
    assert.equal(reply.stopReason, "stop");
    assert.equal(reply.content.filter(part => part.type === "text").map(part => part.text).join("\n"), body);
    assert.equal(messages.at(-1).content[0].type, "thinking");
    pass(`${label} acquired exact current branch with completed Markdown body, tool-only and thinking-only tail`);
    for (const tools of [true, false]) {
      const markdown = buildMarkdownExport(messages, tools, null);
      assert(markdown.includes(body));
      assert(markdown.includes("PRIVATE_THINKING_FIXTURE"));
      assert(!markdown.includes("ABANDONED_"));
      assert(!markdown.includes("FULL_TOOL_RESULT_FIXTURE"));
    }
    pass(`${label} real acquired messages feed both existing Markdown formats without other branches or full tool results`);
  }
  async function rpcRead(type) {
    assert(["get_state", "get_messages"].includes(type));
    const result = await rpc.request({ type }, 25_000);
    assert(result.success, `${type}: ${result.error}`);
    return result.data;
  }
  stage = "stdio resume";
  rpc = new RpcClient({ command, cwd: workRoot,
    args: ["--resume", rpcFixture.getSessionFile(), "--session-dir", rpcFixture.getSessionDir()],
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
  });
  rpc.start();
  const rpcState = await rpcRead("get_state");
  assert.equal(rpcState.sessionId, rpcFixture.getSessionId());
  assert.equal(rpcState.sessionFile, rpcFixture.getSessionFile());
  verify("actual stdio get_messages", (await rpcRead("get_messages")).messages);

  stage = "existing daemon connection";
  sidecar = new DaemonSidecar();
  try { await sidecar.connect(8_000); }
  catch (error) { blocked(`existing daemon unavailable: ${error.message}`); }
  stage = "daemon fixture resume";
  const summary = await sidecar.request({ type: "create", lifecycle: "resident",
    config: { cwd: workRoot, agentDir, sessionDir: daemonFixture.getSessionDir() },
    sessionPath: daemonFixture.getSessionFile(),
  }, 30_000);
  const activeSessionId = summary?.activeSessionId ?? summary?.id;
  assert(activeSessionId, "owned create must return id");
  ownIds.add(activeSessionId);
  assert.equal(summary.sessionFile, daemonFixture.getSessionFile());
  const attached = await sidecar.attach(activeSessionId);
  assert(attached.snapshot, "actual attach must return snapshot");
  verify("actual daemon attach snapshot", attached.snapshot.messages);
  verify("actual daemon getMessages", await sidecar.getMessages(activeSessionId));
  const daemonState = await sidecar.getState(activeSessionId);
  assert.equal(daemonState.sessionId, daemonFixture.getSessionId());
  assert.equal(daemonState.sessionFile, daemonFixture.getSessionFile());
  assert.equal((await rpcRead("get_state")).sessionId, rpcFixture.getSessionId());
  assert.deepEqual((await rpcRead("get_messages")).messages, expected);
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes);
  assert.deepEqual(SessionManager.open(sourceFile).buildSessionContext().messages, sourceMessages);
  pass("daemon resume/read leaves source JSONL byte-identical and stdio identity/messages unchanged");
} catch (error) {
  exitCode = 1;
  console.error(`${error.message.startsWith("BLOCKED:") ? "" : "FAIL "}${stage}: ${error.stack || error}`);
} finally {
  if (!await cleanup()) exitCode = 1;
  clearTimeout(watchdog);
}
console.log(`${exitCode ? "FAIL/BLOCKED" : "PASS"} export-copy-runtime-live (${checks} checks; no prompts/inference; not live UI/clipboard validation)`);
process.exit(exitCode);
