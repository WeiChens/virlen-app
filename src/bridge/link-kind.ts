/**
 * 链路通讯类型（P2P 直连 / TURN 中继）—— 电脑端对**共享包实现**的再导出。
 *
 * ## 为什么这里只剩「再导出」
 *
 * 判定口径必须两端唯一。历史上本文件是一份**完整的本地实现**，手机端
 * （`virlen-mobile/src/lib/rtc-stats.ts`）另抄了一份副本 —— 两份一旦漂移，就会出现
 * 「手机说直连、电脑说中继」，两台设备互相打脸，而用户无从判断该信谁。
 *
 * 自 `virlen-remote@0.1.1` 起，判定实现（`classifyLinkKind` / `probeLinkKind` /
 * `LinkKindWatcher` / `LINK_KIND_POLL_MS`）与它的单测一起搬进了共享包
 * （`virlen-remote/src/transport/link-kind.ts`），电脑端与手机端都引用同一份，改一处两端同时生效。
 *
 * 本文件保留为**出口别名**：`@/bridge` 的对外导出面不变，调用方（设置页 store / `PhoneControlService`）
 * 无需改动 —— 只是“来源”从本地实现换成了共享包。
 *
 * ⚠️ **不要再往这里加判定逻辑**：任何口径改动都应改共享包（先让那边的单测说话）。
 */
export {
  classifyLinkKind,
  probeLinkKind,
  LinkKindWatcher,
  LINK_KIND_POLL_MS,
  /*
   * §33：链路类型 → **传输档位**（`full` / `lean`）。
   *
   * 它放在本文件（而不是调用方现算）的理由与上面完全一致：档位是**两端都要读**的口径
   * （电脑端据此裁剪、手机端据此解释「工具输出为什么是空的」），错一份就是自相矛盾。
   */
  transferTierOf,
  /** §33 的能力名：手机端声明它 = 能渲染省略标记；电脑端列出它 = 会按档位裁剪。 */
  MESSAGE_DETAIL_CAPABILITY,
} from 'virlen-remote'
export type { LinkKind, TransferTier } from 'virlen-remote'
