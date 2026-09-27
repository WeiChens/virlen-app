/**
 * phone-control-settings — 设置 → 手机控制
 *
 * 启用后展示配对二维码（含票据 / 信令基址 / 房间号），并在此确认手机的绑定请求。
 * 覆盖 `phoneControlStore`；真机连接状态由服务回调驱动。
 */
import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { observer } from 'mobx-react-lite'
import { describeGrantRemaining } from 'virlen-remote'
import { phoneControlStore } from '@/ui/store/phoneControlStore'
import type { AuditEntry, PairedDevice } from '@/bridge'
import { t } from '@/ui/i18n'
import './phone-control-settings.scss'

const STATUS_TEXT: Record<string, string> = {
  disabled: '已停用',
  waiting: '等待手机连接…',
  connected: '已连接',
  error: '出错',
}

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

/** 一行描述一台已配对手机：名字 · key · 凭证有效期 · 上次连接。 */
function DeviceRow({ device, onRemove }: { device: PairedDevice; onRemove: () => void }) {
  const last = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '从未'
  return (
    <div className="phone-control__device">
      <div className="phone-control__device-info">
        <span className="phone-control__device-name">{device.name}</span>
        <span className="phone-control__device-meta">
          {shortKey(device.mobileKey)} · 凭证{describeGrantRemaining(device)} · 上次连接 {last}
        </span>
      </div>
      <button type="button" className="btn btn--danger" onClick={onRemove}>
        {t('移除')}
      </button>
    </div>
  )
}

/** 审计条目 → 一行可读文本（保留 `by` / `tier` 等关键信息，便于“谁批了什么”一眼看清）。 */
function describeAudit(e: AuditEntry): string {
  const time = new Date(e.at).toLocaleTimeString()
  if (e.kind === 'approval') {
    const who = e.by === 'mobile' ? '手机' : '电脑'
    const what = e.decision === 'allow' ? '批准' : e.decision === 'shelve' ? '暂存' : '拒绝'
    const tier = e.tier === 'high' ? '·高风险' : ''
    return `${time} ${who}${what}${tier}：${e.detail ?? ''}${e.commandPreview ? ` — ${e.commandPreview}` : ''}`
  }
  return `${time} ${e.allowed ? '✓' : '✕'} ${e.method}${e.detail ? `（${e.detail}）` : ''}`
}

export default observer(function PhoneControlSettings() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const s = phoneControlStore

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !s.payload) return
    void QRCode.toCanvas(canvas, JSON.stringify(s.payload), { width: 200, margin: 1 })
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

  return (
    <div className="phone-control">
      <header className="phone-control__head">
        <h2>{t('手机控制')}</h2>
        <p className="phone-control__sub">
          用手机扫码配对，在外网查看与操作本机 Agent（P2P 加密链路）。
        </p>
      </header>

      <label className="phone-control__toggle">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => s.setEnabled(e.target.checked)}
        />
        <span>{t('启用手机控制')}</span>
      </label>

      {s.enabled && (
        <>
          <div className="phone-control__status">
            状态：{STATUS_TEXT[s.status] ?? s.status}
            {s.error ? `（${s.error}）` : ''}
          </div>

          <div className="phone-control__qr">
            <canvas ref={canvasRef} width={200} height={200} />
            <div className="phone-control__payload">
              <textarea readOnly rows={5} value={s.payload ? JSON.stringify(s.payload, null, 2) : ''} />
              <div className="phone-control__ticket">
                {s.ticketLeftSec == null
                  ? ''
                  : `二维码有效期还剩 ${s.ticketLeftSec} 秒（到期自动刷新）`}
              </div>
              <button type="button" className="btn" onClick={() => s.refreshTicket()}>
                {t('刷新二维码')}
              </button>
            </div>
          </div>
        </>
      )}

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

      <section className="phone-control__devices">
        <h3>{t('已绑定的手机')}</h3>
        {s.devices.length === 0 && <p className="phone-control__empty">还没有绑定手机。</p>}
        {s.devices.map((d) => (
          <DeviceRow key={d.deviceId} device={d} onRemove={() => s.revokeDevice(d.deviceId)} />
        ))}
        <p className="phone-control__tip">
          移除后该手机将无法再连接（需重新扫码并由你确认）——授权凭证当月有效，每次连接自动续期，最长 90 天。
        </p>
      </section>

      {/*
        操作记录（审计）：手机是「远程全权控制面」，而审批取的是宽松档（手机可批含高风险在内的一切，
        见 docs/phone-control-bridge.md §16.3）—— 因此「谁在什么时候批了什么」必须可见、可回溯。
      */}
      <section className="phone-control__audit">
        <div className="phone-control__audit-head">
          <h3>{t('操作记录')}</h3>
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
          <p className="phone-control__empty">还没有操作记录。手机的每次操作与审批都会留在这里。</p>
        )}
        <ul className="phone-control__audit-list">
          {s.auditView.map((e, i) => (
            <li
              key={`${e.at}-${e.method}-${i}`}
              className={`phone-control__audit-item${e.allowed ? '' : ' phone-control__audit-item--denied'}${
                e.kind === 'approval' ? ' phone-control__audit-item--approval' : ''
              }`}
            >
              {describeAudit(e)}
            </li>
          ))}
        </ul>
      </section>

      {s.pendingPair && (
        <div className="phone-control__confirm" role="dialog" aria-modal="true">
          <div className="phone-control__confirm-body">
            <h4>{t('有手机请求配对')}</h4>
            <p>是否允许该手机连接并操作本机？</p>
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
