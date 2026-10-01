// 앱 설정 (<데이터 폴더>/settings.json). API 키는 여기 두지 않는다(메인 프로세스가 safeStorage로 따로 보관).
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './files.ts'
import { DEFAULT_MODEL } from './job.ts'
import type { ProviderId } from './providers.ts'

export type Settings = {
  /** 첫 실행 마법사에서 마지막으로 보던 단계. 앱을 껐다 켜면 여기서 이어 한다 */
  wizardStep: number
  wizardDone: boolean
  /** 노트를 저장할 폴더 (과목별 하위 폴더가 생김) */
  outDir: string | null
  /** 연결된 요약 서비스. null이면 요약 없이 전사문만 담은 노트를 만든다 */
  provider: ProviderId | null
  /** 시작 전 확인에서 마지막으로 고른 과목 (다음 녹음의 기본값). null이면 미분류 */
  lastSubject: string | null
  /** 과목별 강의 언어 기본값. 없는 과목은 한국어. 바꾸는 곳은 설정 > 과목 */
  subjectLanguage: Record<string, Language>
  /** 요약 모델. null이면 서비스의 권장 모델 */
  summaryModel: string | null
  /** 전사문 다듬기 모델. null이면 다듬지 않는다(기본) */
  polishModel: string | null
  /** 받아쓰기 모델 (설정 > 고급 > 받아쓰기 세부설정) */
  sttModel: string
  /** 고친 whisper-cli 옵션. null이면 앱 기본(이 PC에서 잰 장치·스레드) */
  sttArgs: string | null
  /** 화면 색. system이면 Windows 설정을 따른다 */
  theme: Theme
  /** 자동 처리(폴더 감시). 설정 > 자동 처리에서만 켠다. paused면 켜져 있지만 트레이 메뉴에서 잠시 멈춘 상태 */
  watch: { enabled: boolean; folder: string | null; paused: boolean }
  /** 앱에서 녹음하는 동안에도 앞서 넣은 녹음을 받아쓴다. 기본은 꺼짐(녹음이 끝날 때까지 받아쓰기를 멈춤). 설정 > 고급 > 녹음 */
  sttWhileRecording: boolean
  /** 받아쓰기를 이 PC의 whisper 대신 ChatKHU 받아쓰기(Soniox)로. ChatKHU가 연결돼 있을 때만 쓰인다. 설정 > 고급 > 실험 기능 */
  chatkhuStt: boolean
  /** 로컬 LLM(Ollama). 설정 > 고급 */
  ollama: OllamaSettings
}

export type OllamaSettings = {
  /** 요약·전사문 다듬기를 요약 서비스 대신 로컬 LLM으로 한다 (모델을 골라야 쓰인다) */
  summary: boolean
  polish: boolean
  summaryModel: string | null
  polishModel: string | null
  /** 고친 요청 옵션(JSON). null이면 앱 기본 (core/ollama.ts의 DEFAULT_REQUEST) */
  summaryRequest: string | null
  polishRequest: string | null
}

export type Theme = 'system' | 'light' | 'dark'

export type Language = 'ko' | 'en'

export const DEFAULT_SETTINGS: Settings = {
  wizardStep: 0, wizardDone: false, outDir: null, provider: null, lastSubject: null, subjectLanguage: {},
  summaryModel: null, polishModel: null, sttModel: DEFAULT_MODEL, sttArgs: null, theme: 'system',
  watch: { enabled: false, folder: null, paused: false }, sttWhileRecording: false, chatkhuStt: false,
  ollama: { summary: false, polish: false, summaryModel: null, polishModel: null, summaryRequest: null, polishRequest: null }
}

function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json')
}

export async function loadSettings(dataDir: string): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(settingsPath(dataDir))) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

// 읽고-고치고-쓰기를 한 번에 하나씩 한다. 겹치면 앞의 변경이 사라지거나(나중 쓰기가 옛 값을 덮음) rename이 실패한다.
let queue: Promise<unknown> = Promise.resolve()

export function updateSettings(dataDir: string, patch: Partial<Settings>): Promise<Settings> {
  const run = queue.then(async () => {
    const next = { ...(await loadSettings(dataDir)), ...patch }
    await mkdir(dataDir, { recursive: true })
    await writeJsonAtomic(settingsPath(dataDir), next)
    return next
  })
  queue = run.catch(() => {})
  return run
}
