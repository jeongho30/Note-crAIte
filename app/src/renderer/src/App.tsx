import { useEffect, useState } from 'react'
import { call } from './api'
import ComponentGallery from './ComponentGallery'
import type { Settings } from '../../core/settings'
import Wizard from './wizard/Wizard'

type Ping = { version: string; whisperCli: string | null; ffmpeg: string | null }

export default function App(): React.JSX.Element | null {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    call<Settings>('settings.get').then(setSettings)
  }, [])

  if (!settings) return null
  if (!settings.wizardDone) {
    return <Wizard initialStep={settings.wizardStep} onDone={() => setSettings({ ...settings, wizardDone: true })} />
  }
  return <DevHome />
}

// 홈 화면을 만들기 전까지: 처리 도구가 보이는지와 부품 모음.
function DevHome(): React.JSX.Element {
  const [status, setStatus] = useState('확인 중...')

  async function ping(): Promise<void> {
    try {
      const r = await call<Ping>('ping')
      const mark = (path: string | null): string => (path ? '있음' : '없음')
      setStatus(`v${r.version} · whisper-cli ${mark(r.whisperCli)} · ffmpeg ${mark(r.ffmpeg)}`)
    } catch (e) {
      setStatus(`오류: ${(e as Error).message}`)
    }
  }

  useEffect(() => {
    ping()
  }, [])

  return (
    <main style={{ padding: 24 }}>
      <h1>lecture-notes</h1>
      <p>{status}</p>
      <button onClick={ping}>다시 확인</button>
      <hr />
      <ComponentGallery />
    </main>
  )
}
