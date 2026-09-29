import { useEffect, useState } from 'react'
import { call } from './api'
import type { Settings } from '../../core/settings'
import Shell from './home/Shell'
import Wizard from './wizard/Wizard'

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
      onRestartWizard={async () => {
        setSettings(await call<Settings>('settings.setWizard', { step: 0, done: false }))
      }}
    />
  )
}
