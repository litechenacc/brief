# Brief — Proof of Concept PRD

**Status:** Proof of Concept
**Working repository name:** `brief`

## 1. Product thesis

Brief is a file-native collaboration layer on top of an existing agent harness.

The primary interaction model is not:

> Human and agent repeatedly talk in a chat window, accumulate a long transcript, then ask the agent to reconstruct the useful result into documentation or a handoff.

Instead:

> Human and agent work around a living document. Discussion exists to improve that document. Decisions, architecture, constraints, unresolved questions, and task context become durable artifacts as the work progresses.

The existing harness remains responsible for:

* model/provider integration
* agent loop
* tools
* RLM/subagents
* session persistence
* prompt caching
* authentication
* model switching

Brief initially owns only:

* VS Code interaction
* Prime Agent session control
* Markdown projection and parsing
* mapping document edits to agent turns
* mapping agent turns back into the document
* later, handoff/task generation

The POC should determine whether this interaction model is sufficiently better than a normal chat frontend to justify deeper integration.

---

# 2. Problem

Current coding-agent interfaces are optimized around conversation.

A long architecture discussion usually develops like:

```text
initial prompt
→ agent explanation
→ human correction
→ agent revision
→ inspect code
→ human changes requirement
→ more discussion
→ architecture converges
→ ask agent to summarize
→ create design document
→ create implementation task
→ start another session
```

Three problems appear.

### 2.1 The durable artifact is produced too late

The conversation contains the actual design work, while the document is often reconstructed afterward.

This reverses the desired ownership model.

The design document should be continuously improved during the discussion, rather than generated from the meeting transcript after the discussion finishes.

### 2.2 Conversation history and project state diverge

After enough rounds:

```text
conversation history
≠
current architecture
≠
current source tree
≠
implementation task context
```

A new agent therefore needs either:

* a large old transcript, or
* a lossy summary/handoff generated from that transcript.

### 2.3 Chat is a weak editing interface

Architecture work frequently requires:

* rewriting an existing paragraph
* inserting a concern beside a specific design claim
* comparing two alternatives
* moving sections
* editing exact terminology
* reviewing the whole design spatially
* searching existing decisions
* writing a task while reading code

VS Code and Markdown already provide a substantially better interface for these operations than chat bubbles.

---

# 3. Product model

Brief treats the existing agent harness as a runtime.

```text
                    VS Code
                       │
                 Brief extension
                       │
          ┌────────────┴────────────┐
          │                         │
      session.md               project files
          │                         │
          │                    architecture/
          │                    tasks/
          │
          ▼
    Prime RPC adapter
          │
          ▼
      Prime Agent
          │
          ├── tools
          ├── RLM
          ├── models
          └── native session history
```

The first implementation targets Prime Agent only.

The architecture should avoid making Prime-specific assumptions in the Markdown layer so another harness can be added later.

---

# 4. Core design principle

## Markdown is the human interface. Harness history is the execution history.

`session.md` should not initially replace Prime's native session storage.

Prime remains the canonical source for:

* actual user/assistant turns
* tool calls
* runtime state
* model state
* session lineage

Brief projects selected parts of that state into Markdown and accepts human edits from Markdown.

This avoids creating a second agent runtime.

It also avoids requiring Brief to recreate:

* message persistence
* streaming
* cancellation
* model selection
* tool handling
* subagent management

For Prime integration, prefer RPC APIs such as message/session retrieval over directly depending on Prime's internal JSONL format. JSONL can remain a debug/fallback source.

---

# 5. Prompt-cache constraint

The model-visible history should remain append-only whenever possible.

The UI may allow the human to insert a question anywhere in `session.md`, but Brief should normally convert that edit into a new user turn at the end of the Prime session.

Example visual document:

```markdown
### Agent · Buffer ownership

Moving pair ownership into the scheduler simplifies downstream state.

### Human

If reset occurs after LEF but before SEF, what state guarantees that
the stale LEF cannot survive?

### Agent

...

### Human · inserted later

I want to revisit the first assumption. What if downstream backpressure
can last for an entire frame?
```

The final prompt may visually appear beside an earlier discussion.

Its runtime representation is still:

```text
previous immutable history
+
new human message:
  target = earlier buffer-ownership discussion
  question = ...
```

Brief must not rewrite old Prime messages merely because the Markdown representation was reorganized.

This preserves prefix stability and allows the underlying harness/provider to retain its normal prompt-cache behavior.

---

# 6. POC scope

The proof of concept contains three sequential milestones.

```text
POC 1
VS Code ↔ Prime

        ↓

POC 2
Markdown structure + parser

        ↓

POC 3
Markdown-native conversation
```

Each stage must work independently before moving to the next.

Task management, worktree orchestration, merge review, multi-agent visualization, and automatic handoff are intentionally excluded from the initial POC.

---

# 7. POC 1 — VS Code Prime interface

## Goal

Demonstrate that VS Code can act as a usable frontend for a real Prime Agent session, locally and through VS Code Remote SSH.

No Markdown conversation behavior is required yet.

## User experience

Add a Brief icon to the VS Code Activity Bar.

The side panel contains a minimal Prime interface:

```text
BRIEF

Session
────────────────────
architecture-main
GPT-5.6 Sol · High
● idle

Conversation
────────────────────
Human
Investigate the scheduler ownership...

Agent
I'll inspect...

[tool activity...]

Agent
The current scheduler...

────────────────────
[ prompt input                    ]
[ Send ] [ Stop ]
```

The interface is intentionally simple.

It is not intended to outperform Prime TUI as a general-purpose agent UI.

Its purpose is to prove that VS Code can host the runtime interaction needed by later Markdown workflows.

## Required capabilities

The extension must be able to:

* detect whether `prime-agent` is available
* start Prime Agent in RPC mode
* send a prompt
* stream or incrementally display agent activity
* display the final assistant response
* retrieve current session state
* retrieve session messages
* abort a running turn
* create a fresh session
* reconnect/reload the VS Code view without corrupting the session
* display basic errors from the Prime process

Optional for POC 1:

* model selector
* thinking-level selector
* switch existing Prime session
* steer active turn
* queue follow-up
* RLM child status

## Remote SSH requirement

The same extension must operate while VS Code is connected through Remote SSH.

Preferred architecture:

```text
Local VS Code UI
        │
        │ VS Code internal transport
        ▼
Remote Extension Host
        │
        ├── workspace filesystem
        │
        └── spawn prime-agent --mode rpc
                         │
                         ▼
                    Prime Agent
```

Brief must not implement a second SSH connection solely for Prime.

When the workspace is remote, the workspace extension and Prime process should execute on that same remote host.

## POC 1 success criteria

POC 1 passes when all of these work:

1. Open a local repo in VS Code.
2. Start Prime from Brief.
3. Have a multi-turn conversation.
4. Stop/restart the Brief view without losing access to the session.
5. Open a repo through VS Code Remote SSH.
6. Repeat the same workflow with Prime installed only on the remote machine.
7. Confirm that file/tool activity occurs against the remote workspace.

The UI only needs to be pleasant enough to use for the later experiments.

---

# 8. POC 2 — Markdown structure and parser

## Goal

Design a Markdown format that can contain:

* current persistent working artifact
* discussion history
* human prompts
* references between a prompt and an earlier statement
* enough metadata for reliable parsing

without turning Markdown into an unreadable serialization format.

## Initial document model

```markdown
---
brief-version: 1
session: <prime-session-id>
---

# Session: DOL2 Architecture

## Working State

### Current design

LEF/SEF pair construction is owned by the scheduler.

### Accepted constraints

- Merge consumes complete exposure pairs.
- Reset discards incomplete pairs.

### Open questions

- Required FIFO overflow behavior remains undecided.

## Discussion

<!-- brief:turn id=a17 role=assistant -->
### Agent

Moving pair construction upstream removes...

<!-- brief:turn id=h18 role=human target=a17 -->
### Human

What happens if reset arrives after LEF but before SEF?

<!-- brief:turn id=a19 role=assistant -->
### Agent

...

## Pending

<!-- brief:prompt target=a17 -->
I want to revisit this assumption under long downstream backpressure.
<!-- /brief:prompt -->
```

The exact syntax is intentionally provisional.

## Structural requirements

The format should remain:

* valid ordinary Markdown
* readable without Brief installed
* easy to edit with Vim/VS Code commands
* stable under normal Markdown formatting
* minimally polluted with machine metadata
* parseable without relying on line numbers

Durable references should prefer:

```text
document
+ heading
+ stable turn/block ID
```

rather than:

```text
line 183
```

Line ranges may be used transiently but should not be persistent identity.

## Working State semantics

`Working State` is mutable.

The human and eventually the agent may rewrite it.

It contains the current result of the collaboration, not the history of how that result was reached.

Examples:

* current architecture
* accepted constraints
* unresolved decisions
* terminology
* interface definitions
* current task context

## Discussion semantics

`Discussion` represents historical reasoning.

For the POC it should be generated from Prime session messages and should normally be append-only.

The human should not need to preserve every tool call.

Initial projection should include:

* human text
* assistant text

Tool calls can be represented as compact metadata or omitted.

## Pending semantics

`Pending` contains new human input that has not yet been submitted to Prime.

The user may:

* add a prompt at the end
* associate it with an earlier turn
* potentially place it visually close to the relevant section

After successful submission, Brief should mark or transform the block so it is not submitted twice.

## Parser POC tests

The parser must correctly handle:

* multiple prompts
* prompts referring to earlier turns
* headings moved within the document
* edits to Working State
* normal Markdown lists/code blocks
* malformed/incomplete prompt blocks
* document save while Prime is running
* repeated save without duplicate submission

---

# 9. POC 3 — Markdown-native conversation

## Goal

Prove that a useful multi-round architecture discussion can happen primarily through editing `session.md`, without requiring the normal chat interface.

## Target workflow

### Step 1 — Create session

User opens:

```text
docs/architecture/session.md
```

and invokes:

```text
Brief: Start Session
```

The extension starts or attaches to a Prime session.

### Step 2 — Initial prompt

The initial architecture context is sent to Prime once.

Prime responds normally through its existing runtime.

Brief writes the useful assistant response into the Discussion section.

The user does not need to interact with the side-panel chat.

### Step 3 — Human review

The user reads the response as Markdown alongside the source code.

The user can:

* edit Working State directly
* write a new prompt
* attach a prompt to a previous discussion point
* continue writing elsewhere before submitting

### Step 4 — Submit Markdown changes

On explicit command:

```text
Brief: Send Pending
```

the extension calculates:

```text
new pending prompts
+
relevant Working State diff
+
references to targeted earlier turns
```

and converts them into the next Prime user turn.

The extension must not resend the entire `session.md` by default.

### Step 5 — Agent turn

Prime performs a normal turn.

It may:

* inspect repository files
* use tools
* use RLM
* reason over earlier context

Brief receives the result and updates the Markdown Discussion projection.

### Step 6 — Continue

The user remains in the Markdown editor and repeats:

```text
read
→ edit artifact
→ insert direction/question
→ send
→ review result
```

No chat window is required for the normal path.

---

# 10. Two response-mode experiments

POC 3 should compare two modes rather than committing early.

## Mode A — Projected conversation

Prime responds normally.

Brief projects assistant responses into `session.md`.

```text
Prime assistant response
        ↓
RPC
        ↓
Brief
        ↓
Discussion section
```

Advantages:

* minimal modification to Prime
* normal Prime history
* no additional edit-tool call
* easier prompt-cache behavior
* clean separation between runtime and UI

This is the default POC implementation.

## Mode B — Agent edits document directly

Prime is instructed that the document is the primary collaboration artifact.

Instead of producing a substantial chat response, the agent modifies:

* Working State
* design sections
* optional Discussion notes

and returns only a minimal runtime completion message.

Example:

```text
Human prompt
    ↓
Prime
    ↓
edit session.md / architecture.md
    ↓
turn completes
```

This mode more strongly matches the intended long-term interaction model:

> superior gives direction; subordinate updates the working material.

But it may introduce:

* extra edit tool usage
* document race conditions
* noisier tool history
* accidental structural damage
* more complex human/agent ownership rules

The POC should determine whether its UX benefit justifies those costs.

---

# 11. Markdown edit → model context policy

The extension should classify Markdown changes.

### Type A — New human prompt

Send the new prompt as a new user turn.

### Type B — Working State edit

Send a compact diff describing the change.

Example:

```diff
- Merge owns exposure alignment.
+ Scheduler owns pair construction and exposure alignment.
```

Do not resend the full Working State unless required.

### Type C — Discussion reformatting

Do not send to the model.

Whitespace changes, moved rendered history, heading formatting, or other presentation edits should not mutate Prime history.

### Type D — Prompt anchored to historical discussion

Append a new user turn containing:

```text
Reference:
turn a17

Original statement:
<minimal necessary quoted/context text>

Human:
<new prompt>
```

The old history remains unchanged.

### Type E — Large semantic rewrite

If the user rewrites enough Working State that a diff becomes ambiguous, allow:

```text
Brief: Sync Section
```

to explicitly send the complete current section.

This should be exceptional rather than automatic.

---

# 12. Prompt-cache experiment

The POC should measure whether the Markdown workflow preserves or improves inference efficiency.

Compare three workflows on the same architecture discussion.

## Baseline

Normal Prime conversation.

## Brief targeted-sync mode

Prime history remains append-only.

Each round sends only:

* new human prompt
* changed Working State diff
* minimal anchor context

## Full-document mode

Each round resends the current `session.md`.

This exists only as a control experiment.

Collect where available:

* total input tokens
* cached input tokens
* uncached input tokens
* output tokens
* number of turns
* latency to first token
* total turn latency

Expected result:

```text
normal chat
≈
Brief targeted-sync

and both should be materially better than

full session.md resend
```

Brief is successful if the improved editing model does not require significant additional uncached context.

---

# 13. Handoff hypothesis

Automatic handoff is not required for the initial POC, but the document structure should support it.

A later command may perform:

```text
Brief: Handoff
```

and produce:

```markdown
# Handoff

## Current architecture

...

## Accepted decisions

...

## Open questions

...

## Current repository state

...

## Next objective

...
```

The next agent should consume this artifact rather than the full previous conversation.

Likewise an implementation task may be derived from the same live architecture:

```text
architecture session
      ↓
accepted design
      ↓
tasks/014-scheduler.md
      ↓
fresh task-master session
      ↓
RLM / implementation
```

The important property is that the implementation agent receives the current artifact, not a reconstructed transcript summary.

---

# 14. Side panel role after POC 3

If the Markdown experiment succeeds, the Brief side panel becomes operational rather than conversational.

Possible final shape:

```text
BRIEF

Architecture Session
────────────────────
● Prime connected
GPT-5.6 Sol · High
context 42%

Pending
2 prompts

Agent
● working
  ├─ inspect scheduler
  └─ RLM research

Actions
[ Send Pending ]
[ Stop ]
[ New Session ]
[ Handoff ]

Recent
✓ response written to session.md
```

The Markdown editor becomes the main reasoning interface.

The panel exists for:

* runtime status
* model/session controls
* pending prompt state
* errors
* cancellation
* optional subagent status

It should not duplicate the full conversation unless needed for debugging.

---

# 15. Explicit non-goals for POC

Do not build:

* custom LLM provider integrations
* a replacement for Prime RLM
* a custom agent loop
* worktree management
* Git review UI
* pull request management
* generic task/project management
* multi-repo orchestration
* multi-harness support
* rich graphical architecture editing
* automatic compaction
* a complete Markdown CRDT
* simultaneous human/agent editing

VS Code and Prime already solve most surrounding problems.

The POC should remain a thin integration layer.

---

# 16. Proposed implementation boundary

```text
brief/
├─ src/
│  ├─ extension.ts
│  ├─ rpc-client.ts
│  └─ session-controller.ts
├─ webview/
├─ media/
├─ markdown/                 # POC 2
│  ├─ parser.ts
│  ├─ projection.ts
│  ├─ diff.ts
│  └─ anchors.ts
├─ fixtures/
│  └─ session-examples/
├─ docs/
│  └─ runtime-boundary.md
└─ package.json
```

Avoid copying Prime runtime code into Brief.

The Prime integration should sit behind a small interface so the Markdown experiment is not coupled directly to RPC details.

Conceptually:

```typescript
interface AgentSession {
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;

  getState(): Promise<SessionState>;
  getMessages(): Promise<Message[]>;

  subscribe(listener: AgentEventListener): Disposable;
}
```

Prime RPC implements this interface.

A future ACP or other-harness adapter may implement the same boundary.

---

# 17. POC completion criteria

The POC is successful when a real architecture discussion can be completed with this workflow:

```text
open remote repo through VS Code SSH
        ↓
open session.md
        ↓
start Prime session
        ↓
read agent reasoning in Markdown
        ↓
edit persistent architecture
        ↓
insert human direction/question
        ↓
send from Markdown
        ↓
Prime inspects repo / reasons / uses tools
        ↓
new result appears in Markdown
        ↓
repeat for several rounds
```

and all of the following are true:

1. The user does not need Prime TUI for the normal flow.
2. The user does not need the Brief chat side panel for normal multi-round discussion.
3. Markdown remains readable as a normal engineering document.
4. Old runtime conversation history is not rewritten when the Markdown UI changes.
5. Human edits can be converted into precise new Prime turns.
6. VS Code Remote SSH works without a custom network layer.
7. A fresh session can later consume the resulting working artifact without reading the full prior transcript.
8. Token/cache measurements show no major regression compared with normal Prime conversation.

If these conditions hold, the next phase should focus on handoff/task generation and integration with the worktree-based implementation workflow.

# 18. Main POC question

The project should answer one question before growing:

> Is a live editable engineering document a better primary interface for long-running human-agent design work than a chat transcript, while retaining the efficiency and capabilities of an existing agent harness?

If the answer is yes, Brief should remain a thin harness-on-harness layer rather than evolving into another full coding-agent platform.
