/**
 * storage-settings — 存储维护（设置 → 存储）
 *
 * 只做两件事：展示 `virlen.db` 的体积构成，以及手动触发维护动作。
 * 两个动作分别对应「廉价、无需确认」与「需独占、必须确认」两档：
 * - 截断 WAL 日志：`wal_checkpoint(TRUNCATE)`，把 `-wal` 里已提交的页搬回主库并截断文件；
 * - 重建数据库：`VACUUM`，归还已删除数据留下的空闲页，并把 `auto_vacuum` 切为 INCREMENTAL。
 *
 * 都不自动执行：`VACUUM` 期间独占数据库连接（数百 MB 库约 10–60 秒），还需约 2 倍库大小的
 * 临时磁盘空间（详见 `virlen-core/src/session_db/maintenance.rs`）。唯一自动发生的是
 * 「退出应用时截断一次 WAL」，它拿不到连接锁会直接跳过。
 */
import { useCallback, useEffect, useState } from 'react'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import type { DbStats } from '@/infrastructure/sessionRepo'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { t, tpl } from '@/ui/i18n'
import { track } from '@/utils/telemetry'
import './storage-settings.scss'

/** 字节数 → 可读文本（B / KB / MB / GB / TB） */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** 主库文件 + WAL + SHM 的总占用 */
function totalBytes(stats: DbStats): number {
  return stats.dbBytes + stats.walBytes + stats.shmBytes
}

type BusyAction = 'checkpoint' | 'vacuum' | null

function StorageSettings() {
  const [stats, setStats] = useState<DbStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyAction>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setStats(await sessionRepo.dbStats())
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 截断 WAL 日志（廉价：不动主库结构，所以不需要二次确认） */
  async function handleCheckpoint() {
    setBusy('checkpoint')
    const result = await sessionRepo.dbCheckpoint()
    setBusy(null)
    if (!result) {
      track('storage.checkpoint', { status: 'fail' })
      showToast(t('操作失败，请查看日志'), 2500)
      await refresh()
      return
    }
    const freed = Math.max(0, result.beforeBytes - result.afterBytes)
    track('storage.checkpoint', {
      status: result.busy ? 'busy' : 'success',
      freed_bytes: freed,
    })
    await refresh()
    if (result.busy) {
      // 有其它连接占着 WAL 时 checkpoint 无法完成，此时文件不会变小（不是错误）
      showToast(t('数据库正被占用，未能截断 WAL 日志'), 2500)
      return
    }
    showToast(tpl('已回收 $__size__', { size: formatBytes(freed) }), 2000)
  }

  /** 重建数据库（VACUUM）：耗时且需临时空间，必须先经用户确认 */
  async function handleVacuum() {
    const confirmed = await MessageBox.propt(
      t('重建数据库'),
      t(
        '重建会整理整个数据库：期间请勿发送消息（数百 MB 的库约需 10–60 秒），并需要约 2 倍库大小的临时磁盘空间。确定继续？',
      ),
      { confirmText: t('重建数据库'), cancelText: t('取消') },
    )
    if (!confirmed) return
    setBusy('vacuum')
    const startedAt = Date.now()
    const result = await sessionRepo.dbMaintain()
    setBusy(null)
    if (!result) {
      track('storage.maintain', { status: 'fail', duration_ms: Date.now() - startedAt })
      showToast(t('操作失败，请查看日志'), 2500)
      await refresh()
      return
    }
    const freed = Math.max(0, totalBytes(result.before) - totalBytes(result.after))
    track('storage.maintain', {
      status: 'success',
      duration_ms: Date.now() - startedAt,
      vacuum_ms: result.vacuumMs,
      freed_bytes: freed,
    })
    // 直接吃整理结果里的 after，省一次查询（结果就是最终状态）
    setStats(result.after)
    showToast(tpl('已回收 $__size__', { size: formatBytes(freed) }), 2500)
  }

  const total = stats ? totalBytes(stats) : 0
  const reclaimable = stats ? stats.freelistPages * stats.pageSize : 0

  return (
    <div className="storage-settings">
      <div className="storage-header">
        <h2 className="section-title">{t('存储')}</h2>
        <div className="storage-actions">
          <button
            className="storage-btn"
            onClick={handleCheckpoint}
            disabled={busy !== null || !stats}>
            {busy === 'checkpoint' ? t('截断中…') : t('截断 WAL 日志')}
          </button>
          <button
            className="storage-btn primary"
            onClick={handleVacuum}
            disabled={busy !== null || !stats}>
            {busy === 'vacuum' ? t('重建中…') : t('重建数据库')}
          </button>
        </div>
      </div>

      {loading && !stats && <div className="storage-empty">{t('加载中…')}</div>}
      {!loading && !stats && (
        <div className="storage-empty">{t('数据库不可用（浏览器模式）')}</div>
      )}

      {stats && (
        <>
          <div className="storage-total">
            <span className="storage-total-label">{t('总占用')}</span>
            <span className="storage-total-value">{formatBytes(total)}</span>
          </div>

          <div className="storage-rows">
            <div className="storage-row">
              <span className="storage-row-label">{t('数据库文件')}</span>
              <span className="storage-row-value">{formatBytes(stats.dbBytes)}</span>
            </div>
            <div className="storage-row">
              <span className="storage-row-label">{t('WAL 日志')}</span>
              <span className="storage-row-value">{formatBytes(stats.walBytes)}</span>
            </div>
            <div className="storage-row">
              <span className="storage-row-label">{t('空闲页（可回收）')}</span>
              <span className="storage-row-value">
                {tpl('$__pages__ 页 · $__size__', {
                  pages: stats.freelistPages,
                  size: formatBytes(reclaimable),
                })}
              </span>
            </div>
            <div className="storage-row">
              <span className="storage-row-label">{t('会话总数')}</span>
              <span className="storage-row-value">{String(stats.sessionCount)}</span>
            </div>
            <div className="storage-row">
              <span className="storage-row-label">{t('消息总数')}</span>
              <span className="storage-row-value">{String(stats.messageCount)}</span>
            </div>
          </div>

          <div className="storage-note">
            <p>
              {t(
                '数据库体积偏大时，可用「截断 WAL 日志」回收日志文件，用「重建数据库」归还已删除数据留下的空闲页。',
              )}
            </p>
            <p>{t('退出应用时会自动截断 WAL 日志；重建数据库不会自动执行。')}</p>
          </div>
        </>
      )}
    </div>
  )
}

export default StorageSettings
