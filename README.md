# Brief

**A fork built specifically for Prime Agent + VS Code. One workspace, multiple parallel sessions, and a chat layout that fits the way you code.**

Brief is an independent fork of [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode), powered by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent). It keeps the upstream foundation and builds on it with daemon-backed sessions, native editor tabs, sidebar support, and extensive interaction and reliability fixes.

**Version 0.3.0 marks a milestone for conversation-based work inside VS Code:** managing parallel agent conversations, leaving and returning to ongoing work, and moving between code and chat are now the core Brief experience.

> **Community project.** Brief is not published by, endorsed by, or affiliated with Prime Intellect. Prime Agent names the runtime that Brief uses.

## Built for one workspace, many sessions

Run separate conversations for implementation, investigation, review, or tests without opening a VS Code window for each task.

- **Independent sessions.** Each new session runs in its own daemon-resident worker. Starting another conversation does not replace the one already working.
- **Multiple editor tabs.** Keep one session per native VS Code tab. Drag tabs into different editor groups to compare conversations or work beside your code.
- **A code-first sidebar.** Keep the editor area for source files and use Brief in the sidebar. Switch between sessions without stopping their work.
- **Close the view, not the work.** Close a session tab, reload the window, or quit VS Code while the agent continues in the Prime Agent daemon. Reopen the workspace and return to the session later.
- **Workspace session history.** Reopen, rename, and archive conversations, with activity status and subagent visibility.

Sessions share the workspace files; they are not isolated checkouts. Coordinate parallel edits when agents work on the same files.

## Editor tabs or sidebar—your choice

The default location is the **editor area**. Use the Command Palette to choose the layout that suits the task:

| Command | What it does |
| --- | --- |
| `Brief: New Session` | Creates an independent session in the default location. Also available through `+` or `/new`. |
| `Brief: Open Chat in Editor Tab` | Opens chat explicitly in the editor area. |
| `Brief: Focus Chat` | Focuses chat using the default location. |
| `Brief: Use Editor` | Moves the current session to an editor tab and remembers the workspace preference. |
| `Brief: Use Sidebar` | Moves the current session to the sidebar and remembers the workspace preference. |
| `Brief: Toggle Chat Location` | Switches the current session between editor and sidebar. |
| `Brief: Switch Session` | Chooses an open session to display in the sidebar. |
| `Brief: Sessions in this workspace` | Reopens a session from workspace history without duplicating an already open session. |

Moving a session does not stop its agent or move other editor tabs. The sidebar shows one session at a time; a displaced session remains available in the session menu.

Drafts, attachments, and reading position transfer when moving between editor and sidebar. Finish sending, image processing, or input method composition before moving. Unsaved drafts, attachments, and scroll position are not guaranteed to survive closing or reloading a view.

### Leave and return

Closing a tab with `×` closes its view; it does **not** cancel the agent's work. Closing VS Code also disconnects the interface rather than terminating Brief's daemon-resident sessions.

Restored editor tabs reconnect using their saved session identity. Use workspace history to reopen a tab you closed or resume a saved conversation.

To cancel the current run, use **`Brief: Stop Agent`** or the stop button in the composer.

This persistence depends on the Prime Agent daemon and its host remaining available. It does not keep computation running through machine shutdown, sleep, or termination of the runtime. Saved conversations can be resumed, but uninterrupted execution is a separate guarantee.

## Faster feedback, quieter conversations

This fork focuses on how chat feels during real coding work, not only on rendering the final answer.

- **Immediate feedback.** Sending a prompt shows the working indicator immediately. New Session opens the empty composer while the worker starts, with sending disabled until the new session is ready.
- **Refined animation.** Animated working indicators, cycling activity text, and elapsed time make ongoing work visible between replies and tool calls.
- **Less visual noise.** Unfinished thinking and tool arguments stay behind the working row by default. Live transcript rendering, tool-output streaming, thought-process blocks, and usage details are separately configurable.
- **History 與燈號。** 紅燈表示仍有工作執行中，綠燈表示有未讀完成通知，灰燈表示沒有未讀通知。開啟 session 不會強制清除執行中的紅燈。只有對話成功呈現且視窗取得焦點後才確認已讀；背景分頁完成、清單刷新與連線中斷都不會自動清除未讀。`Mark unread` 可手動保留提醒，並立即同步其他分頁。
- **Stable reading.** Transcript updates, scrolling, and view handoff are designed to keep you oriented while work continues.
- **Native visual integration.** Chat colors follow the VS Code Color Theme, including High Contrast. Brief has its own app, activity-bar, and tab branding.

These improvements target interface response and rendering; model generation speed still depends on your provider and runtime.

## Coding conversation tools

- Add selected code or the active file through the editor context menu. Context goes to the most recently used chat session.
- Mention workspace files with `@`, attach images, and open session file links or native image previews.
- Read formatted replies and tool cards, including syntax-highlighted Python cells.
- Follow subagent activity and browse related conversations from the subagent strip.
- Send steering messages or queue follow-ups while the agent works, with pending inputs shown separately from the transcript.
- Inspect context usage, compact context, and export conversations as Markdown.

The fork also includes fixes for session routing and reconnection, duplicate reply rendering, history actions, image handling, and input method composition. The focus is the existing chat workflow—not a replacement for the Prime Agent runtime.

## Install

### Requirements

- VS Code **1.90 or newer**, with a trusted, local-filesystem workspace.
- A working [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) installation and configured provider access.
- For building from source: **Node.js 22 or newer**, npm, and the `code` command on `PATH`.

Install Prime Agent first:

```sh
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Complete Prime Agent's setup and confirm that `prime-agent` works in your environment.

### Build and install Brief

From this repository:

```sh
npm ci
npm run package
code --install-extension brief-0.3.0.vsix --force
```

Or, with [just](https://github.com/casey/just) and Python 3 available:

```sh
just install
```

This packages and installs `litechenacc.brief`. Run **Developer: Reload Window**, then **Brief: New Session**.

If VS Code cannot find the runtime, set `brief.command` to the absolute path of `prime-agent`.

## Settings

Settings use the `brief.*` namespace. All commands appear under **Brief** in the Command Palette.

| Setting | Default | Purpose |
| --- | --- | --- |
| `brief.chatLocation` | `editor` | Default location for new sessions and Focus Chat: `editor` or `sidebar`. |
| `brief.command` | `prime-agent` | Runtime command or absolute executable path. |
| `brief.defaultStreamingBehavior` | `steer` | Delivery of messages sent during a run: `steer` or `followUp`. |
| `brief.liveTranscript` | `false` | Render thinking and tool-call arguments while they stream. |
| `brief.streamToolOutput` | `false` | Render tool output before the tool finishes. |
| `brief.showThoughtProcess` | `false` | Show thought-process blocks; does not change the model's thinking level. |
| `brief.showUsageDetails` | `false` | Show per-reply usage details. |
| `brief.maxFileSearchResults` | `40` | Maximum results for `@` file search. |
| `brief.sendSelectionSnippet` | `true` | Include selected code when adding a selection to chat. |

## Development

```sh
npm ci
npx playwright install chromium
npm run compile
npm run typecheck
npm test
npm run package
```

`npm test` includes Chromium layout and animation tests. Install the browser before running the suite.

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Use `npm run watch` for rebuilds while developing. `npm run test:live` runs integration checks that require a working Prime Agent environment.

## Credits and license

Brief exists because of [sirouk's original extension](https://github.com/sirouk/prime-agent-vscode). Thank you for building and sharing a working VS Code frontend for Prime Agent.

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) provides the agent runtime. Brief focuses on the VS Code conversation experience around it.

**MIT** — see [LICENSE](LICENSE) for the original copyright and license terms. Prime Agent is a Prime Intellect trademark and is named only to identify the runtime this extension uses.
