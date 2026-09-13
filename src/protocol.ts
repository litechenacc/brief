/**
 * Prime Agent RPC protocol types.
 *
 * Mirrors packages/coding-agent/src/modes/rpc/rpc-types.ts, duplicated here so the
 * extension has zero runtime dependencies on the coding-agent package. Keep shapes
 * additive-tolerant: unknown fields are ignored at runtime.
 */

// ---------------------------------------------------------------------------
// AI message content (subset of @earendil-works/pi-ai types)
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	// The agent sends the full per-category breakdown (ai/src/types.ts Usage);
	// narrowing it to `total` hid the per-turn input price the user footer needs.
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number };
}

export interface UserMessage {
	role: "user";
	content: string | Array<TextContent | ImageContent>;
	timestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: Array<TextContent | ThinkingContent | ToolCallContent>;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Usage;
	timestamp?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError?: boolean;
	timestamp?: number;
}

/** Messages can be extension-defined; only the known roles are rendered. */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | { role: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Agent events (subset of @earendil-works/pi-agent-core AgentEvent)
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: string; [key: string]: unknown };

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	// Session-level lifecycle events forwarded by RPC mode
	| { type: "compaction_start"; reason: string; customInstructions?: string }
	| { type: "compaction_end"; reason: string; aborted?: boolean; errorMessage?: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "session_action_update"; actions?: SessionActionSnapshot }
	| { type: "thinking_level_changed"; level: string }
	| { type: "session_info_changed"; name?: string };

export interface RpcModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	reasoning?: boolean;
	/** Input modalities, e.g. ["text"] or ["text","image"] (vision) */
	input?: string[];
	/**
	 * Per-level provider mapping straight off the agent's Model object. `null`
	 * means the level is unsupported; a missing "xhigh"/"max" key means the same.
	 * This is the only honest source for the brain menu — the level list is a
	 * property of the model, not a constant (Kimi K3 TEE supports "max" alone).
	 */
	thinkingLevelMap?: Record<string, string | null> | null;
}

/** Runtime's visible queue projection; not a per-message model-read receipt. */
export interface SessionActionSnapshot {
	queuedCount: number;
	steering: string[];
	followUps: string[];
	active?: {
		kind: "turn" | "session_command";
		phase: "preparing" | "committing" | "running";
		label: string;
	};
}

export interface RpcSessionState {
	cwd?: string;
	sessionActions?: SessionActionSnapshot;
	model?: RpcModel | null;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	steeringMode?: string;
	followUpMode?: string;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	autoCompactionEnabled?: boolean;
	messageCount?: number;
}

export interface RunningTask { id: string; label: string; startedAt: number; kind: "bash" | "background"; pid?: number; }

export interface SessionChild {
	/** bare id (uuid or sub-xxxx) for display */
	id: string;
	/** daemon attach target (12-char active id, or the id when resident); display only. */
	activeSessionId: string;
	/** Opaque host-issued capability required to browse this rendered child. */
	browseRef?: string;
	name?: string;
	runtimeKind?: string;
	rlmDepth?: number;
	created?: string;
	isStreaming?: boolean;
	/**
	 * Roster status, mirroring the CLI's classifySessionRosterStatus.
	 * "inactive" means the daemon serves this one from its on-disk registry — it
	 * finished and is not resident, which `isStreaming: false` alone cannot say
	 * (a resident subagent between turns reports exactly the same bit).
	 */
	status?: "running" | "idle" | "inactive";
	/** Exceptional off-nominal state the daemon flags: "queued" | "recovering" | "failed". */
	statusLabel?: string;
	attachedClients?: number;
}

export interface FileSearchItem {
	path: string;
	isDir: boolean;
}

export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export interface RpcSessionStats {
	sessionFile?: string;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	totalMessages?: number;
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost?: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

// ---------------------------------------------------------------------------
// Extension UI requests emitted by agent extensions that need user input
// ---------------------------------------------------------------------------

export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcOutbound = RpcExtensionUIRequest | AgentEvent | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Extension host <-> webview message bus
// ---------------------------------------------------------------------------

export interface ImageAttachment {
	data: string;
	mimeType: string;
	name?: string;
}

export interface SelectionAttachment {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	languageId: string;
}

export interface ComposerAttachment {
	id: string;
	kind: "text" | "image";
	label: string;
	start: number;
	end: number;
	status: "pending" | "ready" | "error";
	text?: string;
	image?: ImageAttachment;
}

export interface PromptPayload {
	attachments?: ComposerAttachment[];
	text: string;
	images: ImageAttachment[];
	selections: SelectionAttachment[];
	/** delivery behavior while the agent is streaming */
	streamingBehavior: "steer" | "followUp";
	/** Correlates an optimistic webview row with its eventual transport verdict. */
	clientRequestId?: string;
	/**
	 * The thread this text was composed in, as the host last published it.
	 * The host refuses to deliver a prompt whose thread is no longer the one it
	 * would send to: the RPC path addresses no session on the wire (it lands on
	 * whatever session the hidden child currently holds), so without this stamp
	 * a view that moved between typing and Enter delivers into another thread.
	 */
	sessionId?: string;
}

export interface ComposerDraft {
	attachments?: ComposerAttachment[];
	text: string;
	images: ImageAttachment[];
	selections: SelectionAttachment[];
	accepted: string[];
}

export interface ChatViewState {
	composer: {
		draft: ComposerDraft;
		stash: ComposerDraft | null;
		lastNonSlashDraft: ComposerDraft;
		selectionStart: number;
		selectionEnd: number;
		behavior: "steer" | "followUp";
	};
	transcript: { olderCount: number; scrollTop: number; stickToBottom: boolean; anchorIndex: number; anchorOffset: number; expandedBlocks: number[] };
}

export interface ChatReadReceipt { sessionId: string; path: string; revision: number; completedAt: number; }

export type StatisticsKind = "usage" | "context" | "session";

export interface StatisticsSnapshot {
	queriedAt: string;
	scope: string;
	rows: Array<{ label: string; value: string }>;
	running: boolean;
}

export type WebviewToHost =
	| { type: "queryStatistics"; kind: StatisticsKind; requestId: number }
	| { type: "createAttachment"; sessionId: string; attachment: ComposerAttachment }
	| { type: "openAttachment"; sessionId: string; id: string }
	| { type: "chatRendered"; receipt: ChatReadReceipt }
	| { type: "viewStateCaptured"; requestId: string; sessionId: string; state: ChatViewState }
	| { type: "viewStateRestored"; requestId: string; sessionId: string }
	| { type: "viewStateFailed"; requestId: string; sessionId: string; error: string }
	| { type: "ready" }
	| { type: "viewFocused" }
	| { type: "composerFocusChanged"; focused: boolean }
	| { type: "prompt"; payload: PromptPayload }
	| { type: "abort" }
	| { type: "newSession" }
	| { type: "newSessionFromCurrent" }
	| { type: "login" }
	| { type: "logout" }
	| { type: "compact"; instructions?: string }
	| { type: "exportChat" }
	| { type: "restart" }
	| { type: "requestState" }
	| { type: "requestModels" }
	| { type: "requestCommands" }
	| { type: "requestHistory" }
	| { type: "searchHistory"; query: string }
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: string }
	| { type: "switchSession"; path: string; sessionId: string }
	| { type: "stopObserving" }
	| { type: "deleteSession"; path: string; sessionId: string }
	| { type: "searchFiles"; query: string; requestId: number }
	| { type: "openFile"; path: string; startLine?: number; endLine?: number }
	| { type: "pickImage"; requestId: number }
	| { type: "attachActiveFile" }
	| { type: "attachSelection" }
	| { type: "pickModel" }
	| { type: "pickThinkingLevel" }
	| { type: "toggleFavoriteModel"; provider: string; modelId: string }
	| { type: "browseChild"; browseRef: string }
	| { type: "backToParent" }
	| { type: "forkFromUser"; ordinal: number }
	| { type: "forkSession" }
	| { type: "copyConversation" }
	| { type: "copyLastReply" }
	| { type: "dismissInstallPrompt" }
	| { type: "renameSession"; name: string }
	| { type: "promptRenameSession" }
	| { type: "openSidebarHistory" }
	| { type: "noticeAction"; id: string }
	| { type: "renameHistorySession"; path: string; sessionId: string; name: string }
	| { type: "stopSession"; path: string; sessionId: string }
	| { type: "archiveSession"; path: string; sessionId: string }
	| { type: "unarchiveSession"; path: string; sessionId: string }
	| { type: "draftChanged"; text: string; sessionId: string; attachmentDraft?: { text: string; attachments: ComposerAttachment[] } }
	| { type: "setCompactThreshold"; percent: number | null }
	| { type: "openExternal"; url: string };

export type ComposerToolbarItem = "model" | "effort" | "spacer" | "id" | "cost" | "context" | "btn";

export interface StatusSnapshot {
	connected: boolean;
	streaming: boolean;
	/** Current focused session finished and is waiting for operator input. */
	awaitingInput?: boolean;
	/** Completion observed in this window, cleared when the chat is opened. */
	unreadComplete?: boolean;
	/** Daemon/runtime verdict: null means unavailable; absent permits local event fallback. */
	historyRunning?: boolean | null;
	compacting: boolean;
	retrying: boolean;
	restoring: boolean;
	modelLabel: string;
	thinkingLevel: string;
	availableThinkingLevels?: string[] | null;
	sessionName?: string;
	/** Named title, else first prompt line. Empty when the thread has neither. */
	sessionLabel?: string;
	sessionFile?: string;
	sessionId?: string;
	statsText: string;
	statusText?: string;
	/** Ordered, enabled composer controls from the brief.composerToolbar setting. */
	composerToolbar?: ComposerToolbarItem[];
	compactThresholdPercent?: number | null;
	compactDefaultPercent?: number | null;
	usageTotal?: number;
	costUsd?: number;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
	modelProvider?: string;
	modelId?: string;
	/** Session id currently being observed read-only, or null when attached normally */
	observingId?: string | null;
	/**
	 * When true, thinking and tool-call arguments paint as they stream.
	 * Default is false: unfinished parts stay behind the working row until they
	 * settle (thinking ends, a tool starts running, or reply text appears).
	 */
	liveTranscript?: boolean;
	/** When true, tool output paints on each partial. Default is false. */
	streamToolOutput?: boolean;
	/** Show the usage-details entry on each reply. Default is off. */
	showUsageDetails?: boolean;
	/** Show the Thought process block. Default is hidden. */
	showThoughtProcess?: boolean;
}

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface RecentSession {
	/** Open tab with no accepted prompt yet. */
	isNew?: boolean;
	/** Session id (jsonl filename stem); used for observe/resume */
	id: string;
	path: string;
	cwd: string;
	timestamp: string;
	/** Filesystem mtime in ms — the true "last activity" signal (renames/forks move it). */
	modifiedMs?: number;
	/** True when the daemon reports this session is actively streaming rn. */
	running?: boolean;
	/**
	 * Roster status, the same three the CLI's agents view names: a session with
	 * no live worker is "inactive", one whose worker is doing something is
	 * "running", and one holding a worker between turns is "idle". `running`
	 * stays for the controls that only care whether there is a run to stop.
	 */
	status?: "running" | "idle" | "inactive";
	/** Exceptional off-nominal state the daemon flags: "queued" | "recovering" | "failed". */
	statusLabel?: string;
	name?: string;
	firstPrompt?: string;
	inWorkspace: boolean;
	/**
	 * Excerpt of the conversation that matched the current search, from the
	 * daemon's `allMessagesText`. Present only on rows a host-side search found
	 * by message body — it is both the evidence for the hit and what makes the
	 * row rank in the webview's own filter, which cannot see the transcript.
	 */
	matchSnippet?: string;
	/**
	 * Rank time for the history list. Frozen while a turn is in flight; only
	 * advances when a response finishes and the agent is waiting for the user.
	 * Mid-turn RPC chatter must not reshuffle the list.
	 */
	sortMs?: number;
	/** Live direct subagents attached to this history session. */
	children?: Array<{ id: string; activeSessionId?: string; name?: string; status: "running" | "idle"; rlmDepth?: number }>;
	/** True when the operator archived this row from Brief (not daemon auto-archive). */
	archived?: boolean;
	/**
	 * A turn finished and the operator has not opened this session since.
	 * History shows this as the green "done" lamp.
	 */
	unreadComplete?: boolean;
}

export type HostToWebview =
	| { type: "statistics"; kind: StatisticsKind; requestId: number; snapshot?: StatisticsSnapshot; error?: string }
	| { type: "attachmentCreated"; sessionId: string; id: string; error?: string }
	| { type: "setHistoryMode"; enabled: boolean }
	| { type: "setViewMoving"; moving: boolean }
	| { type: "captureViewState"; requestId: string; sessionId: string }
	| { type: "restoreViewState"; requestId: string; sessionId: string; state: ChatViewState }
	| { type: "releaseViewState"; requestId: string; sessionId: string }
	| {
			type: "snapshot";
			readReceipt?: ChatReadReceipt;
			messages: AgentMessage[];
			state: RpcSessionState | null;
			status: StatusSnapshot;
			steerDefault?: "steer" | "followUp";
		}
	| { type: "favorites"; favorites: ModelRef[] }
	| { type: "runningTasks"; tasks: RunningTask[] }
	| { type: "sessionChildren"; children: SessionChild[]; parent?: SessionChild; siblings?: SessionChild[]; viewedActiveSessionId?: string; spawned?: Array<{ activeSessionId: string; browseRef?: string; name?: string; created?: string }> }
	| { type: "installPrompt"; url: string; reason: string }
	| { type: "draft"; text: string }
	| { type: "compactThreshold"; percent: number | null; defaultPercent?: number | null }
	| { type: "event"; event: AgentEvent; readReceipt?: ChatReadReceipt }
	| { type: "status"; status: StatusSnapshot }
	| { type: "models"; models: RpcModel[] }
	| { type: "commands"; commands: RpcSlashCommand[] }
	| { type: "history"; sessions: RecentSession[] }
	| { type: "historySelection"; sessionId?: string }
	| { type: "showHistory" }
	| { type: "requestReadReceipt" }
	| { type: "newThread" }
	| { type: "promptAccepted"; kind: "prompt" | "steer" | "followUp"; clientRequestId?: string; recallText?: string }
	| { type: "promptRejected"; error: string; clientRequestId?: string }
	| {
			type: "notice";
			level: "info" | "warning" | "error";
			text: string;
			/**
			 * Optional one-shot recovery the operator can run from the notice. `id`
			 * is an opaque host-issued capability, like a subagent's `browseRef`:
			 * the webview can only ask the host to run something the host already
			 * decided to offer.
			 */
			action?: { id: string; label: string };
	  }
	| { type: "uiState"; statusText?: string; title?: string }
	| { type: "fileSearchResults"; requestId: number; files: FileSearchItem[]; pending?: boolean }
	| { type: "imagePicked"; requestId: number; images: ImageAttachment[] }
	| { type: "insertSelection"; selection: SelectionAttachment }
	| { type: "insertMention"; path: string }
	| { type: "observedSession"; sessionId: string; messages: AgentMessage[] }
	| { type: "observedEvent"; sessionId: string; event: AgentEvent }
	| { type: "observedClosed"; sessionId: string }
	| { type: "editorText"; text: string }
	| { type: "stashOrRestoreDraft" }
	| { type: "focusComposer" };
