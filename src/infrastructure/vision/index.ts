import { invoke } from '@tauri-apps/api/core'
import { VisionAnalyzeResult } from './types'

export interface IVision {
  /** 从文件路径分析图片 */
  analyze(imagePath: string): Promise<VisionAnalyzeResult>
  /** 从 base64 data URL 分析图片（粘贴/拖拽截图无需落盘） */
  analyzeBase64(dataUrl: string): Promise<VisionAnalyzeResult>
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
}

export const vision: IVision = new Vision()
