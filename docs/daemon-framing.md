# Daemon framing

Brief 的 `DaemonSidecar` 支援兩種 socket framing，依連線收到的第一個 hello 自動選擇，不使用版本號或額外設定。

| 格式 | 讀取 | 回送命令 |
| --- | --- | --- |
| JSONL | 以 LF 分隔 UTF-8 JSON | 既有 command envelope 加 LF |
| Binary | 8-byte prefix、JSON header、payload | command header 加既有 JSONL command envelope |

## Binary 格式

Prefix 的前 4 bytes 是 header 長度，後 4 bytes 是 payload 長度，皆為 unsigned 32-bit big-endian。
長度按 bytes 計算，不按字元數計算。

收到的 routing header 為 `{ kind: "outbound", outboundType, payloadEncoding: "jsonl" }`；
payload 是與 JSONL 模式相同的 response／event JSON。
傳出的 header 為 `{ kind: "command", requestId, commandType }`，`commandType` 是內層命令，例如 `get_state`。

Prime 合法的 binary header 上限是 1 MiB，所以 prefix 第一個 byte 為 NUL；JSONL 不會以 NUL 開頭。
Brief 由此選擇 decoder，收到完整 frame 才解析 JSON，不會先發送探測命令。
TCP 分段、同一批資料包含多個 frame，以及分段的 UTF-8 字元，都以 Buffer 累積處理。
重新連線時清除 buffer 與 framing 狀態，重新依 hello 判斷。

延續 Brief 原有的 64 MiB record 上限；binary 的 header 與 payload 合計受相同上限約束。
目前只處理 JSONL payload，不處理 supervisor 內部的 compact `assistant-delta` encoding。

## Endpoint 與認證不是 framing

已檢查的 Prime 實作依 endpoint 角色選擇格式：

- 公開 supervisor：JSONL，提供 list／create／attach 等能力。
- 內部 worker：binary，要求正式的 `peer_auth` 或 `worker_auth`。

讀懂 worker hello 不代表已授權存取該 worker。
本次只修改 framing 讀寫，不新增票證取得、worker 發現或自動認證，也不更改既有 session 路由。
一般 Brief chat 仍連公開 supervisor。

## 實驗環境

啟動隔離 supervisor 時，不得繼承執行 harness 的 `PRIME_AGENT_INTERNAL_DAEMON_WORKER` 等 worker 環境。
先前實驗正是因為繼承該環境而啟動成 worker，不能據此判定 Prime 更新破壞公開 JSONL 協定。
實驗應固定 CLI 路徑、使用獨立 socket／agent directory，並透過 supervisor 核發的 ticket 驗證 binary worker，不使用既有 session 的憑證。

## 驗證結果

以固定的 Prime 0.9.4 CLI 啟動乾淨的私有 supervisor：

- JSONL hello、list、create、attach、get_commands 與 usage mount 成功。
- 使用 supervisor 核發的單次 ticket，透過同一個 DaemonSidecar implementation 連接 binary worker，peer_auth 與 get_state 成功。
- Chromium 中的 usage 面板以 binary worker 處理 refresh，剩餘額度由示範值 68% 更新成 42%。
- 操作前後 get_messages 均為 0 筆，未收到 agent turn 事件。
- 同一個 client 從 binary worker 斷線，再連 JSONL supervisor，重新辨識格式並取得同一 session 的 state。

使用本機示範 endpoint，沒有使用真實帳號憑證。這是實際 daemon 與瀏覽器實驗，不是完整 VS Code Extension Host 的端對端操作驗證。
