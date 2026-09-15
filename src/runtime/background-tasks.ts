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

export async function readRunningTasks(sessionFile: string | undefined): Promise<RunningTask[]> {
	const dir = directory(sessionFile);
	if (!dir) return [];
	try {
		const names = await fs.readdir(dir);
		const tasks = await Promise.all(names.map(async (id) => {
			try {
				const raw = JSON.parse(await fs.readFile(path.join(dir, id, "state.json"), "utf8")) as Record<string, unknown>;
				if ((raw.status !== "starting" && raw.status !== "running") || typeof raw.id !== "string") return undefined;
				const command = Array.isArray(raw.command) ? raw.command.filter((part): part is string => typeof part === "string").join(" ") : "background task";
				return { id: raw.id, label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : command, startedAt: typeof raw.started_at === "number" ? raw.started_at * 1000 : typeof raw.created_at === "number" ? raw.created_at * 1000 : Date.now(), kind: "background" as const, stdoutPath: path.join(dir, id, "stdout.log"), stderrPath: path.join(dir, id, "stderr.log"), ...(typeof raw.child_pid === "number" ? { pid: raw.child_pid } : {}) };
			} catch { return undefined; }
		}));
		return tasks.filter((task): task is Exclude<typeof task, undefined> => task !== undefined).sort((a, b) => a.startedAt - b.startedAt);
	} catch { return []; }
}
