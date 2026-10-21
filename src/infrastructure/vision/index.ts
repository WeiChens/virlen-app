import { invoke } from '@tauri-apps/api/core'
import { ImageOcrResult, VisionAnalyzeResult } from './types'

export interface IVision {
  /** 从文件路径分析图片 */
  analyze(imagePath: string): Promise<VisionAnalyzeResult>
  /** 从 base64 data URL 分析图片（粘贴/拖拽截图无需落盘） */
  analyzeBase64(dataUrl: string): Promise<VisionAnalyzeResult>
  /** 从文件路径**只做 OCR**（预览用：不跑 UI / 图标 / 物体检测）；`force` = 绕过缓存重算 */
  ocr(imagePath: string, force?: boolean): Promise<ImageOcrResult>
  /** 从 base64 data URL 只做 OCR（消息里的图 / 剪贴板图没有本地路径）；`force` = 绕过缓存重算 */
  ocrBase64(dataUrl: string, force?: boolean): Promise<ImageOcrResult>
}

export class VisionError extends Error {
  constructor(message: string) {
    super(`Vision Error: ${message}`)
    this.name = 'VisionError'
  }
}

class Vision implements IVision {
  async analyze(imagePath: string): Promise<VisionAnalyzeResult> {
    try {
      return await invoke<VisionAnalyzeResult>('vision_analyze', { imagePath })
    } catch (err: any) {
      throw new VisionError(
        typeof err === 'string' ? err : err.message || String(err),
      )
    }
  }

  async analyzeBase64(dataUrl: string): Promise<VisionAnalyzeResult> {
    try {
      return await invoke<VisionAnalyzeResult>('vision_analyze_base64', {
        dataUrl,
      })
    } catch (err: any) {
      throw new VisionError(
        typeof err === 'string' ? err : err.message || String(err),
      )
    }
  }

  async ocr(imagePath: string, force = false): Promise<ImageOcrResult> {
    try {
      return await invoke<ImageOcrResult>('vision_ocr', { imagePath, force })
    } catch (err: any) {
      throw new VisionError(
        typeof err === 'string' ? err : err.message || String(err),
      )
    }
  }

  async ocrBase64(dataUrl: string, force = false): Promise<ImageOcrResult> {
    try {
      return await invoke<ImageOcrResult>('vision_ocr_base64', {
        dataUrl,
        force,
      })
    } catch (err: any) {
      throw new VisionError(
        typeof err === 'string' ? err : err.message || String(err),
      )
    }
  }
}

export const vision: IVision = new Vision()
