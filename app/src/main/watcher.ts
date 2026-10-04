// 자동 처리(폴더 감시) 실행기: 켜져 있으면 20초마다 감시 폴더를 살펴, 복사·동기화가 끝난 새 녹음을 확인 없이 작업으로 넘긴다.
// 강의 언어는 과목 기본값, 과목 폴더 밖의 녹음은 미분류. 노트가 만들어지면 녹음을 그 폴더의 "처리됨"으로 옮긴다.
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { EngineError } from '../core/errors.ts'
import { writeJsonAtomic } from '../core/files.ts'
import { findNotes, notesProblem } from '../core/inputs.ts'
import { jobsDir } from '../core/job.ts'
import type { Job } from '../core/job.ts'
import { loadSettings, updateSettings } from '../core/settings.ts'
import type { Settings } from '../core/settings.ts'
import { inspectFolder } from '../core/vault.ts'
import {
  baselineKey, canOpen, fingerprint, loadWatchState, moveToDone, saveWatchState, scanWatchFolder, settled, subjectDirs
} from '../core/watch.ts'
import type { WatchFile } from '../core/watch.ts'
import type { JobInput } from './jobs.ts'

const POLL_MS = 20_000

export type WatchStatus = {
  enabled: boolean
  folder: string | null
  paused: boolean
  /** 들어왔지만 아직 복사·동기화가 끝나지 않아 기다리는 녹음 수 */
  waiting: number
  /** 켠 뒤 넘긴 녹음 수 */
  started: number
  lastScanAt: string | null
  /** 감시 폴더를 읽지 못함, 저장 폴더가 없음 등 */
  error: string | null
}

type Deps = {
  dataDir: string
  start: (inputs: JobInput[]) => Promise<string[]>
  log: (message: string) => void
  emit: (status: WatchStatus) => void
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && rel !== child)
}

export function createWatcher({ dataDir, start, log, emit }: Deps) {
  let timer: NodeJS.Timeout | null = null
  let polling = false
  let previous = new Map<string, WatchFile>()
  // 이미 판단한 파일 (경로|크기|수정 시각): 폴링마다 다시 해시하지 않는다
  const known = new Set<string>()
  const status: WatchStatus = { enabled: false, folder: null, paused: false, waiting: 0, started: 0, lastScanAt: null, error: null }

  function update(patch: Partial<WatchStatus>): void {
    Object.assign(status, patch)
    emit({ ...status })
  }

  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const settings = await loadSettings(dataDir)
      const { enabled, folder, paused } = settings.watch
      if (!enabled || paused || !folder) return
      if (!settings.outDir) return update({ error: '저장 폴더가 정해지지 않았어요. 설정 > 저장 폴더에서 골라 주세요.' })
      let files: WatchFile[]
      try {
        files = await scanWatchFolder(folder)
      } catch {
        return update({ error: '감시 폴더를 읽지 못했어요. 폴더가 있는지 확인해 주세요.' })
      }
      const now = Date.now()
      const state = await loadWatchState(dataDir)
      const baseline = new Set(state.baseline)
      const fresh = files.filter((f) => !known.has(baselineKey(f)) && !baseline.has(baselineKey(f)))
      const ready = settled(fresh, previous, now)
      previous = new Map(files.map((f) => [f.path, f]))

      const inputs: { input: JobInput; fp: string; file: WatchFile }[] = []
      for (const f of ready) {
        if (!(await canOpen(f.path))) continue // 아직 쓰는 중
        const fp = await fingerprint(f.path, f.size).catch(() => null)
        if (!fp) continue
        if (state.seen[fp]) {
          known.add(baselineKey(f)) // 같은 녹음을 이미 넘김 (이름·위치가 바뀌어도)
          continue
        }
        // 쓸 수 없는 PDF 필기(스캔본 등)는 없는 것으로 보고 받아쓰기·요약은 그대로 한다
        const found = findNotes(f.path)
        const notes = found && !(await notesProblem(found)) ? found : null
        inputs.push({
          fp,
          file: f,
          input: { audio: f.path, notes, subject: f.subject, language: settings.subjectLanguage[f.subject ?? ''] ?? 'ko', from: 'watch' }
        })
      }
      if (inputs.length) {
        const ids = await start(inputs.map((x) => x.input))
        inputs.forEach((x, k) => {
          state.seen[x.fp] = { path: x.file.path, at: new Date().toISOString(), jobId: ids[k] ?? null }
          known.add(baselineKey(x.file))
        })
        await saveWatchState(dataDir, state)
        for (const x of inputs) log(`자동 처리: ${relative(folder, x.file.path)} (${x.file.subject ?? '미분류'})`)
      }
      update({
        error: null,
        lastScanAt: new Date().toISOString(),
        started: status.started + inputs.length,
        waiting: fresh.length - ready.length
      })
    } catch (e) {
      log(`자동 처리 오류: ${(e as Error).message}`)
      update({ error: e instanceof EngineError ? e.message : '녹음을 넘기다 문제가 생겼어요. 잠시 뒤 다시 살펴봐요.' })
    } finally {
      polling = false
    }
  }

  function schedule(s: Settings['watch']): void {
    const run = s.enabled && !s.paused && !!s.folder
    if (run && !timer) {
      timer = setInterval(() => void poll(), POLL_MS)
      void poll()
    } else if (!run && timer) {
      clearInterval(timer)
      timer = null
    }
    update({ enabled: s.enabled, folder: s.folder, paused: s.paused, ...(run ? {} : { waiting: 0 }) })
  }

  async function set(patch: Partial<Settings['watch']>): Promise<Settings['watch']> {
    const cur = (await loadSettings(dataDir)).watch
    const next = (await updateSettings(dataDir, { watch: { ...cur, ...patch } })).watch
    schedule(next)
    return next
  }

  return {
    get: (): WatchStatus => ({ ...status }),
    enabled: (): boolean => status.enabled,
    /** 앱을 켤 때: 켜져 있으면 감시를 시작한다 */
    init: async (): Promise<void> => schedule((await loadSettings(dataDir)).watch),

    /** 켜기 전에 보여 줄 것: 폴더에 있는 녹음 수, 저장 폴더에만 있는 과목, 저장 폴더 안인지 */
    async inspect(folder: string) {
      const settings = await loadSettings(dataDir)
      const state = await loadWatchState(dataDir)
      const files = await scanWatchFolder(folder)
      const seenPaths = new Set(Object.values(state.seen).map((s) => s.path))
      const outSubjects = settings.outDir ? (await inspectFolder(settings.outDir).catch(() => null))?.subjects ?? [] : []
      const have = new Set((await subjectDirs(folder)).map((s) => s.toLowerCase()))
      return {
        existing: files.filter((f) => !seenPaths.has(f.path)).length,
        missingSubjects: outSubjects.filter((s) => !have.has(s.toLowerCase())),
        insideOut: !!settings.outDir && (isInside(folder, settings.outDir) || isInside(settings.outDir, folder))
      }
    },

    /** 켜기: 과목 폴더를 만들고, [새 녹음만]이면 지금 있는 녹음을 기록해 두고 넘기지 않는다 */
    async enable(folder: string, o: { createSubjects: string[]; processExisting: boolean }): Promise<void> {
      await mkdir(folder, { recursive: true })
      for (const s of o.createSubjects) await mkdir(join(folder, s), { recursive: true })
      const state = await loadWatchState(dataDir)
      state.baseline = o.processExisting ? [] : (await scanWatchFolder(folder)).map(baselineKey)
      await saveWatchState(dataDir, state)
      previous = new Map()
      known.clear()
      await set({ enabled: true, folder, paused: false })
      log(`자동 처리 켬: ${folder} · 기존 녹음 ${o.processExisting ? '처리' : '건너뜀'} · 과목 폴더 ${o.createSubjects.length}개 만듦`)
    },
    async disable(): Promise<void> {
      await set({ enabled: false, paused: false })
      log('자동 처리 끔')
    },
    async pause(paused: boolean): Promise<void> {
      await set({ paused })
      log(paused ? '자동 처리 멈춤' : '자동 처리 다시 시작')
    },

    /** 작업이 끝나면: 자동 처리로 들어온 녹음(과 필기)을 "처리됨"으로 옮기고, 작업의 녹음 경로를 고친다 */
    async onDone(job: Job): Promise<void> {
      if (job.input.from !== 'watch') return
      try {
        const moved = await moveToDone(job.input.audio)
        job.input.audio = moved.audio
        await writeJsonAtomic(join(jobsDir(dataDir), job.id, 'job.json'), job)
      } catch (e) {
        // 잠겨 있거나 동기화 중이면 그대로 둔다. 처리 기록(fingerprint)이 있어 다시 넘기지 않는다
        log(`처리됨으로 옮기지 못함: ${job.input.audio} · ${(e as Error).message}`)
      }
    }
  }
}
