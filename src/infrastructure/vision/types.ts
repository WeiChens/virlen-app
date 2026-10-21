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
}
