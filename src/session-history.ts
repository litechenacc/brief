/**
 * History catalog: daemon list, on-disk fallback, search, and rank overlays.
 * Assigned onto SessionController.prototype — no extra class layer.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RecentSession } from "./protocol.js";
import type { SavedSessionInfo, SessionSummaryRef } from "./daemon-sidecar.js";
import { listRecentSessions, normalizeFsPath } from "./recent-sessions.js";
import {
	HISTORY_OTHER_LIMIT,
	HISTORY_WORKSPACE_LIMIT,
	HISTORY_UI_STATE_KEY,
	SAVED_CATALOG_TTL_MS,
	excerpt,
	historyActivityMs,
	isRunningSummary,
	rosterStatus,
} from "./session-logic.js";
import type { ResolvedHistorySession } from "./session-types.js";
import type { SessionController } from "./session-controller.js";

export const historyCatalogMethods = {
scheduleHistoryRefresh(this: SessionController): void {
	if (this.historyRefreshTimer) clearTimeout(this.historyRefreshTimer);
	this.historyRefreshTimer = setTimeout(() => {
		this.historyRefreshTimer = null;
		void this.listHistory();
	}, 800);
},

historyPathKey(this: SessionController, sessionPath: string): string {
	return normalizeFsPath(sessionPath);
},

restoreHistoryUiState(this: SessionController): void {
	const saved = this.context.workspaceState?.get<{
		sortMs?: Record<string, number>;
		archived?: string[];
		unread?: string[];
	}>(HISTORY_UI_STATE_KEY);
	if (!saved) return;
	if (saved.sortMs) {
		for (const [path, ms] of Object.entries(saved.sortMs)) {
			if (typeof ms === "number" && Number.isFinite(ms)) this.historySortMs.set(path, ms);
		}
	}
	if (Array.isArray(saved.archived)) {
		for (const path of saved.archived) {
			if (typeof path === "string" && path) this.historyArchived.add(path);
		}
	}
	if (Array.isArray(saved.unread)) {
		for (const path of saved.unread) {
			if (typeof path === "string" && path) this.historyUnreadComplete.add(path);
		}
	}
},

persistHistoryUiState(this: SessionController): void {
	void this.context.workspaceState?.update(HISTORY_UI_STATE_KEY, {
		sortMs: Object.fromEntries(this.historySortMs),
		archived: [...this.historyArchived],
		unread: [...this.historyUnreadComplete],
	});
},

overlayCachedHistory(this: SessionController): void {
	if (this.lastHistory) this.lastHistory = this.lastHistory.map((row) => this.decorateHistoryRow(row));
	if (this.actionHistory) this.actionHistory = this.actionHistory.map((row) => this.decorateHistoryRow(row));
},

paintHistory(this: SessionController): void {
	const sessions = this.actionHistory ?? this.lastHistory;
	if (sessions) this.broadcast({ type: "history", sessions });
},

viewedSessionPath(this: SessionController): string | undefined {
	if (this.attached?.sessionPath) return this.historyPathKey(this.attached.sessionPath);
	if (this.state?.sessionFile) return this.historyPathKey(this.state.sessionFile);
	return undefined;
},

/**
 * A turn finished and the agent is waiting. This is the only moment the
 * history row is allowed to move — not mid-turn RPC chatter.
 */
markHistoryWaitingForUser(this: SessionController, sessionPath = this.viewedSessionPath()): void {
	if (!sessionPath) return;
	const key = this.historyPathKey(sessionPath);
	this.historySortMs.set(key, Date.now());
	this.historyWasRunning.delete(key);
	if (this.viewedSessionPath() !== key) this.historyUnreadComplete.add(key);
	else this.historyUnreadComplete.delete(key);
	this.persistHistoryUiState();
	this.overlayCachedHistory();
},

markHistorySessionOpened(this: SessionController, sessionPath: string): void {
	const key = this.historyPathKey(sessionPath);
	if (!this.historyUnreadComplete.has(key)) return;
	this.historyUnreadComplete.delete(key);
	this.persistHistoryUiState();
	this.overlayCachedHistory();
},

markHistoryArchived(this: SessionController, sessionPath: string): void {
	this.historyArchived.add(this.historyPathKey(sessionPath));
	this.persistHistoryUiState();
	this.overlayCachedHistory();
	this.paintHistory();
},

/**
 * Rank is frozen while a session is running. Catalog mtime/lastActivity
 * moves on every RPC event; using it as the list order is what made the
 * history jump around mid-turn.
 */
decorateHistoryRow(this: SessionController, row: RecentSession): RecentSession {
	const key = this.historyPathKey(row.path);
	const catalogMs = row.modifiedMs ?? (Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : 0);
	const prev = this.historySortMs.get(key);
	const running = row.status === "running" || row.running === true;
	if (running) {
		this.historyWasRunning.add(key);
		if (prev === undefined) this.historySortMs.set(key, catalogMs);
	} else if (this.historyWasRunning.delete(key)) {
		this.historySortMs.set(key, Date.now());
		if (this.viewedSessionPath() !== key) this.historyUnreadComplete.add(key);
		else this.historyUnreadComplete.delete(key);
	} else if (prev === undefined) {
		this.historySortMs.set(key, catalogMs);
	}
	const sortMs = this.historySortMs.get(key) ?? catalogMs;
	const archived = this.historyArchived.has(key);
	const unreadComplete = !running && this.historyUnreadComplete.has(key);
	return { ...row, sortMs, archived, unreadComplete };
},

showHistoryView(this: SessionController): void {
	this.broadcast({ type: "showHistory" });
	void this.listHistory();
},

/**
 * History actions are capabilities, not arbitrary file operations. A webview
 * may only act on a session record the host generated from its catalog. If a
 * sidebar was reloaded, refresh once before rejecting the stale row.
 */
async resolveHistorySession(this: SessionController, sessionPath: string, sessionId: string): Promise<ResolvedHistorySession | null> {
	if (typeof sessionPath !== "string" || typeof sessionId !== "string" || !sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
		this.broadcast({ type: "notice", level: "error", text: "Invalid session reference." });
		return null;
	}
	const target = normalizeFsPath(sessionPath);
	let rows = this.actionHistory ?? this.lastHistory;
	let match = rows?.find((row) => row.id === sessionId && normalizeFsPath(row.path) === target);
	if (!match) {
		rows = await this.collectHistory();
		this.lastHistory = rows;
		match = rows.find((row) => row.id === sessionId && normalizeFsPath(row.path) === target);
	}
	if (!match) {
		this.broadcast({ type: "notice", level: "warning", text: "That session is no longer available in history." });
		return null;
	}
	try {
		const stat = await fs.lstat(match.path);
		const resolvedPath = path.resolve(match.path);
		const fileId = path.basename(resolvedPath, ".jsonl");
		if (!stat.isFile() || stat.isSymbolicLink() || !/^[A-Za-z0-9_-]+$/.test(fileId) || path.basename(resolvedPath) !== `${fileId}.jsonl`) {
			throw new Error("not a regular session file");
		}
		// Daemon catalogs may expose a runtime/session UUID that differs from the
		// transcript filename stem. Keep the former for view identity and derive
		// the latter only after resolving this host-issued path for file actions.
		return { ...match, path: resolvedPath, fileId };
	} catch {
		this.broadcast({ type: "notice", level: "warning", text: "That session file is no longer available." });
		return null;
	}
},

/**
 * History rows from the daemon's own catalog. This is the authority: it has
 * read every session file end to end, so the CURRENT name (a rename appended
 * megabytes into a file), the message count and the lifecycle are exact —
 * none of which a bounded tail read can promise.
 *
 * Buckets are filled independently. A single global cap applied before
 * bucketing is what starved "This workspace" down to three rows while 79
 * sessions from other folders ate the budget.
 */
rowsFromCatalog(this: SessionController, catalog: SessionSummaryRef[]): RecentSession[] {
	const root = normalizeFsPath(this.workspaceRoot);
	const inWorkspaceRows: Array<{ row: RecentSession; source: SessionSummaryRef }> = [];
	const otherRows: Array<{ row: RecentSession; source: SessionSummaryRef }> = [];
	for (const s of catalog) {
		if (!s.sessionFile || !s.cwd) continue;
		// Subagents belong under their parent in the strip, not in history.
		if ((s.rlmDepth ?? 0) > 0) continue;
		// Drafts have no message and nothing to resume, so they stay out.
		// Archived ones do NOT: prime-agent archives a session whenever its
		// worker closes for any reason but a clean shutdown or an update
		// (daemon-mode closeKeepsResumeEntry), so "archived" marks plenty of
		// threads the operator never retired — a kill, a worker swap, an
		// update that did not land cleanly. Hiding those made real work
		// disappear from the list and left the CLI as the only way to find it.
		// They come back as "inactive", which is what they are.
		if (s.lifecycle === "draft") continue;
		const modified = s.modified ?? s.lastActivityAt;
		const parsed = modified ? Date.parse(modified) : Number.NaN;
		const inWorkspace = normalizeFsPath(s.cwd) === root;
		const row = this.decorateHistoryRow({
			id: s.sessionId ?? path.basename(s.sessionFile, ".jsonl"),
			path: s.sessionFile,
			cwd: s.cwd,
			timestamp: s.created ?? modified ?? new Date().toISOString(),
			modifiedMs: Number.isFinite(parsed) ? parsed : undefined,
			name: s.sessionName,
			firstPrompt: s.firstMessage,
			inWorkspace,
			running: isRunningSummary(s),
			status: rosterStatus(s),
			...(s.statusLabel ? { statusLabel: s.statusLabel } : {}),
		});
		(inWorkspace ? inWorkspaceRows : otherRows).push({ row, source: s });
	}
	const activityOf = (entry: { row: RecentSession }): number => historyActivityMs(entry.row);
	const byActivityDesc = (a: { row: RecentSession }, b: { row: RecentSession }): number => activityOf(b) - activityOf(a);
	inWorkspaceRows.sort(byActivityDesc);
	otherRows.sort(byActivityDesc);
	const visible = [
		...inWorkspaceRows.slice(0, HISTORY_WORKSPACE_LIMIT),
		...otherRows.slice(0, HISTORY_OTHER_LIMIT),
	];
	for (const entry of visible) {
		if (entry.row.status !== "running" && entry.row.status !== "idle") continue;
		const parentSessionId = entry.source.sessionId ?? entry.row.id;
		const parentActiveSessionId = entry.source.activeSessionId ?? entry.row.id;
		const parentIds = new Set([parentSessionId, parentActiveSessionId]);
		const children = catalog
			.filter((child) => {
				if ((child.rlmDepth ?? 0) !== 1) return false;
				const status = rosterStatus(child);
				if (status !== "running" && status !== "idle") return false;
				return [child.parentActiveSessionId, child.parentSessionId].some(
					(parentId) => parentId !== undefined && parentIds.has(parentId),
				);
			})
			.map((child) => ({
				id: child.sessionId ?? child.activeSessionId ?? child.id ?? "",
				...(child.activeSessionId ? { activeSessionId: child.activeSessionId } : {}),
				...(child.sessionName ? { name: child.sessionName } : {}),
				status: rosterStatus(child) as "running" | "idle",
				rlmDepth: child.rlmDepth,
			}));
		if (children.length > 0) entry.row.children = children;
	}
	this.persistHistoryUiState();
	return visible.map(({ row }) => row);
},

async collectHistory(this: SessionController): Promise<RecentSession[]> {
	try {
		const sidecar = await this.ensureSidecar();
		return this.rowsFromCatalog(await this.listSessions(sidecar));
	} catch {
		// Daemon unreachable: the scan is less exact about names but it is the
		// difference between a stale title and no history at all.
		const rows = await listRecentSessions(this.workspaceRoot, {
			workspaceLimit: HISTORY_WORKSPACE_LIMIT,
			otherLimit: HISTORY_OTHER_LIMIT,
		});
		const decorated = rows.map((row) => this.decorateHistoryRow(row));
		const activityOf = (s: RecentSession): number => s.sortMs ?? s.modifiedMs ?? 0;
		const byActivityDesc = (a: RecentSession, b: RecentSession): number => activityOf(b) - activityOf(a);
		return [
			...decorated.filter((s) => s.inWorkspace).sort(byActivityDesc),
			...decorated.filter((s) => !s.inWorkspace).sort(byActivityDesc),
		];
	}
},

async listHistory(this: SessionController): Promise<void> {
	const generation = ++this.historyRequestGeneration;
	// Repaint the previous answer first. The sidebar webview is torn down on
	// every hide, so without a host-side cache the list flashes "Loading…"
	// through a full catalog fetch each time the operator comes back.
	if (this.lastHistory) this.broadcast({ type: "history", sessions: this.lastHistory });
	let sessions: RecentSession[];
	try {
		sessions = await this.collectHistory();
	} catch (err) {
		if (!this.disposed && generation === this.historyRequestGeneration) {
			this.broadcast({ type: "notice", level: "error", text: `Could not load history: ${err instanceof Error ? err.message : String(err)}` });
		}
		return;
	}
	if (this.disposed || generation !== this.historyRequestGeneration) return;
	this.lastHistory = sessions;
	this.actionHistory = sessions;
	this.broadcast({ type: "history", sessions });
},

/**
 * Search the way the CLI does: over the conversation itself, not just the row
 * labels. `allMessagesText` rides only on `list_saved_sessions` (the `list`
 * catalog does not carry it), so this is a second, heavier call — cached for
 * a few seconds because the webview searches as the operator types.
 *
 * Matching rows come back with a `matchSnippet`, which is what lets the
 * webview's own filter rank them: it cannot see the transcript, only what we
 * hand it, and a hit with no visible reason reads as a bug.
 */
async searchHistory(this: SessionController, query: string): Promise<void> {
	const generation = ++this.historyRequestGeneration;
	const needle = query.trim().toLowerCase();
	let base: RecentSession[];
	try {
		base = await this.collectHistory();
	} catch {
		if (!this.disposed && generation === this.historyRequestGeneration) this.broadcast({ type: "history", sessions: [] });
		return;
	}
	if (this.disposed || generation !== this.historyRequestGeneration) return;
	this.lastHistory = base;
	if (needle.length < 2) {
		this.actionHistory = base;
		this.broadcast({ type: "history", sessions: base });
		return;
	}
	let saved: SavedSessionInfo[];
	try {
		saved = await this.savedSessionCatalog();
	} catch {
		// No text corpus available — the webview still filters on names/paths.
		// Same generation guard as every other exit: a slow failure for an old
		// query must not repaint (nor re-authorize) a newer answer's list.
		if (!this.disposed && generation === this.historyRequestGeneration) {
			this.actionHistory = base;
			this.broadcast({ type: "history", sessions: base });
		}
		return;
	}
	if (this.disposed || generation !== this.historyRequestGeneration) return;
	const snippetByPath = new Map<string, string>();
	const hits: RecentSession[] = [];
	const knownPaths = new Set(base.map((s) => normalizeFsPath(s.path)));
	const root = normalizeFsPath(this.workspaceRoot);
	for (const info of saved) {
		// Subagents are shown only when live and nested under a capped root row.
		if ((info.rlmDepth ?? 0) > 0) continue;
		// Same visibility rule as the roster: drafts have nothing to find, and a
		// crashed record is not a session. Archived ones ARE searchable now,
		// because the roster shows them — this filter is what made a real
		// thread unfindable from here while the CLI could still see it.
		if ((info.messageCount ?? 0) === 0 || info.state?.status === "crash") continue;
		const body = info.allMessagesText ?? "";
		const at = body.toLowerCase().indexOf(needle);
		if (at < 0) continue;
		const key = normalizeFsPath(info.path);
		const snippet = excerpt(body, at, needle.length);
		if (knownPaths.has(key)) {
			snippetByPath.set(key, snippet);
			continue;
		}
		// A session the roster capped away still deserves to be findable.
		const modified = info.modified ? Date.parse(info.modified) : Number.NaN;
		hits.push(
			this.decorateHistoryRow({
				id: info.id,
				path: info.path,
				cwd: info.cwd,
				timestamp: info.created ?? info.modified ?? new Date().toISOString(),
				modifiedMs: Number.isFinite(modified) ? modified : undefined,
				name: info.name,
				firstPrompt: info.firstMessage,
				inWorkspace: normalizeFsPath(info.cwd) === root,
				// `running` stays unset: the saved catalog has no runtime state, and
				// "we did not ask" must not render as "not running". The status dot
				// says "inactive" for the same reason the on-disk scan does — this
				// row exists only because the roster did not carry it.
				status: "inactive",
				matchSnippet: snippet,
			}),
		);
	}
	// Copy rather than tag `base` in place — it is the cache replayed on the
	// next visit, and a snippet for a query the operator has already cleared
	// would sit under the row explaining nothing.
	const decorated = base.map((s) => {
		const snippet = snippetByPath.get(normalizeFsPath(s.path));
		return snippet ? { ...s, matchSnippet: snippet } : s;
	});
	const results = [...decorated, ...hits];
	this.actionHistory = results;
	this.broadcast({ type: "history", sessions: results });
},

forgetHistoryRow(this: SessionController, sessionPath: string): void {
	if (!this.lastHistory) return;
	const target = normalizeFsPath(sessionPath);
	this.lastHistory = this.lastHistory.filter((s) => normalizeFsPath(s.path) !== target);
	if (this.actionHistory) this.actionHistory = this.actionHistory.filter((s) => normalizeFsPath(s.path) !== target);
	this.historySortMs.delete(target);
	this.historyArchived.delete(target);
	this.historyUnreadComplete.delete(target);
	this.persistHistoryUiState();
},

async savedSessionCatalog(this: SessionController): Promise<SavedSessionInfo[]> {
	const now = Date.now();
	if (this.savedCatalog && now - this.savedCatalog.at < SAVED_CATALOG_TTL_MS) return this.savedCatalog.rows;
	const sidecar = await this.ensureSidecar();
	const rows = await sidecar.listSavedSessions(this.workspaceRoot, "all");
	this.savedCatalog = { at: now, rows };
	return rows;
}
};
