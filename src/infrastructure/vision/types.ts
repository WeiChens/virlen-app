/** 视觉分析结果（UI 检测 + OCR + 物体检测 合并） */
export interface VisionAnalyzeResult {
  /** UI 元素树文本（tree text 格式） */
  ui_tree_text: string
  /** 物体检测树文本（tree text 格式） */
  objects_tree_text: string
  /** 合并后的完整文本（用分隔符拼接） */
  combined_text: string
  /** 图片尺寸 [width, height] */
  image_size: [number, number]
}

/** 一个 OCR 文本框：**原图像素坐标**（左上角 + 宽高） */
export interface ImageOcrBox {
  /** 这一框识别出的文字 */
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** 文本框坐标系 = 送去推理的图片尺寸 */
export interface ImageOcrSize {
  width: number
  height: number
}

/**
 * 只做 OCR 的结果（图片预览用）。
 *
 * 「没有文字」不是错误：`text` 是空串，且同样会进缓存 —— 否则每次打开这张图都要白跑一遍推理。
 */
export interface ImageOcrResult {
  /** 按阅读顺序拼好的文本（没有文字 = 空串） */
  text: string
  /** 是否命中磁盘缓存（true = 这次没跑推理） */
  cached: boolean
  /** 逐个文本框：预览的透明定位层靠它把文字摆回图片上的原位 */
  boxes?: ImageOcrBox[]
  /** 文本框坐标系的宽（= 送去推理的图片像素宽） */
  width?: number
  /** 文本框坐标系的高 */
  height?: number
}
