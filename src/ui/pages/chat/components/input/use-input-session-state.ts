/**
 * 跨会话输入状态保存 / 恢复（含迭代目标）
 *
 * 用 ref 镜像「当前值」，在 sessionId 变化时先把上一个会话存起来、
 * 再恢复新会话；组件卸载时也保存一次（例如关闭标签页）。
 *
 * 该 hook 只做副作用（不持有 state）；goal 等 state 仍由组件持有，通过参数传入/回写。
 */
import { useEffect, useRef } from 'react'
import { getSessionInput, saveSessionInput } from './session-input-store'
import type {
  FileAttachment,
  ImageAttachment,
  QuoteAttachment,
  SkillAttachment,
} from './hooks'

interface Params {
  sessionId?: string
  value: string
  cursorPos: number
  images: ImageAttachment[]
  files: FileAttachment[]
  quotes: QuoteAttachment[]
  skills: SkillAttachment[]
  goal: string
  goalExpanded: boolean
  setValue: (v: string) => void
  setCursorPos: (v: number) => void
  setImages: (v: ImageAttachment[]) => void
  clearImages: () => void
  setFiles: (v: FileAttachment[]) => void
  clearFiles: () => void
  setQuotes: (v: QuoteAttachment[]) => void
  clearQuotes: () => void
  setSkills: (v: SkillAttachment[]) => void
  clearSkills: () => void
  setGoal: (v: string) => void
  setGoalExpanded: (v: boolean) => void
}

export function useInputSessionState(p: Params) {
  const prevSessionRef = useRef(p.sessionId)
  const valueRef = useRef(p.value)
  valueRef.current = p.value
  const cursorPosRef = useRef(p.cursorPos)
  cursorPosRef.current = p.cursorPos
  const imagesRef = useRef(p.images)
  imagesRef.current = p.images
  const filesRef = useRef(p.files)
  filesRef.current = p.files
  const quotesRef = useRef(p.quotes)
  quotesRef.current = p.quotes
  const skillsRef = useRef(p.skills)
  skillsRef.current = p.skills
  const goalRef = useRef(p.goal)
  goalRef.current = p.goal
  const goalExpandedRef = useRef(p.goalExpanded)
  goalExpandedRef.current = p.goalExpanded

  useEffect(() => {
    const prevId = prevSessionRef.current
    if (prevId === p.sessionId) return

    // 保存上一个 session 的输入状态
    if (prevId != null) {
      saveSessionInput(prevId, {
        value: valueRef.current,
        cursorPos: cursorPosRef.current,
        images: imagesRef.current,
        files: filesRef.current,
        quotes: quotesRef.current,
        skills: skillsRef.current,
        goal: goalRef.current,
        goalExpanded: goalExpandedRef.current,
      })
    }
    prevSessionRef.current = p.sessionId

    // 恢复当前 session 的输入状态（如有）
    const saved = getSessionInput(p.sessionId)
    p.setValue(saved?.value ?? '')
    p.setCursorPos(saved?.cursorPos ?? 0)
    p.setGoal(saved?.goal ?? '')
    p.setGoalExpanded(saved?.goalExpanded ?? false)
    if (saved?.images?.length) {
      p.setImages(saved.images)
    } else {
      p.clearImages()
    }
    if (saved?.files?.length) {
      p.setFiles(saved.files)
    } else {
      p.clearFiles()
    }
    if (saved?.quotes?.length) {
      p.setQuotes(saved.quotes)
    } else {
      p.clearQuotes()
    }
    if (saved?.skills?.length) {
      p.setSkills(saved.skills)
    } else {
      p.clearSkills()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.sessionId])

  // 组件卸载时保存（例如关闭标签页）
  useEffect(() => {
    return () => {
      if (p.sessionId != null) {
        saveSessionInput(p.sessionId, {
          value: valueRef.current,
          cursorPos: cursorPosRef.current,
          images: imagesRef.current,
          files: filesRef.current,
          quotes: quotesRef.current,
          skills: skillsRef.current,
          goal: goalRef.current,
          goalExpanded: goalExpandedRef.current,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.sessionId])
}
