/**
 * 知识库文件导入工具
 *
 * 全部是「传参进、结果出」的纯工具（多编码读取 / 目录扫描 / 批量导入），
 * 不含组件状态；需要刷新列表时通过 `afterImport` 回调注入，避免反向依赖组件。
 */
import { t, tpl } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import { showToastMsg } from './toast'

/** 支持的文件扩展名列表 */
export const SUPPORTED_EXTENSIONS = ['pdf', 'md', 'markdown', 'txt'] as const

/** 判断文件是否为受支持的文本文件（可根据扩展名判断是否可用 readTextFile 读取） */
export function isTextExtension(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown' || ext === 'txt'
}

/** 从文件路径中提取文件名 */
export function extractFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

/** 尝试用多种编码读取文件，返回解码后的 UTF-8 文本 */
export async function tryDecodeTextFile(
  filePath: string,
): Promise<{ text: string; encoding: string } | null> {
  // 1. 先试 UTF-8（最常用）
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const text = await readTextFile(filePath)
    return { text, encoding: 'UTF-8' }
  } catch {
    // UTF-8 失败，继续尝试其他编码
  }

  // 2. 读取原始二进制数据，用 TextDecoder 尝试多种编码
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const data = await readFile(filePath) // returns Uint8Array

    // 按优先级尝试的编码列表
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
        // 解码成功，且内容不为空/无意义二进制
        if (text && text.length > 0) {
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

/** 将文本内容直接写入知识库（绕过 Rust 端文件读取，用于非 UTF-8 文件） */
export async function uploadTextContent(
  kbId: string,
  fileName: string,
  content: string,
  encoding: string,
) {
  showToastMsg(
    tpl('正在导入「$__fileName__」($__encoding__)...', { fileName, encoding }),
    'info',
  )
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

/** 递归扫描目录，收集所有受支持的文本文件路径 */
export async function scanDirForTextFiles(
  dirPath: string,
  maxDepth = 5,
  currentDepth = 0,
): Promise<string[]> {
  if (currentDepth >= maxDepth) return []
  const results: string[] = []
  try {
    const { readDir } = await import('@tauri-apps/plugin-fs')
    const entries = await readDir(dirPath)
    for (const entry of entries) {
      if (!entry.name) continue
      const fullPath = `${dirPath}/${entry.name}`
      if (entry.isDirectory) {
        const subFiles = await scanDirForTextFiles(
          fullPath,
          maxDepth,
          currentDepth + 1,
        )
        results.push(...subFiles)
      } else if (entry.isFile && isTextExtension(entry.name)) {
        results.push(fullPath)
      }
    }
  } catch {
    // 跳过无法读取的目录
  }
  return results
}

/**
 * 批量上传多个文件到知识库
 *
 * @param kbId       知识库 ID
 * @param filePaths  文件路径列表
 * @param baseDir    可选，指定后使用相对路径作为文档名称（用于文件夹导入）
 * @param afterImport 可选，导入完成后回调（用于刷新文档列表 / 知识库列表）
 */
export async function uploadFiles(
  kbId: string,
  filePaths: string[],
  baseDir?: string,
  afterImport?: () => Promise<void>,
) {
  if (filePaths.length === 0) return

  let successCount = 0
  let failCount = 0
  for (let i = 0; i < filePaths.length; i++) {
    const fp = filePaths[i]
    const name = extractFileName(fp)
    // 文件夹导入时，用相对路径作为文档名（如 test/test.md）
    const docName = baseDir ? getRelativePath(fp, baseDir) : name

    // 文件夹导入时，所有文本文件统一走 writeText，以便控制文档名（保留目录结构）
    if (isTextExtension(fp) && baseDir) {
      const decoded = await tryDecodeTextFile(fp)
      if (decoded) {
        try {
          await uploadTextContent(kbId, docName, decoded.text, decoded.encoding)
          successCount++
          continue
        } catch (err: any) {
          showToastMsg(
            tpl('「$__name__」导入失败: $__error__', {
              name: docName,
              error: err?.message || err,
            }),
            'error',
          )
          failCount++
          continue
        }
      } else {
        showToastMsg(
          tpl('已跳过「$__name__」：无法识别的文件编码', { name: docName }),
          'error',
        )
        failCount++
        continue
      }
    }

    // 非文件夹导入 或 PDF 文件：使用原有的 addDocument / 编码检测逻辑
    if (isTextExtension(fp)) {
      const decoded = await tryDecodeTextFile(fp)
      if (decoded) {
        if (decoded.encoding !== 'UTF-8') {
          try {
            await uploadTextContent(kbId, docName, decoded.text, decoded.encoding)
            successCount++
            continue
          } catch (err: any) {
            showToastMsg(
              tpl('「$__name__」导入失败: $__error__', {
                name: docName,
                error: err?.message || err,
              }),
              'error',
            )
            failCount++
            continue
          }
        }
      } else {
        showToastMsg(
          tpl('已跳过「$__name__」：无法识别的文件编码（非 UTF-8/GBK 等常见编码）', {
            name: docName,
          }),
          'error',
        )
        failCount++
        continue
      }
    }

    try {
      await ragService.addDocument(kbId, fp)
      successCount++
    } catch (err: any) {
      const errMsg = err?.message || err?.toString() || t('未知错误')
      if (
        errMsg.includes('UTF-8') ||
        errMsg.includes('utf-8') ||
        errMsg.includes('read_to_string') ||
        errMsg.includes('读取文件失败')
      ) {
        const decoded = await tryDecodeTextFile(fp)
        if (decoded) {
          try {
            await uploadTextContent(kbId, docName, decoded.text, decoded.encoding)
            successCount++
            continue
          } catch {
            // 兜底也失败
          }
        }
        showToastMsg(
          tpl('已跳过「$__name__」：无法识别的文件编码', { name: docName }),
          'error',
        )
      } else {
        showToastMsg(
          tpl('「$__name__」导入失败: $__error__', { name: docName, error: errMsg }),
          'error',
        )
      }
      failCount++
    }
  }

  // 刷新文档列表和知识库列表（由调用方注入）
  if (afterImport) await afterImport()

  if (failCount === 0) {
    showToastMsg(
      tpl('成功导入 $__count__ 个文档', { count: successCount }),
      'success',
    )
  } else {
    showToastMsg(
      tpl('导入完成：$__success__ 成功，$__fail__ 失败', {
        success: successCount,
        fail: failCount,
      }),
      failCount > 0 ? 'error' : 'success',
    )
  }
}

/** 上传文档 — 支持多文件选择 */
export async function pickUploadFiles(
  kbId: string,
  afterImport?: () => Promise<void>,
) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: t('文档'),
          extensions: [...SUPPORTED_EXTENSIONS],
        },
      ],
    })
    if (!selected) return

    const paths = Array.isArray(selected) ? selected : [selected]
    if (paths.length === 0) return
    await uploadFiles(kbId, paths as string[], undefined, afterImport)
  } catch (err: any) {
    showToastMsg(tpl('上传失败: $__error__', { error: err.message }), 'error')
  }
}

/** 上传文件夹 — 扫描并导入所有文本文件 */
export async function pickUploadFolder(
  kbId: string,
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
    showToastMsg(t('正在扫描文件夹中的文本文件...'), 'info')
    const textFiles = await scanDirForTextFiles(dirPath)

    if (textFiles.length === 0) {
      showToastMsg(t('文件夹中未找到支持的文本文件（.md / .txt）'), 'info')
      return
    }

    showToastMsg(
      tpl('找到 $__count__ 个文本文件，正在导入...', { count: textFiles.length }),
      'info',
    )
    await uploadFiles(kbId, textFiles, dirPath, afterImport)
  } catch (err: any) {
    showToastMsg(tpl('文件夹导入失败: $__error__', { error: err.message }), 'error')
  }
}
