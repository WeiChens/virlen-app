/**
 * 工作中过渡动画指示器（纯展示）
 *
 * AI 处理 / 视觉分析 / 上下文压缩时展示。
 * 波浪文字：逐字上下呼吸、靠相位差形成波峰横向推进，无装饰点；
 * 逐字 span 对读屏隐藏，完整文案由 aria-label 承载，避免逐字被拆读。
 */
import { WAVE_MAX_CHARS } from './constants'

export function WorkingIndicator({
  workingText,
  compacting,
}: {
  workingText: string
  compacting: boolean
}) {
  // 波浪文字：拆成单字（Array.from 能正确处理 emoji / 代理对，不像 split('') 会拆碎）
  const waveChars = Array.from(workingText)
  return (
    <div
      className={`working-indicator ${compacting ? 'is-compacting' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={workingText}>
      {waveChars.length <= WAVE_MAX_CHARS ? (
        <span className="working-wave" aria-hidden="true">
          {waveChars.map((ch, i) => (
            <span
              key={`${i}-${ch}`}
              className="working-wave-char"
              // 相位差 = 第几个字 × 波浪步长（负数：上屏即处在自己那一拍，避免开头「闪一下」）
              // 步长定义在 style.scss 的 --wave-step，调节奏只动一处
              style={{
                animationDelay: `calc(${i - waveChars.length} * var(--wave-step))`,
              }}>
              {ch === ' ' ? '\u00a0' : ch}
            </span>
          ))}
        </span>
      ) : (
        <span className="working-text" aria-hidden="true">
          {workingText}
        </span>
      )}
    </div>
  )
}
