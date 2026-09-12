/**
 * Pure session helpers: thinking levels, roster status, compact fallback,
 * and small formatters. No vscode, no controller state.
 */
import type { RecentSession, RpcModel } from "./protocol.js";
import type { SessionSummaryRef } from "./daemon-sidecar.js";

export const HISTORY_WORKSPACE_LIMIT = 200;
export const HISTORY_OTHER_LIMIT = 40;
export const SAVED_CATALOG_TTL_MS = 15_000;
export const HISTORY_UI_STATE_KEY = "brief.historyUi";
export const COMPACT_REPLY_CEILING_MS = 30 * 60_000;

/** Level order used by the agent itself (packages/ai getSupportedThinkingLevels). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Which thinking levels the model actually accepts, derived exactly the way the
 * agent derives them. RPC `get_state` narrows the session state and drops the
 * agent's own availableThinkingLevels, but it keeps the whole Model — including
 * `thinkingLevelMap` — so we can answer honestly instead of offering a fixed six
 * and letting clampThinkingLevel silently swap the operator's choice.
 * Returns null when we have no model to reason about.
 */
export function supportedThinkingLevels(model: RpcModel | null | undefined): string[] | null {
	if (!model) return null;
	if (model.reasoning === false) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** A window of `text` around a match, trimmed to word-ish edges, for search evidence. */
export function excerpt(text: string, at: number, length: number): string {
	const start = Math.max(0, at - 45);
	const end = Math.min(text.length, at + length + 65);
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

export function compactFailureHint(detail: string): string {
	if (/refus/i.test(detail)) {
		return " The model declined to summarize this thread's content.";
	}
	if (/prompt is too long|context (?:window|length) exceeded|too many tokens/i.test(detail)) {
		return " This thread is larger than the current model's context window. Switch to a model with a bigger window and run it again.";
	}
	return "";
}

/**
 * Pick a model to retry a refused compaction with.
 *
 * Deliberately capability-based and name-free: a refusal is a verdict from
 * one model about one thread, and hard-coding which models "work" would be
 * wrong the day a provider changes its mind. Never shrink the context window,
 * never re-offer something already refused for this thread, prefer the roomiest.
 */
export function pickCompactionFallback(
	models: readonly RpcModel[],
	current: RpcModel | null | undefined,
	tried: ReadonlySet<string>,
): RpcModel | null {
	const key = (model: { provider?: string; id?: string }): string => `${model.provider ?? ""}/${model.id ?? ""}`;
	const floor = current?.contextWindow ?? 0;
	const candidates = models
		.filter((model) => model.provider && model.id)
		.filter((model) => key(model) !== key(current ?? {}))
		.filter((model) => !tried.has(key(model)))
		.filter((model) => (model.contextWindow ?? 0) >= floor);
	if (candidates.length === 0) return null;
	return candidates.reduce((best, model) =>
		(model.contextWindow ?? 0) > (best.contextWindow ?? 0) ? model : best,
	);
}

export function isTransientWorkerAttachError(message: string): boolean {
	return /worker recovery was interrupted|retry opening the session|worker is (stopping|starting|recovering|unavailable|not connected)|registered to a failed worker|recovery was interrupted/i.test(
		message,
	);
}

/**
 * The roster status. prime-agent v0.9+ publishes the answer on the row
 * (`rosterStatus`, from its shared classifyAgentStatus) — trust it. Older
 * daemons get the legacy fallback below, mirroring the pre-v0.9
 * classifySessionRosterStatus term for term.
 */
export function rosterStatus(s: SessionSummaryRef): "running" | "idle" | "inactive" {
	const advertised = s.rosterStatus;
	if (advertised === "running" || advertised === "idle" || advertised === "inactive") return advertised;
	if (!s.activeSessionId) return "inactive";
	if (s.hasActiveHeartbeat || s.activity === "working" || s.isSessionActive || s.hasRunningRlmChildren) return "running";
	if (s.activity === undefined && (s.isStreaming || s.isCompacting || s.isBashRunning)) return "running";
	return "idle";
}

export function isRunningSummary(s: SessionSummaryRef): boolean {
	return rosterStatus(s) === "running";
}

export function historyActivityMs(session: RecentSession): number {
	if (session.sortMs !== undefined) return session.sortMs;
	if (session.modifiedMs !== undefined) return session.modifiedMs;
	const parsed = Date.parse(session.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}
