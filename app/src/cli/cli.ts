// 개발용 명령줄: 모델 다운로드와 S3 벤치. 앱과 같은 src/core 코드를 Node로 바로 실행한다 (빌드 없음).
//   node app/src/cli/cli.ts models download small-q5_1 silero-v6.2.0
//   node app/src/cli/cli.ts bench --audio <녹음> --ref <기준 JSON> --config wcpp:small-q5_1:cpu
// run/resume은 M1에서 붙인다.
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureModel } from '../core/downloads.ts'
import { EngineError } from '../core/errors.ts'
import { MODELS } from '../core/models.ts'
import { defaultDataDir } from '../core/paths.ts'
import { run as bench } from './bench.ts'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

const USAGE = `사용법:
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
      python: { type: 'string', default: join(REPO, 'tools', '.venv', 'Scripts', 'python.exe') }
    }
  })
  const dataDir = v['data-dir'] ?? defaultDataDir()
  const binDir = v['bin-dir']
  const [cmd, sub, ...rest] = positionals

  if (cmd === 'models' && sub === 'download' && rest.length) {
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
      whisperDirs: [...(binDir ? [join(binDir, 'whisper')] : []), join(REPO, '.cache', 'whisper', 'bin')],
      python: v.python!,
      fwScript: join(REPO, 'tools', 'fw_transcribe.py')
    })
  } else {
    console.error(USAGE)
    process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (!(e instanceof EngineError)) throw e
  console.error(`\n[오류] ${e.message}`)
  process.exitCode = 1
})
