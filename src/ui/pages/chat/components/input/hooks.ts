/**
 * hooks — 聊天输入框的自定义 hooks
 *
 * useImageAttachment — 图片附件管理（选取 / 粘贴 / 拖拽）
 * useVoiceInput      — 语音输入（Web Speech API）
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { v4 } from '@/utils/uuid'
import { showToast } from '@/ui/components/shared/Toast'
import { t } from '@/ui/i18n'

// ====================================================================
// 图片附件
// ====================================================================

/** 图片附件 */
export interface ImageAttachment {
  id: string
  url: string // base64 data URL
  name?: string
}

/** 图片最大像素阈值：长 × 宽 > MAX_PIXELS 时进行压缩 */
const MAX_PIXELS = 960 * 960
const MAX_DIMENSION = 960
const COMPRESS_QUALITY = 0.85

/** 将 File 转为 base64 data URL（超尺寸自动压缩） */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // 不支持的格式或非图片，直接返回
      if (!file.type.startsWith('image/')) {
        resolve(dataUrl)
        return
      }

      // 用 Image 对象检测原始尺寸
      const img = new Image()
      img.onload = () => {
        const pixelCount = img.naturalWidth * img.naturalHeight
        if (pixelCount <= MAX_PIXELS) {
          // 未超限，直接返回原始 dataURL
          resolve(dataUrl)
          return
        }

        // 超限 → canvas 缩放压缩
        const canvas = document.createElement('canvas')
        let { naturalWidth: w, naturalHeight: h } = img
        if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
          const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h)
          w = Math.round(w * ratio)
          h = Math.round(h * ratio)
        }
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        const compressed = canvas.toDataURL('image/jpeg', COMPRESS_QUALITY)
        resolve(compressed)
      }
      img.onerror = () => resolve(dataUrl) // 加载失败则返回原始数据
      img.src = dataUrl
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * 图片附件管理 hook
 * 返回 images 状态及操作方法，供 ChatInput 消费
 */
export function useImageAttachment() {
  const [images, setImages] = useState<ImageAttachment[]>([])

  /** 添加图片（去重 + 格式校验） */
  const addImages = useCallback(async (files: FileList | File[]) => {
    const validTypes = [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/bmp',
    ]
    const newImages: ImageAttachment[] = []
    for (const file of Array.from(files)) {
      if (!validTypes.includes(file.type)) continue
      const url = await fileToDataUrl(file)
      newImages.push({ id: v4(), url, name: file.name })
    }
    if (newImages.length === 0) {
      showToast(t('不支持的图片格式，仅支持 PNG / JPEG / WebP / GIF / BMP'))
      return
    }
    setImages((prev) => [...prev, ...newImages])
  }, [])

  /** 移除指定图片 */
  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id))
  }, [])

  /** 清空所有图片 */
  const clearImages = useCallback(() => {
    setImages([])
  }, [])

  return { images, setImages, addImages, removeImage, clearImages }
}

// ====================================================================
// 语音输入
// ====================================================================

/**
 * 语音输入 hook
 * 使用 Web Speech API（SpeechRecognition）
 * 权限由 Tauri 原生层在启动时预设为 ALLOW，无需用户授权
 *
 * @param onSpeechResult 语音识别结果回调，接收完整文本（含最终+中间结果）
 */
export function useVoiceInput(onSpeechResult: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef<any>(null)
  const [voiceSupported, setVoiceSupported] = useState(true)

  /** 检测浏览器是否支持语音识别 */
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      setVoiceSupported(false)
    }
  }, [])

  const toggleVoiceInput = useCallback(() => {
    if (isRecording) {
      // 停止录音
      recognitionRef.current?.stop()
      setIsRecording(false)
      return
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      showToast(t('您的浏览器不支持语音输入，请使用 Chrome 或 Edge'))
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN' // 中文识别，也兼容英文
    recognition.continuous = true // 连续识别
    recognition.interimResults = true // 返回中间结果
    recognition.maxAlternatives = 1

    recognition.onresult = (event: any) => {
      let interimTranscript = ''
      let finalTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript
        } else {
          interimTranscript += transcript
        }
      }

      // 拼接文本，中间结果用 ⋯ 前缀标识
      const text =
        finalTranscript + (interimTranscript ? `⋯${interimTranscript}` : '')
      onSpeechResult(text)
    }

    recognition.onerror = (event: any) => {
      console.error('语音识别错误:', event.error)
      setIsRecording(false)
      if (event.error === 'not-allowed') {
        showToast(t('麦克风权限被拒绝，请重启应用后重试'))
      } else if (event.error === 'no-speech') {
        showToast(t('未检测到语音，请重试'))
      } else if (event.error === 'audio-capture') {
        showToast(t('未检测到麦克风设备'))
      } else {
        showToast(`语音识别出错: ${event.error}`)
      }
    }

    recognition.onend = () => {
      setIsRecording(false)
    }

    try {
      recognition.start()
      setIsRecording(true)
      recognitionRef.current = recognition
    } catch (err) {
      showToast(t('启动语音识别失败，请检查麦克风权限'))
      setIsRecording(false)
    }
  }, [isRecording, onSpeechResult])

  /** 组件卸载时停止录音 */
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
    }
  }, [])

  return { isRecording, voiceSupported, toggleVoiceInput }
}
