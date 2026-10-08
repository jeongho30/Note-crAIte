// 작업 하나(녹음 → 노트)를 단계별로 실행하고 job.json에 상태를 남긴다. 끝난 단계는 다시 돌리지 않는다.
// pipeline/process_lecture.py의 process_one() 6단계를 옮겨 온 것이다. 작업 폴더는 <데이터 폴더>/jobs/<id>/.
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { prepareLocal, probe } from './audio.ts'
import type { Chunk } from './audio.ts'
import { clean, transcriptText } from './clean.ts'
import type { Cleaned, Paragraph } from './clean.ts'
import * as corrections from './corrections.ts'
import type { Correction } from './corrections.ts'
import * as credits from './credits.ts'
import { EngineError } from './errors.ts'
import { readJson, writeJsonAtomic } from './files.ts'
import { readNotes } from './inputs.ts'
import { catalog, creditsFromTokens } from './llmcatalog.ts'
import { renderNote, saveNote } from './note.ts'
import { usesCredits } from './providers.ts'
import { unload } from './ollama.ts'
import type { OllamaRequest } from './ollama.ts'
import { transcribeChunks } from './stt/base.ts'
import type { Segment, SttEngine } from './stt/base.ts'
import { chargedCredits, ChatkhuStt } from './stt/chatkhu.ts'
import { WhisperCpp } from './stt/whispercpp.ts'
import { polishParagraphs } from './polish.ts'
import { summarize } from './summarize.ts'
import type { PromptOverride } from './summarize.ts'
import { verifyCorrections } from './verify.ts'

// S3 결정(docs/decisions.md): whisper.cpp, CPU·GPU 모두 large-v3-turbo-q8_0 + greedy
export const DEFAULT_MODEL = 'large-v3-turbo-q8_0'
export const DEFAULT_BEAM_SIZE = 1
export const VAD_MODEL = 'silero-v6.2.0'
/** 설정 > 고급에서 고를 수 있는 받아쓰기 모델: 기본, 더 정확하게(large-v3), 가볍게(small) */
export const STT_MODEL_CHOICES = [DEFAULT_MODEL, 'large-v3-q5_0', 'small-q5_1'] as const

export const STAGES = ['audio', 'stt', 'clean', 'polish', 'summarize', 'note', 'save'] as const
export type StageName = (typeof STAGES)[number]
export type StageState = {
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
  startedAt?: string
  endedAt?: string
  /** 앞서 시작했다가 멈춘 단계를 이어서 했다 (startedAt~endedAt이 단계 전체에 걸린 시간이 아님) */
  resumed?: boolean
}

/** 한 단계(다듬기·요약)가 부를 서비스와 모델 */
export type LlmSettings = {
  endpoint: string
  model: string
  creditsUrl?: string
  /** 서비스 id (chatkhu, ollama …). 10/2 전 작업에는 없다(ChatKHU) */
  service?: string
  /** 있으면 로컬 LLM(Ollama): 고친 요청 옵션. API 키가 필요 없고 크레딧이 들지 않는다 */
  ollama?: OllamaRequest
}

export type JobSettings = {
  language: string // whisper-cli -l (과목별 강의 언어)
  model: string
  beamSize: number
  gpuDevice: number | null // null이면 CPU
  threads: number
  args?: string[] | null // 설정 > 고급에서 고친 whisper-cli 옵션. 있으면 threads·beamSize·gpuDevice 대신 쓴다
  outDir: string
  llm: LlmSettings | null // 요약. null이면 요약 없이 전사만 담은 노트
  /** 요약 뒤 교정 검증 모델(요약 서비스는 llm과 같음). null이거나 없으면 검증하지 않는다(9/30 전 작업) */
  verifyModel?: string | null
  /** 전사문 다듬기. null이면 다듬지 않는다. 없으면 10/2 전 작업이라 polishModel을 본다 */
  polishLlm?: LlmSettings | null
  /** 10/2 전 작업의 전사문 다듬기 모델 (서비스는 llm과 같음) */
  polishModel?: string | null
  /** 받아쓰기 방식. chatkhu면 ChatKHU 받아쓰기(Soniox, 크레딧 사용), 없으면 이 PC의 whisper (설정 > 고급 > 실험 기능) */
  sttService?: 'whisper' | 'chatkhu'
}

export type Job = {
  id: string
  createdAt: string
  // notes는 작업 폴더에 복사한 필기의 파일 이름. from이 'watch'면 자동 처리(폴더 감시)로 들어온 녹음이라, 끝나면 "처리됨"으로 옮긴다
  input: { audio: string; notes: string | null; subject: string | null; from?: 'watch' }
  settings: JobSettings
  stages: Record<StageName, StageState>
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  audio?: { durationS: number | null; recordedAt: string; chunks: Chunk[] }
  /**
   * source: tokens는 응답의 토큰 수 × 단가, balance는 요약 전후 잔액 차이(단가표에 없는 모델만).
   * local은 로컬 LLM으로 요약해 크레딧이 들지 않은 것. source가 없는 것은 9/29 전 기록(잔액 차이)이다. 잔액 차이는 실패한 호출의 늦은 차감이나 다른 사용이 섞일 수 있다.
   */
  cost?: { summaryCredits: number | null; source?: 'tokens' | 'balance' | 'local'; verifyCredits?: number | null; polishCredits?: number | null; sttCredits?: number | null }
  /** 다듬기·요약 호출의 토큰 수 (크레딧을 쓰지 않는 서비스는 이것만 보인다) */
  usage?: { polish?: TokenCount; summary?: TokenCount }
  /** 전사문 다듬기 조각 수와, 그중 검사에 걸려 원문을 그대로 쓴 조각 수 (10/3 전 작업에는 없다) */
  polish?: { chunks: number; fallbackChunks: number; reasons?: string[] }
  output?: { notePath: string }
  /** 노트 목록에서 수정한 제목·날짜. 있으면 요약을 다시 만들어도 이 값을 쓴다 (과목은 input.subject를 고친다) */
  edits?: { title: string; date: string }
  error?: { code: string; message: string; stage: StageName }
}

export type TokenCount = { input: number; output: number }

const tokenCount = (input: unknown, output: unknown): TokenCount => ({ input: typeof input === 'number' ? input : 0, output: typeof output === 'number' ? output : 0 })

/** 크레딧으로 쓰는 호출인가: 로컬 LLM이 아니고 서비스가 ChatKHU */
const credited = (llm: LlmSettings): boolean => !llm.ollama && usesCredits(llm.service)

type SummaryFile = {
  title: string
  summary: string
  keywords: string[]
  corrections: Correction[] // 전사에 실제로 있는 것만 고른 목록 (검증했으면 검증을 통과한 것만)
  parseFailed: boolean
  /** 검증에서 버린 교정. 검증하지 않았거나 검증 호출이 실패했으면 없음 */
  rejected?: Correction[]
  /** 로컬 LLM으로 요약했을 때 실제로 쓴 컨텍스트 길이와 토큰 수 (num_ctx가 auto면 계산한 값) */
  local?: { numCtx: unknown; inputTokens: unknown; outputTokens: unknown }
}

type PolishedFile = { model: string; paragraphs: Paragraph[]; fallbackChunks: number; chunks: number }

/** 다듬은 전사가 있으면 그것, 없으면 정리한 전사 */
async function transcriptParagraphs(job: Job, jobDir: string): Promise<{ paragraphs: Paragraph[]; polished: PolishedFile | null }> {
  if (job.stages.polish?.status === 'done') {
    const polished = await readJson<PolishedFile>(join(jobDir, 'polished.json'))
    return { paragraphs: polished.paragraphs, polished }
  }
  return { paragraphs: (await readJson<Cleaned>(join(jobDir, 'cleaned.json'))).paragraphs, polished: null }
}

export type JobContext = {
  ffmpeg: string
  whisperCli: string[] // 실행 명령 (테스트에서는 node + 가짜 스크립트)
  modelPath: (kind: 'whisper' | 'vad', name: string) => Promise<string> // 없으면 받아 온다
  apiKey: string | null // 연결된 요약 서비스의 키. job.json에는 저장하지 않는다
  /** ChatKHU 게이트웨이 주소 (ChatKHU 받아쓰기를 쓰는 작업만) */
  chatkhuBase?: string
  /** 사용자가 고친 요약 프롬프트. 요약을 시작할 때 읽는다 (받아쓰는 동안 설정에서 고친 것도 쓰이게) */
  summaryPrompt?: () => Promise<PromptOverride>
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
                                settings: JobSettings, from?: 'watch'): Promise<string> {
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
    id, createdAt: now(), input: { audio, notes: notesFile, subject, ...(from ? { from } : {}) }, settings, stages, status: 'queued'
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

/** 녹음 파일 이름에서 확장자를 뺀 것 (노트 제목으로 쓴다). macOS가 자모를 풀어 준 이름이 노트에 그대로 들어가지 않게 NFC로 맞춘다 */
function stem(path: string): string {
  return basename(path).slice(0, basename(path).length - extname(path).length).normalize('NFC')
}

/** 이 작업의 전사문 다듬기 대상 (없으면 다듬지 않는다) */
export function polishTarget(s: JobSettings): LlmSettings | null {
  if (s.polishLlm !== undefined) return s.polishLlm
  return s.llm && s.polishModel ? { ...s.llm, model: s.polishModel } : null
}

/** 로컬 LLM 호출이 실패·취소로 끝나면 모델이 메모리에 남으니 내려 둔다 */
async function unloadOnError<T>(llm: LlmSettings, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (llm.ollama) await unload(llm.endpoint, llm.model)
    throw e
  }
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
    const partsDir = join(jobDir, 'stt')
    let engine: SttEngine
    if (s.sttService === 'chatkhu') {
      if (!ctx.apiKey || !ctx.chatkhuBase) throw new EngineError('auth', 'ChatKHU 키가 없어요. 설정에서 키를 넣어 주세요.')
      await mkdir(partsDir, { recursive: true })
      engine = new ChatkhuStt({ base: ctx.chatkhuBase, apiKey: ctx.apiKey, ffmpeg: ctx.ffmpeg, workDir: partsDir })
    } else {
      engine = new WhisperCpp({
        cli: ctx.whisperCli,
        model: await ctx.modelPath('whisper', s.model),
        vadModel: await ctx.modelPath('vad', VAD_MODEL),
        threads: s.threads,
        gpuDevice: s.gpuDevice,
        beamSize: s.beamSize,
        args: s.args ?? null
      })
    }
    try {
      const segments = await transcribeChunks(engine, job.audio!.chunks, join(jobDir, 'chunks'), partsDir, {
        language: s.language, signal: ctx.signal, onProgress: (f) => ctx.onProgress?.('stt', f)
      })
      await writeJsonAtomic(join(jobDir, 'stt.json'), segments)
    } finally {
      // 실패해도 이미 빠진 크레딧은 남긴다 (작업 목록의 크레딧)
      if (s.sttService === 'chatkhu') job.cost = { ...job.cost, summaryCredits: job.cost?.summaryCredits ?? null, sttCredits: await chargedCredits(partsDir) }
    }
    await rm(join(jobDir, 'chunks'), { recursive: true, force: true }) // 조각 WAV는 전사가 끝나면 필요 없다
    return 'done'
  },

  async clean(_job, jobDir) {
    await writeJsonAtomic(join(jobDir, 'cleaned.json'), clean(await readJson<Segment[]>(join(jobDir, 'stt.json'))))
    return 'done'
  },

  async polish(job, jobDir, ctx) {
    const llm = polishTarget(job.settings)
    if (!llm) return 'skipped'
    const model = llm.model
    if (!llm.ollama && !ctx.apiKey) throw new EngineError('auth', 'API 키가 없어요. 설정에서 키를 넣어 주세요.')
    const cleaned = await readJson<Cleaned>(join(jobDir, 'cleaned.json'))
    const notes = job.input.notes ? await readNotes(join(jobDir, job.input.notes)) : ''
    // 요약도 같은 로컬 모델이면 올려 둔 채 넘기고, 아니면 마지막 조각 뒤에 내린다
    const summary = job.settings.llm
    const unloadAfter = !(summary?.ollama && summary.endpoint === llm.endpoint && summary.model === model)
    const r = await unloadOnError(llm, () => polishParagraphs(cleaned.paragraphs, notes, {
      endpoint: llm.endpoint, apiKey: ctx.apiKey, model, service: llm.service, ollama: llm.ollama, signal: ctx.signal, unloadAfter,
      resumeDir: join(jobDir, 'polish')
    }))
    job.usage = { ...job.usage, polish: tokenCount(r.inputTokens, r.outputTokens) }
    job.polish = { chunks: r.chunks, fallbackChunks: r.fallbackChunks, ...(r.fallbackReasons.length ? { reasons: r.fallbackReasons } : {}) }
    if (credited(llm)) job.cost = { ...job.cost, summaryCredits: job.cost?.summaryCredits ?? null, polishCredits: creditsFromTokens(model, r.inputTokens, r.outputTokens) }
    const file: PolishedFile = { model, paragraphs: r.paragraphs, fallbackChunks: r.fallbackChunks, chunks: r.chunks }
    await writeJsonAtomic(join(jobDir, 'polished.json'), file)
    return 'done'
  },

  async summarize(job, jobDir, ctx) {
    const llm = job.settings.llm
    if (!llm) return 'skipped'
    if (!llm.ollama && !ctx.apiKey) throw new EngineError('auth', 'API 키가 없어요. 설정에서 키를 넣어 주세요.')
    // 다듬은 전사가 있으면 그것을 요약한다. 이미 다듬었으니 교정 목록은 쓰지 않는다
    const { paragraphs, polished } = await transcriptParagraphs(job, jobDir)
    const text = transcriptText({ paragraphs, stats: { segmentsIn: 0, loopsCollapsed: 0, hallucinationsRemoved: 0, repeatsRemoved: 0 } })
    const notes = job.input.notes ? await readNotes(join(jobDir, job.input.notes)) : ''
    // 단가를 아는 모델은 응답의 토큰 수로 크레딧을 계산하고, 모르는 모델만 요약 전후 잔액 차이로 잰다
    const priced = Object.hasOwn(catalog().prices, llm.model)
    const before = credited(llm) && !priced && llm.creditsUrl ? await creditsRemaining(llm.creditsUrl, ctx.apiKey!) : null
    const prompt = await ctx.summaryPrompt?.()
    const result = await unloadOnError(llm, () => summarize(text, notes, job.input.subject, {
      endpoint: llm.endpoint, apiKey: ctx.apiKey, model: llm.model, fallbackTitle: stem(job.input.audio), service: llm.service, ollama: llm.ollama, prompt, signal: ctx.signal
    }))
    job.usage = { ...job.usage, summary: tokenCount(result.usage?.prompt_tokens, result.usage?.completion_tokens) }
    // 앞 단계(다듬기·ChatKHU 받아쓰기)의 크레딧은 그대로 둔다
    const polish = {
      ...(job.cost?.polishCredits !== undefined ? { polishCredits: job.cost.polishCredits } : {}),
      ...(job.cost?.sttCredits != null ? { sttCredits: job.cost.sttCredits } : {})
    }
    if (!credited(llm)) {
      // 크레딧이 들지 않는다(로컬 LLM, 크레딧을 쓰지 않는 서비스). 앞 단계에서 쓴 크레딧이 있을 때만 남긴다
      job.cost = Object.keys(polish).length ? { summaryCredits: null, ...(llm.ollama ? { source: 'local' as const } : {}), ...polish } : undefined
    } else if (priced) {
      job.cost = { summaryCredits: creditsFromTokens(llm.model, result.usage?.prompt_tokens, result.usage?.completion_tokens), source: 'tokens', ...polish }
    } else {
      const after = before !== null ? await creditsRemaining(llm.creditsUrl!, ctx.apiKey!) : null
      job.cost = { summaryCredits: before !== null && after !== null ? Math.round((before - after) * 100) / 100 : null, source: 'balance', ...polish }
    }
    const file: SummaryFile = {
      title: result.title,
      summary: result.summary,
      keywords: result.keywords,
      corrections: polished ? [] : corrections.select(result.corrections, text),
      parseFailed: result.parseFailed,
      ...(llm.ollama ? { local: { numCtx: result.usage?.['num_ctx'], inputTokens: result.usage?.prompt_tokens, outputTokens: result.usage?.completion_tokens } } : {})
    }
    // 교정 검증(앱은 쓰지 않음, CLI --verify-model 실험용): 실제로 바꿀 곳이 있는 교정만 보낸다. 검증 호출이 실패하면 검증 없이 쓴다(요약까지 실패로 두지 않는다)
    const verifyModel = job.settings.verifyModel
    const toVerify = file.corrections.filter((c) => corrections.occurrences(text, c.wrong).length > 0)
    if (verifyModel && toVerify.length) {
      try {
        const v = await verifyCorrections(text, toVerify, job.input.subject, { endpoint: llm.endpoint, apiKey: ctx.apiKey, model: verifyModel })
        file.corrections = v.kept
        file.rejected = v.rejected
        if (job.cost) job.cost.verifyCredits = creditsFromTokens(verifyModel, v.usage?.prompt_tokens, v.usage?.completion_tokens)
      } catch (e) {
        if (e instanceof EngineError && e.code === 'cancelled') throw e
      }
    }
    await writeJsonAtomic(join(jobDir, 'summary.json'), file)
    return 'done'
  },

  async note(job, jobDir) {
    const cleaned = await readJson<Cleaned>(join(jobDir, 'cleaned.json'))
    const summary = job.stages.summarize.status === 'done' ? await readJson<SummaryFile>(join(jobDir, 'summary.json')) : null
    // 다듬은 전사가 있으면 그것이 전사문이다. 원문 정리본은 어느 쪽이든 다듬기 전 그대로 둔다
    const { paragraphs, polished } = await transcriptParagraphs(job, jobDir)
    const [transcript, applied] = corrections.apply(paragraphs.map((p) => p.text), summary?.corrections ?? [])
    const s = job.settings
    const markdown = renderNote({
      title: job.edits?.title ?? summary?.title ?? stem(job.input.audio),
      subject: job.input.subject,
      date: job.edits?.date ?? localDate(job.audio!.recordedAt),
      source: basename(job.input.audio).normalize('NFC'),
      stt: `whisper.cpp ${s.model}`,
      llm: summary ? s.llm!.model : null,
      summary: summary?.summary ?? null,
      keywords: summary?.keywords ?? [],
      transcript,
      polishedBy: polished?.model ?? null,
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
      notePath: await saveNote(job.settings.outDir, job.input.subject, job.edits?.date ?? localDate(job.audio!.recordedAt), title, markdown,
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
    const state = job.stages[stage] ?? { status: 'pending' } // 9/30 전 작업에는 polish 단계가 없다
    if (state.status === 'done' || state.status === 'skipped') continue
    job.stages[stage] = { status: 'running', startedAt: now(), ...(state.startedAt && { resumed: true }) }
    await saveJob(jobDir, job)
    try {
      if (ctx.signal?.aborted) throw new EngineError('cancelled', '작업을 취소했습니다.')
      ctx.onProgress?.(stage, 0) // 화면이 지금 단계를 알게 (로컬 LLM 다듬기·요약은 몇 분씩 걸린다)
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
