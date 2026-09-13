# Brief

**依照個人工作習慣打造的 Prime Agent VS Code 介面。同一個 workspace、平行 sessions，以及適合你寫程式方式的聊天配置。**

[English](README.md) | 繁體中文

Brief 是 [sirouk/prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode) 的獨立 fork，使用 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 作為 runtime。它反映我的日常工作方式與偏好，不是要替所有人定義唯一正確的介面。

目前版本已適合我每天使用。仍有一些 UI 細節待修整，後續改善以實際使用經驗為主，不承諾完全打磨好的體驗。

> **社群專案。** Brief 並非由 Prime Intellect 發布、背書，也不隸屬於該公司。Prime Agent 提供 runtime，Brief 提供 VS Code 介面。

![Brief 左側顯示 session 列表，上方為原生編輯器分頁，並顯示工作狀態與對話大綱。](media/screenshots/editor-tabs.png)

*Editor Tabs：瀏覽與排序 sessions，讓對話和檔案分頁並存，並查看工作狀態與對話大綱。*

## 主要功能

### 選擇 Sidebar 或 Editor Tabs

使用 **Sidebar**，把編輯區留給程式碼；或使用 **Editor Tabs**，讓每段對話都有自己的原生 VS Code 分頁。可將分頁拖到不同 editor groups，並排閱讀對話或程式碼。

執行 `Brief: Use Sidebar` 或 `Brief: Use Editor`，即可搬移目前 session 並記住 workspace 偏好。新 session 預設使用 Editor Tabs。搬移 session 不會停止 agent。

![Brief 聊天位於 VS Code Secondary Side Bar，左側為 Explorer，中間編輯區開啟 README。](media/screenshots/sidebar.png)

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
- 已安裝 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)，並完成 provider 存取設定。

先安裝 Prime Agent：

```sh
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

完成設定並確認 `prime-agent` 可執行，再透過 VS Code 安裝 Brief：

1. 前往 [GitHub Releases](https://github.com/litechenacc/brief/releases)，下載該版本的 `.vsix` 附件（`brief-<version>.vsix`）。安裝插件不需要下載 source code 壓縮檔。
2. 在 VS Code 開啟 **Extensions**，選擇 **… → Install from VSIX…**，再選取下載的檔案。也可從 Command Palette 執行 **Extensions: Install from VSIX...**。
3. 若出現提示，重新載入 VS Code；開啟受信任的 workspace，再執行 **Brief: New Session**。

更新時，下載新版 VSIX 並重複安裝即可。若 VS Code 找不到 runtime，請將 `brief.command` 設為 `prime-agent` 的絕對路徑。

使用 release 不需要 clone repository、安裝建置工具或執行 `just`。原始碼建置與客製化請見[開發與 fork 指南（英文）](docs/usage.md#development-and-forks)。指令、設定、附件行為與保存限制，請見[使用指南（英文）](docs/usage.md)。

## 為什麼 fork？

Brief 能夠存在，是因為 [sirouk 建立並分享了原始插件](https://github.com/sirouk/prime-agent-vscode)。感謝原作者提供這個基礎，讓我能打造自己每天使用的工具。

這個 fork 反映我的個人工作習慣，以及對聊天配置、平行 sessions 和互動設計的偏好。其中一些選擇與原插件的方向不同，因此我選擇獨立維護，而不是把每一項個人偏好都作為 pull request 推回上游。

偏好不同，不代表某個版本對所有人都比較好。歡迎使用原版、Brief，或打造自己的版本。

## Roadmap

| 狀態 | 方向 |
| --- | --- |
| 已提供 | 優化 **Sidebar** 的日常聊天體驗。 |
| 已提供 | **Editor Tabs**：原生分頁與平行 sessions。 |
| 持續改善 | 修正在實際使用中遇到的 UI 細節與互動問題。 |
| 探索中 | **Document Workspace**：以 Markdown 為中心，讓人與 agent sessions 協作，不侷限於線性聊天。 |

Document Workspace 是先前「Session Area」構想的暫稱。方向是讓人與 agent 圍繞可編輯的 Markdown 文件工作，並將 sessions 連結到工作內容。**此版本尚未提供這項功能。** 背景請見[設計討論](https://chatgpt.com/share/6aa639e7-39f8-83e8-afd7-2641ced62b0f)；內容屬於探索，不是實作規格。

Roadmap 表達方向，不代表交付承諾，也沒有預定時程。

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
