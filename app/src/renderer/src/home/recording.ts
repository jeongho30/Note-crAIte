// 앱에서 녹음하기 (화면 쪽): 마이크 또는 컴퓨터 소리를 MediaRecorder로 녹음해 5초마다 메인에 보낸다.
// 화면을 옮겨도(홈이 사라져도) 녹음이 이어지도록 React 밖의 한 곳에 상태를 둔다.
import { useSyncExternalStore } from 'react'
import { ApiError, call } from '../api'

export type RecordSource = 'mic' | 'system'

export type RecorderState =
  | { status: 'idle' }
  | { status: 'starting' }
  | {
      status: 'recording' | 'paused'
      source: RecordSource
      /** 일시정지를 뺀 녹음 시간 (ms) */
      elapsedMs: number
      /** 입력 소리 크기 0~1 */
      level: number
      /** 소리가 거의 없이 이어진 시간 (초) */
      silentS: number
      /** 저장이 실패하고 있으면 그 이유 */
      error: string | null
    }
  | { status: 'stopping' }

const CHUNK_MS = 5000 // 앱이 죽어도 잃는 것은 이만큼
const BITRATE = 48000 // opus 48kbps: 90분에 약 32MB. 받아쓰기는 16kHz로 바꿔 쓰므로 충분하다
const TICK_MS = 200
const SILENT_RMS = 0.004 // 이보다 작으면 소리가 없는 것으로 본다
export const SILENT_WARN_S = 120

let state: RecorderState = { status: 'idle' }
const listeners = new Set<() => void>()

function set(next: RecorderState): void {
  state = next
  for (const l of listeners) l()
}

export function useRecorder(): RecorderState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
}

/** 녹음을 시작하지 못한 이유 (화면에 그대로 보인다). mic: 마이크 권한 문제면 Windows 설정을 여는 버튼을 붙인다 */
export class RecordError extends Error {
  readonly micSettings: boolean

  constructor(message: string, micSettings = false) {
    super(message)
    this.micSettings = micSettings
  }
}

type Session = {
  stream: MediaStream
  media: MediaRecorder
  audio: AudioContext
  timer: number
  queue: Promise<unknown>
  source: RecordSource
  elapsedMs: number
  lastTick: number
  silentS: number
  error: string | null
}

let session: Session | null = null

async function openStream(source: RecordSource, deviceId: string | null): Promise<MediaStream> {
  try {
    if (source === 'mic') {
      // 강의실 녹음: 에코 제거·잡음 억제는 멀리 있는 목소리까지 깎을 수 있어 끈다. 음량 자동 조절은 둔다
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
      })
    }
    // 컴퓨터 소리: 메인이 화면 하나와 시스템 소리(loopback)를 준다. 영상은 쓰지 않으니 바로 끈다
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    for (const t of stream.getVideoTracks()) {
      t.stop()
      stream.removeTrack(t)
    }
    if (!stream.getAudioTracks().length) throw new RecordError('컴퓨터 소리를 가져오지 못했어요.')
    return stream
  } catch (e) {
    if (e instanceof RecordError) throw e
    const name = e instanceof DOMException ? e.name : ''
    if (source === 'mic' && name === 'NotAllowedError')
      throw new RecordError('마이크를 쓸 수 없어요. Windows 설정 > 개인 정보 > 마이크에서 "데스크톱 앱이 마이크에 액세스하도록 허용"을 켜 주세요.', true)
    if (source === 'mic' && (name === 'NotFoundError' || name === 'OverconstrainedError')) throw new RecordError('마이크를 찾지 못했어요. 연결을 확인해 주세요.')
    if (source === 'mic' && name === 'NotReadableError') throw new RecordError('마이크를 열지 못했어요. 다른 프로그램이 쓰고 있을 수 있어요.')
    throw new RecordError(source === 'mic' ? '마이크를 열지 못했어요.' : '컴퓨터 소리를 가져오지 못했어요.')
  }
}

function publish(s: Session, status: 'recording' | 'paused', level: number): void {
  set({ status, source: s.source, elapsedMs: s.elapsedMs, level, silentS: s.silentS, error: s.error })
}

/** 녹음을 시작한다. 실패하면 RecordError */
export async function startRecording(source: RecordSource, deviceId: string | null): Promise<void> {
  if (state.status !== 'idle') return
  set({ status: 'starting' })
  let stream: MediaStream | null = null
  try {
    stream = await openStream(source, deviceId)
    await call('rec.begin', source)
  } catch (e) {
    for (const t of stream?.getTracks() ?? []) t.stop()
    set({ status: 'idle' })
    if (e instanceof RecordError) throw e
    throw new RecordError(e instanceof ApiError ? e.message : '녹음을 시작하지 못했어요.')
  }

  const media = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: BITRATE })
  // 소리 크기: 녹음과 별개로 입력을 들여다본다
  const audio = new AudioContext()
  void audio.resume() // 누른 뒤 권한·IPC를 기다리는 사이 사용자 동작이 만료되면 멈춘 채로 만들어진다
  const analyser = audio.createAnalyser()
  analyser.fftSize = 2048
  audio.createMediaStreamSource(stream).connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  const s: Session = { stream, media, audio, timer: 0, queue: Promise.resolve(), source, elapsedMs: 0, lastTick: performance.now(), silentS: 0, error: null }
  session = s

  // 조각은 받은 순서대로 보낸다 (arrayBuffer가 끝나는 순서는 보장되지 않아 줄을 세운다)
  media.ondataavailable = (e) => {
    if (!e.data.size) return
    s.queue = s.queue
      .then(async () => call('rec.chunk', new Uint8Array(await e.data.arrayBuffer())))
      .then(
        () => (s.error = null),
        (err) => (s.error = err instanceof ApiError ? err.message : '녹음을 저장하지 못하고 있어요.')
      )
  }
  // 장치를 뽑거나 화면 공유가 끊기면 녹음을 끝낸다
  for (const t of stream.getAudioTracks()) t.onended = () => void stopRecording()

  s.timer = window.setInterval(() => {
    const now = performance.now()
    const dt = now - s.lastTick
    s.lastTick = now
    if (media.state !== 'recording') return publish(s, 'paused', 0)
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const rms = Math.sqrt(sum / buf.length)
    s.elapsedMs += dt
    s.silentS = rms < SILENT_RMS ? s.silentS + dt / 1000 : 0
    publish(s, 'recording', Math.min(1, rms * 8))
  }, TICK_MS)

  media.start(CHUNK_MS)
  publish(s, 'recording', 0)
}

export function pauseRecording(): void {
  if (session?.media.state === 'recording') session.media.pause()
}

export function resumeRecording(): void {
  if (session?.media.state !== 'paused') return
  session.lastTick = performance.now()
  session.silentS = 0
  session.media.resume()
}

// 녹음이 끝나면 (직접 끝냈든 장치가 빠져 끝났든) 녹음 파일로 시작 전 확인을 연다. 홈이 없으면 홈 배너에 뜬다
const finished = new Set<(path: string) => void>()

export function onRecordingFinished(cb: (path: string) => void): () => void {
  finished.add(cb)
  return () => finished.delete(cb)
}

/** 녹음을 끝낸다. 녹음 파일은 onRecordingFinished로 알린다 */
export async function stopRecording(): Promise<void> {
  const s = session
  if (!s || state.status === 'stopping') return
  session = null
  set({ status: 'stopping' })
  window.clearInterval(s.timer)
  if (s.media.state !== 'inactive') {
    const stopped = new Promise((resolve) => (s.media.onstop = resolve))
    s.media.stop() // 남은 조각을 ondataavailable로 한 번 더 보낸다
    await stopped
  }
  for (const t of s.stream.getTracks()) t.stop()
  void s.audio.close()
  await s.queue
  try {
    const path = await call<string | null>('rec.end')
    if (path) for (const cb of finished) cb(path)
  } finally {
    set({ status: 'idle' })
  }
}

/** 마이크 목록. 한 번도 허락하지 않았으면 이름이 비어 있을 수 있다 */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `마이크 ${i + 1}` }))
}

/** 컴퓨터 소리 녹음은 Windows에서만 된다 (시스템 소리 loopback) */
export const systemAudioSupported = navigator.userAgent.includes('Windows')

/** "12:34", 한 시간이 넘으면 "1:02:03" */
export function clock(ms: number): string {
  const t = Math.floor(ms / 1000)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
