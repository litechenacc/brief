# 訂閱額度 `/quota`

在 Brief 輸入 `/quota`，查詢 Codex 與 Grok 的已用百分比、剩餘百分比、下次重置時間與查詢當時的剩餘時間。卡片提供 **Refresh**、**Copy**、**Close**；不自動輪詢，也不寫入對話。

- Codex：查詢 `https://chatgpt.com/backend-api/wham/usage`，從 `rate_limit.primary_window` 與 `secondary_window` 選取 `limit_window_seconds = 604800` 的每週窗口。`used_percent` 是已用量；缺少每週窗口時顯示未提供，不把 5 小時窗口當成 weekly。
- Grok：沿用 `xai-oauth` 的已存 OAuth 登入，先查 `https://cli-chat-proxy.grok.com/v1/user`，再以 `x-userid` 查 `/billing?format=credits`。顯示 `config.creditUsagePercent`、`currentPeriod.type` 與 `currentPeriod.end`（缺少時使用 `billingPeriodEnd`）。每月額度不標為每週；缺值不當成 0。
- Grok 不是 `XAI_API_KEY` 對應的 API billing。Brief 不提供另一套登入或 token refresh；token 過期時，請透過既有 xai-oauth 登入流程更新後再按 Refresh。
- 使用 `brief.command` 對應的 Prime SDK `AuthStorage`；Codex 可由 SDK 更新 OAuth token。查詢在 extension host 所在主機的獨立 Node 程序執行（Remote SSH 時在遠端），憑證與 Grok user ID 不傳入 webview、不輸出至 logs。
- 不載入或呼叫 harness extension，不改其設定。`/usage` 仍是原有 session token／cost 統計。

這些 Web API 沒有官方穩定契約，可能因服務、方案、認證或 proxy client 版本變更而失效。Grok proxy client 版本沿用參考實作的 `0.2.101`，亦沿用其 `PI_XAI_CLIENT_VERSION` 環境變數。

## Codex banked resets

Codex 卡片會顯示 `rate_limit_reset_credits.available_count` 的 **Banked resets**；缺值顯示 **Not provided**，不推算成 0。有可用次數時，可按 **Apply reset**，並在 VS Code 確認視窗中確認。

此操作會使用目前登入 Codex 帳號的一次 reset，刷新符合條件的 5 小時與每週額度。沒有需要重置的窗口時，服務會保留該次 reset。Brief 只在確認後呼叫 `POST /backend-api/wham/rate-limit-reset-credits/consume`，送出 `redeem_request_id`，不自動重試；結果不確定時，同一 extension host 執行期間的手動重試沿用同一 ID。重新載入 VS Code 後不保留此 ID，請先至官方用量頁確認結果，不要盲目重試。

套用後重新查詢額度。此功能不載入 harness extension，也不新增 Codex CLI 依賴。開發驗證不執行實際 consume 操作。

## 參考

- [OpenAI banked resets 說明](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work) 與 [官方 backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)。
- Codex：使用者提供的 `prime-setup/extensions/usage/store.ts` 與本機 `pi-codex-status` 的 window schema。
- Grok：[pi-grok](https://github.com/stnly/pi-grok) 的 `usage.ts`、`account.ts`、`models.ts`。Brief 自行實作最小查詢，不匯入該插件。
