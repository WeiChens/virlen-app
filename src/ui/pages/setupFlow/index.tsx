/**
 * SetupFlow — 首次启动引导流程（编排层）
 *
 * 分三步：
 *   1. Welcome      — 展示应用介绍，引导用户开始配置
 *   2. Set Workdir  — 设置默认工作目录
 *   3. Model Setup  — 选择模型服务商 + 填写 API Key
 *
 * 配置完成后自动切换到 ChatView。
 * 各步骤视图拆分至 ./components/*，本文件只负责步骤编排与转场。
 */
import { useState } from 'react'
import './style.scss'
import type { SetupStep } from './types'
import StepIndicator from './components/StepIndicator'
import StepWelcome from './components/StepWelcome'
import StepWorkdir from './components/StepWorkdir'
import StepProvider from './components/StepProvider'

interface Props {
  onComplete: () => void
}

function SetupFlow({ onComplete }: Props) {
  const [step, setStep] = useState<SetupStep>('welcome')
  const [animKey, setAnimKey] = useState(0)

  function goTo(target: SetupStep) {
    setStep(target)
    setAnimKey((k) => k + 1)
  }

  return (
    <div className="setup-flow">
      <div className="setup-flow-inner">
        {/* 进度指示：始终可见，告知用户共几步、当前第几步 */}
        <StepIndicator current={step} />

        {step === 'welcome' ? (
          /* ====== 第一步：欢迎页 ====== */
          <div className="step-page welcome" key="welcome">
            <StepWelcome onNext={() => goTo('setWorkdir')} />
          </div>
        ) : step === 'setWorkdir' ? (
          /* ====== 第二步：设置工作目录 ====== */
          <div className="step-page step-enter" key={`workdir-${animKey}`}>
            <StepWorkdir onNext={() => goTo('setup')} />
          </div>
        ) : (
          /* ====== 第三步：模型配置 ====== */
          <div className="step-page step-enter" key={`setup-${animKey}`}>
            <StepProvider
              onBack={() => goTo('setWorkdir')}
              onComplete={onComplete}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default SetupFlow
