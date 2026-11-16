import { useState, lazy, Suspense } from 'react'
import './App.css'
import './styles/theme.scss'
import { useTheme } from './hooks/useTheme'
import { useAccentColor } from './hooks/useAccentColor'
import { useFontSize } from './hooks/useFontSize'
import { useZoom } from './hooks/useZoom'
import { useApplyCodeDisplay } from './hooks/useCodeDisplay'
import { useLanguage } from './i18n'
import { settingsState } from '@/ui/store/settingStore'
import React from 'react'
import ReactDOM from 'react-dom/client'
import WindowLayout from './layout/WindowLayout'
import SetupFlow from './pages/setupFlow'
import ChatView from './pages/chat/chat-view'
import ImagePreview from './components/shared/ImagePreview'
// 全应用兜底的右键菜单：没有自定义菜单的地方，有选中文本就弹一个「复制」（无选中则跳过）
import GlobalTextMenu from './components/shared/ContextMenu/global'
import ErrorBoundary from './components/shared/ErrorBoundary'
function App() {
  useTheme()
  useAccentColor()
  useFontSize()
  // 界面缩放：设置里的 zoomFactor → webview 原生缩放（启动那次由 main.ts 的 init 步骤负责）
  useZoom()
  // 代码显示：把主题 / 字号落到 <html data-code-theme> 与一份 --code-* 样式表（DOM 侧消费）
  useApplyCodeDisplay()
  useLanguage()

  // 首次启动且未配置模型 → 显示引导流程
  const [page, setPage] = useState<'onboarding' | 'chat'>(() => {
    return settingsState.value.providers.length > 0 ? 'chat' : 'onboarding'
  })
  // return <TestPage />

  return (
    <ErrorBoundary>
      <WindowLayout>
        {page == 'onboarding' ? (
          <SetupFlow onComplete={() => setPage('chat')} />
        ) : (
          <Suspense fallback={null}>
            <ChatView />
            {/* <SetupFlow onComplete={() => setPage('chat')} /> */}
          </Suspense>
        )}
        <ImagePreview />
        {/* 挂在最外层：任何没有自己的右键处理的地方都由它兜底（原生菜单也由它一并挡掉） */}
        <GlobalTextMenu />
      </WindowLayout>
    </ErrorBoundary>
  )
}

export function render() {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
