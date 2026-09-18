import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunningTask } from "../shared/protocol.js";

function directory(sessionFile: string | undefined): string | undefined {
	if (!sessionFile || path.extname(sessionFile) !== ".jsonl") return undefined;
	const resolved = path.resolve(sessionFile);
	const dir = path.dirname(resolved);
	const id = path.basename(resolved, ".jsonl");
	return path.basename(dir) === "sessions" ? path.join(path.dirname(dir), "session-artifacts", id, "background-tasks") : path.join(dir, "background-tasks");
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "launch_failed"]);
/**
 * How long a finished task may still hold the run lamp red waiting for the
 * prompt that resumes the session. The wake-up is armed seconds out, so this is
 * only a safety valve: an armed wake that never lands (a runtime that stayed
 * down) must not pin the lamp forever.
 */
const WAKE_WAIT_MS = 30 * 60_000;
/**
 * The runner's own record of what will resume the session once the task is over:
 * "pending" before it arms anything, "delivered" when the daemon accepted the
 * scheduled prompt, "heartbeat_pending" when a heartbeat will poll the task
 * instead. Only "failed" means nothing is coming, and the operator must look.
 */
const ARMED = new Set(["pending", "delivered", "heartbeat_pending"]);

export interface TaskEvidence {
	/** Tasks still starting or running: what the Running tasks strip shows. */
	running: RunningTask[];
	/**
	 * When the newest finished task's wake-up was recorded, if a prompt that
	 * resumes the session may still be on its way. The work is over but the
	 * session is not waiting for the operator yet, so the run lamp must not call
	 * it done until the session receives that prompt.
	 */
	awaitingWake?: number;
}

export async function readTasks(sessionFile: string | undefined, now = Date.now()): Promise<TaskEvidence> {
	const dir = directory(sessionFile);
	if (!dir) return { running: [] };
	let names: string[];
	try { names = await fs.readdir(dir); } catch { return { running: [] }; }
	const running: RunningTask[] = [];
	let awaitingWake: number | undefined;
	await Promise.all(names.map(async (id) => {
		let raw: Record<string, unknown>;
		try { raw = JSON.parse(await fs.readFile(path.join(dir, id, "state.json"), "utf8")) as Record<string, unknown>; }
		catch { return; } // A receipt being rewritten is not evidence.
		const status = typeof raw.status === "string" ? raw.status : "";
		if (status === "starting" || status === "running") {
			if (typeof raw.id !== "string") return;
			const command = Array.isArray(raw.command) ? raw.command.filter((part): part is string => typeof part === "string").join(" ") : "background task";
			running.push({ id: raw.id, label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : command, startedAt: typeof raw.started_at === "number" ? raw.started_at * 1000 : typeof raw.created_at === "number" ? raw.created_at * 1000 : Date.now(), kind: "background" as const, stdoutPath: path.join(dir, id, "stdout.log"), stderrPath: path.join(dir, id, "stderr.log"), ...(typeof raw.child_pid === "number" ? { pid: raw.child_pid } : {}) });
			return;
		}
		if (!TERMINAL.has(status) || typeof raw.notification !== "string" || !ARMED.has(raw.notification)) return;
		const finished = typeof raw.completed_at === "number" ? raw.completed_at * 1000 : undefined;
		if (finished === undefined || now - finished >= WAKE_WAIT_MS) return;
		if (awaitingWake === undefined || finished > awaitingWake) awaitingWake = finished;
	}));
	running.sort((a, b) => a.startedAt - b.startedAt);
	return { running, awaitingWake };
}
