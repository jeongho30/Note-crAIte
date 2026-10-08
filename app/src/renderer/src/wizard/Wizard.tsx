import { useEffect, useRef, useState } from 'react'
import { call } from '../api'
import { Stepper } from '../components'
import { FolderStep } from './FolderStep'
import { PcStep } from './PcStep'
import { ProviderStep } from './ProviderStep'
import { ReadyStep } from './ReadyStep'
import type { StepProps } from './shared'
import { WelcomeStep } from './WelcomeStep'
import styles from './Wizard.module.css'
import { PC } from '../platform'

const STEPS = ['안내', `이 ${PC} 확인`, '요약 서비스', '저장 폴더']

type Props = {
  /** 지난번에 보던 단계 (settings.json). 0~3은 단계, 4는 준비 완료 */
  initialStep: number
  onDone: () => void
}

// 첫 실행 마법사. 단계마다 settings.json에 적어 두어, 앱을 껐다 켜면 그 단계부터 이어 한다.
export default function Wizard({ initialStep, onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(Math.min(Math.max(0, initialStep), STEPS.length))
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step])

  function goTo(next: number): void {
    setStep(next)
    void call('settings.setWizard', { step: next })
  }

  const nav: StepProps = { next: () => goTo(step + 1), back: () => goTo(step - 1), goTo, headingRef }

  return (
    <div className={styles.wizard}>
      <div className={styles.panel}>
        <Stepper steps={STEPS} current={step} />
        {step === 0 && <WelcomeStep {...nav} />}
        {step === 1 && <PcStep {...nav} />}
        {step === 2 && <ProviderStep {...nav} />}
        {step === 3 && <FolderStep {...nav} />}
        {step === 4 && (
          <ReadyStep
            {...nav}
            finish={async () => {
              await call('settings.setWizard', { done: true })
              onDone()
            }}
          />
        )}
      </div>
    </div>
  )
}
