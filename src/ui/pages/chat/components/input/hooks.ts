/**
 * hooks — 聊天输入框的自定义 hooks
 *
 * useImageAttachment — 图片附件管理（选取 / 粘贴 / 拖拽 / 磁盘路径）
 * useFileAttachment  — 文件附件管理（只存路径，不拷贝文件内容）
 * useQuoteAttachment — 引用消息管理（只存被引用消息的 id / 发送方 / 正文快照）
 * useSkillAttachment — 技能引用管理（读 SKILL.md **全文**快照，与文件附件相反）
 * useVoiceInput      — 语音输入（Web Speech API）
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { v4 } from '@/utils/uuid'
import { showToast } from '@/ui/components/shared/Toast'
import { t, tpl } from '@/ui/i18n'
import { getRegisteredSkill } from '@/skill'

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

  /**
   * 从磁盘路径添加图片（拖拽 / 剪贴板只给路径时使用）
   * 读字节 → 还原成 File → 走与选图完全相同的压缩链路
   */
  const addImagePaths = useCallback(async (paths: string[]) => {
    const newImages: ImageAttachment[] = []
    for (const raw of paths) {
      const path = normalizeFsPath(raw)
      try {
        const url = await readImageFileAsDataUrl(path)
        newImages.push({ id: v4(), url, name: fsBaseName(path) })
      } catch (err) {
        console.error('读取图片失败:', path, err)
        showToast(tpl('读取图片失败：$__path__', { path }))
      }
    }
    if (newImages.length > 0) {
      setImages((prev) => [...prev, ...newImages])
    }
  }, [])

  /** 移除指定图片 */
  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id))
  }, [])

  /** 清空所有图片 */
  const clearImages = useCallback(() => {
    setImages([])
  }, [])

  return { images, setImages, addImages, addImagePaths, removeImage, clearImages }
}

// ====================================================================
// 文件附件（只存路径，不拷贝文件内容）
// ====================================================================

/** 文件附件 */
export interface FileAttachment {
  id: string
  /** 文件绝对路径（分隔符统一为 /） */
  path: string
  /** 文件名（含扩展名） */
  name: string
  /** 是否为目录 */
  isDir?: boolean
  /** 字节数（目录无此值） */
  size?: number
}

/** 走「图片分支」的扩展名（与 <input accept> 白名单保持一致） */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

/**
 * 路径分隔符统一成 /（与全项目其他路径保持一致，便于展示与拼接）
 */
export function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 取路径末段作为文件名 */
function fsBaseName(p: string): string {
  const parts = normalizeFsPath(p).split('/')
  return parts[parts.length - 1] || p
}

/** 扩展名（小写，不含点） */
function extOf(p: string): string {
  const name = fsBaseName(p)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 是否按图片处理：扩展名在白名单内才算（其余图片格式走文件分支，保持与选图一致） */
export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.includes(extOf(p))
}

/** 扩展名 → MIME */
function mimeOf(p: string): string {
  switch (extOf(p)) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 读取磁盘上的图片 → dataURL（超尺寸自动压缩）
 *
 * 拖拽进来的是「路径」而不是 File，这里读字节还原成 File，
 * 复用 fileToDataUrl 的压缩逻辑，行为与 <input type="file"> 选图完全一致。
 */
export async function readImageFileAsDataUrl(path: string): Promise<string> {
  const bytes = await tauriFs.readFile(path)
  const name = fsBaseName(path)
  const file = new File([bytes as unknown as BlobPart], name, {
    type: mimeOf(path),
  })
  return fileToDataUrl(file)
}

/**
 * 文件附件管理 hook
 *
 * 只保存路径与展示元数据（stat 得到的体积 / 是否目录），
 * 不复制、不读取文件内容——真正的读取交给 AI 用 read_file 工具按需完成。
 */
export function useFileAttachment() {
  const [files, setFiles] = useState<FileAttachment[]>([])

  /** 添加文件路径（stat 校验存在性 + 去重） */
  const addPaths = useCallback(async (paths: string[]) => {
    const added: FileAttachment[] = []
    let firstInvalid = ''

    for (const raw of paths) {
      const path = normalizeFsPath(raw)
      try {
        const info = await tauriFs.stat(path)
        added.push({
          id: v4(),
          path,
          name: fsBaseName(path),
          isDir: info.isDirectory,
          size: info.isDirectory ? undefined : info.size,
        })
      } catch {
        firstInvalid = firstInvalid || path
      }
    }

    if (firstInvalid) {
      showToast(tpl('无法访问该路径：$__path__', { path: firstInvalid }))
    }
    if (added.length === 0) return

    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.path))
      return [...prev, ...added.filter((f) => !seen.has(f.path))]
    })
  }, [])

  /** 移除指定文件 */
  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  /** 清空所有文件 */
  const clearFiles = useCallback(() => {
    setFiles([])
  }, [])

  return { files, setFiles, addPaths, removeFile, clearFiles }
}

// ====================================================================
// 引用消息（只存被引用消息的元数据 + 正文快照）
// ====================================================================

/** 引用附件 */
export interface QuoteAttachment {
  /** 被引用消息的 id（同时用作列表 key / 去重键） */
  messageId: string
  /** 被引用消息的发送方 */
  role: 'user' | 'assistant'
  /** 被引用消息的正文快照 */
  text: string
}

/**
 * 引用消息管理 hook
 *
 * 与文件 / 图片附件不同，引用不做任何 IO：只把「哪条消息」记下来，
 * 正文以快照形式一并保存——原消息可能被删除、被上下文压缩（summary）替换，
 * 或被分页懒加载移出内存，只存 id 的话发给模型的引用内容会缺。
 */
export function useQuoteAttachment() {
  const [quotes, setQuotes] = useState<QuoteAttachment[]>([])

  /** 添加引用（同一条消息只保留一次） */
  const addQuote = useCallback((quote: QuoteAttachment) => {
    setQuotes((prev) =>
      prev.some((q) => q.messageId === quote.messageId)
        ? prev
        : [...prev, quote],
    )
  }, [])

  /** 移除指定引用 */
  const removeQuote = useCallback((messageId: string) => {
    setQuotes((prev) => prev.filter((q) => q.messageId !== messageId))
  }, [])

  /** 清空所有引用 */
  const clearQuotes = useCallback(() => {
    setQuotes([])
  }, [])

  return { quotes, setQuotes, addQuote, removeQuote, clearQuotes }
}

// ====================================================================
// 技能引用（存 SKILL.md 全文快照）
// ====================================================================

/** 技能引用附件 */
export interface SkillAttachment {
  id: string
  /** 技能唯一标识（skillStore 的 meta.name） */
  name: string
  /** 技能源码目录绝对路径（chip 展示 / 打开目录用） */
  path: string
  /** 技能描述（SKILL.md frontmatter）：消息气泡的卡片正文用 */
  description?: string
  /** SKILL.md 全文快照（挂载时读一次，发送后技能被改 / 删都不影响本条消息） */
  content: string
}

/**
 * SKILL.md 最大收录字符数
 *
 * 技能说明通常几 KB，但用户完全可以塞一本手册进去——那会把单次请求体撑爆。
 * 超限则截断（并明确提示），而不是静默失败或原样发出去。
 */
const SKILL_MD_MAX_CHARS = 100_000

/**
 * 技能引用管理 hook
 *
 * 与文件附件（只记路径，内容交给模型用工具读）的关键区别：这里**读全文并快照**。
 * 读的是 `skill.path/SKILL.md` 而不是按技能名拼路径——技能目录名允许与
 * frontmatter 的 name 不一致（见 skillStore 的注册逻辑），path 才是权威。
 */
export function useSkillAttachment() {
  const [skills, setSkills] = useState<SkillAttachment[]>([])

  /** 按技能名添加引用（读 SKILL.md 全文 + 去重；同名技能只保留一份） */
  const addSkills = useCallback(async (names: string[]) => {
    const added: SkillAttachment[] = []
    let failedName = ''
    let truncated = false

    for (const raw of names) {
      const name = (raw || '').trim()
      if (!name) continue
      const skill = getRegisteredSkill(name)
      if (!skill) {
        failedName = failedName || name
        continue
      }
      try {
        let content = await tauriFs.readTextFile(`${skill.path}/SKILL.md`)
        if (content.length > SKILL_MD_MAX_CHARS) {
          content = `${content.slice(0, SKILL_MD_MAX_CHARS)}\n\n…[SKILL.md truncated]`
          truncated = true
        }
        added.push({
          id: v4(),
          name: skill.meta.name,
          path: skill.path,
          // 描述取注册元信息（与 SKILL.md 同源于 frontmatter），随消息快照下去
          description: skill.meta.description,
          content,
        })
      } catch {
        failedName = failedName || name
      }
    }

    if (failedName) {
      showToast(tpl('读取技能失败：$__name__', { name: failedName }))
    }
    if (truncated) {
      showToast(
        tpl('SKILL.md 过大，已截断到 $__count__ 字符', {
          count: SKILL_MD_MAX_CHARS,
        }),
      )
    }
    if (added.length === 0) return

    setSkills((prev) => {
      const seen = new Set(prev.map((s) => s.name))
      return [...prev, ...added.filter((s) => !seen.has(s.name))]
    })
  }, [])

  /** 移除指定技能引用 */
  const removeSkill = useCallback((id: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== id))
  }, [])

  /**
   * 按技能名移除引用
   *
   * 侧边栏卡片「再点一下取消」和输入框 chip 的 ✕ 走两条路：chip 持有 id，卡片只知道名字。
   */
  const removeSkillsByName = useCallback((names: string[]) => {
    const targets = new Set(names)
    setSkills((prev) => prev.filter((s) => !targets.has(s.name)))
  }, [])

  /** 清空所有技能引用 */
  const clearSkills = useCallback(() => {
    setSkills([])
  }, [])

  return { skills, setSkills, addSkills, removeSkill, removeSkillsByName, clearSkills }
}

// ====================================================================
// 剪贴板里的文件路径（原生）
// ====================================================================

/**
 * 读系统剪贴板里的文件路径
 *
 * 页面 paste 事件只能拿到 File（有文件名、没有磁盘路径），资源管理器 / VS Code 里
 * 「复制」的文件在 WebView2 里往往连文本形式都拿不到，所以路径统一问原生要。
 * 原生侧识别 Windows 上两种格式：资源管理器的 CF_HDROP、VS Code 的 code/file-list。
 * 非 Tauri 环境 / 平台不支持（macOS、Linux）/ 剪贴板里没有文件，一律返回空数组，
 * 由调用方退回「从剪贴板文本里解析路径」的兜底逻辑。
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  try {
    const paths = await invoke<string[]>('read_clipboard_file_paths')
    return Array.isArray(paths) ? paths : []
  } catch {
    return []
  }
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
