# 空白對話 reload：root cause 審核

## 結論

新對話先取得 ID，但 ID 不代表它已進入可恢復的歷史清單。未送 prompt 的對話可能被移除或停止 worker；不能直接推論所有空白對話都會刪除檔案。

Brief 的直接問題是：webview 在收到 status 時保存 session ID/path；`ChatPanels.deserializeWebviewPanel` 還原分頁後，`initialize` 一律呼叫 `switchSession`。後者使用 `resolveHistorySession` 驗證歷史清單，而 `session-history.ts` 的 `rowsFromCatalog` 刻意排除 `lifecycle === "draft"`。因此 draft 即使仍有檔案，也可能觸發 `That session is no longer available in history.`，不是只有實體檔案被刪除才會發生。

## Runtime 審核

本機安裝版本為 prime-agent 0.9.4。以下路徑相對於安裝套件根目錄，為靜態原始碼審核，未對使用者的 live session 做破壞性實驗。

- `dist/core/session-manager.js:1112–1165`：newSession 先配置 ID/path，尚未 flush。
- 同檔 `1289–1300`：一般 persistence 等待 assistant，但 session_state/session_info 是例外。
- `dist/modes/daemon/daemon-mode.js:1214–1223`：top-level runtime 綁定後寫入 active session state，可能在第一個 prompt 前建立檔案。
- 同檔 `5254–5315`、`5707–5766`：非 worker 路線最後一個 client detach 後，符合空白且沒有執行中工作等條件時，可能 close 並刪除 sessionFile；並非只看有無 prompt。
- `dist/modes/daemon/daemon-supervisor.js:932–971,4795–4807`：worker 路線最後 detach 可觸發 empty session eviction。
- 同檔 `5492–5572` 與 `daemon-mode.js:5677–5711,6385–6420`：該路線使用 shutdown，保留 resume entry，不等於刪除 JSONL 檔案。

## 實作決策

保留 runtime 的清理規則與一般歷史存取驗證，只修正分頁 reload 的語意：

1. Host 將尚未接受 prompt 的新分頁標記送入 status，webview 隨 session reference 保存 `isNew`。
2. prompt 被接受時立即清除標記；snapshot 若已有 user message，也清除 host 標記。
3. 還原已知未送出 prompt 的分頁時，直接查詢 daemon catalog（不使用會排除 draft 的歷史清單）。若不存在，沿用 `ensureStarted` 靜默建立新 session；若存在，保留原 session。catalog 中的 draft 可通過 reload 專用入口，仍須經過原有 regular-file 驗證，避免遺失已選模型、名稱等設定。
4. 清單查詢失敗仍報錯，不視為對話不存在。已送出 prompt、一般 History 操作與檔案驗證維持原有行為。

這裡的「不存在」是 daemon catalog 找不到該 ID/path，不以一般歷史清單排除 draft 作為替換依據，也不宣稱檔案一定消失。實作不刪除舊檔案、不修改 daemon，也不推測舊版保存狀態是否空白。沒有 `isNew` 標記的舊狀態仍按一般既有對話還原。

## 驗證

- Controller：缺少歷史的 unsent reload 僅建立一個新 session，無 notice；歷史仍存在則使用原 path；catalog failure 不建立替代 session。
- Editor tabs：只有帶明確標記的 reload 啟用替代流程；新 ID 後仍保留空白標記，接受 prompt 後清除。
- Webview：標記保存與接受 prompt 時立即清除；不覆蓋其他保存狀態。
- `npm run typecheck` 通過。`npm test` 在 `transcript-window.test.mjs:114` 失敗（`.earlier-load` 為 null）；使用修改前 `HEAD:webview/main.ts` 重建 webview 後，在相同位置重現，屬本次修改前已存在的問題。失敗前的 suites 與另行執行的後續 suites 均通過。新增的 startup tests 也單獨通過。
- 尚未以 VS Code GUI 手動 reload 驗證。
