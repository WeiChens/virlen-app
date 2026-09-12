import { Component, type ReactNode } from 'react'
import { reportReactError } from '@/utils/telemetry/errorHandler'
import { t } from '@/ui/i18n'
import './style.scss'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

/**
 * 顶层错误边界（§5.9 error.react.boundary）
 *
 * 捕获 React 渲染期异常 → 上报埋点 → 展示兜底 UI，避免整树白屏。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string }): void {
    reportReactError(error, info?.componentStack)
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleReset = (): void => {
    this.setState({ hasError: false, message: '' })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <div className="error-boundary-title">{t('界面出现异常')}</div>
            <div className="error-boundary-message">{this.state.message}</div>
            <div className="error-boundary-actions">
              <button className="eb-btn" onClick={this.handleReset}>
                {t('尝试恢复')}
              </button>
              <button className="eb-btn primary" onClick={this.handleReload}>
                {t('重新加载')}
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
