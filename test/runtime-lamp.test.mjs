import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
const file = "/tmp/brief-roster-lamp.jsonl";
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
 console.log("runtime lamp refresh tests passed");
} finally {
 c.dispose();
}
