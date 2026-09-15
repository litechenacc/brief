import { el } from "./dom.js";
import type { RunningTask, WebviewToHost } from "../src/shared/protocol.js";

function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export class RunningTasksStrip {
	readonly root = el("div", "running-tasks-strip");
	private tasks: RunningTask[] = [];
	private expanded = false;
	private timer: number | undefined;
	private autoExpandSuppressed = false;

	constructor(private readonly post: (message: WebviewToHost) => void) {}

	apply(tasks: RunningTask[]): void {
		const appeared = tasks.some((task) => !this.tasks.some((old) => old.id === task.id));
		this.tasks = tasks;
		if (appeared && !this.autoExpandSuppressed) this.expanded = true;
		this.syncTimer();
		this.render();
	}

	private syncTimer(): void {
		window.clearInterval(this.timer);
		this.timer = this.tasks.length > 0 ? window.setInterval(() => this.updateElapsed(), 1_000) : undefined;
	}

	private updateElapsed(): void {
		const now = Date.now();
		this.root.querySelectorAll(".running-task-time").forEach((time, index) => {
			time.textContent = elapsed(now - this.tasks[index].startedAt);
		});
	}

	private render(): void {
		this.root.replaceChildren();
		this.root.classList.toggle("visible", this.tasks.length > 0);
		if (this.tasks.length === 0) return;
		const header = el("button", "running-tasks-header", `${this.expanded ? "▾" : "▸"} Running tasks (${this.tasks.length})`) as HTMLButtonElement;
		header.setAttribute("aria-expanded", String(this.expanded));
		header.addEventListener("click", () => {
			this.expanded = !this.expanded;
			this.autoExpandSuppressed = !this.expanded;
			this.render();
		});
		this.root.appendChild(header);
		if (!this.expanded) return;
		for (const task of this.tasks) {
			const { stdoutPath, stderrPath } = task;
			const row = el("div", "running-task-row");
			const dot = el("span", "running-task-dot");
			dot.setAttribute("aria-hidden", "true");
			row.append(dot, el("span", "running-task-label", task.label));
			row.title = `${task.label}${task.pid ? `\npid ${task.pid}` : ""}`;
			if (stdoutPath) {
				const stdout = el("button", "running-task-log", "StdOut");
				stdout.title = `Open stdout.log in VS Code — ${task.label}`;
				stdout.addEventListener("click", () => this.post({ type: "openFile", path: stdoutPath }));
				row.appendChild(stdout);
			}
			if (stdoutPath && stderrPath) {
				const separator = el("span", "running-task-separator", "|");
				separator.setAttribute("aria-hidden", "true");
				row.appendChild(separator);
			}
			if (stderrPath) {
				const stderr = el("button", "running-task-log", "StdErr");
				stderr.title = `Open stderr.log in VS Code — ${task.label}`;
				stderr.addEventListener("click", () => this.post({ type: "openFile", path: stderrPath }));
				row.appendChild(stderr);
			}
			row.appendChild(el("span", "running-task-time", elapsed(Date.now() - task.startedAt)));
			this.root.appendChild(row);
		}
	}
}
