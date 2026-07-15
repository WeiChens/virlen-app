import { ReactNode, useEffect, useRef, useState } from 'react'
import './WindowLayout.scss'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import WinMinSvg from '@/ui/components/icons/WinMinSvg'
import WinMaxSvg from '@/ui/components/icons/WinMaxSvg'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Window } from '@tauri-apps/api/window'
import { appLogo, appName } from '@/ui/constants'
// import { useMessageBox } from '@/ui/components/shared/MessageBox'
// import useLoading from '@/utils/loading'
import { useToast } from '@/ui/components/shared/Toast'
import SplitScreenSvg from '@/ui/components/icons/SplitScreenSvg'
import AboutSvg from '@/ui/components/icons/AboutSvg'
import AboutModal from './view/AboutModal'
import menuEvent from '@/events/menuEvent'
import { useMessageBox } from '@/ui/components/shared/MessageBox'
// import windowEvent from '@/events/windowEvent'

interface Props {
  children?: ReactNode
  padding?: number
  className?: string
}
const { MessageBox } = useMessageBox()
const { Toast } = useToast()

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
          <div className="control about" onClick={() => aboutHandle()}>
            <AboutSvg />
          </div>
          <div className="control minimize" onClick={() => minHandle()}>
            <WinMinSvg />
          </div>
          <div className="control maximize" onClick={() => maxHandle()}>
            {/* <WinMaxSvg /> */}
            {isMax ? <SplitScreenSvg /> : <WinMaxSvg />}
            {/* <SplitScreenSvg /> */}
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
      {/* <Loading /> */}
      <MessageBox />
      <Toast />
      {/* <ContextMenu /> */}
    </div>
  )
}
export default WindowLayout
