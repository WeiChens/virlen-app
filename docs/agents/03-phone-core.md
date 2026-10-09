# 手机控制（电脑侧 Bridge）· 链路与配对（§5.9 之一）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

### 5.9 手机控制（电脑侧 Bridge）

手机扫码配对后**远程操作本机**（看会话 / 发消息 / 应答工具审批）。电脑侧只做「接口层」，传输交给自维护的 npm 包 `virlen-remote`。

- **装配入口（唯一）**：`src/bridge/index.ts::startPhoneBridge(endpoint, opts)` —— 在一条已建立的 `Endpoint` 上装出三件套：`registerHostHandlers(source)`（`host.*` RPC）、`createStoreBridge(emit)`（`host.event.*` 推送）、配对 / ACL / 审计。
- **生产接线**：`src/ui/store/phoneControlStore.ts` 实例化 `PhoneControlService` / `PairingStore` / `AuditLog`；设置页 `ui/pages/Settings/phone-control-settings.tsx` 是 QR、设备列表、审计记录的入口。
- **传输**：WebRTC（`virlen-remote`）+ SSE 信令（`SseSignalingClient`）。信令基址存 `localStorage['virlen.phone.signal']`（默认 `https://virlen.cn/api/rtc/`），自定义 ICE 同样落 `localStorage`（清应用数据即回服务端默认，不丢功能）。
- **落盘**：配对表 / 设备身份 / 审计经 Rust 命令持久化 —— `cmd_phone_{pairing,device,audit}_*`（`src-tauri/src/commands/phone_{pairing,device,audit}.rs`，已在 `lib.rs` 注册）。

| 文件（`src/bridge/`，17 个） | 职责 |
|---|---|
| `index.ts` | 装配入口 + 对外导出面 |
| `phone-control.ts` | 电脑端常驻服务：握手、配对请求、拒签踢链、状态推送 |
| `host-source.ts` | 真实 `HostDataSource`（**会话域**）：把手机 RPC 落到本机 `sessionStore` / `chat-service` |
| `file-source.ts` / `file-tauri.ts` | 工作目录文件（**文件域**）：浏览 / 分块读 / 原子上传；`file-source` 是对接层，`file-tauri` 是 Tauri 版文件端口 |
| `store-bridge.ts` | mobx `reaction` 旁路订阅本机 store，把变化推给手机 |
| `dto.ts` | DTO 投影（**白名单**出参，不整包外发内部结构） |
| `pairing.ts` / `device-identity.ts` | 配对凭证与电脑设备身份（「重新获取还是同一台」） |
| `acl.ts` / `approval-policy.ts` / `audit.ts` | 授权策略（**默认拒绝**）/ 审批分级判定 / 操作留痕 |
| `interaction-registry.ts` / `interaction-source.ts` | 待应答交互注册表（手机应答与本机弹窗同源；**注册表归服务持有、不归链路**，见下） |
| `telemetry.ts` / `subscription.ts` / `link-kind.ts` | 通讯层埋点 / 订阅计数 / 链路类型（P2P 直连或 TURN 中继） |

- **依赖方向**：`src/bridge/` 依赖 `services` / `domain` / `infrastructure` / `ui/store` / `utils` / `events`；而 `ui/store/phoneControlStore.ts` 反过来 import `@/bridge` —— 两者**双向依赖**，改动时留意模块初始化顺序。
- **服务状态机（`phone-control.ts`，设置页那颗胶囊的真相）**：`waiting → verifying → connected`，另加两个否定态（`rejected` 谁被拒了 / `error` 链路故障）。
  ⚠️ **`error`（链路已关闭）不是终点**：`closed` 是终态 —— 那条 PeerConnection 已 `failed`/`closed`，而 host 侧下一次协商会复用它（共享包 `rtc.ts::ensurePC` 的 `if (this.pc)`），于是**手机再也连不回来**。所以 `closed` 后过 `LINK_CLOSED_RECOVER_MS`（3s）仍未真正恢复就自动 `dropLink()` 原地重开（票据不变、回到「等待手机连接…」）。到点复核「链路没换过 / 服务还开着 / 没有拒绝结论 / **本链路仍带着 `linkClosed` 标记**」，而该标记**只有链路真的回到 `open`（会重新握手）才清** —— 「回到 `connecting`」不算恢复，理由见下一条；拒绝结论生效期间不安排（拆链由踢链负责，`phone-link-recover.test.ts` 钉住四条）。
- **「等待手机连接…」可能是一句假话：电脑端必须对账「自己还在不在房间里」**（2026-10 真机缺陷：手机连过一次后断开，此后电脑端一直显示「等待手机连接…」，而手机端显示「电脑不在线」、怎么点连接都连不上 —— 两边都没看错，房间里真的已经没有这台电脑了，错的只是电脑端以为自己只是在等人）。两个成因分别堵在两层：
  1. **迟到的 `connecting` 撤销了自愈**：`closed` 是终态，电脑端据此排好 3 秒后的原地重开；而紧跟其后的 `connecting` 往往只是**拆链的余音**（对端离开的 `peer-left`、被关掉的 DataChannel 的 `close` —— 后者在真实浏览器里是**异步投递**的）。旧实现让它把状态写回「等待手机连接…」，复位到点一看「已经不是 `error` 了」就放弃 → 这条链路再也回不来（只有用户去设置页关一次再开）。现在复位只认 `linkClosed` 标记，且 `connecting` 期间状态保持「出错（链路已关闭）」、不写「等待」。
     共享包侧也修了同一个根（`rtc.ts::teardownPeer`）：**主动拆除一律静默**（先摘监听器再 `close()`），要表达什么状态由调用点显式 `setState` 说明 —— 否则每次「手机主动走开」都会被记成链路故障、白重建一条（三个回归用例在 `virlen-remote/tests/rtc-transport.test.ts`，其中假 WebRTC 的 `close()` 已改为**异步投递**，与浏览器一致）。
  2. **从头到尾没有事件**（SSE 事件流静默死掉：代理超时 / 服务重启 / 换链那一刻网络未就绪）：状态机无从得知「信令服务已经不认识我了」。故服务按 `ROOM_PRESENCE_CHECK_MS`（20s；**只在本机没有已授权的手机连着时**）`POST /status` 反查自己（`verifyRoomPresence`，注入点 `options.probeRoom`；设置页打开那一刻也会对一次账 —— 用户正盯着那颗胶囊）。服务端明确说「不在」→ 如实报「出错（信令连接已断开）」并原地重开；**问不到（`null` / 请求抛错）一律不动作**（宁可漏判也不误拆）。
     配套（共享包 `fetchHostOnlineMap`）：**「问不到」不再被当成「电脑不在线」** —— 旧实现 `?? false` 会让名单上每一台都显示「不在线」，哪怕只是这次查询失败；现在缺键 = 未知，手机端登录页显示「状态未知」。
     回归：`src/tests/bridge/phone-room-presence.test.ts`（含三条「防修过头」：手机主动走开不算故障 / 链路真的回到 `open` 就不白拆 / 有手机连着时自检不动链路）。
- **手机端重连令牌必须是凭证（`grant`），不是一次性票据**：扫码配对成功时 `host.hello` 会回传凭证，手机端必须把它**同时**写进「设备记录」与「重连参数」（`virlen-mobile/src/store/connection.ts` 的 `lastOptions.token`）。
  ⚠️ 只写设备记录、重连参数仍留着那张票 → 票在那次配对里已被电脑端消费（`redeemTicket` 删票），此后每次重连 / 重新授权都拿**作废的票**握手：电脑端 `pairing.authorize` 判 `ticket-expired`（状态进 `rejected`「已拒绝接入（二维码已过期）」），手机端据 `HARD_DENIALS` 退回登录页并提示「重新扫码」——而两边列表里那台手机都还在（配对记录本身是好的）。真机反馈正是这三个看似矛盾的现象同时出现。回归用例 `virlen-mobile/src/tests/pairing-token-refresh.test.ts`。
- **推送是「变化驱动」，不是「状态驱动」（改动时最容易踩的点）**：`store-bridge.ts` 四条通道全部靠 mobx `reaction` 推**变化**，而订阅登记表（`subscription.ts`）是**普通 Set（非 observable）**——**订阅本身不触发任何推送**。所以「订阅那一刻的现值」必须由 `host-source.ts` 的 subscribe / create 路径显式补一次（`storeBridge.pushRuntime`）。
  少了这一帧的后果是「手机看得见进度、却看不见状态」：会话在手机没订阅的那段时间里**出过的错**（`RuntimeDTO.error`）、**被暂存的 run**（`paused`）、甚至 `working` 的初值都不会到达手机——打开那个会话只看到一个没有任何解释的空会话（手机侧 `virlen-mobile/src/store/chat.ts` 的 `sessionError` 就是这条通道的落点）。
