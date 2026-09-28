import { useEffect, useState } from 'react'

type Ping = { version: string; whisperCli: string | null; ffmpeg: string | null }

// S1(걷는 뼈대): 메인 프로세스 왕복과 처리 도구(whisper-cli, ffmpeg)가 보이는지만 확인한다. 실제 화면은 W2에서 만든다.
export default function App(): React.JSX.Element {
  const [status, setStatus] = useState('확인 중...')

  async function ping(): Promise<void> {
    try {
      const r = (await window.api.call('ping')) as Ping
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
    </main>
  )
}
