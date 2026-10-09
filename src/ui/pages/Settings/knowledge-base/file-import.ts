/**
 * 知识库文件导入工具 —— 全是「传参进、结果出」的工具（多编码读取 / 逐份入库），不含组件状态；
 * 刷新列表通过 `afterImport` 回调注入，避免反向依赖组件。
 *
 * **哪些文件能进库：不再看扩展名，看内容**
 * - PDF → 交给后端抽文字（二进制，前端所有解码对它都只会得到乱码）；
 * - 其余一切文件（`.md` / `.json` / `.py` / 没扩展名的都算）→ 当纯文本试读：多编码解码 + 内容自检，
 *   能读出文字就入库，读不出就跳过并说清是哪一份；
 * - 大小：纯文本 2 MB（[`MAX_TEXT_FILE_BYTES`]）、PDF 50 MB（[`MAX_PARSE_DOC_BYTES`]）。
 *   文件夹那条路径的筛选在 Rust 侧（同一个口径），这里再卡一道是为了「选单个文件」也守得住。
 *
 * 两条**批量**路径（选文件夹 / 导入压缩包）都跑在同一个进度弹窗下（`shared/TaskProgress`）：
 * 每处理一份报一次进度、显示最新一条文案，用户随时可以取消 —— 取消在**下一份的边界**上生效
 * （每份之间查一次 `task.cancelled`），所以不会出现「半个文件进了库」。
 * 逐条的过程文案进弹窗，不再逐份弹 toast（几十份会把屏幕刷满）；「选文档」是多选几个文件、
 * 量小，仍旧走 toast（见 [`reportOrToast`]）。
 *
 * `.gitignore`、依赖与构建目录（`node_modules` 等）、以及内容/大小筛选，都在 Rust 侧按同一套规则做
 *（`rag::import_scan`）—— 这里只拿过滤后的清单，外加「各排除了几份」这些数，好给用户一句交代。
 *
 * 同名文档：调用方先扫一遍现有文档名（[`loadDocIdByName`]），扫到重名就用 [`confirmOverwrite`]
 * 问一次（覆盖 / 跳过同名）—— 不在循环里逐份问，导入一个文件夹弹十几次确认没法用。
 */
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { showToast } from '@/ui/components/shared/Toast'
import { beginTask } from '@/ui/components/shared/TaskProgress'
import type { BatchTask } from '@/ui/components/shared/TaskProgress'

/** 纯文本文件的大小上限（2 MB）—— 与 Rust 侧 `import_scan::MAX_TEXT_FILE_BYTES` 同一个值 */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

/** 可解析文档（PDF）的大小上限（50 MB）—— 与后端 `rag_service::MAX_DOC_SIZE_BYTES` 同一个值 */
export const MAX_PARSE_DOC_BYTES = 50 * 1024 * 1024

/** 字节数 → 「x MB」（只用在提示文案里） */
export function mbOf(bytes: number): string {
  return String(Math.round(bytes / 1024 / 1024))
}

/**
 * 这个文件交给**后端解析**吗（而不是当纯文本读）。
 *
 * 只有 PDF：它是二进制，前端所有的文本解码对它都只会得到乱码（`document::parse_document`
 * 负责抽文字）。其余一切文件 —— 不管是 `.md` / `.json` / `.py` 还是没扩展名的 —— 都走
 * 「当纯文本试读」这条路：能解码成文本就进库，读不出文字就跳过。
 * ⚠️ 后端将来支持新格式时，这里与 Rust `import_scan::PARSEABLE_EXTENSIONS` 要一起改。
 */
export function isPdfFile(filePath: string): boolean {
  return filePath.split('.').pop()?.toLowerCase() === 'pdf'
}

/** 文件大小（拿不到就返回 null —— 例如测试环境或路径已失效） */
async function fileSizeOf(filePath: string): Promise<number | null> {
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    return (await stat(filePath)).size
  } catch {
    return null
  }
}

/**
 * 这个文件是否超过给定上限（拿不到大小 → 不算超过：真护栏在 Rust 侧）
 *
 * 给「读之前先挡一下」用（见 [`assertSize`] 与 `EditDocModal` 的从文件读入）。
 */
export async function exceedsSize(filePath: string, limit: number): Promise<boolean> {
  const size = await fileSizeOf(filePath)
  return size !== null && size > limit
}

/**
 * 超过大小上限就抛错（抛出来的文案直接给用户看）。
 *
 * 为什么要在**读之前**判：几十 MB 的文件先整个读进内存再发现超限，白等白占内存。
 * 为什么拿不到大小就放行：真护栏在 Rust 侧（扫描时按大小筛、写库时另有上限），
 * 这里只是把「太大」这件事提前说清楚。
 */
async function assertSize(filePath: string, limit: number) {
  if (await exceedsSize(filePath, limit)) {
    throw new Error(tpl('文件超过 $__limit__ MB', { limit: mbOf(limit) }))
  }
}

/**
 * 解码结果看着像文本吗。
 *
 * 为什么必须有这道检查：下面的兼容编码里含 `iso-8859-1` / `windows-1252` ——
 * 它们把**每一个字节**都映射到一个字符，所以对任何二进制文件都「解码成功」、永不报错。
 * 没有这道过滤，函数就永远不会返回 null，「读不出来」那条分支实际上不可达，
 * 二进制内容会静默入库（PDF 被读成乱码填进编辑框就是这么来的）。
 */
export function looksLikeText(text: string): boolean {
  if (text.includes('\u0000')) return false
  const sample = text.slice(0, 4000)
  if (sample.length === 0) return false
  let bad = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0
    // 允许制表 / 换行 / 回车；其余 C0 控制字符与替换字符都算「不是文本」
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

/** 尝试用多种编码读取文件，返回解码后的 UTF-8 文本；读不出人类可读的内容时返回 null */
export async function tryDecodeTextFile(
  filePath: string,
): Promise<{ text: string; encoding: string } | null> {
  // 1. 先试 UTF-8（最常用）
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const text = await readTextFile(filePath)
    // 看着不像文本（二进制被解成一堆替换字符）就继续往下试，别当结果直接返回
    if (looksLikeText(text)) return { text, encoding: 'UTF-8' }
  } catch {
    // UTF-8 失败，继续尝试其他编码
  }

  // 2. 读取原始二进制数据，用 TextDecoder 尝试多种编码
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const data = await readFile(filePath)

    // 按优先级尝试的编码列表（末两个是「永不失败」的兼容编码：靠 looksLikeText 兜底）
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
        // 解码成功，且内容看着真的是文本
        if (text && text.length > 0 && looksLikeText(text)) {
          return { text, encoding: enc.toUpperCase() }
        }
      } catch {
        continue // 此编码失败，尝试下一个
      }
    }
  } catch {
    // 连二进制都无法读取，返回 null
  }

  return null
}

/** 将文本内容直接写入知识库（绕过 Rust 端文件读取，用于非 UTF-8 文件 / 压缩包条目） */
export async function uploadTextContent(
  kbId: string,
  fileName: string,
  content: string,
) {
  await ragService.writeText(kbId, fileName, content)
}

/** 计算文件相对于 baseDir 的路径（用于文件夹导入时保留目录结构） */
export function getRelativePath(filePath: string, baseDir: string): string {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedFile.startsWith(normalizedBase + '/')) {
    return normalizedFile.slice(normalizedBase.length + 1)
  }
  return extractFileName(filePath)
}

/** 该库现有文档：文档名 → 文档 id（同名判定与「覆盖」都靠它） */
export async function loadDocIdByName(kbId: string): Promise<Map<string, string>> {
  const docs = await ragService.listDocuments(kbId)
  return new Map(docs.map((d) => [d.file_name, d.id]))
}

/**
 * 导入前把「会覆盖哪几份」说清，返回是否覆盖。
 *
 * `names` 为空 → 不弹窗、直接返回 false。
 * ⚠️ 取消 = 只跳过同名的那些，**其余照常导入** —— 文案里必须写明，否则用户会以为整次导入取消了。
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

/** 导入选项（三样都是可选的，不传 = 原行为） */
export interface UploadOptions {
  /** 该库现有文档：文档名 → 文档 id（同名判定与「覆盖」用；由调用方扫一次传入） */
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
 * 把导入的四个计数拼成一句用户能读的话。
 *
 * 三个导入入口（选文件 / 文件夹、导入压缩包）共用一套说法 —— 只说「加了几份」会把
 * 「覆盖了几份」「跳过了几份」藏掉，而这三件事对用户的意味完全不同。
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

/**
 * 报一条过程文案：有进度弹窗就写进弹窗（只留最新一条），没有就走 toast。
 *
 * 「选文档」那条路径一次也就几个文件，弹窗反而碍事 —— 那时 `task` 为空，行为与从前一致。
 */
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

/** 收尾报账：弹窗接过去显示（带「导入完成 / 已停止导入」），否则 toast 一句 */
function reportFinish(task: BatchTask | undefined, counts: ImportCounts) {
  const summary = summarizeImport(counts)
  if (task) task.finish(task.cancelled, summary)
  else showToast(summary, counts.failed > 0 ? 3000 : 2500)
}

/**
 * 批量上传多个本地文件到知识库
 *
 * @param kbId       知识库 ID
 * @param filePaths  文件路径列表
 * @param options    同名策略 / 文件夹导入的文档名控制（见 [`UploadOptions`]）
 * @param afterImport 导入完成后回调（刷新文档 / 知识库列表）
 * @param task       进度弹窗手柄（文件夹导入传；「选文档」不传 = 走 toast）
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
    // 用户取消：停在**整份的边界**上（每一份要么整份进来，要么没进来）
    if (task?.cancelled) break
    index++

    const name = extractFileName(fp)
    // 文件夹导入时，用相对路径作为文档名（如 test/test.md）
    const docName = baseDir ? getRelativePath(fp, baseDir) : name
    const existingId = existing.get(docName)

    // 同名且不覆盖 → 跳过（这是用户选的，不算失败）
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
        // PDF：二进制，只交给后端抽文字（前端任何解码都只会得到乱码）。
        // ⚠️ PDF 的文档名必须由前端传下去（`docName`）：后端默认用文件的基础名，
        // 文件夹导入会因此丢掉相对路径（`子/手册.pdf` 变成 `手册.pdf`，同名还会相撞）
        reportOrToast(
          task,
          index,
          counts,
          tpl('正在读入「$__fileName__」…', { fileName: docName }),
        )
        await assertSize(fp, MAX_PARSE_DOC_BYTES)
        if (existingId) {
          // 覆盖：`edit` 是「先删旧块再写新块」，中途失败不会把原来那份弄丢；
          // 文档名要显式传：后端默认取文件的基础名，文件夹导入会因此丢掉相对路径
          await ragService.editDocument(kbId, existingId, fp, docName)
          counts.overwritten++
        } else {
          await ragService.addDocument(kbId, fp, docName)
          counts.created++
        }
        continue
      }

      // 其余文件一律**当纯文本试读**（不再看扩展名）：
      // 先看大小（几十 MB 的文件不该被整个读进内存），再解码 + 内容自检。
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
        // 覆盖已有文档：走文本命令，文档名沿用原来那份
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

  // 刷新文档列表和知识库列表（由调用方注入）
  if (afterImport) await afterImport()
  // 一次导入可能有四种结局，拆开报账（只说「加了几份」会把「覆盖了几份」藏掉）
  reportFinish(task, counts)
  return counts
}

/**
 * 逐条导入压缩包里的条目（`names` 来自 `previewKnowledgeBaseZip`，已按包内 .gitignore 过滤）
 *
 * 为什么是一条一条读：整包一次性导入时界面既看不到进度也没法取消；逐条读（Rust 侧
 * `read_knowledge_base_zip_entry`）+ 逐条写库（现成的文本命令）两件都有了，
 * 而且顺带继承了那两条命令上的**记忆详情正文护栏**（某条是记忆正文 → 只失败那一条，不整批拒绝）。
 *
 * 同名看策略：覆盖走 `editTextDocument`（保留原文档名），不覆盖则计入 `skipped`。
 *
 * 大小：条目正文超过 [`MAX_TEXT_FILE_BYTES`]（2 MB）算这一条失败 —— 与文件夹导入同一把尺；
 * 正常走不到这里（Rust 预览名单里已经滤过一道，见 `zip_entry_names`），兜底是为了让「绕过预览
 * 直接调这条循环」也守得住。
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

/** 上传文档 — 支持多文件选择（量小，走 toast；文件夹 / 压缩包才用进度弹窗） */
export async function pickUploadFiles(
  kbId: string,
  afterImport?: () => Promise<void>,
) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      // 不按扩展名筛：「能不能读」由导入时按内容判断（文本就能读，PDF 交给后端解析）
      filters: [{ name: t('所有文件'), extensions: ['*'] }],
    })
    if (!selected) return

    const paths = Array.isArray(selected) ? selected : [selected]
    if (paths.length === 0) return

    // 先扫一遍现有文档名：扫到同名就问一次「覆盖 / 跳过同名」（不在循环里逐份问）
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
 * 扫到了哪些「跳过的东西」——弹窗里用一句话说清「为什么少了这么多」
 *
 * 与 Rust `import_scan::FolderScan` 的字段一一对应。四条原因分开说，因为四件事对用户的意味
 * 不同：被 .gitignore 排除（你自己写的规则）、依赖 / 构建目录（我们替你认的）、不是文本、太大。
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
 * 上传文件夹 — 扫描（按内容 + .gitignore + 依赖目录过滤）后逐份导入，全程一个可取消的进度弹窗
 *
 * @param kbId       知识库 ID
 * @param kbName     知识库名（弹窗里让用户确认「导的是这个库」）
 * @param afterImport 导入完成后回调（刷新文档 / 知识库列表）
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
    // 扫描在 Rust 侧做：同一个目录，按 .gitignore 过滤的结果与「打成压缩包导入」一致
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

    // 文件夹导入的文档名是「相对路径」，所以重名比对也要用相对路径（与 uploadFiles 同一算法）
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
      // 先把「有些东西没进来、为什么」说清楚（弹窗里那条「最新文案」，下一份处理时会被替换）
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
      // 兜底：不该发生（uploadFiles 内部逐份兜错），但弹窗不能卡在「运行中」
      showToast(tpl('导入没能完成：$__error__', { error: err?.message || err }), 3000)
      task.finish(true, t('导入没能完成'))
    }
  } catch (err: any) {
    showToast(tpl('文件夹没能加进来：$__error__', { error: err.message }), 3000)
  }
}
