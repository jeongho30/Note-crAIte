// 요약 모델 고르기용 도구 (개발용 CLI). 키는 환경변수 LN_API_KEY로만 받는다.
//   llm models: ChatKHU 모델 목록 응답을 그대로 <데이터 폴더>/bench/chatkhu-models.json에 저장하고 이름을 출력한다.
//   llm bench:  끝난 작업의 정리된 전사로 모델마다 요약을 한 번씩 만들어 크레딧(잔액 차이)·시간·결과를 잰다.
// 결과에는 강의 내용이 들어가므로 저장소가 아니라 데이터 폴더의 bench/에 쓴다.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { transcriptText } from '../core/clean.ts'
import type { Cleaned } from '../core/clean.ts'
import * as corrections from '../core/corrections.ts'
import * as credits from '../core/credits.ts'
import { EngineError } from '../core/errors.ts'
import { writeJsonAtomic } from '../core/files.ts'
import { readNotes } from '../core/inputs.ts'
import { jobsDir, listJobs } from '../core/job.ts'
import type { Job } from '../core/job.ts'
import { headers, raiseForStatus, request } from '../core/llm.ts'
import { parseModelList } from '../core/llmcatalog.ts'
import { PRESETS } from '../core/providers.ts'
import { summarize } from '../core/summarize.ts'

const P = PRESETS['chatkhu']

function apiKey(): string {
  const key = process.env['LN_API_KEY']
  if (!key) throw new EngineError('auth', '환경변수 LN_API_KEY에 ChatKHU 키를 넣어 주세요.')
  return key
}

export async function models(dataDir: string): Promise<void> {
  const resp = await request(P.models!, { headers: headers(apiKey()) }, 15_000, '모델 목록')
  await raiseForStatus(resp, '모델 목록')
  const raw = await resp.json()
  const out = join(dataDir, 'bench', 'chatkhu-models.json')
  await mkdir(join(dataDir, 'bench'), { recursive: true })
  await writeJsonAtomic(out, raw)
  const items = parseModelList(raw)
  console.log(items.map((m) => `${m.id}${m.owner ? `  (${m.owner})` : ''}`).join('\n'))
  console.log(`\n글 모델 ${items.length}개 · 응답 전체: ${out}`)
}

/** 모델 이름이 없으면 받아쓰기·정리가 끝난 가장 최근 작업을 쓴다. */
async function pickJob(dataDir: string, id: string | undefined): Promise<Job> {
  const jobs = await listJobs(dataDir)
  const job = id ? jobs.find((j) => j.id === id) : jobs.filter((j) => j.stages.clean.status === 'done').at(-1)
  if (!job) throw new EngineError('input', id ? `작업이 없습니다: ${id}` : '받아쓰기가 끝난 작업이 없습니다.')
  if (job.stages.clean.status !== 'done') throw new EngineError('input', `받아쓰기·정리가 끝나지 않은 작업입니다: ${job.id}`)
  return job
}

async function remaining(key: string): Promise<number | null> {
  try {
    return credits.remaining(await credits.get(P.credits!, key))
  } catch {
    return null
  }
}

export type BenchRow = {
  model: string
  ok: boolean
  error?: string
  seconds: number
  credits: number | null
  credits90: number | null // 90분 강의로 환산
  parseFailed?: boolean
  summaryChars?: number
  keywords?: number
  corrections?: number // 전사에 실제로 있는 것만 고른 수
  inputTokens?: number | null
  outputTokens?: number | null
  usage?: unknown // 응답의 usage 원본 (추론 토큰·캐시 등)
}

/** 비교에 쓸 전사: 텍스트 파일(사람이 고친 전사 등)을 주면 그것, 아니면 작업의 정리된 전사. */
export type BenchInput = { job?: string; text?: string; notes?: string; subject?: string; minutes?: number }

async function loadInput(dataDir: string, o: BenchInput) {
  if (o.text) {
    return {
      label: o.text,
      text: (await readFile(o.text, 'utf8')).trim(),
      notes: o.notes ? await readNotes(o.notes) : '',
      subject: o.subject ?? null,
      durationS: o.minutes ? o.minutes * 60 : null
    }
  }
  const job = await pickJob(dataDir, o.job)
  const dir = join(jobsDir(dataDir), job.id)
  return {
    label: `작업 ${job.id}`,
    text: transcriptText(JSON.parse(await readFile(join(dir, 'cleaned.json'), 'utf8')) as Cleaned),
    notes: job.input.notes ? await readNotes(join(dir, job.input.notes)) : o.notes ? await readNotes(o.notes) : '',
    subject: o.subject ?? job.input.subject,
    durationS: job.audio?.durationS ?? (o.minutes ? o.minutes * 60 : null)
  }
}

export async function bench(dataDir: string, modelList: string[], input: BenchInput): Promise<void> {
  const key = apiKey()
  const { label, text, notes, subject, durationS } = await loadInput(dataDir, input)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = join(dataDir, 'bench', `summary-${stamp}`)
  await mkdir(outDir, { recursive: true })
  console.log(`${label} · ${durationS ? `${Math.round(durationS / 60)}분 녹음` : '길이 모름'} · 전사 ${text.length.toLocaleString()}자 · 필기 ${notes ? '있음' : '없음'}`)

  const rows: BenchRow[] = []
  for (const model of modelList) {
    process.stdout.write(`${model} ... `)
    const before = await remaining(key)
    const started = Date.now()
    let row: BenchRow
    try {
      const r = await summarize(text, notes, subject, { endpoint: P.endpoint, apiKey: key, model, fallbackTitle: '(제목 없음)' })
      const seconds = (Date.now() - started) / 1000
      await new Promise((res) => setTimeout(res, 1500)) // 차감이 잔액에 반영될 틈
      const after = await remaining(key)
      const used = before !== null && after !== null ? Math.round((before - after) * 100) / 100 : null
      row = {
        model,
        ok: true,
        seconds: Math.round(seconds * 10) / 10,
        credits: used,
        credits90: used !== null && durationS ? Math.round((used / durationS) * 5400 * 10) / 10 : null,
        parseFailed: r.parseFailed,
        summaryChars: r.summary.length,
        keywords: r.keywords.length,
        corrections: corrections.select(r.corrections, text).length,
        inputTokens: typeof r.usage?.prompt_tokens === 'number' ? r.usage.prompt_tokens : null,
        outputTokens: typeof r.usage?.completion_tokens === 'number' ? r.usage.completion_tokens : null,
        usage: r.usage
      }
      const md = [`# ${r.title}`, '', `모델: ${model} · ${row.seconds}초 · ${used ?? '?'}크레딧`, '', '## 요약', '', r.summary, '', '## 키워드', '', r.keywords.map((k) => `- ${k}`).join('\n'),
        '', '## 교정 목록 (고른 것)', '', corrections.select(r.corrections, text).map((c) => `- ${c.wrong} → ${c.right}`).join('\n')].join('\n')
      await writeFile(join(outDir, `${model.replace(/[^\w.-]+/g, '_')}.md`), md, 'utf8')
    } catch (e) {
      row = { model, ok: false, error: (e as Error).message.split('\n')[0], seconds: Math.round((Date.now() - started) / 100) / 10, credits: null, credits90: null }
    }
    rows.push(row)
    const tokens = row.inputTokens != null ? ` · 토큰 입력 ${row.inputTokens.toLocaleString()} 출력 ${row.outputTokens?.toLocaleString()}` : ''
    console.log(row.ok ? `${row.seconds}초 · ${row.credits ?? '?'}크레딧 (90분 환산 ${row.credits90 ?? '?'})${tokens}` : `실패: ${row.error}`)
  }
  await writeJsonAtomic(join(outDir, 'results.json'), { input: label, durationS, transcriptChars: text.length, rows })
  console.log(`\n결과: ${join(outDir, 'results.json')} (모델별 요약은 같은 폴더의 .md)`)
}
