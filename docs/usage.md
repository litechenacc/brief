# Brief usage guide

[Back to README](../README.md) · [繁體中文介紹](../README.zh-TW.md)

## Editor Tabs or Sidebar—your choice

The default location is the **editor area**. Use the Command Palette to choose the layout that suits the task:

| Command | What it does |
| --- | --- |
| `Brief: New Session` | Creates an independent session in the default location. Also available through `+`. 輸入 `/new` 或 `/clear` 則會沿用目前 session 的工作目錄、模型與 thinking level，在新 editor tab 建立空白 session，保留原對話與草稿；不接受參數。 |
| `Brief: Open Chat in Editor Tab` | Opens chat explicitly in the editor area. |
| `Brief: Focus Chat` | Focuses chat using the default location. |
| `Brief: Use Editor` | Moves the current session to an editor tab and remembers the workspace preference. |
| `Brief: Use Sidebar` | Moves the current session to the sidebar and remembers the workspace preference. |
| `Brief: Toggle Chat Location` | Switches the current session between editor and sidebar. |
| `Brief: Switch Session` | Chooses an open session to display in the sidebar. |
| `Brief: Session history` | Reopens a session from this workspace or the full session history without duplicating an already open session. |

Moving a session does not stop its agent or move other editor tabs. The sidebar shows one session at a time; a displaced session remains available in the session menu.

Drafts, attachments, and reading position transfer when moving between editor and sidebar. Finish sending, image processing, or input method composition before moving. Unsaved drafts, attachments, and scroll position are not guaranteed to survive closing or reloading a view.

### Leave and return

Closing a tab with `×` closes its view; it does **not** cancel the agent's work. Closing VS Code also disconnects the interface rather than terminating Brief's daemon-resident sessions.

Restored editor tabs reconnect using their saved session identity. Use workspace history to reopen a tab you closed or resume a saved conversation.

To cancel the current run, use **`Brief: Stop Agent`** or the stop button in the composer.

This persistence depends on the Prime Agent daemon and its host remaining available. It does not keep computation running through machine shutdown, sleep, or termination of the runtime. Saved conversations can be resumed, but uninterrupted execution is a separate guarantee.

## 本地統計查詢

輸入不帶參數的 `/usage`、`/context` 或 `/session`，會在對話區開啟 Brief 本地統計卡片，不呼叫模型或觸發 compact。

- `/usage`：runtime 回報目前分支保留訊息的累積 tokens 與費用（USD）。壓縮後不保證包含壓縮前累計，不是完整歷史費用或供應商最終帳單。
- `/context`：runtime 估計的目前 context 已用 tokens、容量與比例，不是累積用量；壓縮後尚無有效回覆時可能未提供估計值。
- `/session`：目前 session 的識別、設定、執行／唯讀狀態與訊息統計。

卡片是有查詢時間的快照，可重新整理、複製或關閉；相同指令更新既有卡片，不自動刷新。執行中數值可能仍在增加，缺值標示為未提供。查詢失敗會明確提示；若保留舊快照，會標示過期。

查詢保留草稿與附件，執行中或唯讀觀察模式也可使用，但不會為查詢啟動 agent。輸入區停用時，使用 Usage／Context／Session 本地查詢按鈕。卡片不屬於模型對話，不納入 `/copy` 或 Markdown 匯出；切換 session 或重載 view 後不保留。第一版不提供子代理彙總、context tree 或跨 session 帳單。

## Faster feedback, quieter conversations

This fork focuses on how chat feels during real coding work, not only on rendering the final answer.

- **Immediate feedback.** Sending a prompt shows the working indicator immediately. New Session opens the empty composer while the worker starts, with sending disabled until the new session is ready.
- **Refined animation.** Animated working indicators, cycling activity text, and elapsed time make ongoing work visible between replies and tool calls.
- **Less visual noise.** Unfinished thinking, tool arguments, and reply text stay behind the working row by default; the reply lands complete when the message ends. Live transcript rendering, tool-output streaming, thought-process blocks, and usage details are separately configurable.
- **History and activity indicators.** Red means work is running, including active subagents. Green means this VS Code window observed a new completion that you have not viewed. Successfully displaying the conversation clears green without affecting red; a completion in the foreground does not leave a notification. Starting the next run also clears old notifications. Other states show no light. A new installation, new window, or window reload establishes a history baseline without issuing notifications for past completions. Notifications synchronize across tabs and Sidebar in the same window, but do not persist across windows. Disconnections and unknown activity are shown as text, not inferred as completion.
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

## Pasting long text and images

Pasted text longer than 10 lines or 1,000 characters becomes a text attachment. Short text stays in the composer. Text and images appear as placeholders at the insertion point, with attachment cards above. Click a card, or Ctrl-click a placeholder (Cmd-click on macOS), to open its temporary text file or image preview in VS Code.

- Edit text directly in VS Code. If a referenced text attachment has unsaved changes, Brief asks whether to save those attachments and send. Cancelling or a save failure prevents sending.
- Sending reads the latest file contents. Text expands at its placeholder position; images use the image-attachment path. The agent receives content, not just a temporary file path.
- Removing a placeholder or card detaches the content; Undo can restore it. Detaching does not immediately delete the temporary file.
- Attachment files live in a Brief-specific directory under the platform's temporary directory. The system may remove them; they are not permanent storage. Save important content into your workspace.
- Moving between Editor Tabs and Sidebar, and `/stash`, preserve attachment structure. Image attachments and cards are not guaranteed to recover across restarts; text drafts can recover as expanded plain text.
- Image placeholders indicate placement, but the runtime receives text and images as separate arrays. Interleaved text/image content blocks are not guaranteed.

## Install

For normal use, download the VSIX from [GitHub Releases](https://github.com/litechenacc/brief/releases) and install it through VS Code's **Extensions → … → Install from VSIX…** menu. See [Install and start](../README.md#install-and-start) for runtime requirements and setup. Build tools and `just` are only needed for development or forks.

## Settings

Settings use the `brief.*` namespace. All commands appear under **Brief** in the Command Palette.

| Setting | Default | Purpose |
| --- | --- | --- |
| `brief.chatLocation` | `editor` | Default location for new sessions and Focus Chat: `editor` or `sidebar`. |
| `brief.command` | `prime-agent` | Runtime command or absolute executable path. |
| `brief.defaultStreamingBehavior` | `steer` | Delivery of messages sent during a run: `steer` or `followUp`. |
| `brief.liveTranscript` | `false` | Render the reply while it streams: prose, thinking, and tool-call arguments. Off means the reply lands complete. |
| `brief.streamToolOutput` | `false` | Render tool output before the tool finishes. |
| `brief.showThoughtProcess` | `false` | Show thought-process blocks; does not change the model's thinking level. |
| `brief.showUsageDetails` | `false` | Show per-reply usage details. |
| `brief.maxFileSearchResults` | `40` | Maximum results for `@` file search. |
| `brief.sendSelectionSnippet` | `true` | Include selected code when adding a selection to chat. |

## Development and forks

Clone this repository or your fork and work from its root. Source builds require **Node.js 22 or newer**, npm, and the `code` command on `PATH`. To run Brief, also install and configure Prime Agent as described in the [installation instructions](../README.md#install-and-start).

### Build and install your version

```sh
npm ci
npm run package
code --install-extension "brief-$(node -p "require('./package.json').version").vsix" --force
```

Use the filename matching the version in `package.json` if you change it. Run **Developer: Reload Window**, then **Brief: New Session**.

With [just](https://github.com/casey/just) and Python 3 installed:

- `just package` builds the VSIX and checks its contents.
- `just install` builds, uninstalls the existing `litechenacc.brief` extension, and installs your local build.
- `just uninstall` removes the installed Brief extension and its local extension directories.

These are developer workflows, not prerequisites for installing a release.

### Validate changes

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


## GitHub releases

Releases publish only to `litechenacc/brief` on GitHub. No Azure or Marketplace token is used. Install Python 3 and GitHub CLI (`gh`), then authenticate with `gh auth login`. Release from a clean `main` branch already pushed to `origin`. Node.js and npm build dependencies are required for packaging. Release does not run tests or typecheck, and does not require Playwright or a running Prime Agent. Run development checks separately before deciding to release.

Write release notes under `[Unreleased]` in `CHANGELOG.md`, commit your changes, and push `main`. Then choose explicitly:

```sh
./release.sh patch          # 0.3.2 -> 0.3.3
./release.sh minor          # 0.3.2 -> 0.4.0
./release.sh major          # 0.3.2 -> 1.0.0
./release.sh patch --dry-run
```

`--dry-run` only checks prerequisites and prints the plan. It does not run tests, build, edit files, or publish. Normal execution asks for confirmation; `--yes` confirms the plan for non-interactive use.

The script updates package versions and the changelog, builds and validates the VSIX, then creates the release commit, tag, and GitHub Release. Tests and typecheck are not part of this workflow. Unknown packaged files stop publication. A failed build leaves local edits for inspection rather than deleting them.

For a version already bumped and committed, provide its matching changelog section and use:

```sh
./release.sh --current
```

This does not bump or create an empty commit. It can resume an interrupted publication only when existing tags point to the current commit. An existing VSIX is checked against the rebuilt archive contents and never overwritten with different content. After a failure, inspect `git status`; do not blindly run another bump. If version changes remain uncommitted, review and commit them, push `main`, then use `--current`.
