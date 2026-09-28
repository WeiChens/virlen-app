/**
 * 链路通讯类型 —— 「这次连接到底是**直连**还是**走了中继**」。
 *
 * 为什么要这个（设置页「已连接」旁边那枚胶囊）：用户看得见「已连接」，却看不见代价 —— 走 TURN
 * 中继意味着**每一个字节都要过服务器转发**（更慢、更吃服务器带宽，还可能是跨洲绕行）。真机上报
 * 「手机上操作很卡」时，第一件要确认的事就是它。而这个事实**只存在于本机 PC 的 ICE 候选对里**，
 * 不信令、不落盘、重连就变 —— 所以是「读一次算一次」，不做缓存。
 *
 * 判定口径（电脑端 host 视角，取 `RTCPeerConnection.getStats()` 的**所选候选对**）：
 * - 候选对任一端 `candidateType === 'relay'` → **中继**（字节确实过了 TURN 服务器）；
 * - `host`（同网段）/ `srflx`（STUN 打洞后的公网映射）/ `prflx`（对端反射）→ **直连**；
 * - 拿不到结论（stats 还没填好、环境不支持）→ `unknown` —— **UI 不猜**，宁可不显示。
 *
 * ⚠️ 本文件的 `classifyLinkKind` 是**纯函数**（喂普通对象数组即可），因为真实 WebRTC 跑不进 CI；
 * 真机上的正确性靠「口径写在这里 + 共享包 rtc-transport 的既有用例」兜住。
 *
 * ## 为什么还要 `LinkKindWatcher`（巡检）
 *
 * 「连上了」不是一次就问完的事：**所选候选对随时会换** ——
 *  - 刚打通那几秒：先成的是 relay 那条（打洞还没探完）→ 随后直连候选对胜出**换成 P2P**；
 *  - 之后任何一环变网（手机 WiFi → 蜂窝）：ICE 重新协商，直连可能又退回中继。
 *
 * 而 `iceconnectionstatechange` **只在状态变时触发**：重新提名 / 重协商后换候选对，状态可以一直是
 * `completed` —— 那一刻一个事件都不会来，胶囊就会一直停在「TURN 中继」上骗人。
 *
 * `RTCIceTransport.onselectedcandidatepairchange` 是规范里专为此存在的精确信号，但它挂在
 * `pc.sctp.transport.iceTransport` 上、还得等 SCTP 建好（数据通道这条路上不一定拿得到），
 * 所以采用「**定时问一次**」兜底：一次 `getStats()` 只有几毫秒，换来的是**类型永远跟得上现实**。
 */

/** 通讯类型：`direct` = P2P 直连；`relay` = TURN 中继；`unknown` = 没拿到结论。 */
export type LinkKind = 'direct' | 'relay' | 'unknown'

/** 一条 stats 记录（`RTCStatsReport` 的 value；只用到少数几个字段）。 */
type StatsEntry = Record<string, unknown>

/** `RTCStatsReport` 的最小形状（测试可喂 Map / 假对象）。 */
export interface StatsReportLike {
  forEach(callback: (entry: unknown) => void): void
}

/** `RTCPeerConnection.getStats()` 的最小形状。 */
export interface StatsProvider {
  getStats(): Promise<StatsReportLike>
}

/** 直连的候选类型：本机候选（同网段）/ 服务器反射（打洞成功）/ 对端反射。 */
const DIRECT_TYPES = ['host', 'srflx', 'prflx']

/**
 * 巡检间隔（毫秒）。
 *
 * 取 3s 而不是更短：变化只影响一枚胶囊，用户感知不到亚秒差异；而 3s 一次 `getStats()` 对一条
 * 数据通道而言开销可忽略（比固定更频繁地问更划算的是「只在链路开着时问」）。
 */
export const LINK_KIND_POLL_MS = 3000

/**
 * 从 stats 全集里判定通讯类型。
 *
 * 顺序刻意如此：
 *  1. `transport.selectedCandidatePairId` —— 标准里**明确**指出「正在用哪条候选对」，最可信；
 *  2. 退而求其次：`nominated` 且 `succeeded` 的候选对（老实现不一定给 `transport` 记录）；
 *  3. 再退：任意 `succeeded` 的候选对；
 *  4. 都没有 → `unknown`。
 */
export function classifyLinkKind(stats: Iterable<StatsEntry>): LinkKind {
  const list = [...stats]
  const pair = selectedPair(list) ?? succeededPair(list)
  if (!pair) return 'unknown'
  // 还没定型的候选对（in-progress / failed）不算结论：此刻「怎么连的」还没确定
  const state = pair['state']
  if (typeof state === 'string' && state !== 'succeeded') return 'unknown'

  const local = candidateOf(list, pair['localCandidateId'], 'local')
  const remote = candidateOf(list, pair['remoteCandidateId'], 'remote')
  const types = [local, remote]
    .map((c) => c?.['candidateType'])
    .filter((t): t is string => typeof t === 'string')

  if (types.includes('relay')) return 'relay'
  if (types.some((t) => DIRECT_TYPES.includes(t))) return 'direct'
  return 'unknown'
}

/**
 * 采一次样（`getStats()` 是异步的）。
 *
 * ⚠️ **不吞异常**：调用方（`PhoneControlService`）需要知道「问不到」，那是 `unknown` 而不是直连。
 */
export async function probeLinkKind(pc: StatsProvider): Promise<LinkKind> {
  const report = await pc.getStats()
  const list: StatsEntry[] = []
  report.forEach((entry) => {
    if (entry && typeof entry === 'object') list.push(entry as StatsEntry)
  })
  return classifyLinkKind(list)
}

/**
 * 通讯类型巡检器 —— 链路开着期间定时问一次「现在是直连还是中继」，变了就上报。
 *
 * 生命周期与链路绑定：`watch(pc)` 开始、`stop()` 结束（换链路 / 断链 / 停用都要 stop）。
 * 不碰 UI、不碰 store，只负责「问」与「去重」，因此能用假 PC + 假时钟完整覆盖。
 */
export class LinkKindWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private pc: StatsProvider | null = null
  private _kind: LinkKind = 'unknown'

  constructor(
    private readonly onChange: (kind: LinkKind) => void,
    private readonly intervalMs: number = LINK_KIND_POLL_MS,
  ) {}

  /** 当前结论（`unknown` = 没结论，或巡检已停）。 */
  get kind(): LinkKind {
    return this._kind
  }

  /** 开始巡检（换链路时直接再调一次，旧的会先停）。不会等一个间隔：立刻先问一次。 */
  watch(pc: StatsProvider): void {
    this.stop()
    this.pc = pc
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
  }

  /**
   * 停：链路没了 →结论跟着作废（会广播 `unknown`，UI 据此收起胶囊）。
   *
   * 「换个链路」也是这个动作（`watch` 内部先调它），所以不会残留上一条链路的结论。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.pc = null
    this.publish('unknown')
  }

  /**
   * 探一次并上报。
   *
   * ⚠️ 两个刻意行为：
   *  - 链路**还开着**时读到 `unknown`（stats 还没填好 / 正在重协商）→ **保留上次结论**：
   *    一次读不到不等于「不知道怎么连的」，而在直连/中继之间闪一下比稍旧更难受；
   *  - `await` 期间链路可能已换/已停 → 认准「还是这个 PC」再写回。
   */
  async poll(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    let kind: LinkKind = 'unknown'
    try {
      kind = await probeLinkKind(pc)
    } catch {
      /* `getStats()` 失败 = 拿不到结论，不等于「直连」 */
    }
    if (this.pc !== pc) return
    this.publish(kind)
  }

  private publish(kind: LinkKind): void {
    // 开着链路时的 `unknown` = 这一次没读到（见 `poll` 的说明）→ 保留上次结论
    if (kind === 'unknown' && this.pc) return
    if (kind === this._kind) return
    this._kind = kind
    this.onChange(kind)
  }
}

/** 标准路径：`transport` 记录里明确指出的那条候选对。 */
function selectedPair(list: StatsEntry[]): StatsEntry | undefined {
  const transport = list.find(
    (s) => s['type'] === 'transport' && typeof s['selectedCandidatePairId'] === 'string',
  )
  const id = transport?.['selectedCandidatePairId']
  if (typeof id !== 'string') return undefined
  return list.find((s) => s['type'] === 'candidate-pair' && s['id'] === id)
}

/** 兜底路径：`nominated`（已被选中的那条）+ `succeeded`；没有 nominated 就取第一条 succeeded。 */
function succeededPair(list: StatsEntry[]): StatsEntry | undefined {
  const pairs = list.filter((s) => s['type'] === 'candidate-pair' && s['state'] === 'succeeded')
  return pairs.find((p) => p['nominated'] === true) ?? pairs[0]
}

/**
 * 按 id 找候选记录。
 *
 * `localcandidate` / `remotecandidate` 是 2014 版规范里的类型名（部分老实现仍在用），
 * 一起认下来 —— 认不出的代价是「明明是直连却显示未知」。
 */
function candidateOf(list: StatsEntry[], id: unknown, side: 'local' | 'remote'): StatsEntry | undefined {
  if (typeof id !== 'string') return undefined
  const kinds = side === 'local' ? ['local-candidate', 'localcandidate'] : ['remote-candidate', 'remotecandidate']
  return list.find((s) => s['id'] === id && kinds.includes(s['type'] as string))
}
