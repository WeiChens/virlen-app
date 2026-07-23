/**
 * knowledge-base-settings — 知识库管理页面
 *
 * 功能：
 * - RAG 开关 / 默认知识库设置
 * - 知识库创建（弹窗）/ 删除 / 列表
 * - 文档上传 / 删除 / 编辑 / 预览
 * - 检索测试
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'
import { ragService } from '@/services/rag-service'
import Select from '@/ui/components/shared/Select'
import Modal, { ModalFooterButtons } from '@/ui/components/shared/Modal'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import type { KnowledgeBase, KnowledgeBaseDocument } from '@/domain/ports'
import './knowledge-base-settings.scss'

/** 弹出 toast 消息（简单实现，避免引入 toast 组件的复杂依赖） */
function showToastMsg(
  msg: string,
  type: 'success' | 'error' | 'info' = 'info',
) {
  const el = document.createElement('div')
  el.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    padding: 10px 20px; border-radius: 8px; font-size: 14px;
    z-index: 9999; color: white; max-width: 80vw; text-align: center;
    background: ${type === 'success' ? '#2e7d32' : type === 'error' ? '#c62828' : '#1565c0'};
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: fadeIn 0.2s ease;
  `
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity 0.3s'
    setTimeout(() => el.remove(), 300)
  }, 3000)
}

function KnowledgeBaseSettings() {
  const s = settingsState.value
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)

  // 文档列表弹窗
  const [showDocListModal, setShowDocListModal] = useState(false)
  const [docListKbId, setDocListKbId] = useState('')
  const [docListKbName, setDocListKbName] = useState('')
  const [docListDocs, setDocListDocs] = useState<KnowledgeBaseDocument[]>([])
  const [docListLoading, setDocListLoading] = useState(false)
  const [docListPage, setDocListPage] = useState(1)
  const PAGE_SIZE = 10

  // 创建知识库弹窗
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKbName, setNewKbName] = useState('')
  const [newKbDesc, setNewKbDesc] = useState('')
  const [creating, setCreating] = useState(false)

  // 文档预览弹窗
  const [previewDocName, setPreviewDocName] = useState('')
  const [previewDocContent, setPreviewDocContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showPreviewModal, setShowPreviewModal] = useState(false)

  // 文档编辑弹窗
  const [showEditModal, setShowEditModal] = useState(false)
  const [editDocKbId, setEditDocKbId] = useState('')
  const [editDocId, setEditDocId] = useState('')
  const [editDocName, setEditDocName] = useState('')
  const [editDocContent, setEditDocContent] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [editSaving, setEditSaving] = useState(false)

  // 新建文档弹窗
  const [showNewDocModal, setShowNewDocModal] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [newDocContent, setNewDocContent] = useState('')
  const [newDocCreating, setNewDocCreating] = useState(false)

  // 检索测试
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  // 文档列表搜索
  const [docSearchQuery, setDocSearchQuery] = useState('')
  const [docSearchMode, setDocSearchMode] = useState<'title' | 'content'>(
    'title',
  )
  const [docSearching, setDocSearching] = useState(false)
  const [docSearchResultIds, setDocSearchResultIds] =
    useState<Set<string> | null>(null)

  /** 默认知识库选项（供 Select 组件使用） */
  const kbSelectOptions = [
    { value: '', label: t('未选择') },
    ...kbs.map((kb) => ({ value: kb.id, label: kb.name })),
  ]

  /** 加载知识库列表 */
  const loadKbs = useCallback(async () => {
    setLoading(true)
    try {
      const list = await ragService.listKnowledgeBases()
      setKbs(list)
    } catch (err: any) {
      showToastMsg(`加载知识库失败: ${err.message}`, 'error')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadKbs()
    // 组件卸载时清理防抖定时器
    return () => {
      if (docSearchTimerRef.current) {
        clearTimeout(docSearchTimerRef.current)
      }
    }
  }, [loadKbs])

  /** 打开创建知识库弹窗 */
  const openCreateModal = () => {
    setNewKbName('')
    setNewKbDesc('')
    setShowCreateModal(true)
  }

  /** 创建知识库 */
  const handleCreate = async () => {
    if (!newKbName.trim()) {
      showToastMsg('请输入知识库名称', 'error')
      return
    }
    setCreating(true)
    try {
      await ragService.createKnowledgeBase(newKbName.trim(), newKbDesc.trim())
      showToastMsg('知识库创建成功', 'success')
      setShowCreateModal(false)
      setNewKbName('')
      setNewKbDesc('')
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`创建失败: ${err.message}`, 'error')
    }
    setCreating(false)
  }

  /** 删除知识库 */
  const handleDelete = async (kbId: string, name: string) => {
    const confirmed = await MessageBox.propt(
      t('删除知识库'),
      t(`确定要删除知识库「${name}」吗？此操作不可撤销。`),
    )
    if (!confirmed) return
    try {
      await ragService.deleteKnowledgeBase(kbId)
      showToastMsg('知识库已删除', 'success')
      if (showDocListModal && docListKbId === kbId) setShowDocListModal(false)
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`删除失败: ${err.message}`, 'error')
    }
  }

  /** 打开文档列表弹窗 */
  const openDocListModal = async (kbId: string, kbName: string) => {
    setDocListKbId(kbId)
    setDocListKbName(kbName)
    setDocListPage(1)
    setDocListDocs([])
    setDocSearchQuery('')
    setDocSearchMode('title')
    setDocSearchResultIds(null)
    setShowDocListModal(true)
    setDocListLoading(true)
    try {
      const docs = await ragService.listDocuments(kbId)
      setDocListDocs(docs)
    } catch (err: any) {
      showToastMsg(`加载文档列表失败: ${err.message}`, 'error')
    }
    setDocListLoading(false)
  }

  // 文档列表搜索
  const docSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 文档列表搜索（带 300ms 防抖） */
  const handleDocSearch = useCallback(async () => {
    if (!docSearchQuery.trim() || !docListKbId) return

    if (docSearchMode === 'title') {
      // 标题搜索：前端过滤，不需要防抖
      setDocListPage(1)
      return
    }

    // 内容搜索：防抖，避免快速打字时频繁请求
    if (docSearchTimerRef.current) {
      clearTimeout(docSearchTimerRef.current)
    }
    docSearchTimerRef.current = setTimeout(async () => {
      setDocSearching(true)
      setDocSearchResultIds(null)
      try {
        const result = await ragService.searchDocumentsContent(
          docListKbId,
          docSearchQuery.trim(),
        )
        const matchedIds = new Set(result)
        setDocSearchResultIds(matchedIds)
        setDocListPage(1)
      } catch (err: any) {
        showToastMsg(`搜索失败: ${err.message}`, 'error')
      }
      setDocSearching(false)
      docSearchTimerRef.current = null
    }, 300)
  }, [docSearchQuery, docListKbId, docSearchMode])

  /** 支持的文件扩展名列表 */
  const SUPPORTED_EXTENSIONS = ['pdf', 'md', 'markdown', 'txt'] as const

  /** 判断文件是否为受支持的文本文件（可根据扩展名判断是否可用 readTextFile 读取） */
  function isTextExtension(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase()
    return ext === 'md' || ext === 'markdown' || ext === 'txt'
  }

  /** 从文件路径中提取文件名 */
  function extractFileName(filePath: string): string {
    return filePath.replace(/\\/g, '/').split('/').pop() || filePath
  }

  /** 尝试用多种编码读取文件，返回解码后的 UTF-8 文本 */
  async function tryDecodeTextFile(
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
  async function uploadTextContent(
    kbId: string,
    fileName: string,
    content: string,
    encoding: string,
  ) {
    showToastMsg(`正在导入「${fileName}」(${encoding})...`, 'info')
    await ragService.writeText(kbId, fileName, content)
  }

  /** 计算文件相对于 baseDir 的路径（用于文件夹导入时保留目录结构） */
  function getRelativePath(filePath: string, baseDir: string): string {
    const normalizedFile = filePath.replace(/\\/g, '/')
    const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalizedFile.startsWith(normalizedBase + '/')) {
      return normalizedFile.slice(normalizedBase.length + 1)
    }
    return extractFileName(filePath)
  }

  /** 递归扫描目录，收集所有受支持的文本文件路径 */
  async function scanDirForTextFiles(
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

  /** 批量上传多个文件到知识库
   *  @param baseDir - 可选，指定后使用相对路径作为文档名称（用于文件夹导入） */
  async function uploadFiles(
    kbId: string,
    filePaths: string[],
    baseDir?: string,
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
            await uploadTextContent(
              kbId,
              docName,
              decoded.text,
              decoded.encoding,
            )
            successCount++
            continue
          } catch (err: any) {
            showToastMsg(
              `「${docName}」导入失败: ${err?.message || err}`,
              'error',
            )
            failCount++
            continue
          }
        } else {
          showToastMsg(`已跳过「${docName}」：无法识别的文件编码`, 'error')
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
              await uploadTextContent(
                kbId,
                docName,
                decoded.text,
                decoded.encoding,
              )
              successCount++
              continue
            } catch (err: any) {
              showToastMsg(
                `「${docName}」导入失败: ${err?.message || err}`,
                'error',
              )
              failCount++
              continue
            }
          }
        } else {
          showToastMsg(
            `已跳过「${docName}」：无法识别的文件编码（非 UTF-8/GBK 等常见编码）`,
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
        const errMsg = err?.message || err?.toString() || '未知错误'
        if (
          errMsg.includes('UTF-8') ||
          errMsg.includes('utf-8') ||
          errMsg.includes('read_to_string') ||
          errMsg.includes('读取文件失败')
        ) {
          const decoded = await tryDecodeTextFile(fp)
          if (decoded) {
            try {
              await uploadTextContent(
                kbId,
                docName,
                decoded.text,
                decoded.encoding,
              )
              successCount++
              continue
            } catch {
              // 兜底也失败
            }
          }
          showToastMsg(`已跳过「${docName}」：无法识别的文件编码`, 'error')
        } else {
          showToastMsg(`「${docName}」导入失败: ${errMsg}`, 'error')
        }
        failCount++
      }
    }

    // 刷新文档列表和知识库列表
    if (showDocListModal) await refreshDocList()
    await loadKbs()

    if (failCount === 0) {
      showToastMsg(`成功导入 ${successCount} 个文档`, 'success')
    } else {
      showToastMsg(
        `导入完成：${successCount} 成功，${failCount} 失败`,
        failCount > 0 ? 'error' : 'success',
      )
    }
  }

  /** 上传文档 — 支持多文件选择 */
  const handleUpload = async (kbId: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: '文档',
            extensions: [...SUPPORTED_EXTENSIONS],
          },
        ],
      })
      if (!selected) return

      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return
      await uploadFiles(kbId, paths as string[])
    } catch (err: any) {
      showToastMsg(`上传失败: ${err.message}`, 'error')
    }
  }

  /** 上传文件夹 — 扫描并导入所有文本文件 */
  const handleUploadFolder = async (kbId: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
      })
      if (!selected) return

      const dirPath = selected as string
      showToastMsg('正在扫描文件夹中的文本文件...', 'info')
      const textFiles = await scanDirForTextFiles(dirPath)

      if (textFiles.length === 0) {
        showToastMsg('文件夹中未找到支持的文本文件（.md / .txt）', 'info')
        return
      }

      showToastMsg(`找到 ${textFiles.length} 个文本文件，正在导入...`, 'info')
      await uploadFiles(kbId, textFiles, dirPath)
    } catch (err: any) {
      showToastMsg(`文件夹导入失败: ${err.message}`, 'error')
    }
  }

  /** 删除文档 */
  const handleRemoveDoc = async (
    kbId: string,
    docId: string,
    docName: string,
  ) => {
    const confirmed = await MessageBox.propt(
      t('删除文档'),
      t(`确定要删除文档「${docName}」吗？`),
    )
    if (!confirmed) return
    try {
      await ragService.removeDocument(kbId, docId)
      showToastMsg('文档已删除', 'success')
      if (showDocListModal) await refreshDocList()
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`删除失败: ${err.message}`, 'error')
    }
  }

  /** 清空知识库所有文档 */
  const handleClearAllDocs = async () => {
    if (!docListKbId || docListDocs.length === 0) return
    const confirmed = await MessageBox.propt(
      t('清空所有文档'),
      t(
        `确定要清空「${docListKbName}」中的所有文档吗？（共 ${docListDocs.length} 个）此操作不可撤销。`,
      ),
    )
    if (!confirmed) return

    let successCount = 0
    let failCount = 0
    for (const doc of docListDocs) {
      try {
        await ragService.removeDocument(docListKbId, doc.id)
        successCount++
      } catch {
        failCount++
      }
    }
    showToastMsg(
      `清空完成：${successCount} 成功，${failCount} 失败`,
      failCount > 0 ? 'error' : 'success',
    )
    if (showDocListModal) await refreshDocList()
    await loadKbs()
  }

  /** 导出知识库为 ZIP */
  const handleExportKb = async () => {
    if (!docListKbId || docListDocs.length === 0) return
    await doExportKb(docListKbId, docListKbName)
  }

  /** 导出知识库为 ZIP（指定 kbId 和 kbName，供卡片直接调用） */
  const handleExportKbById = async (kbId: string, kbName: string) => {
    await doExportKb(kbId, kbName)
  }

  /** 实际导出逻辑 */
  const doExportKb = async (kbId: string, kbName: string) => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const savePath = await save({
        defaultPath: `${kbName}.zip`,
        filters: [
          {
            name: 'ZIP 文件',
            extensions: ['zip'],
          },
        ],
      })
      if (!savePath) return

      showToastMsg(`正在导出「${kbName}」...`, 'info')
      await ragService.exportKnowledgeBase(kbId, savePath)
      showToastMsg(`导出成功：${savePath}`, 'success')
    } catch (err: any) {
      showToastMsg(`导出失败: ${err.message}`, 'error')
    }
  }

  /** 刷新文档列表（如果弹窗打开则更新弹窗内容） */
  const refreshDocList = async () => {
    if (!docListKbId) return
    setDocListLoading(true)
    try {
      const docs = await ragService.listDocuments(docListKbId)
      setDocListDocs(docs)
    } catch {
      // 静默失败
    }
    setDocListLoading(false)
  }

  /** 编辑文档 — 打开编辑弹窗 */
  const handleEditDoc = async (
    kbId: string,
    docId: string,
    docName: string,
  ) => {
    setEditDocKbId(kbId)
    setEditDocId(docId)
    setEditDocName(docName)
    setEditDocContent('')
    setShowEditModal(true)
    setEditLoading(true)
    try {
      const content = await ragService.getDocumentContent(kbId, docId)
      setEditDocContent(content)
    } catch (err: any) {
      showToastMsg(`加载文档内容失败: ${err.message}`, 'error')
      setEditDocContent('')
    }
    setEditLoading(false)
  }

  /** 保存文档编辑（名称 + 内容文本） */
  const handleEditSave = async () => {
    if (!editDocName.trim()) {
      showToastMsg('文档名称不能为空', 'error')
      return
    }
    setEditSaving(true)
    try {
      await ragService.editTextDocument(
        editDocKbId,
        editDocId,
        editDocName.trim(),
        editDocContent,
      )
      showToastMsg(`文档已更新为「${editDocName.trim()}」`, 'success')
      setShowEditModal(false)
      if (showDocListModal) await refreshDocList()
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`编辑保存失败: ${err.message}`, 'error')
    }
    setEditSaving(false)
  }

  /** 编辑弹窗中 — 重新上传文件，读取内容后填充到输入框，不直接保存 */
  const handleEditReupload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: '文档',
            extensions: ['pdf', 'md', 'markdown', 'txt'],
          },
        ],
      })
      if (!selected) return

      const filePath = selected as string
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath

      showToastMsg(`正在读取文件「${fileName}」...`, 'info')

      // 使用编码检测读取文件内容
      const decoded = await tryDecodeTextFile(filePath)
      if (decoded) {
        setEditDocName(fileName)
        setEditDocContent(decoded.text)
        showToastMsg(
          `已加载「${fileName}」（${decoded.encoding}），点击保存以确认修改`,
          'success',
        )
      } else {
        // 所有编码都失败
        setEditDocName(fileName)
        showToastMsg(
          '无法读取文本内容（文件编码不受支持），文件名称已更新。请手动输入内容。',
          'info',
        )
      }
    } catch (err: any) {
      showToastMsg(`文件读取失败: ${err.message}`, 'error')
    }
  }

  /** 新建文档 — 手动输入名称和内容 */
  const handleNewDoc = async () => {
    if (!newDocName.trim()) {
      showToastMsg('请输入文档名称', 'error')
      return
    }
    setNewDocCreating(true)
    try {
      await ragService.writeText(
        docListKbId,
        newDocName.trim(),
        newDocContent,
      )
      showToastMsg(`文档「${newDocName.trim()}」创建成功`, 'success')
      setShowNewDocModal(false)
      setNewDocName('')
      setNewDocContent('')
      await refreshDocList()
      await loadKbs()
    } catch (err: any) {
      showToastMsg(`创建失败: ${err.message}`, 'error')
    }
    setNewDocCreating(false)
  }

  /** 预览文档 */
  const handlePreviewDoc = async (
    kbId: string,
    docId: string,
    docName: string,
  ) => {
    setPreviewDocName(docName)
    setPreviewDocContent('')
    setShowPreviewModal(true)
    setPreviewLoading(true)
    try {
      const content = await ragService.getDocumentContent(kbId, docId)
      setPreviewDocContent(content)
    } catch (err: any) {
      setPreviewDocContent(`加载文档内容失败: ${err.message}`)
    }
    setPreviewLoading(false)
  }

  /** 检索测试 */
  const handleSearch = async () => {
    const kbId = docListKbId || s.ragDefaultKnowledgeBaseId
    if (!kbId) {
      showToastMsg('请先选择一个知识库', 'error')
      return
    }
    if (!searchQuery.trim()) {
      showToastMsg('请输入搜索内容', 'error')
      return
    }
    setSearching(true)
    setSearchResults(null)
    try {
      const result = await ragService.query(kbId, searchQuery.trim(), 5)
      if (result.results.length === 0) {
        setSearchResults('未找到相关结果')
      } else {
        setSearchResults(result.context)
      }
    } catch (err: any) {
      setSearchResults(`检索失败: ${err.message}`)
    }
    setSearching(false)
  }

  return (
    <div className="knowledge-base-settings">
      {/* RAG 开关设置 */}
      <div className="kb-section">
        <h3>{t('知识库')}</h3>
        <div className="kb-toggle-row">
          <button
            className={`kb-toggle ${s.ragEnabled ? 'active' : ''}`}
            onClick={() => {
              const next = !settingsState.value.ragEnabled
              settingsState.setValue('ragEnabled', next)
              ragService.setConfig({ enabled: next })
            }}
            title={s.ragEnabled ? t('关闭 RAG') : t('开启 RAG')}>
            <span className="kb-toggle-knob" />
          </button>
          <span>{s.ragEnabled ? t('已启用') : t('已禁用')}</span>
        </div>

        <div className="kb-default-kb-row">
          <label className="kb-label">{t('默认知识库')}</label>
          <Select
            value={s.ragDefaultKnowledgeBaseId}
            onChange={(v) => {
              settingsState.setValue('ragDefaultKnowledgeBaseId', v)
              ragService.setConfig({ defaultKnowledgeBaseId: v })
            }}
            options={kbSelectOptions}
            placeholder={t('未选择')}
            width={220}
          />
        </div>
      </div>

      {/* 知识库列表 */}
      <div className="kb-section">
        <div className="kb-header-row">
          <div className="kb-header-title">
            <h3 style={{ marginBottom: 0 }}>{t('知识库列表')}</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              ({kbs.length})
            </span>
          </div>
          <div className="kb-header-actions">
            <button
              className="kb-btn kb-btn-primary kb-btn-sm"
              onClick={openCreateModal}>
              {t('创建知识库')}
            </button>
            <button
              className="kb-btn kb-btn-sm"
              onClick={loadKbs}
              disabled={loading}>
              {t('刷新')}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="kb-loading">{t('加载中...')}</div>
        ) : kbs.length === 0 ? (
          <div className="kb-empty">{t('暂无知识库，请先创建')}</div>
        ) : (
          <div className="kb-list">
            {kbs.map((kb) => (
              <div key={kb.id}>
                <div className="kb-card">
                  <div
                    className="kb-card-info"
                    onClick={() => openDocListModal(kb.id, kb.name)}
                    style={{ cursor: 'pointer' }}>
                    <div className="kb-card-name">{kb.name}</div>
                    {kb.description && (
                      <div className="kb-card-desc">{kb.description}</div>
                    )}
                    <div className="kb-card-meta">
                      {kb.document_count} {t('个文档')} · {kb.chunk_count}{' '}
                      {t('个片段')}
                    </div>
                  </div>
                  <div className="kb-card-actions">
                    <button
                      className="kb-btn kb-btn-sm kb-btn-primary"
                      onClick={() => handleUpload(kb.id)}
                      title={t('上传文档到该知识库（支持多选）')}>
                      {t('上传文档')}
                    </button>
                    <button
                      className="kb-btn kb-btn-sm"
                      onClick={() => handleUploadFolder(kb.id)}
                      title={t('上传文件夹，自动导入所有文本文件')}>
                      {t('上传文件夹')}
                    </button>
                    <button
                      className="kb-btn kb-btn-sm"
                      onClick={() => handleExportKbById(kb.id, kb.name)}
                      title={t('导出知识库所有文档为 ZIP')}>
                      {t('导出')}
                    </button>
                    <button
                      className="kb-btn kb-btn-sm kb-btn-danger"
                      onClick={() => handleDelete(kb.id, kb.name)}>
                      {t('删除')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建知识库弹窗 */}
      <Modal
        visible={showCreateModal}
        title={t('创建知识库')}
        onClose={() => setShowCreateModal(false)}
        width={460}
        footer={
          <ModalFooterButtons
            cancelText={t('取消')}
            confirmText={creating ? t('创建中...') : t('创建')}
            onCancel={() => {
              if (!creating) setShowCreateModal(false)
            }}
            onConfirm={handleCreate}
            confirmLoading={creating}
          />
        }>
        <div className="kb-create-modal-body">
          <div className="kb-create-field">
            <label className="kb-create-label">{t('知识库名称')} *</label>
            <input
              className="kb-create-input"
              placeholder={t('请输入知识库名称')}
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' &&
                !creating &&
                newKbName.trim() &&
                handleCreate()
              }
              autoFocus
            />
          </div>
          <div className="kb-create-field">
            <label className="kb-create-label">{t('描述（可选）')}</label>
            <textarea
              className="kb-create-textarea"
              placeholder={t('请输入知识库描述')}
              value={newKbDesc}
              onChange={(e) => setNewKbDesc(e.target.value)}
              rows={3}
            />
          </div>
        </div>
      </Modal>

      {/* 文档列表弹窗 */}
      <Modal
        visible={showDocListModal}
        title={`${docListKbName} - ${t('文档列表')}`}
        onClose={() => setShowDocListModal(false)}
        width={880}
        height={580}
        footer={
          <div className="kb-doclist-footer">
            <div className="kb-doclist-footer-left">
              {docListDocs.length > 0 &&
                (() => {
                  // 计算过滤后的文档数用于分页
                  let totalFiltered = docListDocs.length
                  if (docSearchQuery.trim() && docSearchMode === 'title') {
                    const q = docSearchQuery.trim().toLowerCase()
                    totalFiltered = docListDocs.filter((d) =>
                      d.file_name.toLowerCase().includes(q),
                    ).length
                  } else if (docSearchResultIds) {
                    totalFiltered = docListDocs.filter((d) =>
                      docSearchResultIds.has(d.id),
                    ).length
                  }
                  const totalPages = Math.ceil(totalFiltered / PAGE_SIZE)
                  const safePage = Math.min(
                    docListPage,
                    Math.max(1, totalPages),
                  )
                  return (
                    <div className="kb-doclist-pagination">
                      {totalPages > 1 && (
                        <div className="kb-pagination-inline">
                          <button
                            className="kb-btn kb-btn-sm"
                            disabled={safePage <= 1}
                            onClick={() =>
                              setDocListPage((p) => Math.max(1, p - 1))
                            }>
                            {t('上一页')}
                          </button>
                          <span className="kb-pagination-info">
                            {safePage} / {totalPages}
                          </span>
                          <button
                            className="kb-btn kb-btn-sm"
                            disabled={safePage >= totalPages}
                            onClick={() =>
                              setDocListPage((p) => Math.min(totalPages, p + 1))
                            }>
                            {t('下一页')}
                          </button>
                        </div>
                      )}
                      <span className="kb-pagination-total">
                        {t('共')} {docListDocs.length} {t('个文档')}
                        {docSearchQuery.trim() &&
                          `，${t('筛选')} ${totalFiltered} ${t('个')}`}
                      </span>
                    </div>
                  )
                })()}
            </div>
            <div className="kb-doclist-footer-right">
              <button
                className="kb-btn kb-btn-sm"
                onClick={() => handleUpload(docListKbId)}
                title={t('上传文档到该知识库（支持多选）')}>
                {t('上传文档')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={() => handleUploadFolder(docListKbId)}
                title={t('上传文件夹，自动导入所有文本文件')}>
                {t('上传文件夹')}
              </button>
              <button
                className="kb-btn kb-btn-sm"
                onClick={handleExportKb}
                disabled={docListDocs.length === 0}
                title={t('导出知识库所有文档为 ZIP')}>
                {t('导出')}
              </button>
              <button
                className="kb-btn kb-btn-sm kb-btn-danger"
                onClick={handleClearAllDocs}
                disabled={docListDocs.length === 0}
                title={t('清空该知识库中的所有文档')}>
                {t('清空所有文档')}
              </button>
            </div>
          </div>
        }>
        <div className="kb-doclist-modal-body">
          {docListLoading ? (
            <div className="kb-loading">{t('加载中...')}</div>
          ) : (
            <div className="kb-doclist-layout">
              {/* 左侧：文档列表（2/3） */}
              <div className="kb-doclist-left">
                {/* 文档搜索栏 — 放在 scroll-view 外面，始终可见 */}
                {docListDocs.length > 0 && (
                  <div className="kb-doc-search-bar">
                    <input
                      className="kb-search-input"
                      placeholder={t('搜索文档...')}
                      value={docSearchQuery}
                      onChange={(e) => setDocSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleDocSearch()}
                    />
                    <button
                      className={`kb-btn kb-btn-sm ${docSearchMode === 'title' ? 'kb-btn-primary' : ''}`}
                      onClick={() => {
                        setDocSearchMode('title')
                        setDocSearchResultIds(null)
                        setDocListPage(1)
                      }}>
                      {t('搜索标题')}
                    </button>
                    <button
                      className={`kb-btn kb-btn-sm ${docSearchMode === 'content' ? 'kb-btn-primary' : ''}`}
                      onClick={() => {
                        setDocSearchMode('content')
                        if (docSearchQuery.trim()) {
                          handleDocSearch()
                        } else {
                          setDocSearchResultIds(null)
                        }
                      }}
                      disabled={docSearching}>
                      {docSearching ? t('搜索中...') : t('搜索内容')}
                    </button>
                    <span className="kb-doc-search-sep" />
                    <button
                      className="kb-btn kb-btn-sm kb-btn-primary"
                      onClick={() => {
                        setNewDocName('')
                        setNewDocContent('')
                        setShowNewDocModal(true)
                      }}
                      title={t('手动输入名称和内容创建新文档')}>
                      + {t('新建文档')}
                    </button>
                  </div>
                )}

                {/* scroll-view: 只有文档列表滚动，搜索栏保持固定 */}
                <div className="kb-doclist-scroll">
                  {docListDocs.length === 0 ? (
                    <div className="kb-empty">{t('暂无文档')}</div>
                  ) : (
                    <>
                      {(() => {
                        // 计算过滤后的文档列表
                        let filtered = docListDocs
                        if (
                          docSearchQuery.trim() &&
                          docSearchMode === 'title'
                        ) {
                          const q = docSearchQuery.trim().toLowerCase()
                          filtered = docListDocs.filter((d) =>
                            d.file_name.toLowerCase().includes(q),
                          )
                        } else if (docSearchResultIds) {
                          filtered = docListDocs.filter((d) =>
                            docSearchResultIds.has(d.id),
                          )
                        }

                        const totalFiltered = filtered.length
                        const totalPages = Math.ceil(totalFiltered / PAGE_SIZE)
                        const safePage = Math.min(
                          docListPage,
                          Math.max(1, totalPages),
                        )
                        const startIdx = (safePage - 1) * PAGE_SIZE
                        const pageDocs = filtered.slice(
                          startIdx,
                          startIdx + PAGE_SIZE,
                        )

                        return (
                          <>
                            {pageDocs.length === 0 ? (
                              <div className="kb-empty">
                                {t('未找到匹配的文档')}
                              </div>
                            ) : (
                              <div className="doc-list">
                                {pageDocs.map((doc) => (
                                  <div key={doc.id} className="doc-item">
                                    <div className="doc-item-name">
                                      {doc.file_name}
                                    </div>
                                    <div className="doc-item-bottom-row">
                                      <div className="doc-item-left">
                                        {/* <span
                                          className={`doc-item-status status-${doc.status}`}>
                                          {doc.status === 'ready'
                                            ? t('就绪')
                                            : doc.status === 'processing'
                                              ? t('处理中')
                                              : t('错误')}
                                        </span> */}
                                        <span className="doc-item-meta">
                                          {doc.chunk_count} {t('个片段')}
                                        </span>
                                      </div>
                                      <div className="doc-item-actions">
                                        <button
                                          className="kb-btn kb-btn-sm"
                                          onClick={() =>
                                            handlePreviewDoc(
                                              docListKbId,
                                              doc.id,
                                              doc.file_name,
                                            )
                                          }
                                          title={t('预览文档内容')}>
                                          {t('预览')}
                                        </button>
                                        <button
                                          className="kb-btn kb-btn-sm"
                                          onClick={() =>
                                            handleEditDoc(
                                              docListKbId,
                                              doc.id,
                                              doc.file_name,
                                            )
                                          }
                                          title={t('编辑文档名称和内容')}>
                                          {t('编辑')}
                                        </button>
                                        <button
                                          className="kb-btn kb-btn-sm kb-btn-danger"
                                          onClick={() =>
                                            handleRemoveDoc(
                                              docListKbId,
                                              doc.id,
                                              doc.file_name,
                                            )
                                          }>
                                          {t('删除')}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* 重复的搜索结果提示已在上方，这里删除 */}
                          </>
                        )
                      })()}
                    </>
                  )}
                </div>
              </div>

              {/* 右侧：检索测试（1/3） */}
              <div className="kb-doclist-right">
                <div className="kb-search-section">
                  <label className="kb-search-label">{t('检索测试')}</label>
                  <div className="kb-search-test">
                    <input
                      className="kb-search-input"
                      placeholder={t('输入搜索内容...')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && !searching && handleSearch()
                      }
                    />
                    <button
                      className="kb-btn kb-btn-primary kb-btn-sm"
                      onClick={handleSearch}
                      disabled={searching || !searchQuery.trim()}>
                      {searching ? t('搜索中...') : t('搜索')}
                    </button>
                  </div>
                  {searchResults && (
                    <div className="kb-search-results">{searchResults}</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* 文档预览弹窗 */}
      <Modal
        visible={showPreviewModal}
        title={previewDocName || t('文档预览')}
        onClose={() => setShowPreviewModal(false)}
        width={700}
        height={500}>
        <div className="kb-preview-body">
          {previewLoading ? (
            <div className="kb-preview-loading">{t('加载中...')}</div>
          ) : (
            <pre className="kb-preview-content">{previewDocContent}</pre>
          )}
        </div>
      </Modal>

      {/* 新建文档弹窗 */}
      <Modal
        visible={showNewDocModal}
        title={t('新建文档')}
        onClose={() => {
          if (!newDocCreating) {
            setShowNewDocModal(false)
          }
        }}
        width={700}
        height={500}
        footer={
          <div className="kb-edit-footer">
            <ModalFooterButtons
              cancelText={t('取消')}
              confirmText={
                newDocCreating ? t('创建中...') : t('创建')
              }
              onCancel={() => {
                if (!newDocCreating) setShowNewDocModal(false)
              }}
              onConfirm={handleNewDoc}
              confirmLoading={newDocCreating}
            />
          </div>
        }>
        <div className="kb-edit-modal-body">
          <div className="kb-edit-field">
            <label className="kb-edit-label">
              {t('文档名称')} *
            </label>
            <input
              className="kb-edit-input"
              placeholder={t('请输入文档名称（如 readme.md）')}
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' &&
                !newDocCreating &&
                newDocName.trim() &&
                handleNewDoc()
              }
              autoFocus
            />
          </div>
          <div className="kb-edit-field">
            <label className="kb-edit-label">{t('文档内容')}</label>
            <textarea
              className="kb-edit-textarea"
              placeholder={t('请输入文档内容')}
              value={newDocContent}
              onChange={(e) => setNewDocContent(e.target.value)}
              rows={14}
            />
          </div>
        </div>
      </Modal>

      {/* 文档编辑弹窗 */}
      <Modal
        visible={showEditModal}
        title={t('编辑文档')}
        onClose={() => {
          if (!editSaving) setShowEditModal(false)
        }}
        width={700}
        height={500}
        footer={
          <div className="kb-edit-footer">
            <button
              className="kb-btn kb-btn-sm"
              onClick={handleEditReupload}
              title={t('选择文件，读取内容后覆盖到输入框中')}>
              {t('重新上传文件')}
            </button>
            <ModalFooterButtons
              cancelText={t('取消')}
              confirmText={editSaving ? t('保存中...') : t('保存')}
              onCancel={() => {
                if (!editSaving) setShowEditModal(false)
              }}
              onConfirm={handleEditSave}
              confirmLoading={editSaving}
            />
          </div>
        }>
        <div className="kb-edit-modal-body">
          {editLoading ? (
            <div className="kb-edit-loading">{t('加载文档内容...')}</div>
          ) : (
            <>
              <div className="kb-edit-field">
                <label className="kb-edit-label">{t('文档名称')}</label>
                <input
                  className="kb-edit-input"
                  placeholder={t('请输入文档名称')}
                  value={editDocName}
                  onChange={(e) => setEditDocName(e.target.value)}
                />
              </div>
              <div className="kb-edit-field">
                <label className="kb-edit-label">{t('文档内容')}</label>
                <textarea
                  className="kb-edit-textarea"
                  placeholder={t('请输入文档内容')}
                  value={editDocContent}
                  onChange={(e) => setEditDocContent(e.target.value)}
                  rows={12}
                />
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default observer(KnowledgeBaseSettings)
