/**
 * security-preview — 设置 · 浏览器 · HTML 预览：工作目录 HTML 预览的脚本与外部资源权限。
 *
 * 提供组件，由 `browser-settings.tsx`（设置 → 浏览器）渲染。
 *
 * 两条口径：
 * 1. **默认全关**：预览默认在 `sandbox=""` 的 iframe 里渲染，脚本不执行（与 `html-preview.ts` 的 CSP 同源）；
 * 2. **外部资源依赖脚本**：脚本都不跑时，「允许外部资源」没有实际作用 —— 关掉脚本时把它一并关掉，
 *    否则会留下一个「勾着但无效」的开关（用户下次开脚本，它又悄悄生效）。
 *
 * 为什么放在全局设置而不是预览面板里：实测反馈是「每打开一个文件都要重勾一次」不现实，
 * 而这两个值代表的是「用户对哪一类页面可信」的长期判断，不是单文件属性。
 */
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'

const PreviewSecurity = observer(function PreviewSecurity() {
  const s = settingsState.value

  function setScripts(enabled: boolean): void {
    settingsState.setValue('htmlPreviewAllowScripts', enabled)
    if (!enabled) settingsState.setValue('htmlPreviewAllowRemote', false)
  }

  return (
    <>
      <h2 className="section-title">{t('HTML 预览')}</h2>

      <div className="section">
        <div className="section-desc">
          <span className="t">
            {t('HTML 文件默认在隔离环境中渲染，脚本不执行；仅在信任所预览的页面时开启以下两项。')}
          </span>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('允许运行脚本')}</span>
            <span className="label-desc">
              {t('页面内联脚本与本地脚本可以执行；沙箱仍然隔离，脚本读不到应用数据')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('允许运行脚本')}
                checked={s.htmlPreviewAllowScripts}
                onChange={(e) => setScripts(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <div className={`setting-row${s.htmlPreviewAllowScripts ? '' : ' is-disabled'}`}>
          <div className="setting-label">
            <span className="label-text">{t('允许外部资源')}</span>
            <span className="label-desc">
              {s.htmlPreviewAllowScripts
                ? t('允许从 CDN 加载脚本并发起网络请求；会连接第三方服务器')
                : t('需先开启「允许运行脚本」')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('允许外部资源')}
                checked={s.htmlPreviewAllowRemote}
                disabled={!s.htmlPreviewAllowScripts}
                onChange={(e) =>
                  settingsState.setValue('htmlPreviewAllowRemote', e.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>
    </>
  )
})

export default PreviewSecurity
