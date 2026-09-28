// 작업 하나(녹음 → 노트)를 단계별로 실행하고 job.json에 상태를 남긴다. 끝난 단계는 다시 돌리지 않는다.
// pipeline/process_lecture.py의 process_one() 6단계를 옮겨 온 것이다. 작업 폴더는 <데이터 폴더>/jobs/<id>/.
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { prepareLocal, probe } from './audio.ts'
import type { Chunk } from './audio.ts'
import { clean, transcriptText } from './clean.ts'
import type { Cleaned } from './clean.ts'
import * as corrections from './corrections.ts'
import type { Correction } from './corrections.ts'
import * as credits from './credits.ts'
import { EngineError } from './errors.ts'
import { readJson, writeJsonAtomic } from './files.ts'
import { readNotes } from './inputs.ts'
import { renderNote, saveNote } from './note.ts'
import { transcribeChunks } from './stt/base.ts'
import type { Segment } from './stt/base.ts'
import { WhisperCpp } from './stt/whispercpp.ts'
import { summarize } from './summarize.ts'

// S3 결정(docs/decisions.md): whisper.cpp, CPU·GPU 모두 large-v3-turbo-q8_0 + greedy
export const DEFAULT_MODEL = 'large-v3-turbo-q8_0'
export const DEFAULT_BEAM_SIZE = 1
export const VAD_MODEL = 'silero-v6.2.0'

export const STAGES = ['audio', 'stt', 'clean', 'summarize', 'note', 'save'] as const
export type StageName = (typeof STAGES)[number]
export type StageState = { status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; startedAt?: string; endedAt?: string }

export type LlmSettings = { endpoint: string; model: string; creditsUrl?: string }

export type JobSettings = {
  language: string // whisper-cli -l (과목별 강의 언어)
  model: string
  beamSize: number
  gpuDevice: number | null // null이면 CPU
  threads: number
  outDir: string
  llm: LlmSettings | null // null이면 요약 없이 전사만 담은 노트
}

export type Job = {
  id: string
  createdAt: string
  input: { audio: string; notes: string | null; subject: string | null } // notes는 작업 폴더에 복사한 필기의 파일 이름
  settings: JobSettings
  stages: Record<StageName, StageState>
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  audio?: { durationS: number | null; recordedAt: string; chunks: Chunk[] }
  cost?: { summaryCredits: number | null }
  output?: { notePath: string }
  error?: { code: string; message: string; stage: StageName }
}

type SummaryFile = {
  title: string
  summary: string
  keywords: string[]
  corrections: Correction[] // 전사에 실제로 있는 것만 고른 목록
  parseFailed: boolean
}

export type JobContext = {
  ffmpeg: string
  whisperCli: string[] // 실행 명령 (테스트에서는 node + 가짜 스크립트)
  modelPath: (kind: 'whisper' | 'vad', name: string) => Promise<string> // 없으면 받아 온다
  apiKey: string | null // job.json에는 저장하지 않는다
  onProgress?: (stage: StageName, frac: number) => void
  signal?: AbortSignal
}

const now = (): string => new Date().toISOString()

function newId(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

export function jobsDir(dataDir: string): string {
  return join(dataDir, 'jobs')
}

export async function loadJob(jobDir: string): Promise<Job> {
  return readJson<Job>(join(jobDir, 'job.json'))
}

async function saveJob(jobDir: string, job: Job): Promise<void> {
  await writeJsonAtomic(join(jobDir, 'job.json'), job)
}

/** 작업 폴더를 만들고 필기를 복사해 둔다 (원본을 옮기거나 지워도 재개할 수 있게). */
export async function createJob(dataDir: string, audio: string, notes: string | null, subject: string | null,
                                settings: JobSettings): Promise<string> {
  const id = newId()
  const jobDir = join(jobsDir(dataDir), id)
  await mkdir(jobDir, { recursive: true })
  let notesFile: string | null = null
  if (notes) {
    notesFile = `notes${extname(notes).toLowerCase()}`
    await copyFile(notes, join(jobDir, notesFile))
  }
  const stages = Object.fromEntries(STAGES.map((s) => [s, { status: 'pending' }])) as Record<StageName, StageState>
  await saveJob(jobDir, {
    id, createdAt: now(), input: { audio, notes: notesFile, subject }, settings, stages, status: 'queued'
  })
  return jobDir
}

export async function listJobs(dataDir: string): Promise<Job[]> {
  let ids: string[]
  try {
    ids = await readdir(jobsDir(dataDir))
  } catch {
    return []
  }
  const jobs: Job[] = []
  for (const id of ids) {
    try {
      jobs.push(await loadJob(join(jobsDir(dataDir), id)))
    } catch {
      // job.json이 없거나 깨진 폴더는 건너뛴다
    }
  }
  // 넣은 순서대로. id는 초 단위라 한 번에 넣은 녹음끼리는 무작위 꼬리로 순서가 뒤바뀌므로 createdAt(밀리초)로 정렬한다
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** 녹음 날짜: 녹음 파일 메타데이터 → 파일 수정 시각 → 지금. 휴대폰에서 복사하면 수정 시각이 복사한 시각으로 바뀌기도 한다. */
async function recordedAt(audio: string, creationTime: string | null): Promise<string> {
  const meta = creationTime ? new Date(creationTime) : null
  if (meta && !Number.isNaN(meta.getTime()) && meta.getFullYear() >= 2000) return meta.toISOString()
  try {
    return (await stat(audio)).mtime.toISOString()
  } catch {
    return now()
  }
}

function localDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function stem(path: string): string {
  return basename(path).slice(0, basename(path).length - extname(path).length)
}

type Runner = (job: Job, jobDir: string, ctx: JobContext) => Promise<'done' | 'skipped'>

const RUNNERS: Record<StageName, Runner> = {
  async audio(job, jobDir, ctx) {
    const info = await probe(ctx.ffmpeg, job.input.audio)
    const chunks = await prepareLocal(ctx.ffmpeg, job.input.audio, jobDir)
    job.audio = { durationS: info.durationS, recordedAt: await recordedAt(job.input.audio, info.creationTime), chunks }
    return 'done'
  },

  async stt(job, jobDir, ctx) {
    const s = job.settings
    const engine = new WhisperCpp({
      cli: ctx.whisperCli,
      model: await ctx.modelPath('whisper', s.model),
      vadModel: await ctx.modelPath('vad', VAD_MODEL),
      threads: s.threads,
      gpuDevice: s.gpuDevice,
      beamSize: s.beamSize
    })
    const segments = await transcribeChunks(engine, job.audio!.chunks, join(jobDir, 'chunks'), join(jobDir, 'stt'), {
      language: s.language, signal: ctx.signal, onProgress: (f) => ctx.onProgress?.('stt', f)
    })
    await writeJsonAtomic(join(jobDir, 'stt.json'), segments)
    await rm(join(jobDir, 'chunks'), { recursive: true, force: true }) // 조각 WAV는 전사가 끝나면 필요 없다
    return 'done'
  },

  async clean(_job, jobDir) {
    await writeJsonAtomic(join(jobDir, 'cleaned.json'), clean(await readJson<Segment[]>(join(jobDir, 'stt.json'))))
    return 'done'
  },

  async summarize(job, jobDir, ctx) {
    const llm = job.settings.llm
    if (!llm) return 'skipped'
    if (!ctx.apiKey) throw new EngineError('auth', 'API 키가 없어요. 설정에서 키를 넣어 주세요.')
    const cleaned = await readJson<Cleaned>(join(jobDir, 'cleaned.json'))
    const text = transcriptText(cleaned)
    const notes = job.input.notes ? await readNotes(join(jobDir, job.input.notes)) : ''
    const before = llm.creditsUrl ? await creditsRemaining(llm.creditsUrl, ctx.apiKey) : null
    const result = await summarize(text, notes, job.input.subject, {
      endpoint: llm.endpoint, apiKey: ctx.apiKey, model: llm.model, fallbackTitle: stem(job.input.audio)
    })
    const after = before !== null ? await creditsRemaining(llm.creditsUrl!, ctx.apiKey) : null
    job.cost = { summaryCredits: before !== null && after !== null ? Math.round((before - after) * 100) / 100 : null }
    const file: SummaryFile = {
      title: result.title,
      summary: result.summary,
      keywords: result.keywords,
      corrections: corrections.select(result.corrections, text),
      parseFailed: result.parseFailed
    }
    await writeJsonAtomic(join(jobDir, 'summary.json'), file)
    return 'done'
  },

  async note(job, jobDir) {
    const cleaned = await readJson<Cleaned>(join(jobDir, 'cleaned.json'))
    const summary = job.stages.summarize.status === 'done' ? await readJson<SummaryFile>(join(jobDir, 'summary.json')) : null
    const [transcript, applied] = corrections.apply(cleaned.paragraphs.map((p) => p.text), summary?.corrections ?? [])
    const s = job.settings
    const markdown = renderNote({
      title: summary?.title ?? stem(job.input.audio),
      subject: job.input.subject,
      date: localDate(job.audio!.recordedAt),
      source: basename(job.input.audio),
      stt: `whisper.cpp ${s.model}`,
      llm: summary ? s.llm!.model : null,
      summary: summary?.summary ?? null,
      keywords: summary?.keywords ?? [],
      transcript,
      original: cleaned.paragraphs,
      applied
    })
    await writeFile(join(jobDir, 'note.md'), markdown, 'utf8')
    return 'done'
  },

  async save(job, jobDir) {
    const markdown = await readFile(join(jobDir, 'note.md'), 'utf8')
    const title = /^# (.*)$/m.exec(markdown)?.[1] ?? stem(job.input.audio)
    job.output = {
      notePath: await saveNote(job.settings.outDir, job.input.subject, localDate(job.audio!.recordedAt), title, markdown,
                               job.output?.notePath)
    }
    return 'done'
  }
}

async function creditsRemaining(url: string, apiKey: string): Promise<number | null> {
  // 잔액 조회가 실패해도 요약은 한다 (비용 기록만 빠진다)
  try {
    return credits.remaining(await credits.get(url, apiKey))
  } catch {
    return null
  }
}

/** 끝나지 않은 단계부터 실행한다. 실패하면 그 단계만 failed로 두고 오류를 다시 던진다. */
export async function runJob(jobDir: string, ctx: JobContext): Promise<Job> {
  const job = await loadJob(jobDir)
  job.status = 'running'
  delete job.error
  await saveJob(jobDir, job)
  for (const stage of STAGES) {
    const state = job.stages[stage]
    if (state.status === 'done' || state.status === 'skipped') continue
    job.stages[stage] = { status: 'running', startedAt: now() }
    await saveJob(jobDir, job)
    try {
      if (ctx.signal?.aborted) throw new EngineError('cancelled', '작업을 취소했습니다.')
      const result = await RUNNERS[stage](job, jobDir, ctx)
      job.stages[stage] = { ...job.stages[stage], status: result, endedAt: now() }
      ctx.onProgress?.(stage, 1)
    } catch (e) {
      const err = e instanceof EngineError ? e : new EngineError('internal', `${(e as Error).name}: ${(e as Error).message}`)
      job.stages[stage] = { ...job.stages[stage], status: 'failed', endedAt: now() }
      job.status = err.code === 'cancelled' ? 'cancelled' : 'failed'
      job.error = { code: err.code, message: err.message, stage }
      await saveJob(jobDir, job)
      throw err
    }
    await saveJob(jobDir, job)
  }
  job.status = 'done'
  await saveJob(jobDir, job)
  return job
}
