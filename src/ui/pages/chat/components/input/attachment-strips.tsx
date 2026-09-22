/**
 * 输入框附件条（纯展示，状态由父组件注入）
 *
 * 引用 / 技能 / 文件 / 图片 四条，均为「有内容才渲染」。
 */
import FileChip from '@/ui/components/shared/FileChip'
import QuoteChip from '@/ui/components/shared/QuoteChip'
import SkillChip from '@/ui/components/shared/SkillChip'
import { showImagePreview } from '@/ui/components/shared/ImagePreview'
import { t } from '@/ui/i18n'
import type {
  FileAttachment,
  ImageAttachment,
  QuoteAttachment,
  SkillAttachment,
} from './hooks'

/** 引用条（只存被引用消息的元数据 + 正文快照） */
export function QuoteStrip({
  quotes,
  onJump,
  onRemove,
}: {
  quotes: QuoteAttachment[]
  onJump?: (messageId: string) => void
  onRemove: (messageId: string) => void
}) {
  if (quotes.length === 0) return null
  return (
    <div className="quote-preview-strip">
      {quotes.map((q) => (
        <QuoteChip
          key={q.messageId}
          role={q.role}
          text={q.text}
          messageId={q.messageId}
          onClick={onJump ? () => onJump(q.messageId) : undefined}
          onRemove={() => onRemove(q.messageId)}
        />
      ))}
    </div>
  )
}

/** 技能引用条（存 SKILL.md 全文快照） */
export function SkillStrip({
  skills,
  onRemove,
}: {
  skills: SkillAttachment[]
  onRemove: (id: string) => void
}) {
  if (skills.length === 0) return null
  return (
    <div className="skill-preview-strip">
      {skills.map((s) => (
        <SkillChip
          key={s.id}
          name={s.name}
          path={s.path}
          chars={s.content.length}
          onRemove={() => onRemove(s.id)}
        />
      ))}
    </div>
  )
}

/** 文件附件条（只存路径，不拷贝文件） */
export function FileStrip({
  files,
  onRemove,
}: {
  files: FileAttachment[]
  onRemove: (id: string) => void
}) {
  if (files.length === 0) return null
  return (
    <div className="file-preview-strip">
      {files.map((f) => (
        <FileChip
          key={f.id}
          path={f.path}
          name={f.name}
          isDir={f.isDir}
          size={f.size}
          onRemove={() => onRemove(f.id)}
        />
      ))}
    </div>
  )
}

/** 图片预览条 */
export function ImageStrip({
  images,
  onRemove,
}: {
  images: ImageAttachment[]
  onRemove: (id: string) => void
}) {
  if (images.length === 0) return null
  return (
    <div className="image-preview-strip">
      {images.map((img) => (
        <div key={img.id} className="image-preview-item">
          <img
            src={img.url}
            alt={img.name || t('图片')}
            onClick={() =>
              showImagePreview({
                src: img.url,
                previewSrcList: images.map((i) => i.url),
              })
            }
          />
          <button
            className="image-preview-remove"
            onClick={() => onRemove(img.id)}
            title={t('移除图片')}
            type="button">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
