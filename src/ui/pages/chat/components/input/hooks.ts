/**
 * hooks — 聊天输入框的自定义 hooks
 *
 * useImageAttachment — 图片附件管理（选取 / 粘贴 / 拖拽）
 * useVoiceInput      — 语音输入（Web Speech API）
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
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

/** 是否在 Tauri 环境 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 挑选 MediaRecorder 支持的音频格式（优先 m4a，便于 SFSpeechRecognizer 识别） */
function pickSupportedMimeType(): string {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return ''
  }
  const candidates = [
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/webm;codecs=opus',
    'audio/webm',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

/** 根据 mimeType 推导文件扩展名 */
function mimeToExt(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('webm')) return 'webm'
  return 'm4a'
}

/**
 * 语音输入 hook
 *
 * ## 双引擎策略
 * - **Tauri macOS**：WKWebView 无 SpeechRecognition，改用
 *   `getUserMedia + MediaRecorder` 录音 → 落盘 → Rust 调 Apple
 *   SFSpeechRecognizer（离线、免 Key）识别。
 * - **其他环境（Chrome / Edge / Windows Tauri）**：使用 Web Speech API（SpeechRecognition）。
 *
 * @param onSpeechResult 语音识别结果回调，接收完整文本
 */
export function useVoiceInput(onSpeechResult: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const recognitionRef = useRef<any>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const [voiceSupported, setVoiceSupported] = useState(true)
  const isMacTauriRef = useRef(false)

  /** 检测当前环境支持的语音方案 */
  useEffect(() => {
    let mounted = true
    ;(async () => {
      let macTauri = false
      if (isTauriEnv()) {
        try {
          const platform = await invoke<string>('os_platform')
          macTauri = platform === 'macos'
        } catch {
          macTauri = false
        }
      }
      if (!mounted) return
      isMacTauriRef.current = macTauri
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition
      // macOS Tauri 走原生识别；其余环境要求浏览器支持 Web Speech API
      setVoiceSupported(macTauri || !!SpeechRecognition)
    })()
    return () => {
      mounted = false
    }
  }, [])

  /** 清理录音资源（停止所有音轨） */
  const cleanupRecorder = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    mediaStreamRef.current = null
    recorderRef.current = null
  }, [])

  /** macOS：录音 → 落盘 → Rust SFSpeechRecognizer 识别 */
  const startMacRecording = useCallback(async () => {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const mimeType = pickSupportedMimeType()
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      )
      const chunks: Blob[] = []

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }

      recorder.onerror = (e: Event) => {
        console.error('录音出错:', e)
        cleanupRecorder()
        setIsRecording(false)
        showToast(t('启动语音识别失败，请检查麦克风权限'))
      }

      recorder.onstop = async () => {
        cleanupRecorder()
        setIsRecording(false)
        setIsTranscribing(true)
        try {
          const blob = new Blob(chunks, { type: mimeType || 'audio/mp4' })
          if (blob.size === 0) {
            showToast(t('未检测到语音，请重试'))
            return
          }
          const buffer = new Uint8Array(await blob.arrayBuffer())
          const { tempDir } = await import('@tauri-apps/api/path')
          const dir = (await tempDir()).replace(/\\/g, '/').replace(/\/+$/, '')
          const path = `${dir}/virlen-voice-${Date.now()}.${mimeToExt(mimeType)}`
          await invoke('save_file_to_path', { buffer, path })
          const text = await invoke<string>('macos_transcribe_speech', { path })
          const trimmed = (text || '').trim()
          if (trimmed) {
            onSpeechResult(trimmed)
          } else {
            showToast(t('未检测到语音，请重试'))
          }
        } catch (err: any) {
          console.error('语音识别失败:', err)
          showToast(`${t('语音识别出错')}: ${err?.message || err}`)
        } finally {
          setIsTranscribing(false)
        }
      }

      recorder.start()
      recorderRef.current = recorder
      setIsRecording(true)
    } catch (err: any) {
      console.error('获取麦克风失败:', err)
      cleanupRecorder()
      showToast(t('启动语音识别失败，请检查麦克风权限'))
    }
  }, [cleanupRecorder, onSpeechResult])

  const toggleVoiceInput = useCallback(() => {
    if (isTranscribing) return

    if (isRecording) {
      // 停止录音
      if (isMacTauriRef.current) {
        recorderRef.current?.stop()
      } else {
        recognitionRef.current?.stop()
      }
      setIsRecording(false)
      return
    }

    // macOS Tauri：录音 + 原生 SFSpeechRecognizer
    if (isMacTauriRef.current) {
      startMacRecording()
      return
    }

    // 其他环境：Web Speech API
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
      } else if (
        event.error === 'service-not-allowed' ||
        event.error === 'network'
      ) {
        showToast(t('无法连接语音识别服务，请检查网络连接'))
      } else {
        showToast(`${t('语音识别出错')}: ${event.error}`)
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
  }, [isRecording, isTranscribing, startMacRecording, onSpeechResult])

  /** 组件卸载时停止录音/识别 */
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      recorderRef.current?.stop()
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return { isRecording, isTranscribing, voiceSupported, toggleVoiceInput }
}
