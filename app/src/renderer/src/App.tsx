import { useEffect, useState } from 'react'
import { call } from './api'
import type { Settings } from '../../core/settings'
import Shell from './home/Shell'
import Wizard from './wizard/Wizard'

const PROVIDER_STEP = 2

export default function App(): React.JSX.Element | null {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    call<Settings>('settings.get').then(setSettings)
  }, [])

  if (!settings) return null
  if (!settings.wizardDone) {
    return <Wizard initialStep={settings.wizardStep} onDone={() => setSettings({ ...settings, wizardDone: true })} />
  }
  return (
    <Shell
      onConnect={async () => {
        // 설정 화면이 생기기 전까지는 마법사의 요약 서비스 단계로 돌아간다
        setSettings(await call<Settings>('settings.setWizard', { step: PROVIDER_STEP, done: false }))
      }}
    />
  )
}
