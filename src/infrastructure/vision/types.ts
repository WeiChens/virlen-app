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
