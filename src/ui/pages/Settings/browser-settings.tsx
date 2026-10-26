/**
 * browser-settings — 设置 · 浏览器
 *
 * 两块内容：
 *  - 内置浏览器：闲置网页休眠 / 同时保留网页数（真实现点在 `side-panel/browser/view-policy.ts`，
 *    这里只负责把上限写进设置）；
 *  - HTML 预览：工作目录 HTML 的脚本与外部资源权限（组件见 `security-preview.tsx`）。
 *
 * 为什么单独成一页：两块都只服务「网页」这件事。原来一个在「通用」、一个在「安全」的子 Tab 里，
 * 想开「网页能不能跑脚本」得先猜到它归在安全下。
 */
import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'
import {
  BROWSER_MAX_VIEWS_MAX,
  BROWSER_SLEEP_MAX_SEC,
} from '@/ui/pages/chat/components/side-panel/browser/view-policy'
import PreviewSecurity from './security-preview'
import './general-settings.scss'

const BrowserSettings = observer(function BrowserSettings() {
  const s = settingsState.value
  /**
   * 两个策略参数走草稿 + 失焦提交：每敲一个字符就落库会刷出几十条
   * `settings.change` 埋点，而这两个值只有在提交那一刻才有意义。
   */
  const [sleepDraft, setSleepDraft] = useState(() =>
    String(settingsState.value.browserSleepAfterSec),
  )
  const [maxViewsDraft, setMaxViewsDraft] = useState(() =>
    String(settingsState.value.browserMaxViews),
  )

  // 设置被别处改（新窗口 / 恢复默认）→ 草稿跟上
  useEffect(() => {
    setSleepDraft(String(s.browserSleepAfterSec))
  }, [s.browserSleepAfterSec])
  useEffect(() => {
    setMaxViewsDraft(String(s.browserMaxViews))
  }, [s.browserMaxViews])

  /** 按边界收敛：空 / 非数字回落当前值（不让输入框凭空变成 0 —— `Number('')` 也是 0） */
  function commitBrowserNumber(
    raw: string,
    key: 'browserSleepAfterSec' | 'browserMaxViews',
    max: number,
    setDraft: (value: string) => void,
  ) {
    const n = raw.trim() === '' ? Number.NaN : Number(raw)
    const value = Number.isFinite(n)
      ? Math.min(Math.max(0, Math.round(n)), max)
      : s[key]
    setDraft(String(value))
    if (value !== s[key]) settingsState.setValue(key, value)
  }

  return (
    <div className="general-settings">
      <h2 className="section-title">{t('内置浏览器')}</h2>

      <div className="section">
        {/* 两个策略的真实现点在 `side-panel/browser/view-policy.ts`：这里只负责把上限写进设置。
            0 是两个策略各自的「关掉」档（不休眠 / 不限个数），文案里写清楚。 */}
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('闲置网页休眠')}</span>
            <span className="label-desc">
              {t(
                '网页切至后台超过该时长后释放并重新加载，页面状态不再保留\n0 = 不释放',
              )}
            </span>
          </div>
          <div className="setting-control">
            <div className="unit-input">
              <input
                type="number"
                min={0}
                max={BROWSER_SLEEP_MAX_SEC}
                step={5}
                aria-label={t('闲置网页休眠')}
                value={sleepDraft}
                onChange={(e) => setSleepDraft(e.target.value)}
                onBlur={() =>
                  commitBrowserNumber(
                    sleepDraft,
                    'browserSleepAfterSec',
                    BROWSER_SLEEP_MAX_SEC,
                    setSleepDraft,
                  )
                }
                onKeyDown={(e) => {
                  // 回车在 number 输入框里不提交表单 —— 主动失焦即触发校正
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
              <span className="unit">{t('秒')}</span>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('同时保留网页数')}</span>
            <span className="label-desc">
              {t(
                '同时保留的网页上限，超出时释放最久未访问的\n0 = 不限制',
              )}
            </span>
          </div>
          <div className="setting-control">
            <div className="unit-input">
              <input
                type="number"
                min={0}
                max={BROWSER_MAX_VIEWS_MAX}
                step={1}
                aria-label={t('同时保留网页数')}
                value={maxViewsDraft}
                onChange={(e) => setMaxViewsDraft(e.target.value)}
                onBlur={() =>
                  commitBrowserNumber(
                    maxViewsDraft,
                    'browserMaxViews',
                    BROWSER_MAX_VIEWS_MAX,
                    setMaxViewsDraft,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
              <span className="unit">{t('个')}</span>
            </div>
          </div>
        </div>
      </div>

      <PreviewSecurity />
    </div>
  )
})

export default BrowserSettings
