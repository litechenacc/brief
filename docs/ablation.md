# 既有插件消融紀錄

範圍：現有聊天插件；不涉及 PRD，也不新增架構或 dependencies。

## 本輪實驗

| 項目 | 消融與驗證 | 結果 |
| --- | --- | --- |
| 測試清單 | release 改呼叫 `npm test`，不再維護第二份已漏測的清單；納入 hidden-details、working-animation | 修改後完整測試通過 |
| 實作耦合測試 | 移除 export 宣告字串與兩個 CSS 宣告字串斷言；保留 export 行為、DOM 設定切換及 Chromium 版面驗證 | 沒有刪除功能測試；修正 archive 測試的過時順序描述 |
| Dropdown 重建 | hover／方向鍵僅更新 selected class；搜尋與收藏變更仍重建清單 | 新增測試在修改前恰有兩項失敗，修改後通過；六次移動建立元素 **276 → 0**，row／star identity 保持 |
| Host dead code | 移除永遠為 true 的 rendered 狀態與不可達分支、無 caller 的 promotion 流程、純寫入欄位、無 caller 的 debug method、active getter wrapper | Host 淨減 79 行；七組相關測試通過，保留 owner impersonation 與轉移 rollback |
| Webview dead code | 移除兩個未使用欄位、無 caller 的 setChatVisible；Markdown 共用既有 el helper | 不改 Markdown 安全邊界或顯示行為；納入完整回歸驗證 |

元素建立數由既有 happy-dom harness 計數 `createElement`／`createElementNS`，不是整體 UI 延遲 benchmark。這次選取仍需查詢 DOM，沒有宣稱 O(1)。

## 第一輪結束時的後續候選（追加輪次結果見下方）

- `webview/main.ts`：相同 session 的 status 重複呼叫 `setState`。先加寫入次數與 session identity 切換測試，再消融多餘寫入。
- 舊 RPC 分支：目前 startup 直接 `createResident` → daemon attach，但部分測試仍注入 RPC client。先釐清設定與 extension UI 功能如何映射到 daemon，再決定刪除範圍；不能把 stub 測試當成 production caller。

本輪保留 session routing、資料刪改防護、transport framing、owner visibility、附件與位置切換等有效回歸測試。

## 最終驗證

- `npm run typecheck`、`npm test`（含兩個 Chromium 測試）、`bash -n release.sh`、`git diff --check` 全部通過。
- Production build 通過；前後均使用 `SOURCE_DATE_EPOCH=0 node esbuild.config.mjs --production`。

| Bundle | 修改前 bytes | 修改後 bytes |
| --- | ---: | ---: |
| `dist/extension.js` | 133,213 | 132,058 |
| `media/main.js` | 126,201 | 126,092 |

沒有執行 `test:live`、VS Code Extension Host 手動操作或發布；因此不宣稱完整 daemon 端對端驗證。

# 追加五輪消融

以下五輪不含上方第一輪。每輪先通過驗證，才進入下一輪修改。

## 第 1 輪：相同 session 不重複持久化

- 比較既有儲存的 sessionId／sessionFile，僅 identity 改變才 setState；不新增 cache。
- 回歸測試修改前失敗：21 次相同 identity status 造成 21 次寫入；修改後只有 1 次。
- 路徑改變、session 改變各寫入一次；保留 historyFolds；不完整 status 不清除 identity。
- `npm run typecheck`、`npm test` 通過。

## 第 2 輪：只編譯需要的 bundle

- 三份相同 Node test build 設定合併為固定 entryPoints；不新增 factory。
- Build 設定淨減 20 行；一般 build 呼叫 6 → 4，production 6 → 2。
- 暫存工作目錄實跑：一般 build 的六個路徑齊全；production 僅 extension.js／main.js。Watch instrumentation 確認仍只監看 ext／web。
- 完整測試與 typecheck 通過；另存 `/tmp` 的 VSIX 驗證通過，原 VSIX 不變。
- 打包檢查另發現 AGENTS.md 與 scripts/verify-vsix.py 被帶入；以現有 .vscodeignore 排除兩者。`vsce ls` 的九個檔案與既有 release allowlist 完全一致。

## 第 3 輪：純函式測試直接載入記憶體 bundle

- Parser 直接 bundle webview-message.ts，不再載入 ChatPanels 或攔截全域 Module._load。
- Parser、Markdown export、image-fit 都使用現有的 in-memory ESM/data URL 寫法；不新增共用測試框架。
- 三份測試淨減 33 行，所有既有 assertions 保留。
- 三份測試原本建立三個暫存 bundle，其中兩個目錄會殘留；現在不建立暫存 bundle。獨立 TMPDIR 實跑，殘留目錄 2 → 0。
- 三份 targeted tests、typecheck、完整 npm test 全部通過。

## 第 4 輪：刪除未接線的 host 程式碼

- 移除純寫入的 locatedAgent／intentionalStop、無 caller 的 rosterUnsubscribe、未接線的 onOtherMessage 與僅供它使用的 isForegroundRpcClient。
- 查核所有 tracked 文字、computed dispatch 與 prototype mixin；實際 daemon 事件入口仍是 onDaemonEvent。
- 淨減 54 行，沒有修改測試。保留 onExtensionUiRequest、觀察結束恢復、owner identity 與其它 RPC／daemon 路徑。
- typecheck、完整 npm test、git diff --check 通過。測試後另清除一行孤立註解，納入最後整體驗證。

## 第 5 輪：status 只做必要的 DOM 更新

- Model unchanged guard 改比較既有的完整 label，不拿截短顯示文字與原始名稱相比；不新增 cache。
- Context 容量與 threshold 在一次 setContext 中更新，再共用既有 threshold setter 完成單次 render；threshold-only 訊息入口保留。
- 新增回歸測試先在修改前失敗（三項）；修改後長 label 三次相同 status 的文字節點替換 **3 → 0**，context 每次 status 替換 **2 → 1**。
- 保留 text node identity，名稱改變仍更新，model identity 改變仍更新能力；context pending、zero、暖色及獨立 threshold 更新的既有測試通過。
- typecheck、完整 npm test（含兩個 Chromium 測試）通過。

以上次數來自 happy-dom 的 MutationObserver／setState spy，不是整體插件的速度倍數。五輪沒有新增 dependencies 或測試框架。

## 五輪總驗證

- 最後重跑 typecheck、完整 npm test、production build、production webview 測試、release shell syntax、git diff --check，全部通過。
- VSIX 寫至 `/tmp/brief-five-rounds/brief-five-rounds.vsix`；verify-vsix 通過，壓縮檔內只有預期九個 extension 檔案，兩個 bundle 與 production build bytes 完全一致。
- 原有 VSIX 未覆寫；未安裝、commit 或發布。未跑 live daemon／VS Code Extension Host 手動驗證。

| Production bundle | 追加五輪前 bytes | 五輪後 bytes |
| --- | ---: | ---: |
| `dist/extension.js` | 132,058 | 131,057 |
| `media/main.js` | 126,092 | 126,153 |
