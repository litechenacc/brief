/**
 * Compact, auto-compact, and host-issued recovery actions.
 * Assigned onto SessionController.prototype — no extra class layer.
 */
import { randomUUID } from "node:crypto";
import type { RpcModel, RpcSessionState } from "../shared/protocol.js";
import { COMPACT_REPLY_CEILING_MS, compactFailureHint, pickCompactionFallback } from "./session-logic.js";
import type { SessionController } from "./session-controller.js";

export const compactMethods = {
/**
 * A reply that never came is not the same as work that failed.
 *
 * prime-agent's own daemon client gives up on a request after 30s
 * (dist/modes/daemon/daemon-client.js: `request(command, timeoutMs = 30000)`,
 * no special case for `compact`), and compaction on a long thread routinely
 * outlives that. The error it raises names a socket and a log file, so
 * relaying it verbatim as "Compaction failed" told the operator their
 * compaction had died when it was still running — and it kept running.
 *
 * So: never present a timeout as a failure without asking the session itself
 * whether it is still compacting. The transcript refresh does not depend on
 * this reply either; compaction_end drives it.
 */
async compactionStillRunning(this: SessionController): Promise<boolean> {
	try {
		const attached = this.attached;
		if (attached && this.sidecar?.connected) {
			const state = (await this.sidecar.getState(attached.activeSessionId)) as RpcSessionState;
			return state?.isCompacting === true;
		}
		const client = this.client;
		if (client?.running) {
			const response = await client.request({ type: "get_state" }, 15_000);
			if (response.success) return (response.data as RpcSessionState)?.isCompacting === true;
		}
	} catch {
		// Fall back to what the event stream last told us.
	}
	return this.compacting;
},

/**
 * Run a recovery the host itself offered. The webview may be compromised, so
 * the id is only ever a key into this map — never anything it can compose.
 */
async runNoticeAction(this: SessionController, id: string): Promise<void> {
	const run = this.noticeActions.get(id);
	if (!run) return;
	this.noticeActions.delete(id);
	await run();
},

offerNoticeAction(this: SessionController, label: string, run: () => Promise<void>): { id: string; label: string } {
	// One offer at a time: a stale button from an earlier failure would retry
	// against a session the operator has since left.
	this.noticeActions.clear();
	const id = randomUUID();
	this.noticeActions.set(id, run);
	return { id, label };
},

async fetchAvailableModels(this: SessionController): Promise<RpcModel[]> {
	const attached = this.attached;
	if (attached) {
		const sidecar = await this.ensureSidecar();
		const data = await sidecar.request<{ models?: RpcModel[] }>(
			{ type: "get_available_models", activeSessionId: attached.activeSessionId },
			60_000,
		);
		return data.models ?? [];
	}
	const client = this.client;
	if (!client?.running) return [];
	const response = await client.request({ type: "get_available_models" }, 60_000);
	return response.success ? ((response.data as { models?: RpcModel[] }).models ?? []) : [];
},

async compactWithModel(this: SessionController, model: RpcModel): Promise<void> {
	const original = this.state?.model ?? this.rentedState?.model ?? null;
	const label = model.name ?? `${model.provider}/${model.id}`;
	this.compactionModelsTried.add(`${model.provider}/${model.id}`);
	this.broadcast({ type: "notice", level: "info", text: `Compacting with ${label}…` });
	try {
		await this.setModel(model.provider, model.id);
		await this.compact();
	} finally {
		// The operator picked their model for the work, not for summarising.
		if (original?.provider && original.id) await this.setModel(original.provider, original.id);
	}
},

async reportCompactFailure(this: SessionController, detail: string): Promise<void> {
	if (await this.compactionStillRunning()) {
		this.broadcast({
			type: "notice",
			level: "info",
			text: "Compaction is taking longer than the agent's reply timeout — it is still running. The transcript refreshes when it finishes.",
		});
		return;
	}
	const text = `Compaction failed: ${detail}${compactFailureHint(detail)}`;
	if (!/refus/i.test(detail)) {
		this.broadcast({ type: "notice", level: "error", text });
		return;
	}
	let fallback: RpcModel | null = null;
	try {
		const current = this.state?.model ?? this.rentedState?.model ?? null;
		this.compactionModelsTried.add(`${current?.provider ?? ""}/${current?.id ?? ""}`);
		fallback = pickCompactionFallback(await this.fetchAvailableModels(), current, this.compactionModelsTried);
	} catch {
		// Catalogue unavailable: report the failure without an offer we cannot honour.
	}
	if (!fallback) {
		// No button to offer, so the text has to carry the whole instruction.
		this.broadcast({ type: "notice", level: "error", text: `${text} Another model usually compacts it — switch model and run it again.` });
		return;
	}
	const label = fallback.name ?? `${fallback.provider}/${fallback.id}`;
	this.broadcast({
		type: "notice",
		level: "error",
		text,
		action: this.offerNoticeAction(`Compact with ${label}`, () => this.compactWithModel(fallback)),
	});
},

async compact(this: SessionController, instructions?: string, opts?: { betweenTurnsOnly?: boolean }): Promise<void> {
	if (this.guardObservedReadOnly("compacting")) return;
	const wouldAbortARun = (): boolean => opts?.betweenTurnsOnly === true && this.effectiveStreaming();
	if (wouldAbortARun()) return;
	const attached = this.attached;
	if (attached) {
		try {
			const sidecar = await this.ensureSidecar();
			if (!this.isCurrentAttachment(attached) || wouldAbortARun()) return;
			await sidecar.compact(attached.activeSessionId);
		} catch (err) {
			if (this.isCurrentAttachment(attached)) await this.reportCompactFailure(err instanceof Error ? err.message : String(err));
		}
		return;
	}
	if (this.isReattaching()) return;
	const epoch = this.viewEpoch;
	await this.ensureStarted();
	const client = this.client;
	if (!client || !this.isCurrentRpcView(client, epoch) || wouldAbortARun()) return;
	try {
		const response = await client.request(
			instructions ? { type: "compact", customInstructions: instructions } : { type: "compact" },
			COMPACT_REPLY_CEILING_MS,
		);
		if (!this.isCurrentRpcView(client, epoch)) return;
		if (!response.success) {
			await this.reportCompactFailure(response.error ?? "unknown error");
		} else {
			await this.refreshSnapshot();
		}
	} catch (err) {
		if (this.isCurrentRpcView(client, epoch)) {
			await this.reportCompactFailure(err instanceof Error ? err.message : String(err));
		}
	}
},

/**
 * `owner` is the session the percentage was measured on. compact() targets
 * the session on screen, so firing on someone else's number would compact the
 * operator's terminal session because our idle background one filled up.
 */
maybeTriggerAutoCompact(this: SessionController, percent: number | null, owner: string): void {
	if (owner !== this.sessionKey()) return;
	const threshold = this.compactThreshold();
	if (percent == null || threshold == null) {
		this.autoCompactSent = false;
		return;
	}
	if (percent < Math.max(20, threshold - 15)) {
		this.autoCompactSent = false;
		return;
	}
	// Between turns, never during one. `compact` aborts the in-flight run and
	// nothing resends the aborted prompt, so the old mid-turn gate answered the
	// operator's message with silence. Idle is also why setting a threshold
	// below the current fill compacts right away: pushStatus() lands here.
	if (percent >= threshold && !this.autoCompactSent && !this.effectiveStreaming() && !this.compacting) {
		this.autoCompactSent = true;
		this.broadcast({
			type: "notice",
			level: "info",
			text: `Context hit ${percent}% ≥ ${threshold}% — auto-compacting for this session.`,
		});
		void this.compact(undefined, { betweenTurnsOnly: true });
	}
}
};
