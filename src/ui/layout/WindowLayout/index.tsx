import { ReactNode, useEffect, useRef, useState } from 'react'
import './WindowLayout.scss'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import WinMinSvg from '@/ui/components/icons/WinMinSvg'
import WinMaxSvg from '@/ui/components/icons/WinMaxSvg'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Window } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { appLogo, appName } from '@/ui/constants'
import { phoneToggleView } from './phone-toggle'
import SplitScreenSvg from '@/ui/components/icons/SplitScreenSvg'
import AboutSvg from '@/ui/components/icons/AboutSvg'
import AboutModal from './view/AboutModal'
import UpdateModal from '@/ui/components/shared/UpdateModal/UpdateModal'
// 导入进度弹窗（文件夹 / 压缩包导入）：与 Toast / MessageBox 同样是模块级单例，全局挂一次
import TaskProgress from '@/ui/components/shared/TaskProgress'
import menuEvent from '@/events/menuEvent'
import updateEvent from '@/events/updateEvent'
import { useToast, showToast } from '@/ui/components/shared/Toast'
// useMessageBox() 给的是组件（下面 <MessageBox /> 渲染用）；MessageBox as MessagePrompt 是
// 模块级命令式 API，`MessagePrompt.propt()` 返回 boolean 确认框
import {
  useMessageBox,
  MessageBox as MessagePrompt,
} from '@/ui/components/shared/MessageBox'
import type { ICheckUpdateResponse } from '@/types'
import { observer } from 'mobx-react-lite'
import PhoneSvg from '@/ui/components/icons/PhoneSvg'
import { phoneControlStore } from '@/ui/store/phoneControlStore'
import { t } from '@/ui/i18n'

interface Props {
  children?: ReactNode
  padding?: number
  className?: string
}
const { MessageBox } = useMessageBox()
const { Toast } = useToast()

/**
 * 过渡态兜底时长（ms）。
 * 「点了开启」到 `enabled` 翻转之间要初始化设备身份 + 解析 ICE，异常且服务又没上报 error 时，
 * 靠它把按钮放回可点状态，避免永远停在「正在启用…」。
 */
const PHONE_START_TIMEOUT_MS = 20_000

const WindowLayout = ({ children, padding = 0, className }: Props) => {
  const currentWindow = useRef(null as unknown as Window)
  const [isMax, setIsMax] = useState(false)
  const [title, setTitle] = useState(appName)

  useEffect(() => {
    try {
      currentWindow.current = getCurrentWindow()
    } catch {}
  }, [])
  function minHandle(): void {
    currentWindow.current.minimize()
  }

  function maxHandle(): void {
    currentWindow.current.toggleMaximize()
  }

  async function closeHandle(): Promise<void> {
    const wait = { value: null as unknown as Promise<void> }
    await wait.value
    currentWindow.current.close()
  }

  useEffect(() => {
    const handle = async () => {
      const isMax = await currentWindow.current.isMaximized()
      setIsMax(isMax)
    }
    const unlisten = currentWindow.current.listen('tauri://resize', handle)
    handle()
    return () => {
      unlisten.then((e) => e())
    }
  }, [])

  const [aboutShow, setAboutShow] = useState(false)
  function aboutHandle() {
    setAboutShow(true)
  }
  useEffect(() => {
    const uninstall: Function[] = []
    uninstall.push(menuEvent.on('showAboutModal', aboutHandle))
    return () => {
      uninstall.forEach((e) => e())
    }
  }, [])

  const [updateShow, setUpdateShow] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<ICheckUpdateResponse | null>(null)

  useEffect(() => {
    const uninstall = updateEvent.on('showUpdateModal', (info) => {
      setUpdateInfo(info)
      setUpdateShow(true)
    })
    return uninstall
  }, [])

  async function handleUpdateForceCancel() {
    // 强制更新被取消 → 真正退出应用。不能再用 close()：托盘开启后关闭窗口只是隐藏
    // （AI 继续在后台跑），更新包永远装不上 —— 所以走托盘模块的退出入口。
    try {
      await invoke('tray_quit')
    } catch {
      // 托盘不可用（非 Tauri 环境 / 旧版本）→ 退回直接关窗
      currentWindow.current?.close()
    }
  }

  /** 「点了开启、服务还没起来」的过渡态（缘由见 phone-toggle.ts） */
  const [phoneStarting, setPhoneStarting] = useState(false)
  const phoneEnabled = phoneControlStore.enabled
  const phone = phoneToggleView({
    enabled: phoneEnabled,
    starting: phoneStarting,
    status: phoneControlStore.status,
  })

  useEffect(() => {
    if (!phoneStarting) return
    if (phoneEnabled) {
      setPhoneStarting(false)
      return
    }
    const timer = setTimeout(() => setPhoneStarting(false), PHONE_START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [phoneStarting, phoneEnabled])

  async function phoneHandle(): Promise<void> {
    if (phoneStarting) return
    if (!phoneEnabled) {
      // 纯开关：只启用，不跳设置页（配对二维码在「设置 → 手机控制」里）
      setPhoneStarting(true)
      phoneControlStore.setEnabled(true)
      return
    }
    // 关掉会立即断开正在操作的手机：连着时先确认，其余一键关
    if (phoneControlStore.status === 'connected') {
      const ok = await MessagePrompt.propt(
        t('关闭手机控制？'),
        t('这台手机正在操作本机，关闭会立即断开连接。'),
        { confirmText: t('关闭'), cancelText: t('取消'), danger: true },
      )
      if (!ok) return
    }
    phoneControlStore.setEnabled(false)
    showToast(t('已关闭手机控制'), 2000)
  }
  return (
    <div
      className="WindowLayout"
      onContextMenu={(e) => {
        if (!import.meta.env.DEV) {
          e.preventDefault()
        }
      }}>
      <div data-tauri-drag-region className="window-top-bar">
        <div data-tauri-drag-region className="title">
          <img
            src={appLogo}
            alt="logo"
            data-tauri-drag-region
            className="logo"
            draggable={false}
          />
          <div data-tauri-drag-region>{title}</div>
        </div>
        <div className="window-controls">
          {/* 手机控制快捷开关：点一下开、再点一下关（不做跳转；扫码配对在设置页）。
              图标用 PhoneSvg 的 `currentColor`，亮 / 暗与状态点颜色都走 CSS 的 `color`。 */}
          <div
            className={`control phone${phone.active ? ' on' : ''}`}
            title={phone.hint}
            onClick={() => void phoneHandle()}>
            <PhoneSvg />
            {phone.dot && (
              <span className={`phone-dot phone-dot--${phone.dot}`} />
            )}
          </div>
          <div className="control about" onClick={() => aboutHandle()}>
            <AboutSvg />
          </div>
          <div className="control minimize" onClick={() => minHandle()}>
            <WinMinSvg />
          </div>
          <div className="control maximize" onClick={() => maxHandle()}>
            {isMax ? <SplitScreenSvg /> : <WinMaxSvg />}
          </div>
          <div className="control close" onClick={() => closeHandle()}>
            <CloseSvg />
          </div>
        </div>
      </div>
      <div
        className="window-content"
        style={{
          padding,
        }}>
        <div className={`window-content-value ${className || ''}`}>
          {children}
        </div>
      </div>
      <AboutModal show={aboutShow} onHide={() => setAboutShow(false)} />
      <UpdateModal
        show={updateShow}
        updateInfo={updateInfo}
        onHide={() => setUpdateShow(false)}
        onForceCancel={handleUpdateForceCancel}
      />
      <MessageBox />
      <Toast />
      <TaskProgress />
    </div>
  )
}
export default observer(WindowLayout)
