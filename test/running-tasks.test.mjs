import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { BashProcessTracker, readActiveOrphans, unwrapBashCommand } = require("../dist/bash-processes.cjs");
const { readTasks } = require("../dist/background-tasks.cjs");
const check = (name, condition) => { if (!condition) throw new Error(`FAIL ${name}`); console.log(`PASS ${name}`); };
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function startId(pid) { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return `proc:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-running-tasks-"));
const sessions = path.join(dir, "sessions");
const workers = path.join(dir, "daemon-workers", "host");
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(workers, { recursive: true });
const sessionId = "11111111-2222-3333-4444-555555555555";
const sessionFile = path.join(sessions, `${sessionId}.jsonl`);
const journal = path.join(workers, "worker.orphans.jsonl");
fs.writeFileSync(sessionFile, "");
fs.writeFileSync(journal, `${JSON.stringify({ version: 1, pid: process.pid, ownerPid: process.pid, active: true })}\n`);
fs.writeFileSync(path.join(workers, "worker.json"), JSON.stringify({ workerId: "worker", pid: process.pid, orphanProcessJournalPath: journal, updatedAt: new Date().toISOString(), createCommand: { sessionPath: sessionFile } }));

const command = "python3 -c 'import time; time.sleep(30)'";
const gate = `exec 9>&0 8>&1 0</dev/null\nread -r _prime_agent_gate <&9 || exit 127\n{\n${command}\n} 8>&- 9>&-\n__prime_status=$?\nexit \"$__prime_status\"`;
const child = spawn("/bin/bash", ["-c", gate], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
const active = { version: 1, pid: child.pid, ownerPid: process.pid, kernelPid: process.pid + 1, processStartId: startId(child.pid), active: true, recordedAt: new Date().toISOString() };
fs.appendFileSync(journal, `${JSON.stringify(active)}\n`);
child.stdin.write("\n");
await wait(150);
try {
	check("gate command unwraps", unwrapBashCommand(gate) === command);
	check("flattened ps gate command unwraps", unwrapBashCommand(gate.replace(/\n/g, " ")) === command);
	check("kernel enrollment is excluded", readActiveOrphans(journal, process.pid).length === 1);
	const tracker = new BashProcessTracker();
	let tasks = await tracker.refresh({ sessionFile, agentDir: dir });
	check("active bash is found", tasks.length === 1 && tasks[0].kind === "bash");
	check("bash label names the command", tasks[0].label.includes("python3 -c") && !tasks[0].label.includes("_prime_agent_gate"));
	check("bash task has stable process identity", tasks[0].id.includes(active.processStartId) && tasks[0].pid === child.pid);
	fs.appendFileSync(journal, `${JSON.stringify({ version: 1, pid: child.pid, ownerPid: process.pid, active: false, recordedAt: new Date().toISOString() })}\n`);
	tasks = await tracker.refresh({ sessionFile, agentDir: dir });
	check("inactive tombstone removes bash", tasks.length === 0);

	const taskDir = path.join(dir, "session-artifacts", sessionId, "background-tasks", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", label: "build", command: ["npm", "test"], status: "running", created_at: 100, started_at: 101, child_pid: 42 }));
	let evidence = await readTasks(sessionFile);
	check("running background receipt is found", evidence.running.length === 1 && evidence.running[0].label === "build" && evidence.running[0].pid === 42);
	check("a running task awaits no wake", evidence.awaitingWake === undefined);
	const finished = Math.floor(Date.now() / 1000);
	const terminal = (extra) => fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", label: "build", command: ["npm", "test"], status: "completed", created_at: 100, completed_at: finished, ...extra }));
	terminal({ notification: "delivered", notification_at: finished });
	evidence = await readTasks(sessionFile);
	check("completed background receipt is hidden", evidence.running.length === 0);
	check("a task whose wake is in flight awaits it at its completion time", evidence.awaitingWake === finished * 1000);
	terminal({ notification: "failed", notification_at: finished, notification_error: "schedule refused" });
	evidence = await readTasks(sessionFile);
	check("a refused wake awaits nothing", evidence.awaitingWake === undefined);
	terminal({ notification: "heartbeat_pending" });
	evidence = await readTasks(sessionFile);
	check("a heartbeat that will poll the task still awaits it", evidence.awaitingWake === finished * 1000);
	terminal({ notification: "delivered", notification_at: finished });
	check("an armed wake the runtime never delivered is still bounded", (await readTasks(sessionFile, (finished + 31 * 60) * 1000)).awaitingWake === undefined);
} finally {
	try { process.kill(-child.pid, "SIGKILL"); } catch {}
	fs.rmSync(dir, { recursive: true, force: true });
}
console.log("PASS running tasks");
