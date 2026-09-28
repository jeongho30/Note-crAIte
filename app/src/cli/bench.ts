// S3: STT 엔진·모델·장치별 속도(RTF)와 기준 전사 대비 CER 비교.
// 결과에는 강의 전사가 들어가므로 저장소가 아니라 데이터 폴더의 bench/ 아래에만 쓴다.
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareLocal } from '../core/audio.ts'
import { ensureModel } from '../core/downloads.ts'
import { cer, normalize } from '../core/compare.ts'
import { EngineError } from '../core/errors.ts'
import { readJson, writeJsonAtomic } from '../core/files.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { runCapture } from '../core/proc.ts'
import { transcribeChunks } from '../core/stt/base.ts'
import type { Segment } from '../core/stt/base.ts'
import { backendUsed, parseWhisperJson, WhisperCpp } from '../core/stt/whispercpp.ts'
import { wavDuration } from '../core/wav.ts'

const FIELDS = ['config', 'engine', 'model', 'device', 'backend', 'threads', 'audio_s', 'prep_s', 'stt_s', 'rtf', 'cer', 'chars'] as const

export type BenchArgs = {
  audio: string
  ref?: string
  start: number
  duration?: number
  configs: string[] // 엔진:모델:장치[:bsN]. 예) wcpp:small-q5_1:cpu, wcpp:large-v3-turbo-q8_0:cpu:bs1(greedy), fw:small:cpu
  threads?: number
  lang: string
  chunkS: number
  dataDir: string
  binDir?: string
  whisperDirs: string[]
  python: string // fw 설정용 (faster-whisper가 설치된 Python)
  fwScript: string
}

export function textInRange(segments: Segment[], startMs: number, endMs: number): string {
  return segments.filter((s) => startMs <= s.startMs && s.startMs < endMs).map((s) => s.text).join(' ')
}


function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function runWcpp(model: string, device: string, beam: number | undefined, sample: string, work: string, a: BenchArgs,
                       threads: number): Promise<{ prepS: number; segments: Segment[]; backend: string }> {
  const modelsDir = join(a.dataDir, 'models')
  const engine = new WhisperCpp({
    cli: [findWhisperCli(a.whisperDirs)],
    model: await ensureModel('whisper', model, modelsDir),
    vadModel: await ensureModel('vad', 'silero-v6.2.0', modelsDir),
    threads,
    gpuDevice: device === 'cpu' ? null : Number(device.replace(/^gpu/, '')),
    beamSize: beam,
    quiet: false
  })
  const t0 = performance.now()
  const chunks = await prepareLocal(findFfmpeg(a.binDir), sample, work, a.chunkS)
  const prepS = (performance.now() - t0) / 1000
  const segments = await transcribeChunks(engine, chunks, join(work, 'chunks'), join(work, 'stt'), {
    language: a.lang,
    onProgress: (f) => process.stdout.write(`\r  ${(f * 100).toFixed(1).padStart(5)}%`)
  })
  process.stdout.write('\n')
  return { prepS, segments, backend: backendUsed(engine.lastLog) }
}

async function runFw(model: string, device: string, sample: string, work: string, a: BenchArgs,
                     threads: number): Promise<Segment[]> {
  if (device !== 'cpu') throw new EngineError('input', 'faster-whisper 벤치는 CPU만 지원합니다 (NVIDIA는 W3에 실측).')
  await mkdir(work, { recursive: true })
  const out = join(work, 'fw.json')
  const r = await runCapture(a.python, [a.fwScript, '--audio', sample, '--model', model, '--threads', String(threads),
    '--lang', a.lang, '--model-dir', join(a.dataDir, 'models', 'faster-whisper'), '--out', out], 'bench')
  if (r.code !== 0) throw new EngineError('stt_failed', `faster-whisper 실행 실패:\n${r.stderr.slice(-2000)}`)
  return readJson<Segment[]>(out)
}

export async function run(a: BenchArgs): Promise<void> {
  const hw = await detect()
  const threads = a.threads ?? defaultThreads(hw)
  const ffmpeg = findFfmpeg(a.binDir)
  const outDir = join(a.dataDir, 'bench', stamp())
  await mkdir(outDir, { recursive: true })

  const sample = join(outDir, 'sample.wav')
  const cut = ['-ss', String(a.start), ...(a.duration ? ['-t', String(a.duration)] : [])]
  const r = await runCapture(ffmpeg, ['-y', ...cut, '-i', a.audio, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', sample], 'ffmpeg')
  if (r.code !== 0) throw new EngineError('ffmpeg', `샘플 추출 실패:\n${r.stderr.slice(-2000)}`)
  const audioS = await wavDuration(sample)

  let refText: string | null = null
  if (a.ref) {
    const startMs = a.start * 1000
    refText = textInRange(await parseWhisperJson(a.ref), startMs, startMs + audioS * 1000)
  }

  await writeJsonAtomic(join(outDir, 'meta.json'), {
    ...hw, threads, audio: a.audio, start_s: a.start, audio_s: audioS, chunk_s: a.chunkS, configs: a.configs
  })
  console.log(`샘플 ${(audioS / 60).toFixed(1)}분, 스레드 ${threads}, 결과: ${outDir}`)

  const csv = join(outDir, 'results.csv')
  await writeFile(csv, FIELDS.join(',') + '\n', 'utf8')
  for (const [i, config] of a.configs.entries()) {
    const [engine, model, device, opt] = config.split(':')
    const beam = opt?.startsWith('bs') ? Number(opt.slice(2)) : undefined
    console.log(`[${i + 1}/${a.configs.length}] ${config}`)
    const work = join(outDir, `work-${String(i).padStart(2, '0')}`)
    const t0 = performance.now()
    let prepS = 0
    let segments: Segment[]
    let backend = 'CPU'
    if (engine === 'wcpp') ({ prepS, segments, backend } = await runWcpp(model, device, beam, sample, work, a, threads))
    else if (engine === 'fw') segments = await runFw(model, device, sample, work, a, threads)
    else throw new EngineError('input', `모르는 엔진입니다: ${engine} (wcpp 또는 fw)`)
    const sttS = (performance.now() - t0) / 1000 - prepS
    await rm(work, { recursive: true, force: true })

    const hyp = segments.map((s) => s.text).join(' ')
    const stem = `${String(i).padStart(2, '0')}-${config.replaceAll(':', '_')}`
    await writeFile(join(outDir, `${stem}.txt`), hyp, 'utf8')
    await writeJsonAtomic(join(outDir, `${stem}.json`), segments)
    const row: Record<(typeof FIELDS)[number], string | number> = {
      config, engine, model, device, backend, threads,
      audio_s: audioS.toFixed(1), prep_s: prepS.toFixed(1), stt_s: sttS.toFixed(1),
      rtf: (sttS / audioS).toFixed(3),
      cer: refText !== null ? cer(refText, hyp).toFixed(4) : '',
      chars: normalize(hyp).length
    }
    await appendFile(csv, FIELDS.map((f) => row[f]).join(',') + '\n', 'utf8')
    console.log(`  STT ${sttS.toFixed(0)}초 (RTF ${row.rtf}), CER ${row.cer}`)
  }
}
