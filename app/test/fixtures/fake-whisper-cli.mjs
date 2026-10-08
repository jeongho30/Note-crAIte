// 테스트용 가짜 whisper-cli: stdout으로 대량 출력, stderr로 진행률, -of 경로에 JSON을 쓴다.
import { existsSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = process.env.FAKE_WHISPER_MODE ?? 'ok'

// 실제 whisper-cli처럼 옵션을 먼저 읽고(모르는 옵션은 오류, 종료 코드 0), 그다음 입력 파일을 찾는다
const unknown = args.find((a) => a === '--bogus')
if (unknown) {
  process.stderr.write(`error: unknown argument: ${unknown}\n`)
  process.exit(0)
}
if (args.includes('-f') && !existsSync(args[args.indexOf('-f') + 1])) {
  process.stderr.write(`error: input file not found '${args[args.indexOf('-f') + 1]}'\n`)
  process.exit(2)
}

if (mode === 'fail') {
  process.stderr.write('error: failed to load model\n')
  process.exit(3)
}
// metal-hang: GPU로 돌리면 멈춰 버리고 CPU(-ng)로는 된다
if (mode === 'hang' || (mode === 'metal-hang' && !args.includes('-ng'))) {
  setTimeout(() => {}, 60_000)
} else {
  // 실제 whisper-cli처럼 전사 구간을 stdout으로 대량 출력한다 (어댑터가 파이프를 안 비우면 여기서 멈춘다).
  process.stdout.write(('[00:00:00.000 --> 00:00:01.000]  가나다라마바사아자차카타파하 '.repeat(10) + '\n').repeat(2000))
  for (let p = 0; p <= 100; p += 5) {
    process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`)
  }
  if (mode === 'metal' || mode === 'metal-hang') {
    // macOS의 whisper-cli 로그 (whisper.cpp 소스의 문구): Metal로 돌면 MTL0, -ng면 GPU 없이 BLAS(CPU 쪽 가속)
    const gpu = !args.includes('-ng')
    process.stderr.write(
      [
        ...(gpu
          ? ['ggml_metal_device_init: GPU name:   MTL0 (Apple M2)', 'whisper_backend_init_gpu: using MTL0 backend']
          : ['whisper_backend_init_gpu: no GPU found']),
        'whisper_backend_init: using BLAS backend',
        'whisper_print_timings:     load time =   300.00 ms',
        `whisper_print_timings:    total time =  ${gpu ? '1300.00' : '9300.00'} ms`
      ].join('\n') + '\n'
    )
  }
  const out = args[args.indexOf('-of') + 1] + '.json'
  const data = {
    transcription: [
      { offsets: { from: 0, to: 1500 }, text: ' 안녕하세요' },
      { offsets: { from: 1500, to: 1600 }, text: '  ' },
      { offsets: { from: 2000, to: 3000 }, text: ' 강의를 시작합니다' }
    ]
  }
  writeFileSync(out, JSON.stringify(data), 'utf8')
}
