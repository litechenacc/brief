/**
 * Daemon attach, observe, roster, and subagent browsing.
 * Assigned onto SessionController.prototype — no extra class layer.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { DaemonSidecar, type AttachSnapshot, type DaemonServerMessage, type SessionSummaryRef } from "./daemon-sidecar.js";
import { normalizeFsPath } from "./recent-sessions.js";
import { resolveOwnerClientId, resolveWorkerDescriptor } from "./daemon-owner.js";
import { isTransientWorkerAttachError, rosterStatus } from "./session-logic.js";
import type { AttachRef } from "./session-types.js";
import type { SessionController } from "./session-controller.js";
import type { AgentEvent, AgentMessage, HostToWebview, RpcSessionState, SessionChild } from "./protocol.js";

const REATTACH_BACKOFF = [1_000, 2_000, 5_000, 10_000, 10_000, 30_000];
const OWNER_ID_HIT_TTL_MS = 30_000;
const OWNER_ID_MISS_TTL_MS = 2_000;
const CHILDREN_REFRESH_MS = 700;

export const daemonAttachMethods = {
async switchSession(this: SessionController, sessionPath: string, sessionId: string): Promise<void> {
	const previousAttachment = this.attached;
	const epoch = this.beginNavigation();
	const observedAtStart = this.observingId;
	if (!previousAttachment && !observedAtStart) {
		this.rememberedSession = { sessionId, sessionFile: sessionPath };
		this.observationRestoring = true;
	}
	const session = await this.resolveHistorySession(sessionPath, sessionId);
	if (!session || this.disposed || epoch !== this.viewEpoch) {
		this.restoreAttachedView(previousAttachment, epoch);
		return;
	}
	sessionPath = session.path;
	sessionId = session.id;
	if (previousAttachment && normalizeFsPath(previousAttachment.sessionPath) === normalizeFsPath(sessionPath)) {
		this.broadcast({ type: "notice", level: "info", text: "You are already viewing that session." });
		this.restoreAttachedView(previousAttachment, epoch);
		return;
	}
	try {
		const sidecar = await this.connectDaemon();
		const findLive = (rows: SessionSummaryRef[]) => rows.find((row) =>
			row.activeSessionId &&
			(row.sessionId === sessionId || row.id === sessionId ||
				(row.sessionFile ? normalizeFsPath(row.sessionFile) === normalizeFsPath(sessionPath) : false)),
		);
		let target = findLive(await this.listSessions(sidecar));
		if (this.disposed || epoch !== this.viewEpoch) return;
		if (!target) {
			try {
				target = await sidecar.createResident({ cwd: session.cwd || this.workspaceRoot, sessionPath });
			} catch (err) {
				// A lease race means another client made it live between list and create.
				target = findLive(await this.listSessions(sidecar));
				if (!target) throw err;
			}
		}
		if (!target.activeSessionId) throw new Error("daemon returned no activeSessionId");
		const attached = await this.attachViaDaemon(target.activeSessionId, target.sessionFile ?? sessionPath, epoch);
		if (!attached || this.disposed || epoch !== this.viewEpoch) {
			if (!this.disposed && epoch === this.viewEpoch && isTransientWorkerAttachError(this.lastDaemonAttachError ?? "")) {
				if (!previousAttachment && !observedAtStart) {
					this.attachAttempt = {
						activeSessionId: this.lastDaemonAttachCanonicalId ?? target.activeSessionId,
						sessionPath,
						sessionId,
					};
					this.attachAttemptEpoch = epoch;
					this.scheduleReattach(0);
					this.broadcast({ type: "notice", level: "info", text: "The worker is recovering. Brief will attach automatically when it is ready." });
					this.pushStatus();
				} else {
					this.broadcast({ type: "notice", level: "warning", text: "The worker is recovering. Please try again in a moment." });
				}
			}
			this.restoreAttachedView(previousAttachment, epoch);
			return;
		}
		const current = this.attached;
		if (previousAttachment && current !== previousAttachment && this.sidecar?.connected) {
			try {
				await this.detachDaemonSession(this.sidecar, previousAttachment.activeSessionId);
			} catch {
				// The old daemon registration may already be gone.
			}
		}
		if (!(await this.clearObservation(observedAtStart, epoch))) return;
		this.returnTargets = [];
	} catch (err) {
		if (!this.disposed && epoch === this.viewEpoch) {
			this.broadcast({ type: "notice", level: "error", text: `Could not resume session: ${err instanceof Error ? err.message : String(err)}` });
			this.restoreAttachedView(previousAttachment, epoch);
		}
	}
},

async startObserving(
	this: SessionController,
	sessionId: string,
	previousAttachment: AttachRef | null = this.attached,
	epoch = this.viewEpoch,
	sessionPath?: string,
	observedAtStart: string | null = this.observingId,
): Promise<boolean> {
	if (!this.client) return false;
	const client = this.client;
	const response = await client.request({ type: "observe", activeSessionId: sessionId }, 30_000);
	if (
		this.client !== client ||
		this.disposed ||
		epoch !== this.viewEpoch ||
		this.attached !== previousAttachment ||
		this.observingId !== observedAtStart
	)
		return false;
	if (!response.success) return false;
	// Do not retain a writable attachment beneath an observed transcript. If
	// attaching B failed after we were attached to A, leaving A here made every
	// action that fell through to `attached` silently operate on A.
	if (!(await this.detachFromDaemon(previousAttachment)) || epoch !== this.viewEpoch) return false;
	if (!(await this.clearObservation(observedAtStart, epoch))) return false;
	// A daemon reconnect belongs to the writable attachment that just gave way
	// to this read-only view. Do not let its already-in-flight attach complete
	// underneath observation and start delivering a second event stream.
	this.attachAttempt = null;
	this.attachAttemptEpoch = null;
	this.clearReattachTimer();
	this.returnTargets = [];
	this.resetChildrenBaseline();
	this.resetViewedSessionState();
	this.observationRestoring = false;
	this.observingId = sessionId;
	this.observedSession = { activeSessionId: sessionId, sessionId, sessionPath };
	const messages = (response.data as { messages?: AgentMessage[] })?.messages ?? [];
	this.cachedMessages = messages;
	this.broadcast({ type: "observedSession", sessionId, messages });
	this.pushStatus();
	return true;
},

async ensureSidecar(this: SessionController, options: { reattach?: boolean } = {}): Promise<DaemonSidecar> {
	// The daemon binds a connection's identity on its first command envelope, so
	// a claim can only be applied to a FRESH socket. Learning our owner id late
	// (the descriptor is written just after the RPC session starts) or moving to
	// a different worker therefore has to replace the connection.
	//
	// Only ever upgrade or switch: a lookup that momentarily comes back empty —
	// a descriptor caught mid-rewrite — must not drop a working claim and tear
	// down a live attachment with it. The claim is released deliberately when
	// the RPC process exits (see `releaseOwnerIdentity`).
	const owner = this.ownedRosterClientId();
	if (this.sidecar && owner && this.sidecar.impersonateClientId !== owner) {
		this.sidecar.dispose();
		this.sidecar = null;
	}
	if (!this.sidecar) {
		this.sidecar = new DaemonSidecar();
		this.sidecar.impersonateClientId = owner ?? null;
		this.sidecar.onEvent = (message) => this.onDaemonEvent(message);
		this.sidecar.onAnyLine = (byteLength) => this.debugLog.append(`sidecar-line bytes=${byteLength}`);
		this.sidecar.onClose = () => this.onSidecarClosed();
	}
	if (!this.sidecar.connected) {
		await this.sidecar.connect();
	}
	// Roster push is per-connection: offer it again after every (re)connect.
	// Capability-detected, so a pre-v0.9 daemon declines and the pull model
	// below keeps working untouched.
	await this.setupRosterSubscription(this.sidecar);
	// Seamless re-attach after a drop: pick up exactly where the user was.
	// Serialized like connect(): two callers arriving while the socket was down
	// would otherwise both issue `attach` for the same handle, and the loser
	// would detach the attachment the winner had just installed — leaving a
	// live-looking view that receives no events and never recovers.
	if (options.reattach !== false && this.sidecar.connected && this.attachAttempt && !this.attached) {
		if (!this.reattaching) {
			const sidecar = this.sidecar;
			this.reattaching = this.runReattach(sidecar).finally(() => {
				this.reattaching = null;
			});
		}
		await this.reattaching;
	}
	return this.sidecar;
},

/**
 * The daemon connection died. Decide — from the daemon_closing reason the
 * supervisor may have announced first — whether the view rides the
 * re-attach ladder or goes home to this window's own RPC session.
 * Extracted from the socket callback so the lifecycle is testable
 * without a live socket.
 */
onSidecarClosed(this: SessionController): void {
	// A roster subscription dies with its connection; ensureSidecar must
	// offer it again after every reconnect.
	this.rosterSubscribedSidecar = null;
	if (![...this.historyPeers].some((peer) => !peer.disposed && peer.sidecar?.connected)) {
		for (const key of this.historyRuntime.keys()) this.updateHistoryRuntime(key, undefined);
		this.paintHistory();
	}
	// `daemon_closing` told us WHY the socket is about to go: an update
	// wants the re-attach ladder, a real shutdown does not.
	const closing = this.daemonClosingReason;
	this.daemonClosingReason = null;
	if (this.attached) {
		const attachment = this.attached;
		const attachmentEpoch = this.attachedEpoch;
		// The daemon dropped our attach registration with the socket, so we
		// are NOT following this session any more. Leaving `attached` set
		// makes the re-attach guard below permanently false and the notice
		// below a lie: prompts would still land but no events would return.
		this.attached = null;
		this.attachedEpoch = null;
		if (closing === "shutdown") {
			// No supervisor comes back for this socket: the ladder would chase
			// a dead daemon forever. Hand the view back to our own RPC session
			// exactly as the session_closed path does.
			this.attachAttempt = null;
			this.attachAttemptEpoch = null;
			this.clearReattachTimer();
			this.clearRunFlags();
			this.observationRestoring = true;
			const epoch = ++this.viewEpoch;
			this.pushStatus();
			void this.restoreAfterObservationClosed(epoch);
			return;
		}
		if (attachmentEpoch === this.viewEpoch) {
			this.attachAttempt = { ...attachment };
			this.attachAttemptEpoch = attachmentEpoch;
			this.broadcast({
				type: "notice",
				level: "warning",
				text: closing === "update"
					? "The daemon restarted for its update — re-attaching now."
					: "Daemon connection dropped — re-attaching when it comes back.",
			});
		} else {
			this.attachAttempt = null;
			this.attachAttemptEpoch = null;
			// A newer explicit navigation owns the display. Keep it
			// non-interactive until that navigation either completes or
			// restores an authoritative RPC snapshot.
			this.observationRestoring = true;
			// ...but that navigation may itself be blocked on the socket
			// that just died. Nothing else would ever clear the lock, so
			// fall back to this window's own session after a grace period.
			const restoreEpoch = this.viewEpoch;
			const settle = setTimeout(() => {
				if (this.disposed || restoreEpoch !== this.viewEpoch) return;
				if (this.attached || this.observingId || !this.observationRestoring) return;
				void this.restoreAfterObservationClosed(restoreEpoch);
			}, 2_000);
			settle.unref?.();
		}
		this.pushStatus();
		if (attachmentEpoch === this.viewEpoch) this.scheduleReattach(0);
	}
	// Not attached, but a re-attach wait may be riding the ladder (a drop
	// mid-ladder, or the queued wait for a recovering worker). A shutdown
	// means no supervisor is coming back for that handle: stop the ladder
	// and give the view back to this window's own session. An update (or a
	// plain drop) keeps the ladder riding, exactly as before.
	if (closing === "shutdown" && this.attachAttempt !== null) {
		const attemptEpoch = this.attachAttemptEpoch;
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		if (attemptEpoch === this.viewEpoch) {
			this.clearRunFlags();
			this.observationRestoring = true;
			const epoch = ++this.viewEpoch;
			this.pushStatus();
			void this.restoreAfterObservationClosed(epoch);
		}
	}
},

async runReattach(this: SessionController, sidecar: DaemonSidecar): Promise<void> {
	if (this.sidecar !== sidecar || !sidecar.connected || !this.attachAttempt || this.attached) return;
	const attempt = this.attachAttempt;
	const attemptEpoch = this.attachAttemptEpoch;
	if (attemptEpoch === null || attemptEpoch !== this.viewEpoch) {
		if (this.attachAttempt === attempt) {
			this.attachAttempt = null;
			this.attachAttemptEpoch = null;
			this.clearReattachTimer();
		}
		return;
	}
	try {
		// A release of this handle may still be in flight; attaching under it
		// lets the late detach tear down the fresh subscription.
		await this.waitForDaemonDetach(attempt.activeSessionId);
		if (this.sidecar !== sidecar || this.attachAttempt !== attempt || this.viewEpoch !== attemptEpoch || this.attached) return;
		const result = await sidecar.attach(attempt.activeSessionId);
		// The user may have switched, stopped observing, or disposed the panel
		// while the daemon was answering. A late reattach must never reclaim the
		// view (and therefore later prompts) from that newer navigation.
		if (
			this.disposed ||
			this.viewEpoch !== attemptEpoch ||
			this.attachAttempt !== attempt ||
			this.attachAttemptEpoch !== attemptEpoch ||
			this.attached !== null ||
			this.observingId !== null
		) {
			// Never release a handle that is now the live attachment: that is
			// the same daemon registration another attach just installed, and
			// dropping it silently kills the event stream for a view that
			// still looks (and behaves) attached.
			if ((this.attached as AttachRef | null)?.activeSessionId !== attempt.activeSessionId) {
				try {
					await this.detachDaemonSession(sidecar, attempt.activeSessionId);
				} catch {
					// The daemon may already have released the stale viewer.
				}
			}
			return;
		}
		this.attached = attempt;
		this.reachable = true;
		this.attachedEpoch = attemptEpoch;
		this.clearReattachTimer();
		this.observationRestoring = false;
		this.applyAttachedSnapshot(result.snapshot);
		this.broadcast({
			type: "notice",
			level: "info",
			text: "Re-attached to the live session.",
		});
	} catch (err) {
		const transient = isTransientWorkerAttachError(err instanceof Error ? err.message : String(err));
		if (
			transient &&
			!this.disposed &&
			this.attachAttempt === attempt &&
			this.attachAttemptEpoch === attemptEpoch &&
			this.viewEpoch === attemptEpoch &&
			this.attached === null
		) {
			// The worker is still recovering; keep the attempt so the ladder
			// retries instead of ending the view over a transient the daemon
			// itself flagged as retryable.
			this.scheduleReattach(0);
			return;
		}
		// keep the attempt saved? user closed it in the meantime — drop
		if (
			!this.disposed &&
			this.attachAttempt === attempt &&
			this.attachAttemptEpoch === attemptEpoch &&
			this.viewEpoch === attemptEpoch &&
			this.attached === null
		) {
			this.attachAttempt = null;
			this.attachAttemptEpoch = null;
			this.clearReattachTimer();
			// The shared transcript is still painted. Never make it writable-looking
			// by falling through to the hidden RPC session before that session has
			// produced a fresh snapshot.
			this.observationRestoring = true;
			const epoch = this.beginNavigation();
			this.pushStatus();
			void this.restoreAfterObservationClosed(epoch);
		}
	}
},

async waitForDaemonDetach(this: SessionController, activeSessionId: string): Promise<void> {
	const pending = this.pendingDaemonDetaches.get(activeSessionId);
	if (!pending) return;
	try {
		await pending;
	} catch {
		// A failed release leaves no daemon registration to wait on.
	}
},

/**
 * Serialize detach calls by active handle. Without this, Browse can start
 * releasing parent A just as Back re-attaches A, and its late detach tears
 * down the fresh parent subscription.
 */
async detachDaemonSession(this: SessionController, sidecar: DaemonSidecar, activeSessionId: string): Promise<void> {
	const prior = this.pendingDaemonDetaches.get(activeSessionId);
	const chained = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => sidecar.detach(activeSessionId));
	this.pendingDaemonDetaches.set(activeSessionId, chained);
	try {
		await chained;
	} finally {
		if (this.pendingDaemonDetaches.get(activeSessionId) === chained) this.pendingDaemonDetaches.delete(activeSessionId);
	}
},

clearReattachTimer(this: SessionController): void {
	if (this.reattachTimer) clearTimeout(this.reattachTimer);
	this.reattachTimer = null;
},

/**
 * Recovery must not wait for the operator to click something: nothing else
 * calls ensureSidecar() once the socket is gone (the event traffic that drove
 * scheduleChildrenRefresh died with it), so the promised re-attach would
 * never happen on its own.
 */
scheduleReattach(this: SessionController, step: number): void {
	this.clearReattachTimer();
	if (this.disposed || !this.isReattaching()) return;
	const delay = REATTACH_BACKOFF[Math.min(step, REATTACH_BACKOFF.length - 1)];
	this.reattachTimer = setTimeout(() => {
		this.reattachTimer = null;
		if (this.disposed || !this.isReattaching()) return;
		void this.ensureSidecar()
			.catch(() => {})
			.finally(() => {
				if (!this.disposed && this.isReattaching()) this.scheduleReattach(step + 1);
			});
	}, delay);
},

/**
 * Adopt a daemon snapshot (attach reply, re-attach, or a catch-up frame) as
 * the attached transcript and repaint every webview from it.
 */
applyAttachedSnapshot(this: SessionController, snapshot: AttachSnapshot | undefined): void {
	if (snapshot?.messages) this.cachedMessages = snapshot.messages as AgentMessage[];
	if (snapshot?.state) this.rentedState = snapshot.state as RpcSessionState;
	const inFlight = snapshot?.summary?.streamingMessage as AgentMessage | undefined;
	// A turn already under way has no agent_start left to send us; without this
	// the header, the Stop button and the queue/steer toggle all read "idle".
	this.clearRunFlags();
	this.streaming = Boolean(inFlight ?? this.rentedState?.isStreaming);
	this.compacting = this.rentedState?.isCompacting === true;
	this.broadcast({
		type: "snapshot",
		messages: this.cachedMessages,
		state: this.rentedState,
		status: this.buildStatus(),
		steerDefault: vscode.workspace.getConfiguration("brief").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
	});
	// The in-flight assistant message is NOT in snapshot.messages, and its
	// message_start fired before we attached. Replay it so the deltas already
	// on the wire have a bubble to land in — otherwise the transcript freezes
	// mid-turn and the finished answer never appears either.
	if (inFlight?.role === "assistant") {
		this.broadcast({ type: "event", event: { type: "message_start", message: inFlight } as AgentEvent });
	}
	this.pushStatus();
},

/**
 * Attach to a session that is already live somewhere else (a terminal).
 * The daemon brokers it; both clients see the same stream, both can prompt.
 */
async attachViaDaemon(this: SessionController, activeSessionId: string, sessionPath: string, epoch = this.beginNavigation()): Promise<boolean> {
	this.lastDaemonAttachError = null;
	try {
		const sidecar = await this.ensureSidecar({ reattach: false });
		// Resolve the canonical activeSessionId: root-session uuids and 12-char
		// active windows differ, and events are addressed to the canonical id.
		let canonicalId = activeSessionId;
		try {
			const listed = await this.listSessions(sidecar);
			const target =
				listed.find((s) => s.activeSessionId === activeSessionId) ??
				listed.find((s) => (s as { sessionId?: string }).sessionId === activeSessionId) ??
				listed.find((s) => s.id === activeSessionId);
			if (target?.activeSessionId) {
				canonicalId = target.activeSessionId;
			}
		} catch {
			// list failed — fall back to what was asked (attach may still succeed)
		}
		await this.waitForDaemonDetach(canonicalId);
		if (this.disposed || epoch !== this.viewEpoch) return false;
		this.lastDaemonAttachCanonicalId = canonicalId;
		const result = await sidecar.attach(canonicalId);
		if (this.disposed || epoch !== this.viewEpoch) {
			try {
				await this.detachDaemonSession(sidecar, canonicalId);
			} catch {
				// Late attach belongs to an obsolete navigation.
			}
			return false;
		}
		const returnedId = (result.snapshot as { activeSessionId?: string } | undefined)?.activeSessionId;
		const finalId = returnedId ?? canonicalId;
		const snapshot = result.snapshot;
		// History rows and visible-session guards key on the daemon UUID, never
		// the 12-char attach handle. It may differ from the JSONL filename stem.
		const uuid =
			(snapshot?.state as { sessionId?: string } | undefined)?.sessionId ?? snapshot?.summary?.sessionId ?? undefined;
		// Keep the identity presented to a webview stable for this attachment.
		// The daemon may reveal its UUID only in a later get_state reply; changing
		// `sessionId` mid-view otherwise looks like a new chat and clears its draft.
		const stableSessionId = uuid ?? (sessionPath ? path.basename(sessionPath, ".jsonl") : finalId);
		const resolvedSessionPath =
			snapshot?.summary?.sessionFile ?? (snapshot?.state as { sessionFile?: string } | undefined)?.sessionFile ?? sessionPath;
		const attachment = { activeSessionId: finalId, sessionPath: resolvedSessionPath, sessionId: stableSessionId };
		this.attached = attachment;
		this.reachable = true;
		this.attachedEpoch = epoch;
		this.attachAttempt = { activeSessionId: finalId, sessionPath, sessionId: stableSessionId };
		this.attachAttemptEpoch = epoch;
		// Clear the strip only now that the switch is real — a different session
		// owns nothing from the last view, but a failed attach must leave the
		// operator's current strip (and its back row) exactly where it was.
		this.broadcast({ type: "sessionChildren", children: [] });
		this.resetChildrenBaseline();
		this.rentedState = (snapshot?.state ?? null) as RpcSessionState | null;
		// Local busy flags belong to the session we just left; the snapshot below
		// re-establishes them for this one.
		this.clearRunFlags();
		if (!snapshot?.messages) {
			try {
				const messages = await sidecar.getMessages(finalId);
				if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
				this.cachedMessages = messages as AgentMessage[];
			} catch {
				if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
				this.cachedMessages = [];
			}
		}
		if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
		void this.refreshAttachedState();
		this.scheduleChildrenRefresh();
		this.resetViewedSessionState();
		// Stats before the first paint: otherwise the gauge shows the previous
		// session's context until the throttled status push catches up.
		await this.fetchAttachedStats();
		if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
		this.observationRestoring = false;
		this.creatingSessionEpoch = null;
		this.applyAttachedSnapshot(snapshot);
		try {
			await this.persistForegroundSession(stableSessionId, resolvedSessionPath);
		} catch (err) {
			this.output.appendLine(`[prime-agent] could not remember foreground session: ${String(err)}`);
		}
		return true;
	} catch (error) {
		this.lastDaemonAttachError = error instanceof Error ? error.message : String(error);
		this.output.appendLine(`[prime-agent] daemon attach failed: ${String(error)}`);
		return false;
	}
},

/**
 * Undo a half-installed attachment. Reaching this means a newer navigation
 * took the view after we had already published `this.attached`: leaving it
 * set leaks a daemon viewer AND wedges that newer navigation, because its own
 * `detachFromDaemon(previous)` no longer recognises what it is holding — the
 * window then stays in "switching sessions…" with every action refused.
 */
async rollbackAttachment(this: SessionController, sidecar: DaemonSidecar, attachment: AttachRef): Promise<false> {
	const stillOurs = this.attached === attachment;
	if (stillOurs) {
		this.attached = null;
		this.attachedEpoch = null;
		this.clearRunFlags();
	}
	if (this.attachAttempt?.activeSessionId === attachment.activeSessionId) {
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
	}
	// Only release the handle when it is not the one a newer attach installed.
	if (this.attached?.activeSessionId !== attachment.activeSessionId) {
		try {
			await this.detachDaemonSession(sidecar, attachment.activeSessionId);
		} catch {
			// The daemon may already have released this viewer.
		}
	}
	return false;
},

async detachFromDaemon(this: SessionController, expected: AttachRef | null = this.attached): Promise<boolean> {
	if (expected && this.sidecar?.connected) {
		await this.detachDaemonSession(this.sidecar, expected.activeSessionId);
	}
	// A concurrent navigation attached a different session while the detach was
	// in flight. Its state belongs to that navigation and must remain intact.
	if (this.attached !== expected) {
		// A sidecar close has already released `expected` and cleared the local
		// attachment. Let the navigation that owned it continue; its epoch guards
		// still reject an obsolete caller, while treating this as failure would
		// strand the requested switch behind a disconnected old view.
		return this.attached === null;
	}
	this.attached = null;
	this.attachedEpoch = null;
	this.attachAttempt = null;
	this.attachAttemptEpoch = null;
	this.rentedState = null;
	// The run we were following belongs to the session we just let go of.
	this.clearRunFlags();
	this.clearReattachTimer();
	return true;
},

/**
 * The owner id of the client-owned worker hosting THIS session, or undefined
 * when the roster can be read as ourselves.
 *
 * Keyed by session file, so switching or forking a session drops the previous
 * worker's identity instead of quietly reusing it.
 */
ownedRosterClientId(this: SessionController): string | undefined {
	const sessionFile = this.state?.sessionFile;
	if (!sessionFile) return undefined;
	const cached = this.ownerIdCache;
	const now = Date.now();
	if (cached && cached.sessionFile === sessionFile) {
		const ttl = cached.id ? OWNER_ID_HIT_TTL_MS : OWNER_ID_MISS_TTL_MS;
		if (now - cached.at < ttl) return cached.id;
	}
	let id: string | undefined;
	try {
		id = resolveOwnerClientId({ sessionFile });
	} catch {
		// Descriptor layout changed or unreadable: degrade to the plain roster.
		id = undefined;
	}
	this.ownerIdCache = { sessionFile, id, at: now };
	return id;
},

/**
 * Every roster read in this class goes through here.
 *
 * A plain `list all` cannot see the client-owned worker that hosts our own
 * RPC session, so our live root reads as a stale on-disk row and none of our
 * subagents appear at all. The flag asks for owned workers; the identity that
 * makes the daemon hand them over is carried by the sidecar connection itself
 * (see `ensureSidecar`). Without a claim this degrades to the plain roster.
 */
async listSessions(this: SessionController, sidecar: DaemonSidecar): Promise<SessionSummaryRef[]> {
	return sidecar.list(true, { includeClientOwned: true });
},

/**
 * Give up the owner identity when the RPC process that owns the worker is
 * gone.
 *
 * The daemon refuses to reap a client-owned worker while any connected client
 * still answers to its owner id, so holding the claim past the agent's death
 * would strand that worker and its IPython kernels for as long as this window
 * stayed open. Dropping the socket is what releases it: the daemon reschedules
 * cleanup on disconnect. The cache is cleared too, so the next connection
 * resolves the identity again from scratch — and a descriptor whose process is
 * dead resolves to nothing.
 */
releaseOwnerIdentity(this: SessionController): void {
	this.ownerIdCache = null;
	this.rosterSubscribedSidecar = null;
	if (!this.sidecar?.impersonateClientId) return;
	this.sidecar.dispose();
	this.sidecar = null;
},

/**
 * Connect the sidecar lazily and refresh children; fire-and-forget.
 * Coalescing matters twice over: it caps the daemon reads, and it stops the
 * webview rebuilding the strip (and losing its scroll position) mid-burst.
 */
scheduleChildrenRefresh(this: SessionController): void {
	if (this.disposed) return;
	// A refresh already on the wire will not see events that arrive during it,
	// so remember to run once more instead of racing a second list.
	if (this.childrenRefreshInFlight) {
		this.childrenRefreshPending = true;
		return;
	}
	if (this.childrenTimer) return;
	const wait = Math.max(0, CHILDREN_REFRESH_MS - (Date.now() - this.lastChildrenRefreshMs));
	this.childrenTimer = setTimeout(() => {
		this.childrenTimer = null;
		void this.runChildrenRefresh();
	}, wait);
},

async runChildrenRefresh(this: SessionController): Promise<void> {
	if (this.disposed) return;
	this.childrenRefreshInFlight = true;
	this.childrenRefreshPending = false;
	try {
		await this.ensureSidecar();
		await this.refreshChildren();
	} catch {
		// daemon unavailable — panel stays empty
	} finally {
		this.childrenRefreshInFlight = false;
		this.lastChildrenRefreshMs = Date.now();
		if (!this.disposed && this.childrenRefreshPending) this.scheduleChildrenRefresh();
	}
},

/**
 * Forget what the strip knows. Both halves must go together: the spawn
 * baseline decides which subagents count as "new" (a stale one announces a
 * whole resumed session as freshly spawned), and the payload cache would
 * otherwise suppress the re-send the webview needs after it wipes its own
 * copy on a session change.
 */
resetChildrenBaseline(this: SessionController): void {
	this.childrenContext += 1;
	this.previousChildIds = null;
	this.lastChildrenPayload = null;
	this.browseableChildren.clear();
	this.browseRefByActiveId.clear();
},

browseRefFor(this: SessionController, activeSessionId: string, parentId?: string, contextId = this.childrenContext): string | undefined {
	if (!activeSessionId) return undefined;
	let ref = this.browseRefByActiveId.get(activeSessionId);
	if (!ref) {
		ref = randomUUID();
		this.browseRefByActiveId.set(activeSessionId, ref);
	}
	this.browseableChildren.set(ref, { activeSessionId, parentId, contextId });
	return ref;
},

async refreshChildren(this: SessionController): Promise<void> {
	if (!this.sidecar?.connected) return;
	const epoch = this.viewEpoch;
	const attachment = this.attached;
	// The observed transcript is intentionally read-only. Never mine the hidden
	// RPC session for child capabilities while it is on screen.
	if (this.observingId) return;
	try {
		const sessions = await this.listSessions(this.sidecar);
		if (this.disposed || epoch !== this.viewEpoch || this.attached !== attachment || this.observingId) return;
		let parentActive: string;
		let parentUuid: string | undefined;
		if (attachment) {
			parentActive = attachment.activeSessionId;
			parentUuid = undefined;
		} else {
			parentActive = "";
			parentUuid = this.state?.sessionId;
		}
		type Rich = SessionSummaryRef & { runtimeKind?: string; rlmDepth?: number; parentSessionId?: string; isStreaming?: boolean; activity?: string; sessionName?: string };
		const byActive = (s: SessionSummaryRef): string => s.activeSessionId ?? s.id ?? "";
		// Identity that survives passivation. A resident subagent is listed under
		// its 12-char active handle and the same subagent, once finished, under
		// its uuid — diffing on the attach target alone reads that transition as
		// a brand-new subagent and fabricates a spawn card for it.
		const stableId = (s: SessionSummaryRef): string => s.sessionId ?? s.activeSessionId ?? s.id ?? "";
		const asChild = (c: SessionSummaryRef, parentId?: string): SessionChild => {
			const rich = c as Rich;
			const activeSessionId = byActive(c);
			return {
				id: c.id ?? "",
				activeSessionId,
				...(parentId ? { browseRef: this.browseRefFor(activeSessionId, parentId) } : {}),
				name: rich.sessionName,
				runtimeKind: rich.runtimeKind,
				rlmDepth: rich.rlmDepth,
				created: rich.created,
				isStreaming: rich.isStreaming ?? false,
				// One source of truth with history rows and with the CLI: see
				// rosterStatus. A subagent with no worker behind it is "inactive",
				// which for a child means finished.
				status: rosterStatus(c),
				...(c.statusLabel ? { statusLabel: c.statusLabel } : {}),
				attachedClients: c.attachedClients ?? 0,
			};
		};
		const isChildKind = (rich: Rich): boolean => !!rich.runtimeKind && rich.runtimeKind !== "root";
		let children = sessions.filter((s) => {
			const rich = s as Rich;
			if (!isChildKind(rich)) return false;
			if (attachment) {
				return (
					(s.parentActiveSessionId && s.parentActiveSessionId === parentActive) ||
					(rich.parentSessionId === parentActive)
				);
			}
			return parentUuid != null && rich.parentSessionId === parentUuid;
		});

		// Viewing context for the strip: parent + siblings (when the current
		// session has a parent of its own), plus the viewed id for the
		// highlight. Works for browsed subagents and terminal-live sessions.
		let parent: SessionChild | undefined;
		let siblingRefs: SessionSummaryRef[] | undefined;
		const currentId = attachment ? parentActive : undefined;
		const currentSummary = sessions.find((s) => byActive(s) === currentId) as (SessionSummaryRef & Rich) | undefined;
		if (attachment && currentSummary) {
			const parentActiveId = currentSummary.parentActiveSessionId;
			const parentSummaryRef = parentActiveId
				? sessions.find((s) => byActive(s) === parentActiveId)
				: undefined;
			if (parentSummaryRef) parent = asChild(parentSummaryRef);
			if (parentActiveId) {
				// The session being viewed stays in the list. Dropping it was what
				// made the count fall by one on entry and left the green "currently
				// viewing" highlight with no row to land on.
				siblingRefs = sessions
					.filter((s) => {
						const rich = s as Rich;
						return isChildKind(rich) && rich.parentActiveSessionId === parentActiveId;
					})
			}
		}
		const childRows = children.map((child) => {
			const rich = child as Rich;
			return asChild(child, child.parentActiveSessionId ?? rich.parentSessionId);
		});
		const siblings = siblingRefs?.map((sibling) => {
			const rich = sibling as Rich;
			return asChild(sibling, sibling.parentActiveSessionId ?? rich.parentSessionId);
		});
		// A row leaves the visual strip when its daemon relationship changes. Its
		// old ref must stop being authority even if a stale webview still holds it.
		const activeRefs = new Set([...childRows, ...(siblings ?? [])].flatMap((row) => (row.browseRef ? [row.browseRef] : [])));
		for (const [ref, capability] of this.browseableChildren) {
			if (activeRefs.has(ref)) continue;
			this.browseableChildren.delete(ref);
			if (this.browseRefByActiveId.get(capability.activeSessionId) === ref) this.browseRefByActiveId.delete(capability.activeSessionId);
		}
		if (this.disposed || epoch !== this.viewEpoch || this.attached !== attachment || this.observingId) return;
		const flat = new Set<string>(children.map(stableId));
		const prev = this.previousChildIds;
		const spawnCards = prev === null
			? []
			: children
					.filter((c) => !prev.has(stableId(c)))
					.map((c) => {
						const row = childRows.find((candidate) => candidate.activeSessionId === byActive(c));
						return {
							activeSessionId: byActive(c),
							browseRef: row?.browseRef,
							name: (c as Rich).sessionName,
							created: (c as Rich).created,
						};
					});
		this.previousChildIds = flat;
		const payload: Extract<HostToWebview, { type: "sessionChildren" }> = {
			type: "sessionChildren",
			children: childRows,
			parent,
			siblings,
			viewedActiveSessionId: currentId,
			spawned: spawnCards,
		};
		// An unchanged roster must not be re-sent: the webview rebuilds the whole
		// strip from the message, which throws away the operator's scroll position
		// inside it. Spawn cards always go through — they are one-shot news.
		const fingerprint = JSON.stringify({ ...payload, spawned: [] });
		if (spawnCards.length === 0 && fingerprint === this.lastChildrenPayload) return;
		this.lastChildrenPayload = fingerprint;
		this.broadcast(payload);
	} catch (err) {
		// Stale layout is tolerated until the next refresh, but a programming
		// error in the strip logic must not be indistinguishable from "daemon
		// unavailable" — leave a trace instead of a silently frozen panel.
		this.debugLog.append(`children-refresh failed: ${err instanceof Error ? err.message : String(err)}`);
	}
},

async browseChild(this: SessionController, browseRef: string): Promise<boolean> {
	if (this.guardObservedReadOnly("browsing a subagent")) return false;
	const capability = this.browseableChildren.get(browseRef);
	if (!capability || capability.contextId !== this.childrenContext) {
		this.broadcast({ type: "notice", level: "error", text: "Invalid subagent reference." });
		return false;
	}
	// Claim the navigation before either daemon round-trip. A second click wins;
	// this older lookup may still finish, but it cannot attach over the newer view.
	const previous = this.attached;
	const epoch = this.beginNavigation();
	let sidecar: DaemonSidecar;
	let child: SessionSummaryRef | undefined;
	try {
		sidecar = await this.ensureSidecar({ reattach: false });
		child = (await this.listSessions(sidecar)).find((candidate) => (candidate.activeSessionId ?? candidate.id) === capability.activeSessionId);
	} catch {
		if (epoch !== this.viewEpoch) return false;
		this.restoreAttachedView(previous, epoch);
		this.broadcast({ type: "notice", level: "error", text: "Could not verify that subagent session." });
		return false;
	}
	if (this.disposed || epoch !== this.viewEpoch || capability.contextId !== this.childrenContext) return false;
	const parentId = child?.parentActiveSessionId ?? (child as { parentSessionId?: string } | undefined)?.parentSessionId;
	const rich = child as (SessionSummaryRef & { runtimeKind?: string }) | undefined;
	if (!child || !rich || !rich.runtimeKind || rich.runtimeKind === "root" || parentId !== capability.parentId) {
		this.broadcast({ type: "notice", level: "error", text: "That subagent is no longer part of this session." });
		this.restoreAttachedView(previous, epoch);
		return false;
	}
	// A descent pushes a breadcrumb; a lateral move must not.
	//
	// The strip offers exactly two kinds of row: children of the session on
	// screen, and its siblings. Stepping to a sibling does not go anywhere
	// deeper — B has the same parent A did — so the entry already on the stack
	// is still the right way up, and pushing another made "‹ parent" walk back
	// through the siblings the operator had visited instead of going up.
	//
	// From this window's own session there are no siblings, so every browsable
	// row is a descent.
	const descending = previous === null || capability.parentId === previous.activeSessionId;
	// Install the breadcrumb before the target's final snapshot finishes. Back
	// can then recover the parent if the user changes their mind mid-attach.
	const breadcrumb = previous ? ({ kind: "attached", ...previous } as const) : ({ kind: "rpc" } as const);
	if (descending) this.returnTargets.push(breadcrumb);
	// Attach FIRST, let go second. Tearing the current session down up front
	// meant a subagent the daemon can no longer rehydrate left the operator
	// detached, with the strip and its "‹ parent" row destroyed and nothing
	// left to click — the freeze reported in the build thread.
	const attached = await this.attachViaDaemon(capability.activeSessionId, child.sessionFile ?? "", epoch);
	if (this.disposed || epoch !== this.viewEpoch) {
		if (descending && this.returnTargets.at(-1) === breadcrumb) this.returnTargets.pop();
		return false;
	}
	if (!attached) {
		this.broadcast({ type: "notice", level: "error", text: "Could not attach to that subagent session (it may be gone)." });
		if (descending && this.returnTargets.at(-1) === breadcrumb) this.returnTargets.pop();
		this.restoreAttachedView(previous, epoch);
		this.scheduleChildrenRefresh();
		return false;
	}
	if (previous && this.sidecar?.connected && epoch === this.viewEpoch && this.attached !== previous) {
		try {
			await this.detachDaemonSession(this.sidecar, previous.activeSessionId);
		} catch {
		// the daemon dropped it for us — nothing left to release
		}
	}
	if (epoch !== this.viewEpoch) return false;
	this.scheduleChildrenRefresh();
	return true;
},

async backToParent(this: SessionController): Promise<void> {
	const epoch = this.beginNavigation();
	const target = this.returnTargets.at(-1) ?? { kind: "rpc" as const };
	if (target.kind === "attached") {
		const path = target.sessionPath;
		const id = target.activeSessionId;
		const current = this.attached;
		if (!(await this.detachFromDaemon(current)) || epoch !== this.viewEpoch) return;
		if (await this.attachViaDaemon(id, path, epoch)) {
			if (epoch !== this.viewEpoch) return;
			this.returnTargets.pop();
			return;
		}
		if (epoch !== this.viewEpoch || this.attached !== null) return;
		// The parent went away while we were inside the child. Land on our own
		// session rather than on nothing — going up must never dead-end.
		this.broadcast({ type: "notice", level: "warning", text: "The parent session is no longer live — returning to this window's session." });
	}
	// baseline: own RPC session.
	//
	// Browsing from this window's own session into a subagent leaves that CHILD
	// attached and pushes an "rpc" breadcrumb, so going back arrives here
	// holding an attachment that must be released first. Refusing whenever one
	// existed — and asking detachFromDaemon to expect none — made "‹ parent" a
	// silent no-op for the most common path there is: root -> child -> back.
	// A newer navigation is still rejected, by the epoch guard that means it.
	if (epoch !== this.viewEpoch) return;
	const landing = this.attached;
	if (!(await this.detachFromDaemon(landing)) || epoch !== this.viewEpoch || this.attached !== null) return;
	this.returnTargets.pop();
	// The strip belongs to whatever session we just landed on, and the spawn
	// baseline still holds the child's (usually empty) set — leaving it would
	// announce every one of the parent's subagents as freshly spawned.
	this.resetChildrenBaseline();
	this.beginRpcRestore();
	if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
},

onDaemonEvent(this: SessionController, message: DaemonServerMessage): void {
	this.debugLog.append(`daemon-event: type=${message.type} sid=${String(message.activeSessionId).slice(0, 20)}${this.attached ? ` attached=${this.attached.activeSessionId.slice(0, 20)}` : " no-attach"}`);
	// Global frames first: neither carries an activeSessionId, and both must
	// be honored even when no session is attached (the daemon announces its
	// own close on the bare connection, and roster push drives history + the
	// subagents strip for the whole window).
	if (message.type === "daemon_closing") {
		this.onDaemonClosing(message.reason);
		return;
	}
	if (message.type === "roster_update") {
		this.onRosterUpdate(message);
		return;
	}
	const attached = this.attached;
	if (!attached || !this.isCurrentAttachment(attached)) return;
	const msgSessionId = message.activeSessionId;
	if (message.type === "session_event" && msgSessionId === attached.activeSessionId && message.event) {
		this.onAgentEvent(message.event as AgentEvent);
		return;
	}
	if (message.type === "session_status" && msgSessionId === attached.activeSessionId) {
		void this.refreshAttachedState();
		this.scheduleHistoryRefresh();
		return;
	}
	// Catch-up frames REPLACE the live events the daemon withheld while our
	// socket was backpressured or the worker was swapped. Dropping them loses
	// every message from that window with no visible gap in the transcript.
	if (message.type === "session_replaced" && msgSessionId === attached.activeSessionId) {
		this.applyAttachedSnapshot({
			state: message.state as Record<string, unknown> | undefined,
			messages: message.messages as Array<Record<string, unknown>> | undefined,
		});
		void this.refreshAttachedState();
		return;
	}
	if (message.type === "session_resynced" && msgSessionId === attached.activeSessionId) {
		this.applyAttachedSnapshot(message.snapshot as AttachSnapshot | undefined);
		return;
	}
		if (message.type === "session_closed" && msgSessionId === attached.activeSessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "The live session was closed by its other client." });
				this.attached = null;
				this.attachedEpoch = null;
				this.attachAttempt = null;
				this.attachAttemptEpoch = null;
			this.rentedState = null;
		// No agent_end is coming for a session that no longer exists.
			this.clearRunFlags();
			this.clearReattachTimer();
			// The closed shared transcript must never become a writable-looking view
			// of our hidden RPC session. Restore that session before controls return.
			this.observationRestoring = true;
			const epoch = ++this.viewEpoch;
			this.pushStatus();
			void this.restoreAfterObservationClosed(epoch);
		}
},

/**
 * The daemon is about to close every client socket (its own shutdown, or a
 * self-update cutover). Announced BEFORE the EOF so "the view will come back"
 * and "the daemon went away" stop being the same mystery to the operator, and
 * so the close handler knows whether a reconnect ladder is even wanted.
 */
onDaemonClosing(this: SessionController, reason: string | undefined): void {
	const closing = reason === "update" ? "update" : "shutdown";
	this.daemonClosingReason = closing;
	// Only promise a re-attach to a view that is actually following a daemon
	// session; for a window on its own RPC session the daemon coming or going
	// is background news.
	const following = this.attached !== null || this.isReattaching();
	this.broadcast({
		type: "notice",
		level: "info",
		text:
			closing === "update"
				? following
					? "The agent runtime is updating — the view will re-attach automatically when it is back."
					: "The agent runtime is updating — it will be back on its own."
				: "The agent runtime is shutting down.",
	});
},

/**
 * Roster push (rev 24+, capability "agent_roster"): subagent/history state
 * changed, so refresh from the ledger-served list at change cadence instead of
 * agent-event cadence. `resync:true` marks a wholesale replacement; both are
 * handled by the same throttled re-read, and the strip/history fingerprints
 * suppress the paint when nothing visible moved.
 */
onRosterUpdate(this: SessionController, message: DaemonServerMessage): void {
	// Apply pushed runtime verdicts now; reading transcripts must not delay the lamp.
	for (const entry of message.changed ?? []) {
		const summary = entry.summary;
		if (!summary?.sessionFile || (summary.rlmDepth ?? 0) > 0) continue;
		const ownStatus = entry.status ?? rosterStatus(summary);
		const status = summary.hasRunningRlmChildren ? "running" : ownStatus;
		this.updateHistoryRuntime(summary.sessionFile, status, entry.statusLabel ?? summary.statusLabel);
	}
	this.paintHistory();
	this.scheduleHistoryRefresh();
	this.scheduleChildrenRefresh();
},

/**
 * Subscribe this sidecar to agent-roster push when the daemon offers it.
 * Fire-and-forget safe: a refusal (older daemon, mid-update) just leaves the
 * host on the pull model it already has, and a later reconnect tries again.
 */
async setupRosterSubscription(this: SessionController, sidecar: DaemonSidecar): Promise<void> {
	if (this.rosterSubscribedSidecar === sidecar) return;
	this.rosterSubscribedSidecar = null;
	// Older sidecar fakes (tests) and any pre-capability daemon lack the probe
	// entirely — treat both as "push not offered, pull model continues".
	if (!sidecar.connected || typeof sidecar.hasServerCapability !== "function" || !sidecar.hasServerCapability("agent_roster")) return;
	try {
		await sidecar.rosterSubscribe();
		this.rosterSubscribedSidecar = sidecar;
		this.debugLog.append(`roster: subscribed (schemaRevision ${sidecar.hello?.schemaRevision ?? "?"})`);
	} catch (err) {
		this.debugLog.append(`roster: subscribe failed (pull model continues): ${err instanceof Error ? err.message : String(err)}`);
	}
},

async refreshAttachedState(this: SessionController): Promise<void> {
	const attached = this.attached;
	if (!attached || !this.sidecar?.connected) return;
	try {
		const state = (await this.sidecar.getState(attached.activeSessionId)) as RpcSessionState;
		if (!this.isCurrentAttachment(attached)) return;
		this.rentedState = state;
		// get_state answers with the daemon summary, which is where the uuid
		// lives when the attach snapshot didn't carry one.
		this.pushStatus();
	} catch {
		// keep current state
	}
},

async clearObservation(this: SessionController, expectedId: string | null = this.observingId, epoch = this.viewEpoch): Promise<boolean> {
	if (this.disposed || epoch !== this.viewEpoch) return false;
	if (expectedId === null) return this.observingId === null;
	if (this.observingId !== expectedId) return false;
	const id = expectedId;
	this.observingId = null;
	this.observedSession = null;
	const client = this.client;
	if (client) {
		try {
			await client.request({ type: "unobserve", activeSessionId: id }, 10_000);
		} catch {
			// best effort
		}
	}
	if (this.disposed || epoch !== this.viewEpoch) return false;
	this.broadcast({ type: "observedClosed", sessionId: id });
	return true;
},

async stopObserving(this: SessionController): Promise<void> {
	if (!this.observingId) return;
	// Clearing `observingId` has to happen before the daemon reply so observed
	// events stop routing here; keep a separate restore lock over that gap so a
	// prompt cannot fall through to this window's hidden RPC session.
	const observedAtStart = this.observingId;
	const epoch = this.beginNavigation();
	this.observationRestoring = true;
	this.pushStatus();
	if (!(await this.clearObservation(observedAtStart, epoch))) {
		// Never leave the restore lock latched behind a refused hand-off: the
		// composer would stay disabled with no way back. A newer navigation owns
		// the lock (and will clear it) only when it also took the epoch.
		if (!this.disposed && epoch === this.viewEpoch && !this.attached) {
			this.observationRestoring = false;
			this.pushStatus();
		}
		return;
	}
	// Same trap as backToParent: we land on a different session, so the strip
	// and the spawn baseline both belong to the one we just left.
	this.beginRpcRestore();
	if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
}
};
