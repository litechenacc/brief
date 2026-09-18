import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");
const store = new Map();
const state = {
 get: (key, fallback) => store.get(key) ?? fallback,
 update: (key, value) => { store.set(key, value); return Promise.resolve(); },
};
const c = new SessionController(
 { subscriptions: [], extensionUri: { fsPath: "/tmp" }, workspaceState: state, globalState: state },
 { append() {}, appendLine() {} },
);
c.scheduleHistoryRefresh = () => {};
c.scheduleChildrenRefresh = () => {};
c.onBusySettled = () => {};
c.scheduleReattach = () => {};
// The session file must sit in a `sessions/` directory: that is what tells the
// background-task reader where the durable task receipts live.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "brief-roster-lamp-"));
const file = path.join(root, "sessions", "lamp.jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, "");
const summary = {
 sessionId: "lamp", sessionFile: file, cwd: "/tmp", rlmDepth: 0,
 activeSessionId: "active", rosterStatus: "running",
};
c.attached = { sessionId: "lamp", activeSessionId: "active", sessionPath: file };
c.attachedEpoch = c.viewEpoch;
c.rentedState = { sessionId: "lamp", sessionFile: file, isStreaming: true };
c.streaming = true;
const posted = [];
c.attach({ post: (message) => posted.push(message) });
const push = (status, extra = {}) => c.onRosterUpdate({
 type: "roster_update",
 changed: [{ agentId: "lamp", status, summary: { ...summary, rosterStatus: status, ...extra } }],
});
const lamp = () => {
 c.pushStatusLight();
 return posted.filter((message) => message.type === "status").at(-1).status.historyRunning;
};
const assertUnknown = (reason) => {
 assert.equal(c.historyRuntime.get(file).status, undefined, reason);
 assert.equal(lamp(), null, "unknown roster must not reuse stale streaming");
 assert.equal(c.historyCompletedAt.has(file), false, "loss of runtime evidence is not completion");
 assert.equal(c.historyUnreadComplete.has(file), false, "loss of runtime evidence creates no notification");
};
try {
 c.rowsFromCatalog([summary]);
 const oldFetch = ++c.historyRuntimeClock.revision;
 push("idle", { isStreaming: false, hasRunningRlmChildren: false });
 assert.equal(c.streaming, true, "roster lamp updates do not mutate local stream controls");
 assert.equal(c.historyRuntime.get(file).status, "idle", "idle push clears lamp without disk reads");
 assert.equal(lamp(), false, "authoritative idle beats stale local streaming");
 assert.equal(posted.filter((message) => message.type === "status").at(-1).status.historyRunning, false);
 c.rowsFromCatalog([summary], oldFetch);
 assert.equal(c.historyRuntime.get(file).status, "idle", "old catalog cannot overwrite newer idle push");
 c.rowsFromCatalog([], oldFetch);
 assert.equal(c.historyRuntime.get(file).status, "idle", "old missing catalog cannot erase newer idle push");

 c.onAgentEvent({ type: "agent_end", messages: [] });
 assert.equal(c.buildStatus().streaming, false, "agent_end clears stale attached snapshot isStreaming");
 push("running");
 assert.equal(c.historyRuntime.get(file).status, "running", "later work turns lamp red");
 push("idle", { hasRunningRlmChildren: true });
 assert.equal(c.historyRuntime.get(file).status, "running", "delegated work remains running");
 c.historyUnreadComplete.add(file);
 c.onAgentEvent({ type: "agent_start" });
 assert.equal(c.historyUnreadComplete.has(file), false, "new turn clears reminder even when aggregate already running");
 c.onAgentEvent({ type: "agent_end", messages: [] });
 assert.equal(lamp(), true, "root agent_end cannot prove delegated work finished");
 push("idle", { hasRunningRlmChildren: false });
 assert.equal(lamp(), false, "authoritative roster settles delegated completion");
 c.onAgentEvent({ type: "agent_start" });
 assert.equal(lamp(), true, "new local work overrides the previous idle verdict");

 c.streaming = true;
 c.rowsFromCatalog([]);
 assertUnknown("full catalog clears missing runtime entries");
 push("running");
 const beforeRemoval = ++c.historyRuntimeClock.revision;
 c.onRosterUpdate({ type: "roster_update", removed: ["lamp"] });
 assertUnknown("removed roster entries invalidate running immediately");
 c.rowsFromCatalog([summary], beforeRemoval);
 assertUnknown("old in-flight catalog cannot resurrect removed running");

 push("running");
 c.onRosterUpdate({ type: "roster_update", resync: true, changed: [] });
 assertUnknown("empty roster resync invalidates running immediately");
 push("running");
 c.onRosterUpdate({
  type: "roster_update", resync: true,
  changed: [{ agentId: "lamp", status: "idle", summary: { ...summary, rosterStatus: "idle" } }],
 });
 assert.equal(lamp(), false, "resync replacement applies current verdict");

 push("running");
 c.onSidecarClosed();
 assertUnknown("disconnected daemon invalidates running without completing the turn");

 // Running tasks hold the lamps exactly as live children do: the turn ended, the
 // work did not. The daemon roster cannot see either of these, so only Brief's
 // own evidence can keep the row red.
 const idleSummary = { ...summary, rosterStatus: "idle", isStreaming: false };
 push("idle", { isStreaming: false, hasRunningRlmChildren: false });
 assert.equal(lamp(), false, "idle roster settles the lamp before the task arrives");

 // A shell process the strip found through the worker journal.
 c.updateHistoryRunningTask(file, "shell", true);
 assert.equal(lamp(), true, "a shell process the daemon cannot see holds the lamp red");
 const other = path.join(root, "sessions", "other.jsonl");
 c.shellTaskPath = file;
 c.attached = { ...c.attached, sessionPath: other };
 await c.refreshRunningTasks();
 assert.equal(c.historyRunningTasks.has(c.historyPathKey(file)), false, "a window that stops reading a session retracts its shell evidence");
 c.attached = { ...c.attached, sessionPath: file };

 // A durable background task: no runtime trace exists for the daemon to see.
 const taskDir = path.join(root, "session-artifacts", "lamp", "background-tasks", "task-1");
 fs.mkdirSync(taskDir, { recursive: true });
 const receipt = (status, extra = {}) => fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify({
  id: "task-1", label: "build", command: ["npm", "run", "build"], status, created_at: 100, started_at: 101, ...extra,
 }));
 const finished = Math.floor(Date.now() / 1000);
 receipt("running");
 await c.refreshRunningTasks();
 assert.equal(lamp(), true, "a running background task holds the lamp red");
 const taskRows = c.rowsFromCatalog([idleSummary]);
 await c.refreshHistoryRunningTasks(taskRows);
 const taskRow = c.decorateHistoryRow(taskRows[0]);
 assert.equal(taskRow.status, "running", "the task keeps its history row red");
 assert.equal(taskRow.running, false, "a task is not a run the row's stop control can abort");

 // The runner records the terminal state and only then arms the wake, so the
 // work is over seconds before the follow-up turn starts.
 receipt("completed", { exit_code: 0, completed_at: finished, notification: "delivered", notification_at: finished });
 await c.refreshRunningTasks();
 assert.equal(lamp(), true, "a finished task whose follow-up is still in flight keeps the lamp red");
 const handoffRows = c.rowsFromCatalog([idleSummary]);
 await c.refreshHistoryRunningTasks(handoffRows);
 assert.equal(c.decorateHistoryRow(handoffRows[0]).status, "running", "...and its history row red with it");

 // The prompt the wake turns into is what the lamp was waiting for.
 c.recordHistoryPrompt(file, finished * 1000 + 1);
 await c.refreshRunningTasks();
 assert.equal(lamp(), false, "the lamp clears once the session receives the prompt");
 assert.equal(c.decorateHistoryRow(c.rowsFromCatalog([idleSummary])[0]).status, "idle", "and the row back to its verdict");

 // A wake the runner never armed resumes nothing at all.
 receipt("completed", { exit_code: 0, completed_at: finished, notification: "failed", notification_at: finished });
 await c.refreshRunningTasks();
 assert.equal(lamp(), false, "a task whose wake failed never holds the lamp");

 // The same evidence read from a transcript: a row clears against the prompt the
 // scan found, not against the host's own idea of time.
 fs.writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: "resume", timestamp: finished * 1000 + 2 } })}\n`);
 receipt("completed", { exit_code: 0, completed_at: finished, notification: "delivered", notification_at: finished });
 const scanned = c.rowsFromCatalog([idleSummary]);
 await c.refreshHistoryCompletions(scanned);
 await c.refreshHistoryRunningTasks(scanned);
 assert.equal(c.decorateHistoryRow(scanned[0]).status, "idle", "a transcript prompt clears the row");
 receipt("completed", { exit_code: 0, completed_at: finished + 5, notification: "delivered", notification_at: finished + 5 });
 const unread = c.rowsFromCatalog([idleSummary]);
 await c.refreshHistoryCompletions(unread);
 await c.refreshHistoryRunningTasks(unread);
 assert.equal(c.decorateHistoryRow(unread[0]).status, "running", "a task that finished after the last prompt still holds the row");

 // The viewed session takes the same marker from the live event it is watching.
 assert.equal(lamp(), true, "and the open session is red with it");
 receipt("completed", { exit_code: 0, completed_at: finished, notification: "delivered", notification_at: finished });
 c.onAgentEvent({ type: "message_start", message: { role: "user", content: "resume", timestamp: finished * 1000 + 3 } });
 await c.refreshRunningTasks();
 assert.equal(lamp(), false, "a live prompt clears the open session");
 console.log("runtime lamp refresh tests passed");
} finally {
 c.dispose();
 fs.rmSync(root, { recursive: true, force: true });
}
