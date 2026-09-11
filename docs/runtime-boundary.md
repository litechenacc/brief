# Brief runtime boundary

Status: proposed for POC 1.
Source of evidence: `prime-agent-vscode` fork of `sirouk/prime-agent-vscode`
(`src/rpc-client.ts`, `src/protocol.ts`, `src/session-controller.ts`,
`src/agent-locator.ts`).

## 1. Decision

Brief talks to Prime only through a small `AgentSession` interface.

Prime remains canonical for turns, tools, model state, and session lineage.
Brief does not read JSONL as the primary API. JSONL is debug/fallback only.

The existing VS Code extension is a **reference implementation of the
transport**, not Brief's product surface.

Reuse from the fork:

* `RpcClient` (stdio JSONL, no vscode)
* RPC type subset in `protocol.ts` (`AgentEvent`, `AgentMessage`,
  `RpcSessionState`, `Usage`)
* `locateAgent` (GUI PATH / Remote SSH)
* spawn policy: workspace cwd, Remote Extension Host, no second SSH

Do not reuse as Brief's core:

* chat webview / composer
* thread diffs, process panel, background-jobs UI
* history search, favorites, export HTML
* daemon sidecar attach/observe/subagent browsing

Those stay optional debug adapters. Markdown code must not import them.

## 2. Why SessionController is not the boundary

`SessionController` is a VS Code window product: webview sinks, daemon
attach, observe, roster, drafts, diffs, jobs.

It already mixes two transports:

1. Owned RPC child: `prime-agent --mode rpc` via `RpcClient`
2. Daemon sidecar: attach to a session already live in a TUI

POC 1 only needs (1).

Daemon attach is valuable later (same session as an existing TUI) but it
is not required to answer the Markdown-vs-chat question. Keep it behind
the same interface, not inside Markdown code.

`prompt()` in the fork also encodes chat-only policy:

* `PromptPayload.sessionId` stamp so a stale composer cannot post
  into another thread
* `streamingBehavior`: `steer` vs `followUp`
* image / selection attachments

Brief Markdown submission is a different policy (pending prompts +
Working State diff). Put that policy above `AgentSession`, not inside it.

## 3. Interface

TypeScript shape. Implementation may wrap `RpcClient` directly.

```ts
export type SessionId = string;

export interface SessionState {
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  modelLabel?: string;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  reachable: boolean;
  messageCount?: number;
}

export type AgentMessage =
  | { role: "user"; content: string | unknown[]; timestamp?: number }
  | {
      role: "assistant";
      content: unknown[];
      model?: string;
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
      };
      timestamp?: number;
    }
  | { role: "toolResult"; toolCallId: string; toolName: string; isError?: boolean }
  | { role: string; [k: string]: unknown };

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: string; [k: string]: unknown };

export interface PromptInput {
  text: string;
  /**
   * Only used when a turn is already running.
   * Markdown Send Pending should normally wait for idle, then `prompt`.
   * Do not steer from a document save.
   */
  whenStreaming?: "reject" | "followUp" | "steer";
}

export interface AgentSession extends Disposable {
  readonly workspaceRoot: string;

  start(): Promise<void>;
  stop(): void;

  prompt(input: PromptInput): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;

  getState(): Promise<SessionState>;
  getMessages(): Promise<AgentMessage[]>;

  subscribe(listener: (event: AgentEvent) => void): Disposable;
}
```

Optional later, still on this interface, not in Markdown:

* `setModel` / `setThinkingLevel`
* `switchSession(sessionId)`
* `getStats()` for the prompt-cache experiment (input / cacheRead / output)

## 4. Mapping onto Prime RPC

Owned-process transport (`RpcClient`):

| AgentSession | RPC |
|---|---|
| `start` | locate CLI, spawn `--mode rpc`, cwd = workspace |
| `prompt` | `{ type: "prompt", message }` |
| idle + follow-up | same `prompt` (append-only user turn) |
| streaming + `followUp` | `{ type: "prompt", streamingBehavior: "followUp" }` |
| streaming + `steer` | `{ type: "prompt", streamingBehavior: "steer" }` |
| `abort` | `{ type: "abort" }` |
| `newSession` | `{ type: "new_session" }` |
| `getState` | `{ type: "get_state" }` → `RpcSessionState` |
| `getMessages` | `{ type: "get_messages" }` → `{ messages }` |
| `subscribe` | stdout events that are not `response` |

Reachability rule, copied from the fork:

> A process object is not a session. Connected means a completed RPC
> round-trip (`get_state` / `get_messages`). Spawn-then-silence is an error.

Default Brief policy for `whenStreaming`:

* `Send Pending` while idle → `prompt`
* `Send Pending` while streaming → `reject` (queue in Markdown, do not
  mutate the in-flight turn)
* explicit Stop → `abort`

`steer` is a chat concern. Do not use it for document edits.

## 5. Canonical vs projected data

```text
Prime session (RPC)
  messages[], state, usage
        │  getMessages / events
        ▼
Brief projection
  Discussion (append-only view)
  turn ids

Human Markdown edits
  Working State (local file)
  Pending prompts (local file)
        │  Send Pending
        ▼
new user turn on Prime (append-only)
```

Invariants:

1. Never rewrite a past Prime message because Markdown moved.
2. Never send the whole `session.md` as the default prompt.
3. `session.md` front matter stores `session: <prime sessionId>`.
4. Turn anchors in Markdown must map to identities we can recover from
   `getMessages()`, not to line numbers.

### Message identity (POC 1 gap)

Upstream `AgentMessage` in the fork has **no stable `id` field**.
Roles are `user` | `assistant` | `toolResult`. Identity today is
ordinal-in-array plus timestamp.

For POC 2 anchors Brief should:

* treat `(sessionId, index, role, timestamp)` as the durable key
  until Prime RPC exposes ids
* write `brief:turn id=<sessionId-short>-<index>` into Markdown
* never invent ids that cannot be recomputed from `getMessages()`

If a later Prime RPC adds message ids, switch the key; keep the
Markdown attribute name.

## 6. Process ownership

```text
VS Code UI (local or remote client)
        │  VS Code transport
        ▼
Extension Host (workspace machine)
        ├── AgentSessionRpc  (Brief)
        └── optional Chat debug view (fork controller, not imported by markdown/)
                │
                ▼
        prime-agent --mode rpc
                cwd = workspace folder
```

Remote SSH: extension host and CLI already share the remote workspace.
Brief must not open its own SSH session.

One workspace window still starts one RPC client so the daemon autostarts.
That RPC session is promoted to a **resident** daemon worker. Additional
Brief "New Session" actions `create` another resident worker and attach;
they must not call RPC `new_session`, which replaces the runtime in the
current worker and aborts a running turn.

Disconnecting RPC (Stop / window close) drops the JSONL client only.
Resident workers keep running. Other `prime-agent` TUI clients can list
and attach to those sessions.

If both a debug chat and Markdown are open, they share one `AgentSession`.

## 7. What Markdown may observe

Subscribe to events, but Discussion projection uses:

* `user` text
* `assistant` text (and optionally thinking, collapsed)
* compact tool summary or omit tools

Ignore for Markdown:

* `extension_ui_request` (VS Code dialogs, not a document)
* process journal / jobs
* thread diffs
* child roster

Status panel (later, after POC 3) may show `isStreaming`, model,
`sessionId`, errors. That panel talks to `AgentSession`, not to
webview protocol types (`HostToWebview`).

## 8. Token / cache experiment hook

`AssistantMessage.usage` already has `input`, `output`, `cacheRead`,
`cacheWrite`, `totalTokens`.

`AgentSession` should pass usage through unchanged. Brief logs per turn:

* workflow: `chat` | `brief-targeted` | `full-document`
* usage fields
* latency if we timestamp `prompt` → `agent_end`

Do not add a second metering path.

## 9. Module split (target tree)

```text
brief/
  src/
    runtime/
      agent-session.ts      # interface only
      rpc-session.ts        # RpcClient wrapper, vscode-free
      locate-agent.ts       # copy or git subtree of agent-locator
      protocol.ts           # RPC subset only
    session-host.ts         # workspace cwd, config, output channel
    status-bar.ts           # optional, POC 1
    markdown/               # empty until POC 2; must import runtime only
  vendor/prime-agent-vscode/  # reference, not compiled into markdown
```

`rpc-session.ts` may be a thin wrapper around vendored `RpcClient`.
It must not subclass `SessionController`.

## 10. POC 1 acceptance for this boundary

Pass when a headless or minimal VS Code host can:

1. `start()` against a local workspace
2. `prompt()` two turns
3. `getMessages()` returns both user and assistant texts
4. `abort()` during a turn
5. `stop()` then `start()` reconnects without creating a second
   canonical history (same process policy as the fork: daemon-backed
   Prime session survives the UI)
6. Remote SSH: same host path, tools write the remote workspace

Chat UI is optional evidence, not the deliverable.

## 11. Explicit non-goals of this boundary

* Markdown parser
* Working State diff
* pending-prompt idempotency
* Mode B (agent edits `session.md`)
* ACP / other harnesses (keep the interface harness-agnostic, do not
  implement a second adapter)
* wrapping daemon attach until POC 1 owned-RPC is boringly reliable
