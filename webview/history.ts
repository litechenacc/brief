/**
 * History view: workspace-scoped by default, with an all-session toggle.
 */

import { el, icon } from "./dom.js";
import type { RecentSession } from "../src/protocol.js";
import { deriveSessionLabel } from "../src/session-label.js";
import { subagentLabel } from "./subagent-label.js";

export interface HistoryFoldState {
	active: boolean;
	archive: boolean;
}

type HistorySort = "priority" | "birth";
type HistoryScope = "workspace" | "all";

export interface HistoryDeps {
	onResume: (path: string, sessionId: string) => void;
	onDelete: (path: string, sessionId: string) => void;
	onArchive: (path: string, sessionId: string) => void;
	onUnarchive: (path: string, sessionId: string) => void;
	onRename: (path: string, sessionId: string, name: string) => void;
	onStop: (path: string, sessionId: string) => void;
	/** Ask the host to search the conversations themselves, not just these rows. */
	onSearch: (query: string) => void;
	onBack: () => void;
	readFolds?: () => Partial<HistoryFoldState> | undefined;
	writeFolds?: (folds: HistoryFoldState) => void;
	readSort?: () => HistorySort | undefined;
	writeSort?: (sort: HistorySort) => void;
	readScope?: () => HistoryScope | undefined;
	writeScope?: (scope: HistoryScope) => void;
}

/** Host round-trip debounce: long enough to not search every keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 220;
/** 1.4s alternate animation: keep rebuilt status dots on one shared phase. */
const RUNNING_PULSE_CYCLE_MS = 2_800;

function historyLabel(session: { name?: string; firstPrompt?: string; isNew?: boolean }): string {
	return deriveSessionLabel(session) || (session.isNew ? "New session" : "(untitled session)");
}

export class HistoryView {
	readonly root: HTMLElement;
	private listEl: HTMLElement;

	constructor(private readonly deps: HistoryDeps) {
		this.root = el("div", "history-view");
		const header = el("div", "history-header");
		const backBtn = document.createElement("button");
		backBtn.className = "icon-btn history-back";
		backBtn.title = "Back to chat";
		backBtn.appendChild(icon("back", 15));
		backBtn.addEventListener("click", () => this.deps.onBack());
		this.scope = this.deps.readScope?.() === "all" ? "all" : "workspace";
		this.scopeEl = document.createElement("button");
		this.scopeEl.className = "history-scope";
		this.scopeEl.addEventListener("click", () => {
			this.scope = this.scope === "workspace" ? "all" : "workspace";
			this.deps.writeScope?.(this.scope);
			this.updateScopeControl();
			this.render(this.lastSessions ?? [], this.currentId);
		});
		this.updateScopeControl();
		header.append(backBtn, el("span", "history-title", "Sessions"), this.scopeEl);
		// Search bar. The local filter is the instant layer; the host searches the
		// conversation bodies in parallel and hands back the extra rows with a
		// snippet, so a phrase the operator only half-remembers still finds them.
		this.searchEl = document.createElement("input");
		this.searchEl.className = "history-search";
		this.searchEl.placeholder = "Search sessions…";
		this.searchEl.setAttribute("aria-label", "Search sessions");
		this.searchEl.setAttribute("spellcheck", "false");
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl.value;
			this.render(this.lastSessions ?? [], this.currentId);
			if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
			const query = this.query;
			this.searchTimer = setTimeout(() => this.deps.onSearch(query), SEARCH_DEBOUNCE_MS) as unknown as number;
		});
		this.headerEl = header;
		this.sortEl = document.createElement("select");
		this.sortEl.className = "history-sort";
		this.sortEl.setAttribute("aria-label", "Sort sessions");
		for (const [label, value] of [["Priority", "priority"], ["Birth time", "birth"]] as const) {
			const option = document.createElement("option");
			option.textContent = label;
			option.value = value;
			this.sortEl.appendChild(option);
		}
		this.sort = this.deps.readSort?.() === "birth" ? "birth" : "priority";
		this.sortEl.value = this.sort;
		this.sortEl.addEventListener("change", () => {
			this.sort = this.sortEl.value === "birth" ? "birth" : "priority";
			this.deps.writeSort?.(this.sort);
			this.render(this.lastSessions ?? [], this.currentId);
		});
		this.listEl = el("div", "history-list");
		this.root.append(header, this.searchEl, this.sortEl, this.listEl);
		const saved = this.deps.readFolds?.();
		this.folds = {
			active: saved?.active ?? false,
			archive: saved?.archive ?? true,
		};
	}

	private searchEl: HTMLInputElement;
	private sortEl: HTMLSelectElement;
	private scopeEl: HTMLButtonElement;
	private sort: HistorySort = "priority";
	private scope: HistoryScope = "workspace";
	private headerEl: HTMLElement;
	private lastSessions: RecentSession[] | null = null;
	private query = "";
	private fetching = false;
	private searchTimer: number | undefined;
	private folds: HistoryFoldState;
	private applyingFolds = false;
	private expandedChildSessions = new Set<string>();

	/** Keep the last render on screen while a fresh list arrives; mark subtly. */
	showLoading(): void {
		this.fetching = true;
		this.root.classList.add("refreshing");
		if (!this.lastSessions || this.lastSessions.length === 0) {
			this.listEl.textContent = "";
			this.listEl.appendChild(el("div", "history-empty", "Loading…"));
		}
	}

	setCurrentSession(sessionId?: string): void {
		if (sessionId === this.currentId) return;
		this.render(this.lastSessions ?? [], sessionId);
	}

	render(sessions: RecentSession[], currentId?: string): void {
		const needle = this.query.trim().toLowerCase();
		// matchSnippet is the host's evidence that the conversation itself matched;
		// without it in the haystack the local filter would drop the very rows the
		// host just searched the transcripts to find.
		const haystackFields = (s: RecentSession): string[] =>
			[s.name, s.firstPrompt, s.cwd, s.matchSnippet]
				.filter((v): v is string => typeof v === "string" && v.length > 0)
				.map((v) => v.toLowerCase());

		/** Rank: 3 exact substring · 2 all-tokens match · 1 subsequence fuzzy · 0/no hit. */
		const rankOf = (s: RecentSession): number => {
			if (!needle) return 1;
			const fields = haystackFields(s);
			const joined = fields.join(" ");
			if (fields.some((f) => f.includes(needle))) return 3;
			const tokens = needle.split(/\s+/).filter(Boolean);
			if (tokens.length > 1 && tokens.every((tok) => joined.includes(tok))) return 2;
			// subsequence: all chars of needle appear in order somewhere
			const compressed = joined.replace(/[^a-z0-9./_-]/g, "");
			let pos = 0;
			const compactNeedle = needle.replace(/[^a-z0-9./_-]/g, "");
			for (const ch of compressed) {
				if (pos < compactNeedle.length && ch === compactNeedle[pos]) pos += 1;
				else if (pos >= compactNeedle.length) break;
			}
			return pos >= Math.min(compactNeedle.length, 3) && pos === compactNeedle.length && compactNeedle.length > 0 ? 1 : 0;
		};

		// Dedupe by path: a host-side search appends rows the roster had capped
		// away, and the operator must never see the same session twice.
		const seen = new Set<string>();
		const withRanks: Array<{ s: RecentSession; rank: number }> = [];
		for (const s of sessions) {
			if (this.scope === "workspace" && !s.inWorkspace) continue;
			if (seen.has(s.path)) continue;
			seen.add(s.path);
			const rank = rankOf(s);
			if (needle !== "" && rank === 0) continue;
			withRanks.push({ s, rank });
		}
		// Always keep the full list: the search box re-filters from `lastSessions`,
		// so skipping this while a needle was active froze the list at whatever
		// arrived before the operator started typing.
		this.lastSessions = sessions;
		this.currentId = currentId;
		this.fetching = false;
		this.root.classList.remove("refreshing");
		this.listEl.textContent = "";
		if (withRanks.length === 0) {
			const emptyText = needle
				? `No sessions match "${needle}".`
				: this.scope === "workspace" ? "No sessions in this workspace." : "No previous sessions found.";
			this.listEl.appendChild(el("div", "history-empty", emptyText));
			return;
		}
		const activityOf = (s: RecentSession): number =>
			s.sortMs ?? s.modifiedMs ?? (Number.isFinite(Date.parse(s.timestamp)) ? Date.parse(s.timestamp) : 0);
		const birthOf = (s: RecentSession): number => {
			const birth = Date.parse(s.timestamp);
			return Number.isFinite(birth) ? birth : 0;
		};
		const priorityOf = (s: RecentSession): number =>
			s.unreadComplete && s.status !== "running" && !s.running ? 0 : s.status === "running" || s.running ? 1 : 2;
		const bySelectedSort = (a: { s: RecentSession; rank: number }, b: { s: RecentSession; rank: number }) =>
			this.sort === "birth"
				? birthOf(b.s) - birthOf(a.s)
				: priorityOf(a.s) - priorityOf(b.s) || b.rank - a.rank || activityOf(b.s) - activityOf(a.s);
		const active = withRanks.filter(({ s }) => !s.archived).sort(bySelectedSort);
		const archived = withRanks.filter(({ s }) => s.archived).sort(bySelectedSort);
		const searching = needle !== "";
		if (active.length > 0) {
			this.listEl.appendChild(this.buildGroup("Active", active.length, "active", searching, active, false));
		}
		if (archived.length > 0) {
			this.listEl.appendChild(this.buildGroup("Archive", archived.length, "archive", searching, archived, false));
		}
	}

	private updateScopeControl(): void {
		const showingWorkspace = this.scope === "workspace";
		this.scopeEl.textContent = showingWorkspace ? "This workspace" : "All sessions";
		this.scopeEl.title = showingWorkspace ? "Show all sessions" : "Show this workspace only";
		this.scopeEl.setAttribute("aria-label", showingWorkspace
			? "Showing this workspace. Switch to all sessions"
			: "Showing all sessions. Switch to this workspace");
	}

	private persistFolds(): void {
		this.deps.writeFolds?.(this.folds);
	}

	private buildGroup(
		title: string,
		count: number,
		key: keyof HistoryFoldState,
		searching: boolean,
		rows: Array<{ s: RecentSession }>,
		showFolder: boolean,
	): HTMLElement {
		const group = document.createElement("details");
		group.className = "history-group";
		// Search must not hide a hit. Archive stays folded until the operator
		// wants it, except while a search is matching inside it.
		this.applyingFolds = true;
		group.open = searching || !this.folds[key];
		this.applyingFolds = false;
		const summary = document.createElement("summary");
		summary.className = "history-group-summary";
		summary.textContent = `${title} (${count})`;
		group.appendChild(summary);
		group.addEventListener("toggle", () => {
			if (this.applyingFolds) return;
			this.folds[key] = !group.open;
			this.persistFolds();
		});
		for (const { s } of rows) group.appendChild(this.buildItem(s, showFolder || !s.inWorkspace));
		return group;
	}

	private currentId?: string;

	private buildItem(session: RecentSession, showFolder: boolean): HTMLElement {
		// Keep the row container non-interactive: the inline management controls and
		// rename input must never become descendants of the resume control.
		const item = el("div", "history-item");
		item.title = session.cwd;
		item.dataset.showFolder = showFolder ? "1" : "0";
		const isCurrent = session.id === this.currentId;
		const hasCurrentChild = session.children?.some(
			(child) => child.id === this.currentId || child.activeSessionId === this.currentId,
		) ?? false;
		if (isCurrent) item.classList.add("current");
		if (hasCurrentChild) item.classList.add("has-current-child");
		const top = el("div", "history-item-top");
		const name = historyLabel(session);
		const resume = document.createElement("button");
		resume.className = "history-resume";
		resume.title = isCurrent ? `${name} (current session)` : `Resume ${name}`;
		resume.setAttribute("aria-label", resume.title);
		if (isCurrent) resume.setAttribute("aria-current", "true");
		resume.appendChild(el("span", "history-item-name", name));
		const meta = el("div", "history-item-meta");
		meta.appendChild(
			el(
				"span",
				"history-item-time",
				relativeTime(session.modifiedMs != null ? new Date(session.modifiedMs).toISOString() : session.timestamp),
			),
		);
		if (session.isNew) meta.appendChild(el("span", "history-new-session", "New session"));
		const status = session.status;
		const lamp = status === "running" || session.running ? "working" : session.unreadComplete ? "complete" : "";
		if (lamp) {
			const mark = el("span", `running-mark ${lamp}`);
			mark.title = lamp === "working"
				? session.statusLabel != null ? `Working — flagged by the daemon as ${session.statusLabel}` : "Working"
				: "Newly completed";
			const dot = el("span", "running-dot");
			if (lamp === "working") dot.style.animationDelay = `${-(Date.now() % RUNNING_PULSE_CYCLE_MS)}ms`;
			mark.appendChild(dot);
			meta.appendChild(mark);
		}
		if (status === undefined && !session.running) {
			meta.appendChild(el("span", "history-execution-unknown", "Execution status unavailable"));
		}
		resume.append(meta);
		const actions = el("div", "history-actions");
		if (session.running) {
			const stop = document.createElement("button");
			stop.className = "history-action";
			stop.title = "Stop this session (aborts the live run)";
			stop.appendChild(icon("stop", 10));
			stop.addEventListener("click", (event) => {
				event.stopPropagation();
				this.deps.onStop(session.path, session.id);
			});
			actions.appendChild(stop);
		}
		const rename = document.createElement("button");
		rename.className = "history-action";
		rename.title = "Rename session";
		rename.appendChild(icon("pencil", 11));
		rename.addEventListener("click", (event) => {
			event.stopPropagation();
			this.armRename(item, session);
		});
		actions.appendChild(rename);
		if (session.archived) {
			const unarchive = document.createElement("button");
			unarchive.className = "history-action";
			unarchive.title = "Move out of Archive";
			unarchive.appendChild(icon("back", 11));
			unarchive.addEventListener("click", (event) => {
				event.stopPropagation();
				this.render((this.lastSessions ?? []).map((row) =>
					row.path === session.path ? { ...row, archived: false } : row), this.currentId);
				this.deps.onUnarchive(session.path, session.id);
			});
			actions.appendChild(unarchive);
		} else {
			const archive = document.createElement("button");
			archive.className = "history-action";
			archive.disabled = !!session.running || (status !== "idle" && status !== "inactive");
			archive.title = status === "running" || session.running
				? "Archive unavailable while this session is running"
				: archive.disabled
					? "Archive unavailable: execution status unknown"
					: "Archive session (hides it in the Archive section)";
			archive.appendChild(icon("archive", 11));
			archive.addEventListener("click", (event) => {
				event.stopPropagation();
				if (archive.disabled) return;
				this.render((this.lastSessions ?? []).map((row) =>
					row.path === session.path ? { ...row, archived: true } : row), this.currentId);
				this.deps.onArchive(session.path, session.id);
			});
			actions.appendChild(archive);
		}
		if (!isCurrent) {
			const del = document.createElement("button");
			del.className = "history-action";
			del.title = "Delete (moves to Trash when possible, also removes session data)";
			del.appendChild(icon("close", 11));
			del.addEventListener("click", (event) => {
				event.stopPropagation();
				this.armConfirm(item, session, actions, {
					label: "Delete",
					className: "history-action destructive",
					run: () => this.deps.onDelete(session.path, session.id),
				});
			});
			// Delete stays last: the furthest from a stray click.
			actions.appendChild(del);
		}
		// Unsaved entries only focus their open tab; file actions need a saved session.
		if (session.isNew) actions.replaceChildren();
		top.append(resume, actions);
		item.appendChild(top);
		// A row surfaced by a transcript hit shows the hit, so the operator can see
		// why it matched instead of having to guess.
		if (session.matchSnippet) {
			item.appendChild(el("div", "history-item-sub match", session.matchSnippet.slice(0, 160)));
		} else {
			const sub = session.name && session.firstPrompt
			? session.firstPrompt.replace(/\s+/g, " ").trim().slice(0, 110)
			: showFolder
				? session.cwd
				: undefined;
			if (sub) item.appendChild(el("div", "history-item-sub", sub));
		}
		if (session.children?.length) {
			const childrenKey = session.path;
			const expanded = this.expandedChildSessions.has(childrenKey);
			const toggle = el("button", "history-children-toggle") as HTMLButtonElement;
			toggle.append(el("span", "history-children-caret", expanded ? "▾" : "▸"), `Subagents (${session.children.length})`);
			toggle.title = expanded ? "Hide subagents" : "Show subagents";
			toggle.addEventListener("click", (event) => {
				event.stopPropagation();
				if (expanded) this.expandedChildSessions.delete(childrenKey);
				else this.expandedChildSessions.add(childrenKey);
				this.render(this.lastSessions ?? [], this.currentId);
			});
			item.appendChild(toggle);
			if (expanded) {
				const children = el("div", "history-children");
				for (const child of session.children) {
					const childItem = el("div", "history-child");
					if (child.id === this.currentId || child.activeSessionId === this.currentId) childItem.classList.add("current");
					childItem.addEventListener("click", (event) => event.stopPropagation());
					childItem.append(
						el("span", "history-child-arrow", "↳"),
						el("span", "history-child-name", subagentLabel(child)),
						el("span", `history-child-status ${child.status}`, child.status),
					);
					children.appendChild(childItem);
				}
				item.appendChild(children);
			}
		}
		const openSession = (): void => {
			this.deps.onResume(session.path, session.id);
		};
		resume.addEventListener("click", openSession);
		// Preserve click-anywhere row behavior without stealing clicks intended
		// for a nested action or rename input.
		item.addEventListener("click", (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest?.("button, input, select, textarea, a, [contenteditable='true']")) return;
			openSession();
		});
		return item;
	}

	/** Inline rename: pencil swaps the name for a small input; Enter commits, Esc cancels. */
	private armRename(item: HTMLElement, session: RecentSession): void {
		if (item.classList.contains("renaming") || item.classList.contains("confirming")) return;
		item.classList.add("renaming");
		const resume = item.querySelector(".history-resume") as HTMLElement | null;
		if (!resume) {
			item.classList.remove("renaming");
			return;
		}
		const currentText = session.name || historyLabel(session);
		const input = document.createElement("input");
		input.className = "history-rename-input";
		input.value = currentText;
		input.spellcheck = false;
		const restore = (): void => {
			item.classList.remove("renaming");
			input.replaceWith(resume);
		};
		input.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Enter") {
				restore();
				this.deps.onRename(session.path, session.id, input.value.trim());
			} else if (event.key === "Escape") {
				restore();
			} else {
				input.style.width = `${Math.min(320, Math.max(120, input.value.length * 8 + 16))}px`;
			}
		});
		input.addEventListener("blur", () => restore());
		resume.replaceWith(input);
		input.focus();
		input.select();
	}

	/** Inline one-tap confirm: swaps the subtle buttons for ✓ <label> / ✕ for a few seconds. */
	private armConfirm(
		item: HTMLElement,
		session: RecentSession,
		actions: HTMLElement,
		action: { label: string; className: string; run: () => void },
	): void {
		if (item.classList.contains("confirming")) return;
		item.classList.add("confirming");
		actions.textContent = "";
		const confirm = document.createElement("button");
		confirm.className = action.className;
		confirm.title = `Confirm ${action.label.toLowerCase()}`;
		confirm.appendChild(icon("check", 12));
		confirm.appendChild(document.createTextNode(action.label));
		confirm.addEventListener("click", (event) => {
			event.stopPropagation();
			item.classList.remove("confirming");
			action.run();
		});
		const cancel = document.createElement("button");
		cancel.className = "history-action";
		cancel.title = "Cancel";
		cancel.appendChild(icon("close", 11));
		cancel.addEventListener("click", (event) => {
			event.stopPropagation();
			if (!item.isConnected) return;
			item.classList.remove("confirming");
			item.parentElement?.insertBefore(this.buildItem(session, item.dataset.showFolder === "1"), item);
			item.remove();
		});
		actions.append(confirm, cancel);
		setTimeout(() => {
			if (item.isConnected && item.classList.contains("confirming")) {
				cancel.click();
			}
		}, 6000);
	}
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "";
	const diff = Date.now() - then;
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(then).toLocaleDateString();
}
