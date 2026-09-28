// 개발용 명령줄: 노트 만들기(run/resume), 모델 다운로드, S3 벤치. 앱과 같은 src/core 코드를 Node로 바로 실행한다 (빌드 없음).
//   node app/src/cli/cli.ts run <녹음> --out <저장 폴더> [--subject 과목]
//   node app/src/cli/cli.ts models download small-q5_1 silero-v6.2.0
//   node app/src/cli/cli.ts bench --audio <녹음> --ref <기준 JSON> --config wcpp:small-q5_1:cpu
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureModel } from '../core/downloads.ts'
import { EngineError } from '../core/errors.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { findNotes } from '../core/inputs.ts'
import { createJob, DEFAULT_BEAM_SIZE, DEFAULT_MODEL, jobsDir, listJobs, runJob } from '../core/job.ts'
import type { JobContext, LlmSettings, StageName } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { defaultDataDir, findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { PRESETS } from '../core/providers.ts'
import { run as bench } from './bench.ts'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

const USAGE = `사용법:
  cli.ts [--data-dir D] [--bin-dir B] run <녹음> --out <저장 폴더> [--subject 과목] [--notes 필기]
         [--lang ko] [--model large-v3-turbo-q8_0] [--device cpu|gpu0] [--threads N]
         필기를 주지 않으면 녹음 옆의 같은 이름 .md/.txt를 쓴다. 환경변수 LN_API_KEY(ChatKHU 키)가 없으면 요약 없이 전사만 담는다.
  cli.ts [--data-dir D] [--bin-dir B] resume <작업 ID>
  cli.ts [--data-dir D] jobs
  cli.ts [--data-dir D] [--bin-dir B] models download <이름...>
  cli.ts [--data-dir D] [--bin-dir B] bench --audio A [--ref R] --config 엔진:모델:장치 [--config ...]
         [--start 초] [--duration 초] [--threads N] [--lang ko] [--chunk-s 600] [--python P]
         엔진: wcpp(whisper.cpp) | fw(faster-whisper, tools/.venv 필요). 장치: cpu | gpu0 | gpu1 ...`

function progressPrinter(label: string): (done: number, total: number) => void {
  let last = -1
  return (done, total) => {
    const pct = total ? Math.floor((done * 100) / total) : 0
    if (pct !== last) {
      last = pct
      process.stdout.write(`\r${label}: ${pct}% (${(done / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)}MB)`)
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      'bin-dir': { type: 'string', description: 'ffmpeg·whisper 실행 파일 폴더 (설치본의 resources/bin)' },
      audio: { type: 'string' },
      ref: { type: 'string', description: '기준 전사 (whisper JSON)' },
      start: { type: 'string', default: '0' },
      duration: { type: 'string' },
      config: { type: 'string', multiple: true },
      threads: { type: 'string', description: '기본: 물리 코어 - 2' },
      lang: { type: 'string', default: 'ko' },
      'chunk-s': { type: 'string', default: '600', description: 'whisper.cpp 조각 길이 (초). 0이면 나누지 않음' },
      python: { type: 'string', default: join(REPO, 'tools', '.venv', 'Scripts', 'python.exe') },
      out: { type: 'string', description: '노트를 저장할 폴더 (과목별 하위 폴더가 생김)' },
      subject: { type: 'string' },
      notes: { type: 'string' },
      model: { type: 'string', default: DEFAULT_MODEL },
      device: { type: 'string', default: 'cpu', description: 'cpu | gpu0 | gpu1 ...' }
    }
  })
  const dataDir = v['data-dir'] ?? defaultDataDir()
  const binDir = v['bin-dir']
  const whisperDirs = [...(binDir ? [join(binDir, 'whisper')] : []), join(REPO, '.cache', 'whisper', 'bin')]
  const [cmd, sub, ...rest] = positionals

  if (cmd === 'run' && sub && v.out) {
    const apiKey = process.env['LN_API_KEY'] || null
    const chatkhu = PRESETS['chatkhu']
    const llm: LlmSettings | null = apiKey ? { endpoint: chatkhu.endpoint, model: chatkhu.model, creditsUrl: chatkhu.credits } : null
    if (!llm) console.log('LN_API_KEY가 없어 요약 없이 전사만 담은 노트를 만듭니다.')
    if (!existsSync(sub)) throw new EngineError('input', `녹음 파일이 없습니다: ${sub}`)
    const notes = v.notes ?? findNotes(sub)
    const jobDir = await createJob(dataDir, resolve(sub), notes ? resolve(notes) : null, v.subject ?? null, {
      language: v.lang!,
      model: v.model!,
      beamSize: DEFAULT_BEAM_SIZE,
      gpuDevice: v.device === 'cpu' ? null : Number(v.device!.replace('gpu', '')),
      threads: v.threads ? Number(v.threads) : defaultThreads(await detect()),
      outDir: resolve(v.out),
      llm
    })
    console.log(`작업 ${jobDir}${notes ? ` · 필기 ${notes}` : ''}`)
    await runAndReport(jobDir, jobContext(dataDir, binDir, whisperDirs, apiKey))
  } else if (cmd === 'resume' && sub) {
    await runAndReport(join(jobsDir(dataDir), sub), jobContext(dataDir, binDir, whisperDirs, process.env['LN_API_KEY'] || null))
  } else if (cmd === 'jobs') {
    for (const j of await listJobs(dataDir)) {
      const detail = j.error ? `${j.error.stage}: ${j.error.message.split('\n')[0]}` : j.output?.notePath ?? ''
      console.log(`${j.id}  ${j.status.padEnd(9)}  ${detail}`)
    }
  } else if (cmd === 'models' && sub === 'download' && rest.length) {
    for (const name of rest) {
      const kind = name in MODELS.vad ? 'vad' : 'whisper'
      const path = await ensureModel(kind, name, join(dataDir, 'models'), progressPrinter(name))
      console.log(`\n${name}: ${path}`)
    }
  } else if (cmd === 'bench' && v.audio && v.config?.length) {
    await bench({
      audio: v.audio,
      ref: v.ref,
      start: Number(v.start),
      duration: v.duration ? Number(v.duration) : undefined,
      configs: v.config,
      threads: v.threads ? Number(v.threads) : undefined,
      lang: v.lang!,
      chunkS: Number(v['chunk-s']),
      dataDir,
      binDir,
      whisperDirs,
      python: v.python!,
      fwScript: join(REPO, 'tools', 'fw_transcribe.py')
    })
  } else {
    console.error(USAGE)
    process.exitCode = 2
  }
}

function jobContext(dataDir: string, binDir: string | undefined, whisperDirs: string[], apiKey: string | null): JobContext {
  let shown = ''
  return {
    ffmpeg: findFfmpeg(binDir),
    whisperCli: [findWhisperCli(whisperDirs)],
    modelPath: (kind, name) => ensureModel(kind, name, join(dataDir, 'models'), progressPrinter(`${name} 받는 중`)),
    apiKey,
    onProgress: (stage: StageName, frac: number) => {
      const line = `[${stage}] ${Math.floor(frac * 100)}%`
      if (line !== shown) process.stdout.write(`\r${(shown = line)}${frac >= 1 ? '\n' : ''}`)
    }
  }
}

async function runAndReport(jobDir: string, ctx: JobContext): Promise<void> {
  const started = Date.now()
  const job = await runJob(jobDir, ctx)
  const credits = job.cost?.summaryCredits != null ? ` · 요약 ${job.cost.summaryCredits}크레딧` : ''
  console.log(`\n완료 (${Math.round((Date.now() - started) / 1000)}초${credits}): ${job.output!.notePath}`)
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (!(e instanceof EngineError)) throw e
  console.error(`\n[오류] ${e.message}`)
  process.exitCode = 1
})
