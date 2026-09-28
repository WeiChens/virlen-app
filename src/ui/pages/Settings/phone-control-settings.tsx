/**
 * phone-control-settings — 设置 → 手机控制
 *
 * 启用后展示配对二维码（含票据 / 信令基址 / 房间号），并在此确认手机的绑定请求。
 * 覆盖 `phoneControlStore`；真机连接状态由服务回调驱动。
 *
 * 视觉结构（自上而下）：开关卡片 → 扫码配对卡片 → 高级（ICE 折叠）→ 已绑定手机 → 操作记录，
 * 最后是被手机配对请求唤起的确认弹窗。细节（配对链接、ICE 文本）一律收进折叠区，
 * 首屏只留「现在能不能连、怎么连」。
 */
import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { observer } from 'mobx-react-lite'
import { PAIRING_TICKET_TTL_MS, buildPairingUrl, describeGrantRemaining } from 'virlen-remote'
import { phoneControlStore } from '@/ui/store/phoneControlStore'
import { DEVICE_NAME_MAX, type PhoneControlStatus } from '@/bridge'
import Toggle from '@/ui/components/shared/Toggle'
import { showToast } from '@/ui/components/shared/Toast'
import PhoneSvg from '@/ui/components/icons/PhoneSvg'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import type { AuditEntry, PairedDevice } from '@/bridge'
import { t, tpl } from '@/ui/i18n'
import './phone-control-settings.scss'

/** 二维码画布尺寸（px）。画布属性与 CSS 显示尺寸保持同一个值，否则模组会被重采样糊掉。 */
const QR_SIZE = 200

/** 票据总时长（秒）。倒计时进度条按它换算比例 —— 口径取自共享包，此处不再写死一个 300。 */
const TICKET_TTL_SEC = PAIRING_TICKET_TTL_MS / 1000

/**
 * 状态胶囊的文案。
 *
 * ⚠️ `waiting` 与 `verifying` 是两件事，不能合成一句：「在等一台手机连上」（没人接入）与
 * 「有人接入了、正在验它是谁」（链路已通、等着 `hello` 出结论）对用户的意义完全不同。
 * `rejected` 更是一个**否定结论**（那台手机已不许可），必须一眼看见 —— 以前这几件事共用
 * 「等得手机连接…（链路已建立，等待手机握手…）」，用户读到的是「我在等它连上」，
 * 而事实往往是「刚才被移除的那台又摸进来了」。
 */
const STATUS_TEXT: Record<PhoneControlStatus, string> = {
  disabled: '已停用',
  waiting: '等待手机连接…',
  verifying: '正在验证接入的设备…',
  connected: '已连接',
  rejected: '已拒绝接入',
  error: '出错',
}

/**
 * 通讯类型文案（只在**真的连上且有结论**时显示）。
 *
 * 直连 / 中继的差别用户能感知：中继意味着字节全部经 TURN 服务器转发（更慢，且吃服务器带宽）。
 * 排查「手机操作很卡」时，这是第一个要看的结论；`unknown` 不在表里 —— 没结论就不显示。
 */
const LINK_TEXT: Record<string, string> = {
  direct: 'P2P 直连',
  relay: 'TURN 中继',
}

/** 通讯类型的解释（悬停提示）：胶囊上只给结论，原因放这里。 */
const LINK_HINT: Record<string, string> = {
  direct: '两台设备已直接打通（局域网或 NAT 打洞），字节不经服务器转发。',
  relay: '网络无法直连，字节经 TURN 服务器转发 —— 能用，但比直连慢。',
}

/** 配对三步（放在二维码旁边，省掉用户「扫完该干嘛」的猜测）。 */
const PAIR_STEPS = ['用手机扫一扫二维码', '手机上确认连接', '本机弹窗点「允许」']

/** 设备 key 缩略（列表里看全串没必要；排查时靠前几位就够定位）。 */
function shortKey(key: string | null): string {
  if (!key) return '旧版手机（未上报 key）'
  return key.length > 14 ? `${key.slice(0, 10)}…${key.slice(-4)}` : key
}

/**
 * 自定义 ICE 的**填写示例**（占位文本）。
 *
 * ⚠️ 这只是占位，不是默认值：默认值由服务端下发（`GET <信令基址>/ice`）。
 */
const ICE_PLACEHOLDER = `[
  { "urls": "stun:your.server:3478" },
  { "urls": "turn:your.server:3478", "username": "user", "credential": "pass" }
]`

/**
 * 一行描述一台已配对手机：头像 + 名字（+ 在线徽标）+ 三个信息胶囊（key / 凭证有效期 / 上次连接）
 * + 行尾操作（改名 / 移除）。
 *
 * `online` = **此刻正连着本机**的那台（`phoneControlStore.activeDeviceId`）——
 * 多台手机时，「哪台在用」比「有哪些」更值得一眼看到。
 *
 * 改名用**行内编辑**而不是弹窗：这里改的只是一个标签，弹窗会把「哪一行被改」这件事盖掉
 * （多台手机时尤其容易点错行）。
 */
function DeviceRow({
  device,
  online,
  onRemove,
  onRename,
}: {
  device: PairedDevice
  online: boolean
  onRemove: () => void
  /** 改名提交（已 trim，且保证与当前名字不同）；真的改没改成由父层提示 */
  onRename: (name: string) => void
}) {
  const last = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '从未'
  /** 是否正在改这一行的名字 */
  const [editing, setEditing] = useState(false)
  /** 编辑草稿（只在编辑态有意义；开始编辑时回填当前名） */
  const [draft, setDraft] = useState(device.name)
  const inputRef = useRef<HTMLInputElement>(null)

  // 进入编辑就聚焦并全选：用户想改整个名字时直接打字即可覆盖，想微调也仍可用方向键
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const startEdit = () => {
    setDraft(device.name)
    setEditing(true)
  }

  /**
   * 提交：空名 / 没改都算「取消」（保存按钮在空名时本来就是禁用态）。
   *
   * ⚠️ Enter 与随后的 blur 可能在同一帧内先后触发（与侧边栏行内重命名同一个坑），
   * 这里**不做「只能提交一次」的守卫**，因为 `PairingStore.rename` 本身就是幂等的：
   * 第二遍拿到的名字与已写入的名字相同 → 不发通知、不落盘。
   */
  const commit = () => {
    const name = draft.trim()
    setEditing(false)
    if (name && name !== device.name) onRename(name)
  }

  return (
    <div
      className={`phone-control__device${online ? ' phone-control__device--online' : ''}${
        editing ? ' phone-control__device--editing' : ''
      }`}
    >
      <span className="phone-control__device-icon" aria-hidden="true">
        <PhoneSvg />
      </span>
      <div className="phone-control__device-info">
        <span className="phone-control__device-name">
          {editing ? (
            <input
              ref={inputRef}
              className="phone-control__device-input"
              type="text"
              value={draft}
              // 上限取自 bridge（名字真源），与 store 的截断同一个数
              maxLength={DEVICE_NAME_MAX}
              aria-label={t('手机名称')}
              title={tpl('最多 $__max__ 个字符', { max: DEVICE_NAME_MAX })}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                }
              }}
              onBlur={commit}
            />
          ) : (
            <span className="phone-control__device-name-text">{device.name}</span>
          )}
          {online && (
            <span className="phone-control__device-live">
              <span className="phone-control__device-live-dot" aria-hidden="true" />
              {t('已连接')}
            </span>
          )}
        </span>
        <span className="phone-control__device-meta">
          <span className="phone-control__chip">{shortKey(device.mobileKey)}</span>
          <span className="phone-control__chip">凭证{describeGrantRemaining(device)}</span>
          <span className="phone-control__chip">上次连接 {last}</span>
        </span>
      </div>
      <span className="phone-control__device-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={!draft.trim()}
              onClick={commit}
            >
              {t('保存')}
            </button>
            <button type="button" className="btn btn--small" onClick={() => setEditing(false)}>
              {t('取消')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--small"
              aria-label={tpl('给「$__name__」改名', { name: device.name })}
              onClick={startEdit}
            >
              {t('重命名')}
            </button>
            <button type="button" className="btn btn--danger" onClick={onRemove}>
              {t('移除')}
            </button>
          </>
        )}
      </span>
    </div>
  )
}

/** 审计条目的时间列（与正文分开渲染，便于对齐成两列）。 */
function auditTime(e: AuditEntry): string {
  return new Date(e.at).toLocaleTimeString()
}

/** 审计条目的正文（保留 `by` / `tier` 等关键信息，便于「谁批了什么」一眼看清）。 */
function auditText(e: AuditEntry): string {
  if (e.kind === 'approval') {
    const who = e.by === 'mobile' ? '手机' : '电脑'
    const what = e.decision === 'allow' ? '批准' : e.decision === 'shelve' ? '暂存' : '拒绝'
    const tier = e.tier === 'high' ? '（高风险）' : ''
    return `${who}${what}${tier}：${e.detail ?? ''}${e.commandPreview ? ` — ${e.commandPreview}` : ''}`
  }
  return `${e.method}${e.detail ? `（${e.detail}）` : ''}`
}

export default observer(function PhoneControlSettings() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const s = phoneControlStore

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !s.payload) return
    void QRCode.toCanvas(canvas, buildPairingUrl(s.payload), { width: QR_SIZE, margin: 1 })
  }, [s.payload])

  // 打开面板时读回磁盘审计（Tauri）；浏览器 harness 下是空操作
  useEffect(() => {
    void s.loadAuditHistory()
  }, [s])

  // 进菜单就换一张新二维码（用户拍板：切到「手机控制」即重新生成）——
  // 挂载时跑一次，之后由 store 的倒计时在到期那一刻自动换新
  useEffect(() => {
    s.onPanelOpen()
  }, [s])

  /** 二维码剩余比例（0–100），驱动进度条。 */
  const ticketPct =
    s.ticketLeftSec == null
      ? 0
      : Math.max(0, Math.min(100, (s.ticketLeftSec / TICKET_TTL_SEC) * 100))

  return (
    <div className="phone-control">
      <header className="phone-control__head">
        <span className="phone-control__head-icon" aria-hidden="true">
          <PhoneSvg />
        </span>
        <div className="phone-control__head-text">
          <h2 className="phone-control__title">{t('手机控制')}</h2>
          <p className="phone-control__sub">
            用手机扫码配对，在外网查看与操作本机 Agent（P2P 加密链路）。
          </p>
        </div>
      </header>

      {/* 主开关：开着还是关着，是本页唯一决定「下面还有没有内容」的东西，故给它一块卡片 */}
      <section className="phone-control__switch">
        <div className="phone-control__switch-text">
          <span className="phone-control__switch-title">{t('启用手机控制')}</span>
          <span className="phone-control__switch-desc">
            {s.enabled
              ? t('已开启：手机可扫码配对并操作本机，关闭会断开当前连接。')
              : t('开启后生成配对二维码；关闭会断开所有已连接的手机。')}
          </span>
          <span className="phone-control__status-row">
            <span className={`phone-control__status phone-control__status--${s.status}`}>
              <span className="phone-control__dot" aria-hidden="true" />
              {STATUS_TEXT[s.status] ?? s.status}
              {s.error ? `（${s.error}）` : ''}
            </span>
            {/*
              通讯类型：状态说「连没连上」，它说「怎么连上的」—— 并排看才完整。
              没结论（`unknown`）时**不占位、不猜**，省得把「不知道」显示成「直连」。
            */}
            {s.status === 'connected' && LINK_TEXT[s.linkKind] && (
              <span
                className={`phone-control__link phone-control__link--${s.linkKind}`}
                title={LINK_HINT[s.linkKind]}
              >
                {LINK_TEXT[s.linkKind]}
              </span>
            )}
          </span>
        </div>
        <Toggle
          size="lg"
          checked={s.enabled}
          onChange={(next) => s.setEnabled(next)}
          ariaLabel={t('启用手机控制')}
        />
      </section>

      {s.enabled && (
        <section className="phone-control__card">
          <div className="phone-control__card-head">
            <h3 className="phone-control__card-title">{t('扫码配对')}</h3>
            <button type="button" className="btn btn--small" onClick={() => s.refreshTicket()}>
              <RefreshSvg fill="currentColor" />
              {t('刷新二维码')}
            </button>
          </div>

          <div className="phone-control__pair">
            <div className="phone-control__qr">
              <canvas ref={canvasRef} width={QR_SIZE} height={QR_SIZE} />
              {!s.payload && <span className="phone-control__qr-hint">{t('生成中…')}</span>}
            </div>
            <ol className="phone-control__steps">
              {PAIR_STEPS.map((step, i) => (
                <li key={step}>
                  <span className="phone-control__step">{i + 1}</span>
                  <span>{t(step)}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* 倒计时：进度条 + 秒数。到期由 store 自动换新，所以文案只说「自动刷新」 */}
          <div className="phone-control__ticket">
            <span className="phone-control__ticket-bar" aria-hidden="true">
              <span className="phone-control__ticket-fill" style={{ width: `${ticketPct}%` }} />
            </span>
            <span className="phone-control__ticket-text">
              {s.ticketLeftSec == null
                ? ''
                : tpl('二维码有效期还剩 $__sec__ 秒（到期自动刷新）', { sec: s.ticketLeftSec })}
            </span>
          </div>

          {/*
            配对链接（`https://virlen.cn/mobile?t=<配对数据>`）—— 既是排查用的，也是「手动输入 / 分享」的复制源。
            既是链接就能被系统相机 / 微信扫开直接配对，数据本体是 `vrp1:` 混淆串（不是明文 JSON）。
          */}
          <details className="phone-control__payload">
            <summary>{t('配对链接（排查 / 手动输入用）')}</summary>
            <textarea
              readOnly
              rows={5}
              spellCheck={false}
              value={s.payload ? buildPairingUrl(s.payload) : ''}
            />
          </details>
        </section>
      )}



      <section className="phone-control__card">
        <div className="phone-control__card-head">
          <h3 className="phone-control__card-title">{t('已绑定的手机')}</h3>
          <span className="phone-control__count">{s.devices.length}</span>
        </div>
        {s.devices.length === 0 && (
          <div className="phone-control__empty">
            <PhoneSvg />
            <p>{t('还没有绑定手机。启用后让手机扫一次二维码即可。')}</p>
          </div>
        )}
        {s.devices.map((d) => (
          <DeviceRow
            key={d.deviceId}
            device={d}
            online={d.deviceId === s.activeDeviceId}
            onRemove={() => s.revokeDevice(d.deviceId)}
            onRename={(name) => {
              // 失败的唯一现实原因是「那一行已不在」（比如刚在别处被移除）——如实告诉用户，不静默
              if (!s.renameDevice(d.deviceId, name)) {
                showToast(t('改名失败：这台手机已不在列表里'), 3000)
              }
            }}
          />
        ))}
        <p className="phone-control__tip">
          改名只改本机显示的标签（手机侧不知道本机给它起了什么名），不影响它的授权与连接。
          移除后该手机立刻断开（若此刻正连着），它手上的授权与旧二维码一并作废 ——
          想再连必须重新扫屏上的新码并由你确认；它自己重连上来的那几次会被直接拒掉
          （状态胶囊会写「已拒绝接入」）。授权凭证当月有效，每次连接自动续期，最长 90 天。
        </p>
      </section>
            {/*
        ICE 配置（§31）：默认值由服务端下发，**客户端源码里不含任何 TURN 凭证**。
        ⚠️ 这里只显示「来源 + 数量」，**不渲染**服务端下发的凭证内容 —— 截图 / 录屏 / 反馈日志
        都可能外流，而 TURN 口令一旦公开就是中继带宽被白嫖。
      */}
      <details
        className="phone-control__ice"
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) s.loadIceText()
        }}
      >
        <summary>{t('高级：ICE 服务器（STUN / TURN）')}</summary>
        <div className="phone-control__ice-status">
          当前生效：{s.iceDetail}
          {s.iceLoading ? '（解析中…）' : ''}
          {s.iceWarning ? ` · ${s.iceWarning}` : ''}
        </div>
        {s.iceCustomError && (
          <div className="phone-control__ice-error">自定义配置有问题：{s.iceCustomError}</div>
        )}
        <textarea
          className="phone-control__ice-text"
          rows={6}
          spellCheck={false}
          placeholder={ICE_PLACEHOLDER}
          value={s.iceText}
          onChange={(e) => s.setIceText(e.target.value)}
        />
        <div className="phone-control__ice-actions">
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => void s.saveIceConfig()}
          >
            {t('保存')}
          </button>
          <button type="button" className="btn btn--small" onClick={() => void s.resetIceConfig()}>
            {t('恢复服务端默认')}
          </button>
        </div>
        <p className="phone-control__tip">
          留空 = 用服务端下发的默认值（信令服务的 <code>GET /ice</code>，配置在服务端 .env）；
          填了就完全用你这份（自建 coturn / 内网 STUN / 公共 STUN 都行）。保存后如果手机控制已启用，
          会重建链路让新配置立即生效（二维码会换一张）。
        </p>
      </details>

      {/*
        操作记录（审计）：手机是「远程全权控制面」，而审批取的是宽松档（手机可批含高风险在内的一切，
        见 docs/phone-control-bridge.md §16.3）—— 因此「谁在什么时候批了什么」必须可见、可回溯。
      */}
      <section className="phone-control__audit">
        <div className="phone-control__audit-head">
          <h3 className="phone-control__card-title">{t('操作记录')}</h3>
          <button
            type="button"
            className="btn btn--small"
            disabled={s.auditView.length === 0}
            onClick={() => void s.clearAudit()}
          >
            {t('清空记录')}
          </button>
        </div>
        {s.auditView.length === 0 && (
          <div className="phone-control__empty">
            <p>{t('还没有操作记录。手机的每次操作与审批都会留在这里。')}</p>
          </div>
        )}
        <ul className="phone-control__audit-list">
          {s.auditView.map((e, i) => (
            <li
              key={`${e.at}-${e.method}-${i}`}
              className={`phone-control__audit-item${e.allowed ? '' : ' phone-control__audit-item--denied'}${
                e.kind === 'approval' ? ' phone-control__audit-item--approval' : ''
              }`}
            >
              <span className="phone-control__audit-time">{auditTime(e)}</span>
              <span className="phone-control__audit-badge">
                {e.kind === 'approval' ? t('审批') : t('操作')}
              </span>
              <span className="phone-control__audit-text">{auditText(e)}</span>
            </li>
          ))}
        </ul>
      </section>

      {s.pendingPair && (
        <div className="phone-control__confirm" role="dialog" aria-modal="true">
          <div className="phone-control__confirm-body">
            <span className="phone-control__confirm-icon" aria-hidden="true">
              <PhoneSvg />
            </span>
            <h4>{t('有手机请求配对')}</h4>
            <p>
              {tpl('「$__name__」请求连接并操作本机，是否允许？', {
                name: s.pendingPair.deviceName,
              })}
            </p>
            <div className="phone-control__confirm-actions">
              <button type="button" className="btn" onClick={() => s.answerPair(false)}>
                {t('拒绝')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => s.answerPair(true)}>
                {t('允许')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
