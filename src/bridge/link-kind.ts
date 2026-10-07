/**
 * 链路通讯类型（P2P 直连 / TURN 中继）—— 电脑端对**共享包实现**的再导出。
 *
 * 判定口径必须两端唯一：历史上本文件是完整本地实现、手机端另抄一份，两份漂移就会出现「手机说直连、
 * 电脑说中继」。自 virlen-remote@0.1.1 起实现与单测都搬进共享包（virlen-remote/src/transport/link-kind.ts），
 * 两端引用同一份。本文件保留为**出口别名**，对外导出面不变。
 *
 * ⚠️ 不要再往这里加判定逻辑：任何口径改动应改共享包（先让那边的单测说话）。
 */
export {
  classifyLinkKind,
  probeLinkKind,
  LinkKindWatcher,
  LINK_KIND_POLL_MS,
  // §33：链路类型 → 传输档位（full / lean）。放这里的理由同上：档位是两端都读的口径。
  transferTierOf,
  /** §33 能力名：手机端声明它 = 能渲染省略标记；电脑端列出它 = 会按档位裁剪。 */
  MESSAGE_DETAIL_CAPABILITY,
} from 'virlen-remote'
export type { LinkKind, TransferTier } from 'virlen-remote'
