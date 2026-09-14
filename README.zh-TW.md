# Brief

**依照個人工作習慣打造的 Prime Agent VS Code 介面。同一個 workspace、平行 sessions，以及適合你寫程式方式的聊天配置。**

[English](README.md) | 繁體中文

Brief 是 [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode) 的獨立 fork，使用 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 作為 runtime。它反映我的日常工作方式與偏好，不是要替所有人定義唯一正確的介面。

目前版本已適合我每天使用。仍有一些 UI 細節待修整，後續改善以實際使用經驗為主，不承諾完全打磨好的體驗。

> **社群專案。** Brief 並非由 Prime Intellect 發布、背書，也不隸屬於該公司。Prime Agent 提供 runtime，Brief 提供 VS Code 介面。

![Brief 左側顯示 session 列表，上方為原生編輯器分頁，並顯示工作狀態與對話大綱。](https://raw.githubusercontent.com/litechenacc/brief/HEAD/media/screenshots/editor-tabs.jpg)

*Editor Tabs：瀏覽與排序 sessions，讓對話和檔案分頁並存，並查看工作狀態與對話大綱。*

## 我自己很愛的功能

我帶著對程式碼與 Prime Agent 的愛開發 Brief。下面這些細節，是我每天用起來會覺得開心的地方：

![Brief 功能導覽：agents 對話泡泡、原生分頁、大綱、工作狀態、訊息控制與其他貼心功能。](https://raw.githubusercontent.com/litechenacc/brief/HEAD/media/screenshots/features-annotated.zh-TW.jpg)

以下編號與圖片一致。**01–06 標示截圖中可見的介面；07–10 是功能補充，對應的狀態或操作未出現在這張截圖中。**

1. **Agents 之間的對話泡泡。** Prime Agent 讓 agents 能彼此對話、協調工作。我很愛自己把這些交流呈現成對話泡泡的設計，搭配各自的頭像與名稱：不只是知道它們正在平行工作，而是看得見它們如何溝通合作。
2. **原生 tabs，還能在 VS Code 並排。** 對話和檔案都有原生 editor tabs，也能拖到不同 editor groups，讓對話和程式碼、對話和對話放在一起，真的太舒服了。圖中顯示的是分頁列，尚未展示並排配置。
3. **Session 右側的 outline 跳轉。** 想回頭看某一段，不必一路捲過整個對話。
4. **Subagents 狀態，一眼就知道。** 清單顯示哪些 agents 正在 running、哪些處於 idle，也能開啟各自的 view。這是 agent 活動狀態，不是第 10 項的 `bash` 或背景任務清單。
5. **把 Claude Code 的「verbing」偷進來。** 那些工作中的動詞狀態文字，我實在太喜歡，就借來放進 Brief 了。這張圖顯示的是「Plotting…」與經過時間。
6. **Steer／Queue／Send，統一在一個按鈕。** Agent 執行中可選 **Steer** 或 **Queue**；閒置時，同一個控制顯示 **Send**。圖中顯示 Steer，不是三種選項同時展開的選單。
7. **Pending inputs，待送訊息看得見。** 等待送出的訊息獨立於對話紀錄顯示，讓我知道接下來安排了什麼，不必在回覆裡翻找。這張圖沒有顯示待送訊息清單。
8. **附件在草稿裡有自己的位置。** 插入圖片時，在插入位置留下 placeholder；貼上的長文本可以直接在 VS Code 開啟、編輯，再送出。圖片 placeholder 表示輸入區中的位置，不保證 runtime 會依圖文交錯順序接收。圖中是先前已送出的圖片，並非草稿 placeholder 或長文本編輯流程。
9. **Sessions 能排序，實際檔案隨手開。** Session History 提供 **Priority（優先度）**與 **Birth time（建立時間）**排序；對話中的檔案連結可以直接在 VS Code 開啟。這讓我能決定接下來關注哪個 session，也不只看 agent 怎麼描述，而是打開實際程式碼。這張圖未展示排序選單或開啟檔案的操作。
10. **`bash` 與背景任務的通知、狀態管理。** 這是我使用 Prime Agent 時一直希望有的功能：更清楚知道哪些工作還在跑、哪些已經完成。Running tasks 與完成通知和 Subagents 是不同功能；沒有執行中任務時，Running tasks 清單會消失。這張圖沒有顯示這些任務狀態。

## 主要功能

### 選擇 Sidebar 或 Editor Tabs

使用 **Sidebar**，把編輯區留給程式碼；或使用 **Editor Tabs**，讓每段對話都有自己的原生 VS Code 分頁。可將分頁拖到不同 editor groups，並排閱讀對話或程式碼。

執行 `Brief: Use Sidebar` 或 `Brief: Use Editor`，即可搬移目前 session 並記住 workspace 偏好。新 session 預設使用 Editor Tabs。搬移 session 不會停止 agent。

![Brief 聊天位於 VS Code Secondary Side Bar，左側為 Explorer，中間編輯區開啟 README。](https://raw.githubusercontent.com/litechenacc/brief/HEAD/media/screenshots/sidebar.jpg)

*Sidebar：檔案列表、編輯中的檔案與對話放在同一個視窗。此圖將 Brief 放在 Secondary Side Bar。*

### 同時進行多個 sessions

在同一個 workspace 開啟獨立對話，分別進行實作、調查、review 或測試。可以瀏覽歷史、重新命名或封存對話，以及查看 subagent 活動。

**Sessions 共用 workspace 檔案，並非隔離的 checkout。** 多個 agent 修改相同檔案時，需要協調。

### 離開後再回來

關閉分頁只會關閉視圖，不會停止工作。Brief 的 sessions 在 Prime Agent daemon 中執行，重新載入或關閉 VS Code 後仍可繼續。再次開啟 workspace 時，可透過還原分頁或 session history 回到對話。

這依賴 daemon 與所在主機持續可用。關機、休眠或終止 runtime 時，不保證工作持續執行。要取消目前工作，請使用停止按鈕或 `Brief: Stop Agent`。

### 介面安靜，進度仍然清楚

工作指示、經過時間、session 活動與完成通知，讓你知道 agent 是否仍在工作。思考內容、工具輸出串流與用量細節可分別設定。配色跟隨 VS Code 主題，也支援 High Contrast。

這些改善針對介面回饋與顯示，不代表模型生成速度變快。

### 把工作材料帶進對話

- 從編輯器右鍵選單加入選取程式碼或目前檔案。
- 使用 `@` 引用 workspace 檔案，或附加圖片。
- 將貼上的長文本收成附件，送出前可在 VS Code 開啟編輯。
- 在 agent 工作時傳送 steering 訊息，或排入後續訊息。
- 查看 context 用量、壓縮 context，以及將對話匯出為 Markdown。

## 安裝與開始使用

需求：

- VS Code **1.90 以上**，以及受信任、使用本機檔案系統的 workspace。
- 已安裝 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)，可透過 Brief 的 `/login` 設定 provider 存取。

先安裝 Prime Agent：

```sh
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

確認 `prime-agent` 可執行，再透過 VS Code 安裝 Brief：

1. 前往 [GitHub Releases](https://github.com/litechenacc/brief/releases)，下載該版本的 `.vsix` 附件（`brief-<version>.vsix`）。安裝插件不需要下載 source code 壓縮檔。
2. 在 VS Code 開啟 **Extensions**，選擇 **… → Install from VSIX…**，再選取下載的檔案。也可從 Command Palette 執行 **Extensions: Install from VSIX...**。
3. 若出現提示，重新載入 VS Code；開啟受信任的 workspace，再執行 **Brief: New Session**。

在 Brief 輸入 `/login`，即可透過 VS Code 選擇 provider 並完成 OAuth 或輸入 API key。Provider 清單來自已安裝的 Prime Agent SDK；瀏覽器授權仍會開啟外部瀏覽器。憑證由 Prime 自己的儲存機制管理，可與同主機、同設定目錄的 `prime-agent` 共用。Remote SSH 時，SDK 在 remote extension host 所在主機執行。MCP Connections 與需要特殊設定的登入流程會標示限制，不會送成聊天 prompt。

更新時，下載新版 VSIX 並重複安裝即可。若 VS Code 找不到 runtime，請將 `brief.command` 設為 `prime-agent` 的絕對路徑。

使用 release 不需要 clone repository、安裝建置工具或執行 `just`。原始碼建置與客製化請見[開發與 fork 指南（英文）](docs/usage.md#development-and-forks)。指令、設定、附件行為與保存限制，請見[使用指南（英文）](docs/usage.md)。Slash commands 的完成度與待討論設計請見 [roadmap](docs/roadmap.md)。

## 為什麼 fork？

Brief 能夠存在，是因為 [sirouk 建立並分享了原始插件](https://github.com/sirouk/prime-agent-vscode)。感謝原作者提供這個基礎，讓我能打造自己每天使用的工具。

這個 fork 反映我的個人工作習慣，以及對聊天配置、平行 sessions 和互動設計的偏好。其中一些選擇與原插件的方向不同，因此我選擇獨立維護，而不是把每一項個人偏好都作為 pull request 推回上游。

偏好不同，不代表某個版本對所有人都比較好。歡迎使用原版、Brief，或打造自己的版本。

## 刻意的選擇與限制

### 選擇 VS Code，因為我還是想了解自己的程式碼

過去幾個月，我幾乎沒親手寫幾行程式了。但我還是希望透過 file tree，以及實際點開檔案，了解自己的程式。很多 agentic 介面沒有我想要的檔案瀏覽與程式碼跳轉體驗；加上 Language Server Protocol (LSP) 支援與熟悉的編輯工具，VS Code 對我來說仍然最舒服。選它作為 Brief 的載體，是刻意的選擇。

### 一個 workspace，多個對話

我刻意讓多個對話留在同一個 workspace，因為 **Prime Agent 裡的 agents 不只是各自平行工作，還能彼此對話**。它們可以討論工作、協調改動、互相告知進度，不必每一句都由我居中傳話。這讓我能放心讓它們在同一個 workspace 工作，不會只因為它們同時動手就擔心。我也刻意把這些交流設計成對話泡泡，讓我直接看見它們如何合作。能溝通不等於保證沒有編輯衝突；共用檔案仍需要協調。

這個選擇換來的，是我對 workspace 更深入的了解。Brief 並不是為同時管理多個 repository 工作而打造的控制中心。對我而言，多 repo 並行會讓掌控感大幅降低，精神消耗也翻倍。把注意力留在一個 workspace，是我願意做的取捨。

### 適合現在的工作方式

也許未來我有更多 tokens，可以投入多 agent、事件驅動、循環執行與 workflow 的建構，這套介面就不再適合了。我不期待它涵蓋所有未來的工作方式。至少到目前為止，它很契合我的流程，也讓我能在這個基礎上快速開發。

## Roadmap

| 狀態 | 方向 |
| --- | --- |
| 已提供 | 優化 **Sidebar** 的日常聊天體驗。 |
| 已提供 | **Editor Tabs**：原生分頁與平行 sessions。 |
| 持續改善 | 修正在實際使用中遇到的 UI 細節與互動問題。 |
| 探索中 | **Document Workspace**：以 Markdown 為中心，讓人與 agent sessions 協作，不侷限於線性聊天。 |

Document Workspace 是先前「Session Area」構想的暫稱。方向是讓人與 agent 圍繞可編輯的 Markdown 文件工作，並將 sessions 連結到工作內容。**此版本尚未提供這項功能。** 背景請見[設計討論](https://chatgpt.com/share/6aa639e7-39f8-83e8-afd7-2641ced62b0f)；內容屬於探索，不是實作規格。

Roadmap 表達方向，不代表交付承諾，也沒有預定時程。

### Slash commands 完成進度

以下整理自 [slash commands roadmap](docs/roadmap.md)。**已完成**表示該列明定的 Brief 範圍已實作並驗證，不代表與 Prime Agent 的全部行為相同。詳細決策與驗證界線以 roadmap 為準；底層 runtime 有能力不代表 Brief 已支援。

| 狀態 | 指令 | 已完成範圍／剩餘工作 |
| --- | --- | --- |
| 已完成 | `/compact [instructions]`、`/refine`、`/goal`、`/autonomous` | 固定補全入口與既有 prompt 路徑；goal 與 autonomous 操作選單。持續可見的狀態面板不在本次範圍。 |
| 已完成 | `/stash`、`/new`、`/clear` | 每個 session 的草稿暫存；在新 editor tab 建立空白 session，保留原 session。 |
| 已完成 | `/logout` | Provider 選單、移除確認、已儲存認證移除，以及不啟動 agent 的模型清單更新。 |
| 已完成 | `/name`、`/rename`、`/resume` | 重新命名目前 session，或開啟 sidebar Session History。 |
| 已完成 | `/fork`、`/export`、`/copy` | 從 user message 分支至新分頁、匯出 Markdown，或複製最後一則已完成 agent 回覆的正文。 |
| 已完成 | `/session`、`/context`、`/usage` | 本地唯讀統計快照，明示統計範圍並區分缺值。 |
| 部分完成 | `/model`、`/effort`、`/thinking` | 已實作選擇與驗證；Prime 仍會寫入全域預設，預期的 session-only 行為受 runtime 限制。 |
| 部分完成 | `/login` | 已有 VS Code provider 登入；特殊設定流程與認證管理範圍待討論。 |
| 部分完成 | Extension、prompt template、`/skill:名稱` | 已有動態補全與 prompt 路徑；自訂 extension UI 尚未完全支援。 |
| 待討論 | `/fast`、`/scoped-models`、`/import`、`/clone`、`/tree`、`/system-prompt`、`/btw`、`/side`、`/rlm-max-depth`、`/heartbeat`、`/heartbeats`、`/reload`、`/settings` | Runtime 已有底層能力，Brief 接入方式與互動設計尚未定案。 |
| 待討論 | `/mcp`、`/share`、`/logs`、`/traces`、`/changelog`、`/hotkeys`、`/update`、`/fullscreen`、`/quit` | 前端或命令列整合，以及 Brief 對應操作仍待討論。 |

## 改成你喜歡的樣子

**歡迎 fork，使用 AI agent 把 Brief 改成符合你習慣與喜好的工具。** 不需要等我的同意，也不必遵循我的設計方向。請保留 MIT 授權要求的 copyright 與授權聲明。

歡迎提出 issue 與 pull request，也歡迎使用 AI agent 協助製作。提交前，請理解改動內容、說明用途，並提供適當驗證。不論使用什麼工具，提交者仍須對提交內容負責。

這是利用空閒時間維護的個人專案。**請不要期待即時回覆、review 或 merge。** 我也不保證一定會回覆或合併。若你需要某項修改，歡迎直接在自己的 fork 推進，不必等我。

## 按現狀提供，風險自負

**Brief 按現狀提供（as is），不提供任何擔保。使用風險由你自行承擔（use at your own risk）。** 它驅動的 agent runtime 可以執行指令與修改 workspace 檔案。請檢查 agent 的操作與改動、保護憑證，並為重要工作保留備份或使用版本控制。

不保證提供支援或持續維護。完整免責與責任限制請見 [LICENSE](LICENSE)。

## 感謝與授權

- [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode)：原始插件，也是這個 fork 的基礎。
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)：agent runtime。
- [Lobe Icons](https://github.com/lobehub/lobe-icons)：provider 圖示，詳見[第三方授權聲明](THIRD_PARTY_NOTICES.md)。
- Lite Chen：Brief fork 的修改。

採用 [MIT 授權](LICENSE)，保留原作者 copyright，並加入 Lite Chen 對此 fork 貢獻的聲明。Prime Agent 是 Prime Intellect 的商標；本授權不授予商標權利。
