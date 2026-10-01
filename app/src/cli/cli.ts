// 개발용 명령줄: 노트 만들기(run/resume), 모델 다운로드, S3 벤치, 요약 모델 비교. 앱과 같은 src/core 코드를 Node로 바로 실행한다 (빌드 없음).
//   node app/src/cli/cli.ts run <녹음> --out <저장 폴더> [--subject 과목]
//   node app/src/cli/cli.ts models download small-q5_1 silero-v6.2.0
//   node app/src/cli/cli.ts bench --audio <녹음> --ref <기준 JSON> --config wcpp:small-q5_1:cpu
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { probe as probeAudio } from '../core/audio.ts'
import { ensureModel } from '../core/downloads.ts'
import { EngineError } from '../core/errors.ts'
import { defaultThreads, detect } from '../core/hardware.ts'
import { findNotes } from '../core/inputs.ts'
import { createJob, DEFAULT_BEAM_SIZE, DEFAULT_MODEL, jobsDir, listJobs, runJob, VAD_MODEL } from '../core/job.ts'
import type { JobContext, LlmSettings, StageName } from '../core/job.ts'
import { MODELS } from '../core/models.ts'
import { defaultDataDir, findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { writeJsonAtomic } from '../core/files.ts'
import { estimateSttSeconds, probeDevices, sttSpeed } from '../core/probe.ts'
import type { ProbeResult } from '../core/probe.ts'
import { PRESETS } from '../core/providers.ts'
import { run as bench } from './bench.ts'
import * as llm from './llmbench.ts'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

const USAGE = `사용법:
  cli.ts [--data-dir D] [--bin-dir B] run <녹음> --out <저장 폴더> [--subject 과목] [--notes 필기]
         [--lang ko] [--model large-v3-turbo-q8_0] [--device auto|cpu|gpu0] [--threads N]
         [--verify-model 모델] [--polish 다듬기 모델]
         auto는 probe 결과(장치, 예상 시간)를 쓴다. probe를 안 했으면 CPU.
         필기를 주지 않으면 녹음 옆의 같은 이름 .md/.txt를 쓴다. 환경변수 LN_API_KEY(ChatKHU 키)가 없으면 요약 없이 전사만 담는다.
  cli.ts [--data-dir D] [--bin-dir B] resume <작업 ID>
  cli.ts [--data-dir D] jobs
  cli.ts [--data-dir D] [--bin-dir B] probe [--sample 16kHz 모노 WAV] [--threads N]
         CPU와 GPU마다 샘플을 돌려 쓸 장치와 속도를 정하고 <데이터 폴더>/probe.json에 남긴다.
  cli.ts [--data-dir D] [--bin-dir B] models download <이름...>
  cli.ts [--data-dir D] [--bin-dir B] bench --audio A [--ref R] --config 엔진:모델:장치 [--config ...]
         [--start 초] [--duration 초] [--threads N] [--lang ko] [--chunk-s 600] [--python P]
         엔진: wcpp(whisper.cpp) | fw(faster-whisper, tools/.venv 필요). 장치: cpu | gpu0 | gpu1 ...
  cli.ts [--data-dir D] llm models
         ChatKHU 모델 목록 (환경변수 LN_API_KEY). 응답 전체는 <데이터 폴더>/bench/chatkhu-models.json
  cli.ts [--data-dir D] llm bench --models a,b,c [--job 작업 ID | --text 전사.txt --minutes 90] [--notes 필기] [--subject 과목]
         전사로 모델마다 요약을 한 번씩 만들어 크레딧·시간·토큰을 잰다(모델마다 크레딧이 든다).
         --text(사람이 고친 전사 등)가 없으면 작업의 정리된 전사, 작업도 없으면 받아쓰기가 끝난 가장 최근 작업.
         결과는 <데이터 폴더>/bench/summary-<시각>/`

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
      device: { type: 'string', default: 'auto', description: 'auto | cpu | gpu0 | gpu1 ...' },
      sample: { type: 'string', default: join(REPO, 'app', 'resources', 'probe-ko.wav') },
      models: { type: 'string' },
      job: { type: 'string' },
      text: { type: 'string' },
      minutes: { type: 'string' },
      'verify-model': { type: 'string', description: '요약 뒤 교정 검증 모델(실험용, 앱은 쓰지 않음). 없으면 검증하지 않음' },
      polish: { type: 'string', description: '전사문 다듬기 모델 (없으면 다듬지 않음)' }
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
    const probed = await loadProbe(dataDir, v.model!)
    let gpuDevice: number | null
    if (v.device === 'auto') gpuDevice = probed?.gpuDevice ?? null
    else gpuDevice = v.device === 'cpu' ? null : Number(v.device!.replace('gpu', ''))
    const threads = v.threads ? Number(v.threads) : probed?.threads ?? defaultThreads(await detect())
    const { durationS } = await probeAudio(findFfmpeg(binDir), sub)
    if (probed && durationS && gpuDevice === probed.gpuDevice) {
      const minutes = Math.ceil(estimateSttSeconds(durationS, sttSpeed(probed, await listJobs(dataDir), null)) / 60)
      console.log(`녹음 ${Math.round(durationS / 60)}분 · ${gpuDevice === null ? 'CPU' : `GPU ${gpuDevice}`} · 예상 전사 시간 약 ${minutes}분`)
    } else if (!probed) {
      console.log('예상 시간은 probe를 한 번 돌리면 보입니다.')
    }
    const jobDir = await createJob(dataDir, resolve(sub), notes ? resolve(notes) : null, v.subject ?? null, {
      language: v.lang!,
      model: v.model!,
      beamSize: DEFAULT_BEAM_SIZE,
      gpuDevice,
      threads,
      outDir: resolve(v.out),
      llm,
      verifyModel: v['verify-model'] ?? null,
      polishModel: v.polish ?? null
    })
    console.log(`작업 ${jobDir}${notes ? ` · 필기 ${notes}` : ''}`)
    await runAndReport(jobDir, jobContext(dataDir, binDir, whisperDirs, apiKey))
  } else if (cmd === 'resume' && sub) {
    await runAndReport(join(jobsDir(dataDir), sub), jobContext(dataDir, binDir, whisperDirs, process.env['LN_API_KEY'] || null))
  } else if (cmd === 'probe') {
    if (!existsSync(v.sample!)) throw new EngineError('input', `감지용 샘플이 없습니다: ${v.sample} (--sample로 지정)`)
    const modelsDir = join(dataDir, 'models')
    const result = await probeDevices({
      cli: [findWhisperCli(whisperDirs)],
      model: await ensureModel('whisper', v.model!, modelsDir, progressPrinter(`${v.model} 받는 중`)),
      modelName: v.model!,
      vadModel: await ensureModel('vad', VAD_MODEL, modelsDir),
      threads: v.threads ? Number(v.threads) : defaultThreads(await detect()),
      beamSize: DEFAULT_BEAM_SIZE,
      language: v.lang!,
      sample: v.sample!,
      workDir: join(dataDir, 'probe'),
      onTrial: (name) => console.log(`${name} 확인 중...`)
    })
    for (const t of result.trials) {
      const speed = t.ok ? `처리 ${(t.processMs / 1000).toFixed(1)}초 · 로드 ${(t.loadMs / 1000).toFixed(1)}초 · ${t.chars}자` : t.reason
      console.log(`  ${t.device === null ? 'CPU' : `GPU ${t.device}`} ${t.name}: ${speed}`)
    }
    const choice = result.gpuDevice === null ? 'CPU' : `GPU ${result.gpuDevice}`
    console.log(`선택: ${choice} · 90분 강의 예상 전사 시간 약 ${Math.ceil(estimateSttSeconds(5400, sttSpeed(result, [], null)) / 60)}분`)
    await writeJsonAtomic(join(dataDir, 'probe.json'), result)
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
  } else if (cmd === 'llm' && sub === 'models') {
    await llm.models(dataDir)
  } else if (cmd === 'llm' && sub === 'bench' && v.models) {
    await llm.bench(dataDir, v.models.split(',').map((m) => m.trim()).filter(Boolean), {
      job: v.job, text: v.text, notes: v.notes, subject: v.subject, minutes: v.minutes ? Number(v.minutes) : undefined
    })
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

/** 같은 모델로 잰 probe 결과가 있으면 돌려준다. */
async function loadProbe(dataDir: string, model: string): Promise<ProbeResult | null> {
  try {
    const p = JSON.parse(await readFile(join(dataDir, 'probe.json'), 'utf8')) as ProbeResult
    return p.model === model ? p : null
  } catch {
    return null
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
  const c = job.cost
  const credits = [
    c?.summaryCredits != null ? ` · 요약 ${c.summaryCredits}크레딧` : '',
    c?.verifyCredits != null ? ` · 교정 검증 ${c.verifyCredits}크레딧` : '',
    c?.polishCredits != null ? ` · 전사문 다듬기 ${c.polishCredits}크레딧` : ''
  ].join('')
  console.log(`\n완료 (${Math.round((Date.now() - started) / 1000)}초${credits}): ${job.output!.notePath}`)
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (!(e instanceof EngineError)) throw e
  console.error(`\n[오류] ${e.message}`)
  process.exitCode = 1
})
