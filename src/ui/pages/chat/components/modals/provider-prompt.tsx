/**
 * provider-prompt — 提示用户配置模型服务的弹窗
 */
import Modal from '@/ui/components/shared/Modal'
import SettingSvg from '@/ui/components/icons/SettingSvg'
import './provider-prompt.scss'
import { appName } from '@/ui/constants'

interface Props {
  visible: boolean
  onClose: () => void
  onGoToSettings: () => void
}

export default function ProviderPrompt({
  visible,
  onClose,
  onGoToSettings,
}: Props) {
  return (
    <Modal
      visible={visible}
      onClose={onClose}
      width={380}
      showCloseButton={false}
      className="provider-prompt">
      <div className="prompt-content">
        <div className="prompt-icon">
          <svg
            style={{
              width: 100,
              height: 100,
            }}
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="5736"
            width="200"
            height="200">
            <path
              d="M648.13 689.31c-0.1-60.56-41.1-113.41-99.74-128.55V124.13c0-18.36-14.88-33.25-33.25-33.25-18.36 0-33.25 14.88-33.25 33.25v436.4c-71.06 18.57-113.61 91.23-95.03 162.29 12.16 46.53 48.5 82.87 95.03 95.03v82.01c0 18.36 14.88 33.25 33.25 33.25 18.36 0 33.25-14.88 33.25-33.25v-82.01c58.64-15.13 99.65-67.98 99.74-128.54zM515.15 755.8c-36.72 0-66.49-29.77-66.49-66.49s29.77-66.49 66.49-66.49 66.49 29.77 66.49 66.49-29.77 66.49-66.49 66.49z m417.79-421.11c-0.1-60.56-41.1-113.41-99.74-128.55v-82.01c0-18.36-14.88-33.25-33.25-33.25-18.36 0-33.25 14.88-33.25 33.25v82.01c-71.06 18.57-113.61 91.23-95.03 162.29 12.16 46.53 48.5 82.87 95.03 95.03v436.4c0 18.36 14.88 33.25 33.25 33.25 18.36 0 33.25-14.88 33.25-33.25v-436.4c58.72-15.16 99.74-68.13 99.74-128.77z m-132.99 66.49c-36.72 0-66.49-29.77-66.49-66.49s29.77-66.49 66.49-66.49 66.49 29.77 66.49 66.49-29.76 66.49-66.49 66.49z m-443.27-66.49c-0.1-60.56-41.1-113.41-99.74-128.55v-82.01c0-18.36-14.88-33.25-33.25-33.25s-33.25 14.88-33.25 33.25v82.01c-71.06 18.57-113.61 91.23-95.03 162.29 12.16 46.53 48.5 82.87 95.03 95.03v436.4c0 18.36 14.88 33.25 33.25 33.25s33.25-14.88 33.25-33.25v-436.4c58.72-15.16 99.74-68.13 99.74-128.77zM223.7 401.18c-36.72 0-66.49-29.77-66.49-66.49s29.77-66.49 66.49-66.49 66.49 29.77 66.49 66.49-29.77 66.49-66.49 66.49z"
              fill="#333333"
              p-id="5737"></path>
          </svg>
        </div>
        <h3>未配置模型服务</h3>
        <p>使用 {appName} 前需要先配置模型服务商（如 DeepSeek、OpenAI 等）。</p>
        <div className="prompt-actions">
          <button className="btn-cancel" onClick={onClose}>
            稍后再说
          </button>
          <button className="btn-primary" onClick={onGoToSettings}>
            <SettingSvg fill="var(--bg-primary)" />
            去配置
          </button>
        </div>
      </div>
    </Modal>
  )
}
