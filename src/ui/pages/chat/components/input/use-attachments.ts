/**
 * 附件汇总 hook — 把四类附件（图片 / 文件 / 引用 / 技能）的 hook 调用收在一处
 *
 * 只是分组，不改变任何一个子 hook 的实现或调用顺序。
 */
import {
  useFileAttachment,
  useImageAttachment,
  useQuoteAttachment,
  useSkillAttachment,
} from './hooks'

export function useAttachments() {
  const image = useImageAttachment()
  const file = useFileAttachment()
  const quote = useQuoteAttachment()
  const skill = useSkillAttachment()

  return {
    // 图片
    images: image.images,
    setImages: image.setImages,
    addImages: image.addImages,
    addImagePaths: image.addImagePaths,
    removeImage: image.removeImage,
    clearImages: image.clearImages,
    // 文件
    files: file.files,
    setFiles: file.setFiles,
    addPaths: file.addPaths,
    removeFile: file.removeFile,
    clearFiles: file.clearFiles,
    // 引用
    quotes: quote.quotes,
    setQuotes: quote.setQuotes,
    addQuote: quote.addQuote,
    removeQuote: quote.removeQuote,
    clearQuotes: quote.clearQuotes,
    // 技能
    skills: skill.skills,
    setSkills: skill.setSkills,
    addSkills: skill.addSkills,
    removeSkill: skill.removeSkill,
    removeSkillsByName: skill.removeSkillsByName,
    clearSkills: skill.clearSkills,
  }
}
