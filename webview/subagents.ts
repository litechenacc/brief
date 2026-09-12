/**
 * Subagent strip: collapsible roster floating above the composer.
 */
import { el } from "./dom.js";
import type { SessionChild, WebviewToHost } from "../src/protocol.js";

export interface SpawnCard {
	id: string;
	browseRef?: string;
	name?: string;
	created?: string | null;
}

export interface SubagentsStripDeps {
	post: (message: WebviewToHost) => void;
	injectSpawnCard: (card: SpawnCard) => void;
	onRosterPainted: (opened: boolean) => void;
}

const childKey = (child: { activeSessionId?: string; id?: string }): string => child.activeSessionId || child.id || "";

/**
 * Roster status of a row. Hosts before the status field only sent `isStreaming`,
 * which cannot tell a finished subagent from one waiting between turns — fall
 * back to it rather than inventing a liveness we don't have.
 */
export function childStatus(child: SessionChild): "running" | "idle" | "inactive" {
	return child.status ?? (child.isStreaming ? "running" : "idle");
}

export class SubagentsStrip {
	readonly root: HTMLElement;
	private expanded = false;
	private children: SessionChild[] = [];
	private parent: SessionChild | null = null;
	private siblings: SessionChild[] = [];
	private viewedId: string | null = null;
	private autoExpandSuppressed = false;
	private liveChildIds = new Set<string>();
	private rosterSeen = false;
	private historicalExpanded = false;
	private spawnSeenBaseline = false;

	constructor(private readonly deps: SubagentsStripDeps) {
		this.root = el("div", "subagents-strip") as HTMLElement;
	}

	workingCount(): number {
		return this.children.filter((child) => childStatus(child) === "running").length;
	}

	/** New thread: no operator instruction about this strip yet. */
	resetForNewThread(): void {
		this.expanded = false;
		this.autoExpandSuppressed = false;
		this.spawnSeenBaseline = false;
		this.resetActivityBaseline();
		this.render();
	}

	/**
	 * Session identity changed. Drop the previous tree; keep expanded because
	 * browsing into a subagent is a session change and collapsing mid-navigation
	 * made siblings unreachable.
	 */
	resetForSessionChange(): void {
		this.children = [];
		this.parent = null;
		this.siblings = [];
		this.viewedId = null;
		this.spawnSeenBaseline = false;
		this.resetActivityBaseline();
		this.render();
	}

	/** Forget spawn-card / auto-expand baselines without collapsing the strip. */
	resetActivity(): void {
		this.spawnSeenBaseline = false;
		this.resetActivityBaseline();
	}

	applyRoster(message: {
		children?: SessionChild[];
		parent?: SessionChild | null;
		siblings?: SessionChild[];
		viewedActiveSessionId?: string | null;
		spawned?: Array<{ activeSessionId: string; browseRef?: string; name?: string; created?: string }>;
	}): void {
		this.children = message.children ?? [];
		this.parent = message.parent ?? null;
		this.viewedId = message.viewedActiveSessionId ?? null;
		this.siblings = message.siblings ?? [];
		const spawnedList = message.spawned ?? [];
		for (const spawn of spawnedList) {
			this.deps.injectSpawnCard({ id: spawn.activeSessionId, browseRef: spawn.browseRef, name: spawn.name, created: spawn.created });
		}
		const started = this.takeStartedSubagents(spawnedList);
		if (!this.spawnSeenBaseline && this.children.length > 0) {
			this.spawnSeenBaseline = true;
			for (const child of this.children) {
				if (childStatus(child) === "running" && child.created) {
					this.deps.injectSpawnCard({ id: child.activeSessionId, browseRef: child.browseRef, name: child.name, created: child.created });
				}
			}
		}
		const opened = this.maybeAutoExpand(started);
		this.render();
		this.deps.onRosterPainted(opened);
	}

	/**
	 * Forget which subagents were live, so the next roster seeds instead of reading
	 * as a burst of activity. Deliberately does NOT clear the operator's collapse:
	 * `expanded` already survives a session change on purpose.
	 */
	private resetActivityBaseline(): void {
		this.liveChildIds = new Set();
		this.rosterSeen = false;
	}

	/**
	 * Subagents that STARTED since the last roster: freshly spawned, or an existing
	 * one that went from idle/finished back to running. Seeds silently on the first
	 * roster of a session — resuming a busy thread is not something starting now.
	 */
	private takeStartedSubagents(spawned: readonly { activeSessionId: string }[]): string[] {
		const liveNow = new Set(this.children.filter((child) => childStatus(child) === "running").map(childKey));
		const seeding = !this.rosterSeen;
		this.rosterSeen = true;
		const started = seeding
			? []
			: [...spawned.map((entry) => entry.activeSessionId).filter(Boolean), ...[...liveNow].filter((id) => !this.liveChildIds.has(id))];
		this.liveChildIds = liveNow;
		return [...new Set(started)].filter(Boolean);
	}

	/** Open the strip for work that just began. Returns whether it actually opened. */
	private maybeAutoExpand(started: readonly string[]): boolean {
		if (started.length === 0 || this.expanded || this.autoExpandSuppressed) return false;
		if (this.parent || this.viewedId) return false;
		this.expanded = true;
		return true;
	}

	private render(): void {
		this.root.textContent = "";
		const parent = this.parent;
		const viewedId = this.viewedId;
		const siblings = this.siblings;
		const nothingToShow = !parent && this.children.length === 0 && siblings.length === 0;
		if (nothingToShow) {
			this.root.classList.remove("visible");
			return;
		}
		this.root.classList.add("visible");

		const live = (child: SessionChild): boolean => childStatus(child) !== "inactive";
		const liveChildren = this.children.filter(live);
		const liveSiblings = siblings.filter(live);
		const historical = [...this.children, ...siblings].filter((child) => !live(child));

		if (parent) {
			const back = el("button", "subagents-back-row") as HTMLButtonElement;
			back.append(el("span", "subagents-back", "‹ parent"), el("span", "subagents-back-name", parent.name ?? parent.id));
			back.title = "Return to the parent agent";
			back.addEventListener("click", () => this.deps.post({ type: "backToParent" }));
			this.root.appendChild(back);
		}

		const header = el("button", "subagents-header") as HTMLButtonElement;
		const tally = { running: 0, idle: 0, inactive: 0 };
		for (const child of [...this.children, ...siblings]) tally[childStatus(child)] += 1;
		const countParts: string[] = [];
		if (tally.running > 0) countParts.push(`${tally.running} running`);
		if (tally.idle > 0) countParts.push(`${tally.idle} idle`);
		if (tally.inactive > 0) countParts.push(`${tally.inactive} finished`);
		const countLabel = countParts.join(" · ") || "0";
		header.append(el("span", "subagents-caret", this.expanded ? "▾" : "▸"), `Subagents (${countLabel})`);
		header.title =
			`${tally.running} running · ${tally.idle} idle · ${tally.inactive} finished — ` +
			"click to expand, browse one to look inside";
		header.addEventListener("click", () => {
			this.expanded = !this.expanded;
			this.autoExpandSuppressed = !this.expanded;
			this.render();
		});
		this.root.appendChild(header);

		if (!this.expanded) return;

		const buildRow = (child: SessionChild, isSibling: boolean): HTMLElement => {
			const row = el("button", `subagent-row${isSibling ? " sibling" : ""}`) as HTMLButtonElement;
			const viewing = viewedId === child.activeSessionId;
			const status = childStatus(child);
			const dotClass = status === "running" ? "active" : status === "idle" ? "idle" : "done";
			const dot = el("span", `subagent-dot ${dotClass}`);
			dot.title =
				child.statusLabel != null
					? `${child.statusLabel} — flagged by the daemon: ${
							child.statusLabel === "queued"
								? "spawn accepted, worker not started yet"
								: child.statusLabel === "recovering"
									? "worker went quiet past the staleness threshold and is being recovered"
									: child.statusLabel === "failed"
										? "worker failed; waiting for a client with fresh runtime context"
										: "an exceptional state this build does not know by name"
						}`
					: status === "running"
						? child.isStreaming
							? "running (responding)"
							: "running (working)"
						: status === "idle"
							? "idle — resident, waiting for work"
							: "finished — no worker behind it";
			const name = el("span", "subagent-name", child.name ?? child.id);
			const badgeText = child.statusLabel ?? (status === "running" ? "running" : status === "idle" ? "idle" : "finished");
			const badge =
				status === "running" && !child.statusLabel
					? el("span", "subagent-badge", badgeText)
					: el("span", `subagent-badge idle${child.statusLabel ? " labeled" : ""}`, badgeText);
			const suffix = el("span", "subagent-go", viewing ? "" : "view ›");
			row.title = `${child.runtimeKind === "subagent" ? `subagent${child.rlmDepth ? ` · depth ${child.rlmDepth}` : ""}` : (child.runtimeKind ?? "session")}${child.attachedClients ? ` · ${child.attachedClients} attached client(s)` : ""}`;
			if (viewing) {
				row.classList.add("viewing");
				row.title = "Currently viewing — this transcript shows this subagent";
			}
			row.append(dot, name, badge, suffix);
			row.addEventListener("click", (event) => {
				event.stopPropagation();
				if (!viewing && child.browseRef) this.deps.post({ type: "browseChild", browseRef: child.browseRef });
			});
			return row;
		};

		if (liveChildren.length > 0) {
			const list = el("div", "subagents-list");
			for (const child of liveChildren) list.appendChild(buildRow(child, false));
			this.root.appendChild(list);
		}
		if (liveSiblings.length > 0) {
			const siblingHeader = el("div", "subagents-sibling-header", parent ? `Under ${parent.name ?? parent.id}` : "Siblings");
			const list = el("div", "subagents-list siblings");
			for (const sib of liveSiblings) list.appendChild(buildRow(sib, true));
			this.root.append(siblingHeader, list);
		}
		if (historical.length > 0) {
			const histHeader = el("button", "subagents-subhead") as HTMLButtonElement;
			histHeader.append(
				el("span", "subagents-caret", this.historicalExpanded ? "▾" : "▸"),
				`Historical (${historical.length})`,
			);
			histHeader.title = "Subagents that already finished — open one to read what it did";
			histHeader.addEventListener("click", (event) => {
				event.stopPropagation();
				this.historicalExpanded = !this.historicalExpanded;
				this.render();
			});
			this.root.appendChild(histHeader);
			if (this.historicalExpanded) {
				const list = el("div", "subagents-list historical");
				for (const child of historical) list.appendChild(buildRow(child, false));
				this.root.appendChild(list);
			}
		}
	}
}
