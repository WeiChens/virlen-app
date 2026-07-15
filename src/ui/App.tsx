import { useState, lazy, Suspense } from 'react'
import './App.css'
import './styles/theme.css'
import { useTheme } from './hooks/useTheme'
import { useFontSize } from './hooks/useFontSize'
import { useLanguage } from './i18n'
import { settingsState } from '@/ui/store/settingStore'
import React from 'react'
import ReactDOM from 'react-dom/client'
import WindowLayout from './layout/WindowLayout'
import SetupFlow from './pages/setupFlow'
import ChatView from './pages/chat/chat-view'
import ImagePreview from './components/shared/ImagePreview'
function App() {
  useTheme()
  useFontSize()
  useLanguage()

  // 首次启动且未配置模型 → 显示引导流程
  const [page, setPage] = useState<'onboarding' | 'chat'>(() => {
    return settingsState.value.providers.length > 0 ? 'chat' : 'onboarding'
  })
  // return <TestPage />

  return (
    <WindowLayout>
      {page === 'onboarding' ? (
        <SetupFlow onComplete={() => setPage('chat')} />
      ) : (
        <Suspense fallback={null}>
          <ChatView />
          {/* <SetupFlow onComplete={() => setPage('chat')} /> */}
        </Suspense>
      )}
      <ImagePreview />
    </WindowLayout>
  )
}

export function render() {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
