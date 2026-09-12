/**
 * Shared session-host types. Kept here so history, daemon attach, and the
 * controller can import one shape without pulling the whole host file.
 */
import type { HostToWebview, RecentSession } from "./protocol.js";

export interface WebviewSink {
	post(message: HostToWebview): void;
}

/** A daemon-brokered session we are following, under both of its identities. */
export interface AttachRef {
	/** Daemon attach handle (12-char active id). Addresses every daemon command. */
	activeSessionId: string;
	sessionPath: string;
	/** Daemon/session UUID, when available. What history rows and UI identity key on. */
	sessionId?: string;
}

/** A catalog capability plus the immutable JSONL filename it authorizes. */
export interface ResolvedHistorySession extends RecentSession {
	/** File-stem identity used only by offline file operations and artifacts. */
	fileId: string;
}
