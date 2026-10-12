import { useEffect, useState } from 'react'
import { call } from '../api'
import { Banner, Button, Card, Dialog, ProgressBar, RadioCardGroup, Select } from '../components'
import type { Settings } from '../../../core/settings'
import {
  clock, listMics, pauseRecording, RecordError, resumeRecording, SILENT_WARN_S, startRecording, stopRecording, systemAudioSupported, useRecorder,
  type RecordSource
} from './recording'
import styles from './Recorder.module.css'
import { OS, PC, TRAY_WHERE } from '../platform'

const SOURCE_KEY = 'record.source'
const MIC_KEY = 'record.mic'

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 기억하지 못해도 녹음에는 지장이 없다
  }
}

// 녹음 안내의 아이콘: 글자색을 따르는 선 그림 (20×20)
function IntroIcon({ d, warn }: { d: string; warn?: boolean }): React.JSX.Element {
  return (
    <span className={warn ? styles.introIconWarn : styles.introIcon} aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  )
}

const INTRO: { d: string; warn?: boolean; title: string; text: string }[] = [
  { d: 'M5.2 4.5h9.6a1.2 1.2 0 0 1 1.2 1.2v6.8H4V5.7a1.2 1.2 0 0 1 1.2-1.2z M2.5 15.5h15', warn: true, title: '노트북 덮개는 열어 두세요', text: '덮개를 닫으면 녹음이 멈춰요. 강의가 끝날 때까지 열어 두세요.' },
  { d: 'M4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4z M3 7.5h14 M12.5 5.8h2', title: '창을 닫아도 녹음은 계속돼요', text: `앱은 ${TRAY_WHERE}에 남아 있어요.` },
  { d: 'M4 8v4 M7.5 5.5v9 M11 7.5v5 M14.5 4.5v11', title: '소리가 들어오는지 확인하세요', text: '녹음 중에는 소리 크기 막대가 움직여요.' },
  { d: 'M6 3h6l3 3v11H6z M8.5 9.5h4 M8.5 12.5h4', title: '끝내면 바로 노트로 만들어요', text: '[끝내고 노트 만들기]를 누르면 과목을 고르고 노트를 만들기 시작해요.' }
]

type DialogProps = {
  open: boolean
  onClose: () => void
  /** 받아쓰기(오디오 준비 포함)가 돌고 있는가: 녹음을 시작하면 멈춘다는 주의를 띄운다 */
  transcribing: boolean
}

// 녹음 시작 창: 마이크 / 컴퓨터 소리, 마이크 고르기. 받아쓰기 중이면 멈춘다고 알리고 [녹음 시작]을 한 번 더 누르게 한다.
// 처음 열 때만 같은 창의 본문 자리에 녹음 안내가 먼저 보이고, [계속하기]를 누르면 소리 고르기로 넘어간다.
export function RecordDialog({ open, onClose, transcribing }: DialogProps): React.JSX.Element {
  const saved = remembered(SOURCE_KEY)
  const [source, setSource] = useState<RecordSource>(saved === 'system' && systemAudioSupported ? 'system' : 'mic')
  const [mics, setMics] = useState<{ id: string; label: string }[]>([])
  const [mic, setMic] = useState<string>(remembered(MIC_KEY) ?? '')
  const [holdStt, setHoldStt] = useState(true)
  const [error, setError] = useState<RecordError | null>(null)
  const [introSeen, setIntroSeen] = useState(true) // 설정을 읽기 전에는 본 것으로 둔다 (안내가 잠깐 비쳤다 사라지지 않게)
  const [introAgain, setIntroAgain] = useState(false) // [녹음 안내 다시 보기]
  const rec = useRecorder()

  useEffect(() => {
    call<Settings>('settings.get').then((s) => setIntroSeen(s.recordIntroSeen), () => {})
  }, [])

  useEffect(() => {
    if (!open) return
    setError(null)
    setIntroAgain(false)
    void listMics().then(setMics)
    call<Settings>('settings.get').then((s) => setHoldStt(!s.sttWhileRecording), () => {})
  }, [open])

  async function start(): Promise<void> {
    setError(null)
    const device = mics.some((m) => m.id === mic) ? mic : null
    try {
      await startRecording(source, source === 'mic' ? device : null)
      remember(SOURCE_KEY, source)
      if (device) remember(MIC_KEY, device)
      onClose()
    } catch (e) {
      setError(e instanceof RecordError ? e : new RecordError('녹음을 시작하지 못했어요.'))
    }
  }

  const starting = rec.status === 'starting'
  if (!introSeen || introAgain) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="처음 녹음하기 전에"
        actions={
          <>
            <Button onClick={onClose}>취소</Button>
            <Button
              variant="primary"
              onClick={() => {
                setIntroSeen(true)
                setIntroAgain(false)
                void call('settings.introSeen', 'record').catch(() => {})
              }}
            >
              계속하기
            </Button>
          </>
        }
      >
        <ul className={styles.intro}>
          {INTRO.map((item) => (
            <li key={item.title}>
              <IntroIcon d={item.d} warn={item.warn} />
              <span>
                <strong>{item.title}</strong>
                <span className={styles.introText}>{item.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    )
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="녹음하기"
      actions={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={starting} onClick={() => void start()}>
            {starting ? '시작하는 중…' : '녹음 시작'}
          </Button>
        </>
      }
    >
      <RadioCardGroup
        label="녹음할 소리"
        value={source}
        onChange={setSource}
        options={[
          { value: 'mic', title: '마이크', description: '강의실에서 교수님 목소리를 녹음해요.' },
          // 컴퓨터 소리 녹음은 Windows에서만 된다. macOS에서는 선택지를 보이지 않는다
          ...(systemAudioSupported
            ? [{ value: 'system' as const, title: '컴퓨터 소리', description: `온라인 강의처럼 이 ${PC}에서 나오는 소리를 녹음해요. 알림음도 함께 들어가요.` }]
            : [])
        ]}
      />
      {source === 'mic' && mics.length > 1 && (
        <Select label="마이크" value={mics.some((m) => m.id === mic) ? mic : ''} onChange={(e) => setMic(e.target.value)}>
          <option value="">{OS} 기본 마이크</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      )}
      {transcribing && holdStt && (
        <Banner tone="warning" title="받아쓰기 중이에요">
          녹음을 시작하면 받아쓰기를 멈추고, 녹음이 끝나면 멈춘 곳부터 이어서 해요.
        </Banner>
      )}
      {error && (
        <Banner
          tone="danger"
          action={
            error.micSettings ? (
              <Button size="sm" onClick={() => void call('rec.openMicSettings')}>
                설정 열기
              </Button>
            ) : undefined
          }
        >
          {error.message}
        </Banner>
      )}
      <p className={styles.hint}>
        녹음은 이 {PC}에만 저장돼요. 창을 닫아도 녹음은 계속되지만, 노트북 덮개를 닫으면 멈춰요.{' '}
        <Button variant="link" onClick={() => setIntroAgain(true)}>
          녹음 안내 다시 보기
        </Button>
      </p>
    </Dialog>
  )
}

// 녹음 중 카드: 시간, 소리 크기, 오래 조용하면 경고, 일시정지·끝내기.
export function RecordingCard(): React.JSX.Element | null {
  const rec = useRecorder()
  if (rec.status !== 'recording' && rec.status !== 'paused' && rec.status !== 'stopping') return null
  if (rec.status === 'stopping') {
    return (
      <Card className={styles.card}>
        <div className={styles.top}>
          <span className={styles.title}>녹음을 저장하는 중…</span>
        </div>
      </Card>
    )
  }
  const paused = rec.status === 'paused'
  const silent = !paused && rec.silentS >= SILENT_WARN_S
  return (
    <Card className={styles.card} aria-label="녹음 중">
      <div className={styles.top}>
        <span className={paused ? styles.dotPaused : styles.dot} aria-hidden="true" />
        <span className={styles.title}>{paused ? '일시정지' : rec.source === 'mic' ? '마이크 녹음 중' : '컴퓨터 소리 녹음 중'}</span>
        <span className={styles.clock}>{clock(rec.elapsedMs)}</span>
        <Button size="sm" onClick={paused ? resumeRecording : pauseRecording}>
          {paused ? '이어서 녹음' : '일시정지'}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void stopRecording()}>
          끝내고 노트 만들기
        </Button>
      </div>
      <ProgressBar value={rec.level} label="들어오는 소리 크기" />
      {rec.error ? (
        <Banner tone="danger">{rec.error}</Banner>
      ) : silent ? (
        <Banner tone="warning">
          {Math.floor(rec.silentS / 60)}분째 소리가 거의 없어요. {rec.source === 'mic' ? '마이크가 맞는지 확인해 주세요.' : '소리가 나오고 있는지 확인해 주세요.'}
        </Banner>
      ) : (
        <p className={styles.hint}>창을 닫아도 녹음은 계속돼요. 노트북 덮개를 닫으면 멈춰요.</p>
      )}
    </Card>
  )
}
