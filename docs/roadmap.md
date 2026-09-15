# Brief slash commands roadmap

本文件追蹤 slash commands 在 Brief 體系下的完成度與待討論事項，不是照搬終端介面的承諾。
基準：Brief 0.3.3 工作目錄、Prime Agent 0.9.4。runtime 能力為原始碼盤點，不代表所有流程已通過整合驗證。

## 狀態與更新方式

- **已完成**：該列明定的 Brief 範圍已實作並驗證，不表示與上游所有行為相同。
- **部分完成**：已有可用功能，但還有列出的缺口。
- **待討論**：尚未決定 Brief 的操作與呈現方式；不是已核准的實作規格。
- **待實作**：操作與完成定義已確認，但 slash 入口尚未完成並驗證。

未來逐項實作前，先釐清該列的 UI、參數、session 範圍與錯誤行為；完成後更新狀態、決策及驗證依據。
不以百分比估計完成度，也不因底層有方法就標記完成。不新增通用指令框架或一次實作所有項目。

## 第一階段：補上現有 runtime session commands

這四個指令固定出現在補全選單，不依賴 `get_commands`。`/compact`、`/refine` 選取只插入文字；位於輸入開頭的 `/goal`、`/autonomous` 選取會開啟既有 dropdown 操作選單。完整指令仍走既有 prompt 路徑，參數原樣保留。同名 runtime 清單項目不重複顯示，內文補全不觸發操作。

| 指令 | 狀態 | 已完成範圍 | 後續界線 |
| --- | --- | --- | --- |
| `/compact [instructions]` | 已完成 | 固定選單入口、既有 prompt 送出 | 本階段不修改壓縮按鈕或附接 session 的 instructions 傳遞 |
| `/refine` | 已完成 | 固定選單入口、既有 prompt 送出 | 不新增 harness 管理 UI |
| `/goal` | 已完成 | 設定目標格式提示、狀態／暫停／恢復／清除選單；清除需確認 | 持續可見的目標狀態面板另行討論 |
| `/autonomous` | 已完成 | 查看狀態／開啟／關閉選單；提示額外用量與關閉不等於中止 | 持續可見的模式與用量狀態另行討論 |

操作決策：
- 裸 `/goal`、`/autonomous` 送出也開選單；有參數時不攔截。
- 設定目標僅帶入 `/goal `，提示 `/goal [--budget <tokens>] <objective>`，建議包含成果、完成條件與範圍。不預填預算或可誤送的佔位文字；runtime 指令需為單行。
- 選單取消或送出控制指令後還原草稿，控制指令不夾帶草稿附件；設定目標時原草稿留在本地暫存，可用 `/stash` 暫存／還原。
- 不猜測目前 goal 或 autonomous 狀態；由「View status」取得 runtime 回覆。

驗證：`test/webview.test.mjs` 涵蓋空 runtime 清單、選單操作、格式提示、帶預算與參數送出、清除確認、鍵盤操作、草稿還原、送出可用性、去重、內文補全與 session 切換關閉選單。這些是前端測試，不是 live runtime 執行驗證。

## 既有本地指令與動態清單

| 指令 | 狀態 | 現況／待釐清 |
| --- | --- | --- |
| `/model` | 部分完成 | 已實作精確匹配／搜尋、草稿保留、執行中與唯讀限制、權威狀態回讀；Prime 原生切換會寫入預設設定，「不改全域預設」是 intentional 設計決策，目前 runtime 尚未符合。 |
| `/effort`、`/thinking` | 部分完成 | 同義操作、依模型可用層級、執行中與唯讀限制及錯誤回讀已實作；不控制 thought process 顯示。Prime 原生設定會寫入預設值；只改目前 session、不改全域預設是 intentional 設計決策，目前 runtime 尚未符合。 |
| `/stash` | 已完成 | 每個 session 一份文字／附件暫存，禁止覆寫；可自訂、限文字輸入區焦點的快捷鍵。切換 session 保留，不承諾關閉／重載後保存。 |
| `/new`、`/clear` | 已完成 | 同義指令，建立空白 session 並開啟新 editor tab；以建立參數繼承工作目錄／模型／thinking，不改 Prime 預設，保留原 session。命名與初始 prompt 參數不納入本次範圍。 |
| `/login` | 部分完成 | 已有 VS Code provider 登入；特殊設定流程及認證管理範圍待討論 |
| `/logout` | 已完成 | provider 選單、移除確認、SDK 認證移除與不啟動 agent 的模型清單更新；完成範圍與驗證見下節 |
| extension、prompt template、`/skill:名稱` | 部分完成 | 已有動態清單及 prompt 路徑；自訂 extension UI 不完全支援，需按實際使用案例釐清 |

## 已定案的本地指令完成條件

以下是本次核准範圍，不要求複製 Prime 的全部參數語法。

### `/model`

**已知阻礙**：Prime 目前的 `set_model` 與 `set_thinking_level` 會寫入 Prime 的預設設定，兩種連線皆無 session-only 參數。**Intentional 設計決策**：使用者已確認只改目前 session、不改全域預設，不採用 Prime 原生寫入預設值的語意。此完成條件保留，但目前實作尚未達成，因此維持「部分完成」；intentional 指設計選擇，不表示已完成 session-only 隔離。不以事後覆寫設定檔繞過。

- 無參數開啟選單，標示目前模型；有參數時，忽略大小寫比對 model ID、顯示標籤與 `provider/modelId`。只有唯一精確匹配才直接切換；重名、部分匹配或查無結果均開啟搜尋選單，不猜測。
- 所有同行參數視為模型查詢文字；不支援 thinking level、其他 flags 或切換後立即送 prompt。
- 只改目前 session，不改其他 session 或全域預設。執行中與唯讀禁止切換。
- 成功、失敗與取消皆保留草稿／附件；指令不送給模型。失敗須提示，畫面以 runtime 確認的狀態為準。

### `/effort`、`/thinking`

- 兩者為相同操作的 alias。無參數開啟選單；指定層級忽略大小寫，但只接受目前模型可用層級。Brief 沿用 `supportedThinkingLevels()`，依 runtime 回傳的模型能力與 `thinkingLevelMap` 推導選單；標準輸入輸出的 `get_state` 不直接提供完整層級清單。模型尚未取得時不猜測。
- 無效層級不變更設定，提示可用值並開啟選單；模型不支援 thinking 或層級尚未取得時，只提示，不提供猜測層級。
- 不換算 `max`、`xhigh` 等不同層級。切換模型後，清除舊選單層級，由 runtime 決定並回報有效設定。
- 只改目前 session，執行中與唯讀禁止變更；草稿／附件保留，錯誤時不顯示成已成功變更。
- 顯示或隱藏 thought process 是另一個設定，不納入本指令。

### `/stash`

- 每個 session 一份暫存，包含文字與附件及其還原資訊，不包含模型、thinking level 或對話紀錄。
- 有草稿而無暫存：收起草稿並清空輸入區。無草稿而有暫存：還原成功後清空暫存。兩者皆有：拒絕操作並提示，不覆寫、不合併、不交換。兩者皆空：提示無內容。
- `/stash` 本身不存入草稿，也不送出 prompt。同行參數須提示並保留輸入；下一行可放待暫存內容。
- 同一個 Brief view 內切換 session／分頁須保留各自暫存。關閉分頁、重載 view 或重啟 VS Code 後不保證保留；提示須說明暫存性質，不新增磁碟保存。
- 輸入區允許編輯草稿時，即使 agent 執行中也可操作。
- 提供 `Brief: Stash / Restore Draft`（`brief.stashDraft`）與可自訂快捷鍵：Windows／Linux 為 `Ctrl+K Ctrl+Alt+S`，macOS 為 `Cmd+K Cmd+Alt+S`（依序按下兩組按鍵）。可在 VS Code Keyboard Shortcuts 修改。快捷鍵只在 Brief 文字輸入區有焦點時生效，沿用相同暫存／還原邏輯；工具列、其他分頁或背景視窗不觸發。

### `/new`、`/clear`

- `/clear` 沿用 Prime 的 `/new` alias，但選單須明示是建立新 session，不是清空或刪除對話。
- 建立空白 session 並開啟新 editor tab；保留原 session 的對話、草稿、附件、stash 與分頁。原 agent 若正在執行，不停止它。
- 新 session 沿用來源的工作目錄、模型與 thinking level，不複製對話、草稿、附件或 stash。
- 建立失敗須提示，留在原 session，不遺失內容。
- 本次兩者皆不接受命名或初始 prompt 參數；有參數須提示並保留輸入。命名使用既有重新命名功能，初始 prompt 在新分頁輸入。這些參數不列為本次完成缺口。

驗收需涵蓋上述成功、錯誤、取消、執行中與唯讀條件，以及 session 隔離。模型／thinking 設定與新 session 建立需分別驗證標準輸入輸出與 daemon 附接路徑；不可把 mock 或純前端測試宣稱為 live runtime 驗證。

### 本次驗證依據

- Review 後修正：首次取得 session ID 時保留啟動期間的 stash；`test/composer-slash-contracts.test.mjs` 新增文字、圖片、selection／文字附件、重複 identity 及切換 session 往返的回歸檢查。新增測試先重現資料遺失，修正後通過。
- 啟動狀態文字的測試預期已由 `connecting` 同步為 `Initializing…`，保留輸入區不被啟動流程阻擋的斷言。上述修正後重新執行 `npm test`、`npm run typecheck` 與 `git diff --check`，全部通過；不是只補跑個別測試。

- `npm test`：完整測試通過，包含既有回歸測試與以下新增測試。
- `npm run typecheck`：通過。
- `test/composer-slash-contracts.test.mjs`：模型匹配／搜尋、thinking 選單、執行中／唯讀及選單競態限制、草稿／附件、stash 隔離、`/clear` 與無效參數；保留 `/goal`、`/autonomous` 多行 prompt 行為。
- `test/stash-shortcut.test.mjs`、`test/stash-shortcut-host.test.mjs`：可重綁快捷鍵宣告、輸入區焦點、toolbar／背景視窗不觸發、editor／sidebar 派送、session 隔離與移動／關閉限制。使用 browser DOM 與 VS Code mock，未宣稱已做真實 VS Code 按鍵人工驗證。
- `test/session-settings.test.mjs`、`test/editor-tabs.test.mjs`：以 mock 覆蓋標準輸入輸出與 daemon 的設定成功／失敗／權威回讀、執行中與唯讀，以及新分頁建立、來源保留、失敗回復、初始參數繼承。slash 使用獨立 `newSessionFromCurrent` 訊息；既有「＋」與 `Brief: New Session` 的預設位置行為不變。
- `node test/slash-runtime-live.mjs`：Prime Agent 0.9.4 的 **22 項 live checks 通過**。實際標準輸入輸出及 daemon 連線驗證模型切換、所有提供層級的設定／回讀、runtime 空白 session，以及 daemon 建立新 worker 的模型／thinking 繼承。新 worker 建立不改來源設定，隔離的預設設定檔前後相同；原生 `set_model`／`set_thinking_level` 寫入預設值的限制也有可重現斷言。
- live verifier 使用隔離的工作目錄、session 與 agent 設定目錄，只清理自建 worker；未送出 prompt 或模型推論。daemon 不存在時明確失敗，不以 skip 當通過。
- live 驗證直接操作 Brief transport，**不是完整 VS Code host `/new` 端到端測試**；host 行為由上述 mock 測試覆蓋。`/model` 與 `/thinking` 仍因預設設定作用範圍保留「部分完成」。

### 已確認：`/logout`

狀態：已完成以下 Brief 範圍。採 VS Code provider 選單與已安裝的 Prime Agent SDK，不送成 agent prompt。

完成定義：
- 固定補全入口；裸 `/logout` 開啟 Quick Pick，只列本次範圍內已有儲存認證的模型 provider，不顯示 key 或 token。沒有可移除認證時明確提示。
- 不支援參數或全部登出；帶參數提示使用 `/logout` 選擇 provider，不送成 prompt。MCP、Traces、Amazon Bedrock、Google Vertex AI 與外部認證管理不納入。
- 選取後確認移除；說明共用認證可能影響其他 Brief／CLI session，不刪環境變數或外部工具認證、不保證撤銷供應商 token 或登出瀏覽器。
- 只移除指定 provider 的已儲存認證，包含 SDK 管理的 Prime Inference 特殊儲存；其他 provider 不變。
- 沒有 session 或 agent 因缺少認證無法啟動時仍可操作。不停止 agent、不重啟 session、不自動換模型；已開始的請求不保證立即失效。
- 成功後重新取得發出操作之 view 的目前模型清單；移除失敗與移除成功但模型清單更新失敗分開回報，不顯示錯誤的成功狀態。
- 取消不變更認證；不夾帶附件、不遺失原草稿與附件。選單、錯誤與 log 不洩漏認證。

驗證：
- `test/webview.test.mjs`：固定入口與去重、內文不觸發、裸指令與補全、參數／多行拒絕、草稿與附件保存、session 未就緒時操作。
- `test/prime-auth.test.mjs`：provider 範圍、空清單、選取／確認取消、API key／OAuth／Prime Inference 移除、其他 provider 保留、儲存失敗、安全錯誤、登入／登出互斥。
- `test/editor-tabs.test.mjs`、`test/session-controller-boundary.test.mjs`、`test/chat-view-message.test.mjs`：無 session、發出操作之 view 路由、daemon／RPC 模型清單更新與失敗、停止／失敗 worker 不啟動，以及訊息邊界。
- 本機已安裝 SDK 另以暫存 auth 與 Prime CLI config、假認證驗證移除及其他欄位保留；未碰實際認證或呼叫模型服務。
- 上列測試、`npm run typecheck` 與 `git diff --check` 均通過。

驗證界線：daemon／RPC 使用測試替身，不宣稱已完成 live runtime 或真實 provider 登出驗證。沒有 session 時略過模型清單更新；已有 tab 但 worker 未執行或處於唯讀觀察模式時，不啟動 agent，明確回報認證已移除但清單未更新。

## 既有功能的 slash 入口

依各列狀態追蹤入口完成度；「已有功能」不等同上游指令語意完全一致。

| 指令 | 狀態 | 可重用功能 | 實作前討論 |
| --- | --- | --- | --- |
| `/name`、`/rename` | 已完成 | 無參數輸入框、帶參數直接命名、session 綁定與標題／History 更新 | 完成範圍與驗證見下節 |
| `/resume` | 已完成 | 固定開啟 sidebar Session History、沿用既有 session 開啟與 tab 重用 | 不支援參數；完成範圍與驗證見下節 |
| `/fork` | 已完成 | 從 user message 分支 | 選取訊息後另開 editor tab，選定訊息退回草稿；完成定義見下節 |
| `/export` | 已完成 | Markdown 匯出 | 沿用兩種 Markdown 與 Save Dialog，不支援參數；完成定義見下節 |
| `/copy` | 已完成 | 複製訊息／對話 | 複製最後一則已完成且含正文的 agent 訊息，不含 thinking；完成定義見下節 |
| `/session` | 已完成 | session 狀態與統計 | 本地統計卡片；完成範圍與驗證見下節 |
| `/context`、`/usage` | 已完成 | context／cost 顯示 | 本地統計快照，不另做子代理彙總或 context tree；完成範圍與驗證見下節 |

### 已確認：`/usage`、`/context`、`/session`

狀態：已完成以下 Brief 範圍。三個指令皆為本地唯讀查詢，不送成 prompt、不呼叫模型。

完成定義：
- `/usage` 顯示 runtime 回報的目前分支保留訊息之累積 Input、Output、Cache read／write、Total tokens 與費用（USD）；壓縮後不保證保留壓縮前累計，不宣稱為完整 session 歷史費用或供應商最終帳單。
- `/context` 顯示 runtime 估計的目前 context 已用 tokens、context window 與比例，與累積 usage 明確區分。壓縮後尚無有效回覆時可能未提供估計值。
- `/session` 顯示名稱、ID、工作目錄、模型、thinking level、執行／唯讀狀態，以及 user／assistant messages、tool calls 與總訊息數。
- 第一版不另做子代理彙總、完整 context tree、token 分類估算或跨 session／全帳戶帳單。runtime 可將子代理計費用量歸入 parent assistant usage，因此不能將本卡片描述為排除子代理；依 runtime 回報值顯示，不重複加總。
- 在對話區顯示明確標示 Brief 本地資訊的統計卡片，包含查詢時間、範圍、重新整理、複製與關閉。不是 assistant message，不寫入模型對話，不納入 `/copy` 或對話匯出。
- 手動查詢快照，不自動刷新；同一 session 同指令更新既有卡片。執行中提示數值可能仍在增加。切換 session 清除卡片，不持久化；既有資訊列維持即時摘要。
- 固定補全入口；不接受參數或多行輸入，無效輸入提示且保留原文。不夾帶附件、不遺失草稿與附件。
- 只查發出指令的 view 所屬 session；執行中與唯讀觀察模式可查，不啟動或停止 agent，也不觸發 compact。無可用連線時明確提示。既有唯讀／無連線狀態停用輸入區，因此停用時另提供三個本地查詢按鈕，不放寬 prompt 編輯限制。
- 缺值顯示「未提供」，不可代以零；費用零與未知必須區分。失敗明確提示，保留舊數值時標示舊快照及原時間。
- 查詢期間切換 session，丟棄舊結果，不能更新新 session 的卡片。

實作方式：本地 slash 攔截後，依目前 session 連線使用 `get_session_stats` 與既有 session state，傳遞結構化資料至簡單的本地卡片。不解析 runtime 文字、不新增通用指令框架。既有 `fetchStatsText()`／`fetchAttachedStats()` 含 auto-compact 副作用與吞錯行為，不直接作為本指令查詢入口。

驗收：補全與參數拒絕、草稿／附件保存、三種卡片與更新／複製／關閉、快照時間、缺值／零值、查詢失敗、執行中／唯讀、無連線不啟動 agent、session 路由與切換競態、不觸發 compact，以及標準輸入輸出 RPC／daemon 兩條路徑。mock、前端測試與 live runtime 驗證分別記錄，不互相替代。

驗證依據：
- `test/statistics-host.test.mjs`：訊息邊界、標準輸入輸出 RPC／daemon、零值與缺值、成功／失敗、執行中／唯讀觀察、session 切換競態，以及不呼叫啟動／compact／狀態刷新。以實際 ChatPanels receiver 搭配 mock 驗證 editor／sidebar 發出 view 的路由、無 tab 錯誤、不初始化 session 與 view 重新綁定後丟棄舊結果。
- `test/statistics-webview.test.mjs`：三個補全入口、精確指令排序、參數／多行拒絕、草稿／選取附件／待建立文字附件保存、卡片重新整理／複製／關閉、舊快照與錯誤、request/session 競態、停用輸入區的本地查詢按鈕，以及卡片不納入 transcript 或持久 view state。使用 browser DOM 測試，不宣稱真實 VS Code 人工操作驗證。
- `node test/statistics-runtime-live.mjs`：Prime Agent 0.9.4 的 **9 項 live checks 通過**。兩種真實 transport 驗證空白零值、已知分支 usage 與獨立 context total、壓縮後 context 未知；重複查詢前後 state、messages、stats 與 session 檔案內容不變。只使用私有 fixture 與自建 worker，不送 prompt／推論／compact，不改使用者設定或歷史。daemon 不存在時視為阻礙而非 skip/pass。
- runtime 原始碼確認：`getSessionStats()` 加總目前 `state.messages`；`buildSessionContext()` 依分支與壓縮決定保留訊息；`attributeChildUsage()` 可歸入子代理計費用量但保留 parent context 的 `totalTokens`。context 是最近有效 assistant usage 加上後續內容估計，不是即時完整 tokenizer。子代理歸入語意為原始碼依據，未執行子代理推論驗證。
- 最終整合驗證：`npm test` 完整通過（含前置重新 build 與兩項新增統計測試），`npm run typecheck` 與 `git diff --check` 通過。初次新增測試 fixture 缺少 selection `languageId`，補齊後重新執行完整測試通過。未執行真實 VS Code 人工操作或完整 host-to-runtime 端到端驗證；host／前端 mock 與 live transport 驗證如上分列。


### 已確認：`/name`、`/rename`

現況：兩個本地 slash 入口已接入。無參數與 VS Code 指令共用重新命名輸入框；目前 session 的重新命名支援 daemon 與 RPC 路徑。History 的逐列重新命名保留。

完成定義：
- `/name` 與 `/rename` 為相同操作。無參數開啟既有輸入框並預填名稱；有參數直接命名，整段參數視為名稱，允許空格。
- 作用於發出指令的聊天 view 所屬 session，不使用全域最後作用中的 session。輸入框開啟期間若切換 session，取消此次操作，不能誤改其他 session。
- 空白或取消不變更名稱，不提供清除名稱語意；唯讀觀察模式禁止重新命名。
- 成功更新標題與 History；失敗明確提示，不顯示成功狀態。
- 指令不送成 agent prompt、不夾帶附件、不遺失原草稿；多行輸入提示改用單行，不消耗原文。

驗收：兩個 alias、無參數輸入框、帶空格名稱、空白與取消、唯讀限制、輸入框期間切換 session、標題與 History 更新、失敗回報、草稿與附件保存，以及 daemon／RPC 兩條路徑。

### 已確認：`/resume`

現況：本地 slash 入口已接入 sidebar Session History，沿用既有搜尋與開啟流程，重用既有 tab；執行中的 session 直接 attach，已停止的 session 從歷史檔案啟動 worker 後 attach。

完成定義：
- 裸 `/resume` 固定開啟 **sidebar 中的 Session History**，不受目前聊天位於 editor 或 sidebar 影響；不是開啟目前聊天 view 內的 History，也不是只列已開啟 session 的 Switch Session 選擇器。
- 不支援參數，不實作 ID／路徑解析。帶參數時提示使用 `/resume` 開啟 Session History，不送成 agent prompt；多行輸入提示改用單行，不消耗原文。
- 開啟 History 本身不搬移目前聊天、不切換或啟動 session。選取歷史項目後，沿用既有 History 開啟流程。
- 目標已有 tab 時顯示既有 tab，不重複建立、不強制搬移；尚未開啟時沿用目前 editor／sidebar 設定。
- 選取目前 session 不重新啟動或建立副本。Sidebar 顯示其他 session 時，不刪除或停止原 session；切換 view 不等於停止 agent，也不自動送出 prompt。
- 取消或失敗保留原草稿與附件；失敗明確提示，不誤開空白 session。

驗收：從 editor／sidebar 發出指令皆開啟 sidebar Session History、帶參數提示、開啟 History 不改變目前 session、選取與取消、既有 tab 去重與位置重用、執行中／已停止 session、草稿與附件保存，以及恢復失敗。

驗證依據（兩項共用）：
- `test/webview.test.mjs`：固定入口與去重、鍵盤補全／送出、內文補全不執行、兩個命名 alias、完整名稱參數、resume 參數與多行提示、原草稿／圖片／程式碼選取附件保存；新增檢查通過。
- `test/chat-view-message.test.mjs`：host 訊息解析與名稱欄位驗證，通過。
- `test/editor-tabs.test.mjs`：指令路由至發出操作的 view、切換 tab 取消命名、editor／sidebar 開啟 History 不新增 session 或搬移聊天，以及既有 History tab 重用流程，通過。
- `test/session-controller-boundary.test.mjs`：RPC／daemon 命名成功與失敗、空白／取消／唯讀／navigation 邊界、名稱與 History 更新，通過。
- 最終整合驗證：`npm test` 全數通過（exit code 0），`npm run compile`、`npm run typecheck`、`git diff --check` 通過。以上涵蓋本地前端／host 測試；本節兩項功能未執行 live runtime 或 VS Code 人工操作驗證。

### 已確認：`/fork`

現況：slash 與 user message 的 fork 按鈕均接入獨立 editor tab 流程，不再呼叫會切換來源 worker 的原生 fork。

完成定義：
- 裸 `/fork` 開啟 Quick Pick，列出目前 session 可分支的 user messages，顯示順序與文字摘要；沒有可分支訊息時提示。
- 選取後在新 editor tab 開啟分支。保留選定 user message 之前的對話，將選定訊息放入新分支輸入區供修改，不自動送出。
- 原 session、分頁、草稿、附件與 stash 不變；既有訊息 fork 按鈕沿用相同行為。
- 原 agent 執行中或唯讀觀察模式禁止操作。本次不接受訊息編號、名稱或其他參數；帶參數提示並保留輸入，不送成 prompt。
- 選單取消或失敗不影響來源；失敗明確提示。選取期間切換 session 時取消，不對其他 session 分支。
- 選定訊息的附件不得靜默遺失；若 runtime 無法完整還原，明確阻擋該操作，不自行縮減成純文字 fork。

實作方式：重用 runtime 可分支訊息清單，以 `entryId` 指向選取位置，不靠摘要文字猜測；新 tab 重用既有 session 開啟流程。已安裝 runtime 原始碼確認 daemon 與 RPC 的原生 fork 都會切換來源 worker 的 session，且僅回傳選定文字。因此不呼叫來源 worker 的原生 fork；由已安裝 SDK 的 SessionManager 建立獨立 session，設定並保存選定訊息之前的 active branch。SDK 新檔案保留來源 tree records，但目前對話與模型 context 不包含選定訊息及其後續回覆。選定訊息含無法還原的非文字內容時阻擋操作。

驗收：訊息清單與選取位置、無可分支訊息、參數拒絕、取消與失敗、執行中與唯讀限制、session 切換、新 tab 與來源保留、分支對話邊界、選定訊息及附件還原、不自動送出、既有按鈕一致性，以及 daemon／RPC 兩條路徑。

### 已確認：`/export`

現況：slash 已接入兩種 Markdown 匯出與 Save Dialog，重用 `exportChat()`、`exportMarkdown()` 及既有 Markdown formatter。

完成定義：
- 裸 `/export` 開啟既有格式選單：「Markdown，含 tool call 摘要」與「Markdown，純對話」，再開 Save Dialog 選擇路徑。覆寫既有檔案需確認。
- 僅匯出目前 session 分支由 runtime 取得的對話，不含未送出草稿、stash 或其他分支；定位為閱讀用文件，不宣稱是可完整恢復 session 的備份。
- 沿用既有 formatter 的內容規則：兩種格式均包含正文與 thinking；純對話選項僅排除 tool calls。含 tool call 摘要的格式不輸出完整工具結果。User message 圖片以數量標示，不嵌入圖片。
- 本次不做 HTML、JSONL、附件檔案打包或路徑參數。帶參數提示使用 `/export` 選擇格式與儲存位置，不送成 prompt。
- 執行中可匯出已取得的訊息快照，不保證包含尚未完成的串流內容；沿用唯讀觀察模式禁止匯出的限制。
- 取消不寫檔；讀取或寫入失敗明確提示，不顯示成功。選單或儲存對話框期間切換 session 時取消，不匯出其他對話。
- 不夾帶附件、不遺失原草稿與附件。

實作方式：直接接入既有匯出流程，補齊參數拒絕、錯誤回報與覆寫確認驗證，不新增格式框架。

驗收：兩種格式及內容規則、目前分支範圍、空對話、參數拒絕、Save Dialog 取消與覆寫確認、讀取及寫入失敗、執行中快照、唯讀限制、session 切換、草稿與附件保存，以及 daemon／RPC 訊息取得。

### 已確認：`/copy`

現況：slash 已接入 `copyLastReply()`，只取已完成 agent 訊息正文；既有整段對話與訊息複製按鈕保留原行為。

完成定義：
- 裸 `/copy` 複製目前 session 最後一則已完成且含正文的 agent 訊息；最後一則只有 tool calls 或無正文時，向前找最近一則符合條件的訊息。
- 複製原始 Markdown 正文並保留 code fences，不含 thinking、tool calls、tool results、角色標題或統計資訊。
- 執行中可操作，但不複製尚在串流的片段。沒有可複製內容時提示，不清空剪貼簿。
- 本次不接受參數；帶參數提示並保留輸入，不送成 prompt。整段對話仍使用既有「Copy conversation」入口；不修改既有訊息複製按鈕的內容範圍。
- 沿用目前整段複製的唯讀觀察限制。取得內容期間切換 session 時取消，不複製其他對話。
- 剪貼簿寫入成功後才顯示成功；讀取或寫入失敗明確提示。不夾帶附件、不遺失原草稿與附件。

實作方式：重用目前 session 的訊息讀取路徑，由後往前找符合條件的 agent 訊息，取正文並呼叫 VS Code clipboard API。不從 DOM 抽文字，也不使用整段對話的 Markdown formatter。

驗收：最後一則符合條件的訊息、略過 tool-only／空正文訊息、排除 thinking 與工具內容、Markdown 與 code fences 保留、串流中使用已完成訊息、無內容不改剪貼簿、參數拒絕、唯讀限制、session 切換、讀取與剪貼簿失敗、草稿與附件保存，以及 daemon／RPC 訊息取得。

三項共通驗收：固定補全入口、指令不送成 agent prompt、不夾帶附件，以及操作只作用於發出指令的 view 所屬 session。fork 與訊息取得需分別驗證標準輸入輸出 RPC 與 daemon 路徑，不可將 mock 或純前端測試宣稱為 live runtime 驗證。

三項狀態：已完成本節定義的 Brief 實作與自動化驗證；不代表與上游全部行為相同。

驗證依據（三項共用）：
- 最終整合的 `npm test`、`npm run typecheck`、`npm run compile` 與 `git diff --check` 通過。
- `test/editor-tabs.test.mjs`：slash／訊息按鈕新 tab 路由、原 session 保留、草稿還原、不送 prompt、取消與儲存草稿期間切換 session，通過。
- `test/webview.test.mjs`：固定入口與去重、Tab／Enter、本地動作、參數與多行拒絕、草稿／圖片／selection 附件與 stash 保存、執行中與唯讀限制，通過。
- `test/chat-view-message.test.mjs`：三項 host 訊息解析與不轉送額外 payload，通過。
- `test/export-copy-commands.test.mjs`、`test/export-md.test.mjs`、`test/session-controller-boundary.test.mjs`：daemon／RPC mock 訊息讀取、正文範圍、Markdown、空內容、唯讀與 session 邊界、取消、覆寫確認與讀寫錯誤，通過。
- `test/fork-session.test.mjs`：daemon／RPC mock 清單、entryId 選取、可見訊息 ordinal、來源隔離、取消、執行中與唯讀限制，通過。
- `PRIME_AGENT_SDK=/path/to/prime-agent/dist/index.js node test/fork-runtime-live.mjs`：使用已安裝 SDK 與實際 fork helper，驗證來源 bytes 不變、分支持久化、第一則 user message、附件阻擋與 git_state parent 處理。此測試不啟動 daemon 或模型。
- `node test/export-copy-runtime-live.mjs`：8 項 live 檢查通過。實際 fork helper 建立兩份分支，再分別由真實 RPC `--resume` 與 daemon create／attach 讀取；確認只取得選定訊息之前的 active branch、還原草稿文字、排除其他分支及後續回覆、來源 bytes 不變。取得的訊息驗證兩種 Markdown formatter。
- Live 測試只使用隔離 fixtures，不呼叫模型、不修改使用者 session 或設定、不 shutdown daemon；只清理測試建立的 worker 與檔案。
- 真實 VS Code 剪貼簿、原生 Save Dialog 與人工操作尚未驗證；不將 mock 或 SDK 測試宣稱為 live UI 驗證。部分平台的原生 Save Dialog 也會確認覆寫，因此可能與 Brief 的明確確認重複。

## runtime 有能力，Brief 尚未接入

Remote Procedure Call（RPC）的標準輸入輸出與 daemon 路徑能力不同。實作時確認目前顯示的 session、唯讀限制、執行中操作、取消與錯誤回報，不可只驗證其中一條路徑。

| 指令 | 狀態 | 已知底層能力 | 實作前討論 |
| --- | --- | --- | --- |
| `/fast` | 待討論 | daemon service tier 設定 | 支援模型、費用提示、目前狀態呈現 |
| `/scoped-models` | 待討論 | daemon 模型範圍設定 | Brief 是否需要循環模型？與 favorites 的差異 |
| `/import` | 待討論 | daemon JSONL 匯入 | 檔案選擇、workspace、匯入後 tab 與 session 行為 |
| `/clone` | 待討論 | clone／fork 能力 | 與 fork 的操作區別、新 tab 與命名 |
| `/tree` | 待討論 | daemon session tree／navigation | 分支樹 UI、切換位置、摘要選項與未送出草稿 |
| `/system-prompt` | 待討論 | daemon system prompt 查詢 | 唯讀 editor 或面板、內容敏感性與複製操作 |
| `/btw`、`/side` | 待討論 | daemon side question 與事件串流 | **UI 呈現優先討論**：側欄、抽屜或獨立區塊？與主對話的區隔、追問、關閉／取消、session 切換後保留方式 |
| `/rlm-max-depth` | 待討論 | daemon 深度查詢／設定 | session 與 global 範圍、數值驗證與即時狀態 |
| `/heartbeat` | 待討論 | 兩條路徑都有排程方法 | 建立／狀態／暫停／恢復／停止；時區、投遞方式與確認 |
| `/heartbeats` | 待討論 | 排程列表與管理方法 | 單 session 或跨 session 視圖、user／agent 排程區分 |
| `/reload` | 待討論 | daemon 資源 reload | 與 Restart Agent 的區別、清單更新與執行中行為 |
| `/settings` | 待討論 | 部分獨立 runtime 設定方法 | Brief 設定與 runtime 設定的界線、儲存範圍與入口 |

## 需要前端或 CLI 整合

| 指令 | 狀態 | 實作前討論 |
| --- | --- | --- |
| `/mcp` | 待討論 | Model Context Protocol（MCP）連線管理的範圍、認證、設定入口與錯誤呈現 |
| `/share` | 待討論 | 分享管道、內容預覽、敏感資訊及上傳前明確確認 |
| `/logs` | 待討論 | Brief／runtime logs 的區分、開啟位置與不存在時的提示 |
| `/traces` | 待討論 | 設定、預覽、上傳流程及敏感資訊處理 |
| `/changelog` | 待討論 | 顯示 Brief 或 runtime 的版本紀錄，入口如何區分 |
| `/hotkeys` | 待討論 | 顯示 Brief／VS Code 快捷鍵，不照搬終端快捷鍵 |
| `/update` | 待討論 | Brief 與 runtime 分開更新、確認步驟、執行中 session 影響 |
| `/fullscreen` | 待討論 | 終端語意不直接適用；先決定是否需要 Brief 對應操作 |
| `/quit` | 待討論 | 關閉 view、離開 session 與停止 agent 必須區分；不可等同 daemon shutdown |

## 共通待討論事項

- 已知但未支援的內建指令：是否明確攔截並提示，避免被當成一般 prompt？如何避免擋住 extension 指令？本次不修改。
- 選單呈現：目前最多顯示 12 項；指令增加後要如何搜尋與瀏覽？本次保留既有行為。
- 參數提示、別名、未知參數與多行輸入：按每個 Brief 操作決定，不先建立通用解析框架。
- 上游共有 37 個公開 canonical 指令、5 個 alias；本表涵蓋這些項目並另列 Brief 的 `/stash`。3 個隱藏終端指令不納入目前範圍。

## 原始碼依據

- Brief：`webview/composer.ts`、`src/session/session-controller.ts`、`src/session/session-compact.ts`。
- Prime Agent 0.9.4：`dist/core/slash-commands.js`、`dist/modes/agent-connection/snapshot.js`、`dist/modes/rpc/rpc-mode.js`、`dist/modes/daemon/daemon-mode.js`。
