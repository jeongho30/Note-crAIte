// 앱 설정 (<데이터 폴더>/settings.json). API 키는 여기 두지 않는다(메인 프로세스가 safeStorage로 따로 보관).
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './files.ts'
import type { ProviderId } from './providers.ts'

export type Settings = {
  /** 첫 실행 마법사에서 마지막으로 보던 단계. 앱을 껐다 켜면 여기서 이어 한다 */
  wizardStep: number
  wizardDone: boolean
  /** 노트를 저장할 폴더 (과목별 하위 폴더가 생김) */
  outDir: string | null
  /** 연결된 요약 서비스. null이면 요약 없이 전사문만 담은 노트를 만든다 */
  provider: ProviderId | null
}

export const DEFAULT_SETTINGS: Settings = { wizardStep: 0, wizardDone: false, outDir: null, provider: null }

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
