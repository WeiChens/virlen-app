/**
 * input 组件常量
 *
 * ⚠️ 高度模型（铁律：改一个必须改另一个）：
 *   本文件的 INPUT_CHROME_HEIGHT(=58) ↔ style.scss 的 .input-wrapper 静止高度 125
 *   ↔ textarea 的 min-height 67px。三者必须保持 125 = 58 + 67 的关系。
 */

/**
 * 输入区（textarea + 工具条）的最小高度 —— 拖拽手柄的下限。
 * 与 style.scss 的静止高度一致（125 = 固定占用 58 + textarea 67），
 * 否则第一次拖拽会突然跳高（旧值 170 > 静止高度 125）。
 */
export const MIN_HEIGHT = 125

/**
 * 输入区里除 textarea 之外的固定占用：
 *   工具条 36 + 与 textarea 的间距 8 + 上下 padding 12 + 上下边框 2 = 58
 *
 * 拖拽手柄给的是「输入区整体高度」（也是 localStorage 里的历史语义），
 * 但真正被撑开的是 textarea，所以套用到 textarea 上时要扣掉这部分。
 * 对齐 style.scss：.input-wrapper 的静止高度 125 ↔ textarea 的 min-height 67。
 */
export const INPUT_CHROME_HEIGHT = 58

/** 波浪动画的字符上限：超长文案退化为静态文案（避免上百个 span + 视觉噪音） */
export const WAVE_MAX_CHARS = 20
