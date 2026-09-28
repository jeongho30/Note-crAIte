import { useEffect, useState } from 'react'

// S1(걷는 뼈대): 앱 ↔ 엔진 ping 왕복만 확인한다. 실제 화면은 W2에서 만든다.
export default function App(): React.JSX.Element {
  const [status, setStatus] = useState('엔진 확인 중...')

  async function ping(): Promise<void> {
    try {
      const result = (await window.api.call('ping')) as { version: string }
      setStatus(`엔진 연결됨 (v${result.version})`)
    } catch (e) {
      setStatus(`엔진 오류: ${(e as Error).message}`)
    }
  }

  useEffect(() => {
    ping()
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>lecture-notes</h1>
      <p>{status}</p>
      <button onClick={ping}>다시 확인</button>
    </main>
  )
}
