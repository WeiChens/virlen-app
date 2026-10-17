/**
 * 知识库文件导入工具（无组件状态）：多编码读取 + 逐份入库，刷新列表由 afterImport 回调注入。
 *
 * 能否入库看内容不看扩展名：PDF 交后端抽文字，其余当纯文本试读（多编码 + looksLikeText 自检）。
 * 批量路径共用进度弹窗，取消在每份的边界生效；.gitignore / 依赖目录 / 大小筛选在 Rust 侧。
 */
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { beginTask } from '@/ui/components/shared/TaskProgress'
import type { BatchTask } from '@/ui/components/shared/TaskProgress'

/** 纯文本上限（2 MB），与 Rust import_scan::MAX_TEXT_FILE_BYTES 同值 */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

/** PDF 上限（50 MB），与后端 MAX_DOC_SIZE_BYTES 同值 */
export const MAX_PARSE_DOC_BYTES = 50 * 1024 * 1024

/** 字节数 → 「x MB」（只用在提示文案里） */
export function mbOf(bytes: number): string {
  return String(Math.round(bytes / 1024 / 1024))
}

/**
 * 是否交后端解析（只有 PDF）：前端对二进制只会解成乱码，其余一律当纯文本试读。
 * 后端支持新格式时，这里与 Rust PARSEABLE_EXTENSIONS 要一起改。
 */
export function isPdfFile(filePath: string): boolean {
  return filePath.split('.').pop()?.toLowerCase() === 'pdf'
}

/** 文件大小（拿不到返回 null） */
async function fileSizeOf(filePath: string): Promise<number | null> {
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    return (await stat(filePath)).size
  } catch {
    return null
  }
}

/** 是否超过上限（拿不到大小 → 不算超过：真护栏在 Rust 侧） */
export async function exceedsSize(filePath: string, limit: number): Promise<boolean> {
  const size = await fileSizeOf(filePath)
  return size !== null && size > limit
}

/**
 * 超限就抛错（文案直接给用户看）。在读之前判，避免几十 MB 先读进内存。
 */
async function assertSize(filePath: string, limit: number) {
  if (await exceedsSize(filePath, limit)) {
    throw new Error(tpl('文件超过 $__limit__ MB', { limit: mbOf(limit) }))
  }
}

/**
 * 解码结果看着像文本吗。必要：兼容编码（iso-8859-1 / windows-1252）对任何字节都「解码成功」，
 * 没这道过滤二进制会静默入库。
 */
export function looksLikeText(text: string): boolean {
  if (text.includes('\u0000')) return false
  const sample = text.slice(0, 4000)
  if (sample.length === 0) return false
  let bad = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0
    // 允许制表 / 换行 / 回车；其余 C0 控制字符与替换字符都算不是文本
    const isControl =
      code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d
    if (isControl || code === 0xfffd) bad++
  }
  return bad / sample.length < 0.05
}

/** 取路径末段的文件名 */
export function extractFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

/** 多编码读取：读不出可读内容返回 null */
export async function tryDecodeTextFile(
  filePath: string,
): Promise<{ text: string; encoding: string } | null> {
  // 1. 先试 UTF-8（最常用）
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const text = await readTextFile(filePath)
    // 看着不像文本（二进制被解成一堆替换字符）就继续试下一种
    if (looksLikeText(text)) return { text, encoding: 'UTF-8' }
  } catch {
    // UTF-8 失败，继续尝试其他编码
  }

  // 2. 读取原始二进制数据，用 TextDecoder 尝试多种编码
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const data = await readFile(filePath)

    // 末两个是「永不失败」的兼容编码：靠 looksLikeText 兜底
    const encodings = [
      'gbk',
      'gb2312',
      'shift-jis',
      'big5',
      'euc-jp',
      'euc-kr',
      'iso-8859-1',
      'windows-1252',
    ] as const

    for (const enc of encodings) {
      try {
        const decoder = new TextDecoder(enc, { fatal: true })
        const text = decoder.decode(data)
        // 解码成功且内容看着真的是文本
        if (text && text.length > 0 && looksLikeText(text)) {
          return { text, encoding: enc.toUpperCase() }
        }
      } catch {
        continue // 此编码失败，试下一个
      }
    }
  } catch {
    // 连二进制都无法读取，返回 null
  }

  return null
}

/** 将文本直接写入知识库（绕过 Rust 读文件，用于非 UTF-8 文件 / 压缩包条目） */
export async function uploadTextContent(
  kbId: string,
  fileName: string,
  content: string,
) {
  await ragService.writeText(kbId, fileName, content)
}

/** 计算相对 baseDir 的路径（文件夹导入时保留目录结构） */
export function getRelativePath(filePath: string, baseDir: string): string {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedFile.startsWith(normalizedBase + '/')) {
    return normalizedFile.slice(normalizedBase.length + 1)
  }
  return extractFileName(filePath)
}

/** 该库现有文档：文档名 → 文档 id */
export async function loadDocIdByName(kbId: string): Promise<Map<string, string>> {
  const docs = await ragService.listDocuments(kbId)
  return new Map(docs.map((d) => [d.file_name, d.id]))
}

/**
 * 导入前说清「会覆盖哪几份」，返回是否覆盖。取消 = 只跳过同名，其余照常导入。
 */
export async function confirmOverwrite(names: string[]): Promise<boolean> {
  if (names.length === 0) return false
  const head = names.slice(0, 3).join('、')
  const rest = names.length > 3 ? tpl(' 等 $__count__ 份', { count: names.length }) : ''
  return (
    (await MessageBox.propt(
      t('有同名文档'),
      tpl(
        '这个库里已经有：$__names__。\n覆盖 = 用新文件的内容替换它们；跳过同名 = 保留原来的，只加新的。',
        { names: `${head}${rest}` },
      ),
      { danger: true, confirmText: t('覆盖'), cancelText: t('跳过同名') },
    )) === true
  )
}

/** 导入选项（都可选，不传 = 原行为） */
export interface UploadOptions {
  /** 该库现有文档名 → id（由调用方扫一次传入） */
  existing?: Map<string, string>
  /** 同名文档是否覆盖（false = 跳过同名、只加新的） */
  overwrite?: boolean
  /** 指定后使用相对路径作为文档名称（用于文件夹导入） */
  baseDir?: string
}

/** 一次导入的四个计数 */
export interface ImportCounts {
  /** 新入库的文档数 */
  created: number
  /** 同名且按策略覆盖掉的文档数 */
  overwritten: number
  /** 同名但策略为「不覆盖」而跳过的文档数 */
  skipped: number
  /** 读不了 / 空内容 / 超过大小上限的文档数 */
  failed: number
}

/**
 * 四个计数 → 一句用户能读的话。三个导入入口共用：只报「新增」会把覆盖 / 跳过 / 失败藏掉。
 */
export function summarizeImport(counts: ImportCounts): string {
  const parts: string[] = []
  if (counts.created > 0)
    parts.push(tpl('新增 $__count__ 份', { count: counts.created }))
  if (counts.overwritten > 0)
    parts.push(tpl('覆盖 $__count__ 份', { count: counts.overwritten }))
  if (counts.skipped > 0)
    parts.push(tpl('跳过同名 $__count__ 份', { count: counts.skipped }))
  if (counts.failed > 0)
    parts.push(tpl('$__count__ 份没成功', { count: counts.failed }))
  return parts.length > 0 ? parts.join('，') : t('没有可导入的文件')
}

/** 报过程文案：有进度弹窗就写进弹窗，否则 toast */
function reportOrToast(
  task: BatchTask | undefined,
  index: number,
  counts: ImportCounts,
  text: string,
  duration = 2500,
) {
  if (task) task.step(index, text, summarizeImport(counts))
  else showToast(text, duration)
}

/** 收尾报账：弹窗接过去显示，否则 toast 一句 */
function reportFinish(task: BatchTask | undefined, counts: ImportCounts) {
  const summary = summarizeImport(counts)
  if (task) task.finish(task.cancelled, summary)
  else showToast(summary, counts.failed > 0 ? 3000 : 2500)
}

/**
 * 批量上传本地文件到知识库。
 * @param options 同名策略 / 文件夹导入的文档名控制
 * @param task 进度弹窗手柄（选文档不传 = 走 toast）
 */
export async function uploadFiles(
  kbId: string,
  filePaths: string[],
  options: UploadOptions = {},
  afterImport?: () => Promise<void>,
  task?: BatchTask,
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    created: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
  }
  if (filePaths.length === 0) return counts

  const {
    existing = new Map<string, string>(),
    overwrite = false,
    baseDir,
  } = options

  let index = 0
  for (const fp of filePaths) {
    // 取消停在整份的边界上（要么整份进来，要么没进来）
    if (task?.cancelled) break
    index++

    const name = extractFileName(fp)
    // 文件夹导入用相对路径作为文档名
    const docName = baseDir ? getRelativePath(fp, baseDir) : name
    const existingId = existing.get(docName)

    // 同名且不覆盖 → 跳过（用户选的，不算失败）
    if (existingId && !overwrite) {
      counts.skipped++
      reportOrToast(
        task,
        index,
        counts,
        tpl('跳过同名的「$__name__」', { name: docName }),
      )
      continue
    }

    try {
      if (isPdfFile(fp)) {
        // PDF 只交后端抽文字；文档名必须由前端传下去，否则文件夹导入会丢相对路径
        reportOrToast(
          task,
          index,
          counts,
          tpl('正在读入「$__fileName__」…', { fileName: docName }),
        )
        await assertSize(fp, MAX_PARSE_DOC_BYTES)
        if (existingId) {
          // edit 是先删旧块再写新块，中途失败不会弄丢原文档
          await ragService.editDocument(kbId, existingId, fp, docName)
          counts.overwritten++
        } else {
          await ragService.addDocument(kbId, fp, docName)
          counts.created++
        }
        continue
      }

      // 其余一律当纯文本试读：先卡大小（别整个读进内存），再解码 + 内容自检
      await assertSize(fp, MAX_TEXT_FILE_BYTES)
      const decoded = await tryDecodeTextFile(fp)
      if (!decoded) {
        counts.failed++
        reportOrToast(
          task,
          index,
          counts,
          tpl('跳过「$__name__」：这个文件读不出文字（可能是二进制文件）', {
            name: docName,
          }),
          3000,
        )
        continue
      }
      reportOrToast(
        task,
        index,
        counts,
        decoded.encoding === 'UTF-8'
          ? tpl('正在读入「$__fileName__」…', { fileName: docName })
          : tpl('正在读入「$__fileName__」（$__encoding__）…', {
              fileName: docName,
              encoding: decoded.encoding,
            }),
      )
      if (existingId) {
        // 覆盖：走文本命令，文档名沿用原来那份
        await ragService.editTextDocument(kbId, existingId, docName, decoded.text)
        counts.overwritten++
      } else {
        await uploadTextContent(kbId, docName, decoded.text)
        counts.created++
      }
    } catch (err: any) {
      counts.failed++
      reportOrToast(
        task,
        index,
        counts,
        tpl('「$__name__」没能加进来：$__error__', {
          name: docName,
          error: err?.message || err?.toString() || t('未知错误'),
        }),
        3000,
      )
    }
  }

  // 刷新文档 / 知识库列表（由调用方注入）
  if (afterImport) await afterImport()
  // 四种结局拆开报账
  reportFinish(task, counts)
  return counts
}

/**
 * 逐条导入压缩包条目。逐条读 + 逐条写库：既能报进度 / 取消，也继承了记忆正文护栏。
 * 同名按策略覆盖或跳过；条目超过 MAX_TEXT_FILE_BYTES 算这一条失败。
 */
export async function importZipEntries(
  kbId: string,
  zipPath: string,
  names: string[],
  options: { existing?: Map<string, string>; overwrite?: boolean },
  afterImport?: () => Promise<void>,
  task?: BatchTask,
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    created: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
  }
  const { existing = new Map<string, string>(), overwrite = false } = options

  let index = 0
  for (const name of names) {
    if (task?.cancelled) break
    index++

    const existingId = existing.get(name)
    if (existingId && !overwrite) {
      counts.skipped++
      reportOrToast(
        task,
        index,
        counts,
        tpl('跳过同名的「$__name__」', { name }),
      )
      continue
    }

    reportOrToast(task, index, counts, tpl('正在读入「$__fileName__」…', { fileName: name }))
    try {
      const text = await ragService.readKnowledgeBaseZipEntry(zipPath, name)
      if (!text.trim()) throw new Error(t('内容是空的'))
      if (new TextEncoder().encode(text).length > MAX_TEXT_FILE_BYTES) {
        throw new Error(
          tpl('文件超过 $__limit__ MB', { limit: mbOf(MAX_TEXT_FILE_BYTES) }),
        )
      }
      if (existingId) {
        await ragService.editTextDocument(kbId, existingId, name, text)
        counts.overwritten++
      } else {
        await ragService.writeText(kbId, name, text)
        counts.created++
      }
    } catch (err: any) {
      counts.failed++
      reportOrToast(
        task,
        index,
        counts,
        tpl('「$__name__」没能加进来：$__error__', {
          name,
          error: err?.message || err,
        }),
        3000,
      )
    }
  }

  if (afterImport) await afterImport()
  reportFinish(task, counts)
  return counts
}

/** 上传文档（多选，量小走 toast） */
export async function pickUploadFiles(
  kbId: string,
  afterImport?: () => Promise<void>,
) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      // 不按扩展名筛：能否读由导入时按内容判断
      filters: [{ name: t('所有文件'), extensions: ['*'] }],
    })
    if (!selected) return

    const paths = Array.isArray(selected) ? selected : [selected]
    if (paths.length === 0) return

    // 先扫现有文档名，同名就问一次（不在循环里逐份问）
    const existing = await loadDocIdByName(kbId)
    const dup = (paths as string[])
      .map((p) => extractFileName(p))
      .filter((n) => existing.has(n))
    const overwrite = await confirmOverwrite(dup)

    await uploadFiles(kbId, paths as string[], { existing, overwrite }, afterImport)
  } catch (err: any) {
    showToast(tpl('添加失败：$__error__', { error: err.message }), 3000)
  }
}

/**
 * 扫到了哪些跳过的东西 —— 弹窗里说清「为什么少了这么多」。字段与 Rust FolderScan 一一对应。
 */
export function scanSkipNotes(scan: {
  ignored: number
  skipped_dirs: number
  not_text: number
  text_too_large: number
  pdf_too_large: number
}): string[] {
  const notes: string[] = []
  if (scan.ignored > 0)
    notes.push(tpl('$__count__ 份被 .gitignore 排除，已跳过', { count: scan.ignored }))
  if (scan.skipped_dirs > 0)
    notes.push(
      tpl('$__count__ 个依赖或构建目录（node_modules、dist 之类）已跳过', {
        count: scan.skipped_dirs,
      }),
    )
  if (scan.not_text > 0)
    notes.push(tpl('$__count__ 份不是文本文件，已跳过', { count: scan.not_text }))
  if (scan.text_too_large > 0)
    notes.push(
      tpl('$__count__ 份超过 $__limit__ MB，已跳过', {
        count: scan.text_too_large,
        limit: mbOf(MAX_TEXT_FILE_BYTES),
      }),
    )
  if (scan.pdf_too_large > 0)
    notes.push(
      tpl('$__count__ 份 PDF 超过 $__limit__ MB，已跳过', {
        count: scan.pdf_too_large,
        limit: mbOf(MAX_PARSE_DOC_BYTES),
      }),
    )
  return notes
}

/**
 * 上传文件夹：扫描（按内容 + .gitignore + 依赖目录过滤）后逐份导入，全程可取消。
 * @param kbName 弹窗里让用户确认「导的是这个库」
 */
export async function pickUploadFolder(
  kbId: string,
  kbName: string,
  afterImport?: () => Promise<void>,
) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
    })
    if (!selected) return

    const dirPath = selected as string
    showToast(t('正在看这个文件夹里有哪些文档…'))
    // 扫描在 Rust 侧做：与「打成压缩包导入」同一套 .gitignore 口径
    let scan
    try {
      scan = await ragService.scanImportFolder(dirPath)
    } catch (err: any) {
      showToast(tpl('文件夹没能加进来：$__error__', { error: err.message }), 3000)
      return
    }

    if (scan.files.length === 0) {
      const notes = scanSkipNotes(scan).join('，')
      showToast(
        notes
          ? tpl('这个文件夹里没有能导入的内容：$__notes__', { notes })
          : t('这个文件夹里没有能导入的内容（只收 PDF 和纯文本文件）'),
        3000,
      )
      return
    }

    // 文档名是相对路径，重名比对也要用相对路径
    const existing = await loadDocIdByName(kbId)
    const dup = scan.files
      .map((fp) => getRelativePath(fp, dirPath))
      .filter((n) => existing.has(n))
    const overwrite = await confirmOverwrite(dup)

    const task = beginTask({
      title: t('正在添加文档'),
      source: tpl('「$__name__」· 从文件夹 $__dir__', {
        name: kbName,
        dir: extractFileName(dirPath) || dirPath,
      }),
      total: scan.files.length,
      doneText: t('导入完成'),
      stoppedText: t('已停止导入'),
      stoppingHint: t(
        '正在停下 —— 这一份处理完就收手，已经进来的文档不会回退',
      ),
      ariaLabel: t('导入进度'),
    })
    const skipNotes = scanSkipNotes(scan)
    if (skipNotes.length > 0) {
      // 先把「有些东西没进来、为什么」写进弹窗的最新文案
      task.step(0, skipNotes.join('\n'), '')
    }
    try {
      await uploadFiles(
        kbId,
        scan.files,
        { baseDir: dirPath, existing, overwrite },
        afterImport,
        task,
      )
    } catch (err: any) {
      // 兜底：不该发生（uploadFiles 内部逐份兜错），但弹窗不能卡在运行中
      showToast(tpl('导入没能完成：$__error__', { error: err?.message || err }), 3000)
      task.finish(true, t('导入没能完成'))
    }
  } catch (err: any) {
    showToast(tpl('文件夹没能加进来：$__error__', { error: err.message }), 3000)
  }
}
