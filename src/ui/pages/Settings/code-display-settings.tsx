/**
 * code-display-settings — 代码显示设置页
 *
 * 一个页面管住代码区的全部外观：主题（固定 / 跟随应用）、字族、字号、行高、连字、行号，
 * 顶部给一块真实 Monaco 预览（同一套解析结果，改完立刻能看出效果）。
 *
 * 表单样式复用 general-settings.scss（顶层作用域已含 .code-display-settings），
 * 本页只补主题卡片与滑块这类专属部分（code-display-settings.scss）。
 *
 * 交互口径：主题 / 开关 / 下拉是「点一下就落库」；字号与行高是滑杆 —— 拖动只改本地草稿，
 * 松手（或失焦 / 键盘抬起）才提交，否则一次拖动就是几十次 settings.change 埋点与写库。
 */
import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import type { SettingsStore } from '@/ui/store'
import Select from '@/ui/components/shared/Select'
import CodePreview from '@/ui/components/code-preview/CodePreview'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'
import {
  CODE_FONT_OPTIONS,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CODE_LINE_HEIGHT_MAX,
  CODE_LINE_HEIGHT_MIN,
  DEFAULT_CODE_DISPLAY_SETTINGS,
  codeThemeOf,
  listCodeThemes,
} from '@/domain/code-display'
import './general-settings.scss'
import './code-display-settings.scss'

/**
 * 预览示例：注释 / 关键字 / 类型 / 字符串 / 数字都有，换主题时一眼能看出差异。
 * 用数组拼而不是模板字符串：里面的 `${}` 是想原样显示的代码，不该被本文件插值。
 */
const SAMPLE = [
  '// 代码主题预览：改上面任何一项，这里立刻生效',
  'interface CodeTheme {',
  '  background: string',
  '  foreground: string',
  '}',
  '',
  'export function pickTheme(theme: CodeTheme, dark: boolean): string {',
  "  const suffix = dark ? 'dark' : 'light' // 亮暗两档",
  '  const count = 13',
  '  return `virlen-${suffix}-${count}`',
  '}',
].join('\n')

/** 主题卡片：用该主题自己的颜色画一行迷你代码（bg / comment / keyword / string / number） */
function ThemeCard({
  themeId,
  active,
  disabled,
  onSelect,
}: {
  themeId: string
  active: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const palette = codeThemeOf(themeId)
  return (
    <button
      type="button"
      className={`cd-theme${active ? ' active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}>
      <span
        className="cd-theme-swatch"
        style={{ background: palette.bg, color: palette.fg }}>
        <span style={{ color: palette.comment }}>// </span>
        <span style={{ color: palette.keyword }}>const </span>
        <span style={{ color: palette.string }}>'virlen'</span>
        <span style={{ color: palette.fg }}> = </span>
        <span style={{ color: palette.number }}>13</span>
      </span>
      <span className="cd-theme-name">{t(palette.label)}</span>
    </button>
  )
}

function CodeDisplaySettings() {
  const s = settingsState.value
  const follow = s.codeThemeMode === 'follow'

  /** 滑杆草稿：拖动期间只改这里，松手才落库（见文件头） */
  const [sizeDraft, setSizeDraft] = useState(s.codeFontSize)
  const [lineDraft, setLineDraft] = useState(s.codeLineHeight)

  // 外部改了值（恢复默认 / 迁移校正）→ 草稿跟上；正在拖动时不抢用户的手
  useEffect(() => setSizeDraft(s.codeFontSize), [s.codeFontSize])
  useEffect(() => setLineDraft(s.codeLineHeight), [s.codeLineHeight])

  function update<K extends keyof SettingsStore>(
    key: K,
    value: SettingsStore[K],
  ) {
    settingsState.setValue(key, value)
  }

  function commitSize(px: number) {
    if (px === s.codeFontSize) return
    update('codeFontSize', px)
  }

  function commitLineHeight(mult: number) {
    if (mult === s.codeLineHeight) return
    update('codeLineHeight', mult)
  }

  function resetAll() {
    settingsState.set({ ...DEFAULT_CODE_DISPLAY_SETTINGS })
    showToast(t('已恢复默认代码显示设置'), 1800)
  }

  return (
    <div className="code-display-settings">
      <h2 className="section-title">{t('代码显示')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('代码主题')}</span>
            <span className="label-desc">
              {t('代码块、差异视图与代码编辑器共用一套配色')}
            </span>
          </div>
          <div className="setting-control">
            <div className="segmented-control">
              <button
                className={`segment ${!follow ? 'active' : ''}`}
                onClick={() => update('codeThemeMode', 'fixed')}>
                {t('固定主题')}
              </button>
              <button
                className={`segment ${follow ? 'active' : ''}`}
                onClick={() => update('codeThemeMode', 'follow')}>
                {t('跟随应用主题')}
              </button>
            </div>
          </div>
        </div>

        {follow && (
          <div className="cd-hint">
            {t('跟随应用主题：界面亮色用 Virlen Light，暗色用 Virlen Dark')}
          </div>
        )}

        <div className="cd-themes">
          {listCodeThemes().map((theme) => (
            <ThemeCard
              key={theme.id}
              themeId={theme.id}
              active={!follow && s.codeThemeId === theme.id}
              disabled={follow}
              onSelect={() => update('codeThemeId', theme.id)}
            />
          ))}
        </div>
      </div>

      <h2 className="section-title">{t('字体')}</h2>

      <div className="section">
        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('字族')}</span>
            <span className="label-desc">
              {t('代码区使用的等宽字体，缺字体时按系统回退')}
            </span>
          </div>
          <div className="setting-control">
            <Select
              value={s.codeFontFamily}
              onChange={(v) => update('codeFontFamily', String(v))}
              options={CODE_FONT_OPTIONS.map((o) => ({
                value: o.id,
                label: t(o.label),
              }))}
              width={180}
            />
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('字号')}</span>
            <span className="label-desc">
              {t('代码字号，与界面字号相互独立')}
            </span>
          </div>
          <div className="setting-control cd-range-control">
            <input
              type="range"
              className="cd-range"
              min={CODE_FONT_SIZE_MIN}
              max={CODE_FONT_SIZE_MAX}
              step={1}
              value={sizeDraft}
              aria-label={t('字号')}
              onChange={(e) => setSizeDraft(Number(e.currentTarget.value))}
              onPointerUp={(e) => commitSize(Number(e.currentTarget.value))}
              onKeyUp={(e) => commitSize(Number(e.currentTarget.value))}
              onBlur={(e) => commitSize(Number(e.currentTarget.value))}
            />
            <span className="cd-range-value">{sizeDraft}px</span>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('行高')}</span>
            <span className="label-desc">{t('行高倍数，1.2–2.0')}</span>
          </div>
          <div className="setting-control cd-range-control">
            <input
              type="range"
              className="cd-range"
              min={CODE_LINE_HEIGHT_MIN}
              max={CODE_LINE_HEIGHT_MAX}
              step={0.05}
              value={lineDraft}
              aria-label={t('行高')}
              onChange={(e) => setLineDraft(Number(e.currentTarget.value))}
              onPointerUp={(e) =>
                commitLineHeight(Number(e.currentTarget.value))
              }
              onKeyUp={(e) => commitLineHeight(Number(e.currentTarget.value))}
              onBlur={(e) => commitLineHeight(Number(e.currentTarget.value))}
            />
            <span className="cd-range-value">{lineDraft.toFixed(2)}</span>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('连字')}</span>
            <span className="label-desc">
              {t('启用连字（JetBrains Mono / Fira Code 等字体才有区别）')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('连字')}
                checked={s.codeFontLigatures}
                onChange={(e) =>
                  update('codeFontLigatures', e.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="label-text">{t('显示行号')}</span>
            <span className="label-desc">
              {t('代码块与差异视图的默认行号；调用点显式指定的以调用点为准')}
            </span>
          </div>
          <div className="setting-control">
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={t('显示行号')}
                checked={s.codeShowLineNumbers}
                onChange={(e) =>
                  update('codeShowLineNumbers', e.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      <h2 className="section-title">{t('预览')}</h2>
      <div className="section">
        <div className="cd-preview">
          <CodePreview code={SAMPLE} language="typescript" height={220} />
        </div>
        <div className="cd-actions">
          <button className="cd-reset" onClick={resetAll}>
            {t('恢复默认')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default observer(CodeDisplaySettings)
