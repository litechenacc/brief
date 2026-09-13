/** Read-only view of subprocesses started by Prime Agent's Python bash() helper. */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { resolveWorkerDescriptor, type OwnerLookup } from "./daemon-owner.js";
import type { RunningTask } from "./protocol.js";

interface OrphanRecord { version?: number; pid?: number; ownerPid?: number; kernelPid?: number; processStartId?: string; active?: boolean; recordedAt?: string; }

export function readActiveOrphans(file: string, ownerPid: number): OrphanRecord[] | undefined {
	const latest = new Map<number, OrphanRecord>();
	let text: string;
	try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as OrphanRecord;
			if (row.version !== 1 || !Number.isInteger(row.pid) || (row.pid ?? 0) <= 0 || row.ownerPid !== ownerPid || typeof row.active !== "boolean") continue;
			latest.set(row.pid!, row);
		} catch { /* A writer may have left only the final line incomplete. */ }
	}
	return [...latest.values()].filter(row => row.active && Number.isInteger(row.kernelPid) && row.kernelPid !== row.pid);
}

interface PsRow { pid: number; lstart: string; args: string; }
const PS_ROW = /^\s*(\d+)\s+\d+\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

export function parsePsListing(text: string): Map<number, PsRow> {
	const rows = new Map<number, PsRow>();
	let current: PsRow | undefined;
	for (const line of text.split("\n")) {
		const match = PS_ROW.exec(line);
		if (match) { current = { pid: Number(match[1]), lstart: match[2].trim(), args: match[3] }; rows.set(current.pid, current); }
		else if (current) current.args += `\n${line}`;
	}
	return rows;
}

function procStartId(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return start ? `proc:${start}` : undefined;
	} catch { return undefined; }
}

function psListing(): Promise<Map<number, PsRow> | undefined> {
	return new Promise(resolve => execFile("ps", ["-axww", "-o", "pid=,pgid=,lstart=,args="], { timeout: 4_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : parsePsListing(stdout))));
}

export function unwrapBashCommand(args: string): string {
	const text = args.replace(/\\012/g, "\n");
	const gate = /read -r _prime_agent_gate <&\d+ \|\| exit \d+\s*/.exec(text);
	if (!gate) return text.trim();
	const body = text.slice(gate.index + gate[0].length).replace(/^\s*\{\s*/, "");
	const close = /\s+\}\s*\d+>&-\s*\d+>&-\s*__prime_status=/.exec(body);
	return (close ? body.slice(0, close.index) : body).trim() || text.trim();
}

function label(command: string): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

export class BashProcessTracker {
	private last: RunningTask[] = [];
	async refresh(lookup: OwnerLookup, skipPids: ReadonlySet<number> = new Set()): Promise<RunningTask[]> {
		if (process.platform === "win32") return [];
		const descriptor = resolveWorkerDescriptor(lookup);
		const journal = descriptor?.orphanProcessJournalPath;
		if (!descriptor?.pid || !journal || !fs.existsSync(journal)) return this.last;
		const records = readActiveOrphans(journal, descriptor.pid);
		if (!records) return this.last;
		const rows = await psListing();
		if (!rows) return this.last;
		const tasks: RunningTask[] = [];
		for (const row of records) {
			const pid = row.pid!;
			if (skipPids.has(pid)) continue;
			const processRow = rows.get(pid);
			if (!processRow) continue;
			const currentStart = procStartId(pid) ?? `ps:${processRow.lstart}`;
			if (row.processStartId && row.processStartId !== currentStart) continue;
			const command = unwrapBashCommand(processRow.args);
			tasks.push({ id: `bash:${descriptor.workerId ?? descriptor.pid}:${pid}:${row.processStartId ?? row.recordedAt ?? "unknown"}`, kind: "bash", label: label(command), startedAt: Date.parse(row.recordedAt ?? "") || Date.now(), pid });
		}
		this.last = tasks.sort((a, b) => a.startedAt - b.startedAt);
		return this.last;
	}
	reset(): void { this.last = []; }
}
