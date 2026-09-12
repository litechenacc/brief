# Brief

Fork of [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode).

This repository exists because of that work. Thank you to [sirouk](https://github.com/sirouk) for building a usable VS Code frontend on top of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), and for publishing it as a community project.

**Community project.** Brief is independent and is not published by, endorsed by, or affiliated with Prime Intellect. Prime Agent is named only as the CLI that Brief drives.

## What this repo is right now

目前 Brief 支援 VS Code 原生 editor tabs 與 sidebar。每個 session 透過 Prime Agent daemon 獨立執行，顯示回覆、thinking、tool calls 與 subagents。

That is intentional. The fork starts from a working Prime Agent UI instead of rewriting the runtime.

## Where it is going

The product thesis is in [`prd.md`](prd.md). Chat is not the destination.

Brief is meant to become a **file-native collaboration layer** on top of the existing agent harness:

- Human and agent work around a living Markdown document, not a long transcript that is summarized afterwards.
- `session.md` is the human interface. Prime Agent remains the execution history (turns, tools, session state).
- Document edits map to new agent turns without rewriting old harness history, so prompt-cache prefixes stay stable.

POC stages in the PRD:

1. VS Code ↔ Prime (this tree, still mostly origin)
2. Markdown structure + parser
3. Markdown-native conversation

Expect this repository to diverge substantially from [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode) as those stages land. The product UI and package now use the Brief identity throughout.

## Install (current tree)

The extension still talks to a local [`prime-agent` CLI](https://github.com/PrimeIntellect-ai/prime-agent). Install that first:

```sh
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Then from this repo:

```sh
just install
```

That packages a `.vsix` and installs `litechenacc.brief`. Reload the VS Code window afterwards.

From source without `just`:

```sh
npm ci
npm run package
code --install-extension brief-<version>.vsix --force
```

Requires VS Code 1.90+, `node` >= 22, and the `code` CLI on `PATH`.

## 使用 editor tabs 與 sidebar

預設使用原生 editor tabs，每個 session 一個 tab。長標題在 tab 上最多顯示 16 個字元（含 `…`），session 的完整名稱不變。

- `Brief: New Session`、標題列 `+` 或 `/new`：在預設位置建立新 session。
- `Brief: Use Editor`：將目前 session 移到 editor，並記住 editor 為此 workspace 的預設位置。
- `Brief: Use Sidebar`：將目前 session 移到 sidebar，並記住 sidebar 為預設位置。
- `Brief: Toggle Chat Location`：切換目前 session 的位置。
- `Brief: Switch Session`：從已開啟的 sessions 選擇 sidebar 顯示的 session。
- `Brief: Sessions in this workspace`：從歷史重新開啟 session；已開啟的 session 不重複建立。

也可在 Settings 設定 `brief.chatLocation` 為 `editor` 或 `sidebar`，決定新 session 與 `Focus Chat` 的預設位置。位置切換不停止 agent，也不移動其他 editor tabs。Sidebar 一次顯示一個 session，替換後的 session 仍在背景，可從 session 選單找回。

移動會保留草稿、附件與閱讀位置。若正在送出訊息、處理圖片或使用輸入法組字，請等操作完成再切換，避免遺失尚未確認的輸入。關閉 editor tab 的 `×` 只關閉畫面；需要停止工作時，請用 `Brief: Stop Agent` 或輸入框的停止按鈕。

Editor tabs 可拖到不同 editor groups 並排。`Brief: Open Chat in Editor Tab` 明確使用 editor；`Brief: Focus Chat` 使用預設位置。從程式碼執行 `Add Selection to Chat` 或 `Add Active File to Chat`，會送到最近使用的聊天 session。

重新載入 VS Code 時，editor tabs 依各自儲存的 session identity 重新連接。附件與捲動位置只保證在位置切換時移交，不保證跨關閉或重新載入保留。

## Settings and commands

Settings use `brief.*`. Commands are under the **Brief** category in the Command Palette (`Brief: Focus Chat`, `New Session`, `Stop Agent`, …).

See origin's README for the current chat-UI feature list; this tree still has that behavior, plus local work such as the working-row spinner and New Session empty-page lock.

## Development

```bash
npm install
npm run compile
npm run typecheck
npm run test
npm run package
```

Open this folder and press `F5` for an Extension Development Host.

## License

MIT — original copyright [sirouk](https://github.com/sirouk); see [LICENSE](LICENSE). Prime Agent is a Prime Intellect trademark and is named only to identify the CLI this extension drives.
