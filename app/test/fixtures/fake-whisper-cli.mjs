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
if (mode === 'hang') {
  setTimeout(() => {}, 60_000)
} else {
  // 실제 whisper-cli처럼 전사 구간을 stdout으로 대량 출력한다 (어댑터가 파이프를 안 비우면 여기서 멈춘다).
  process.stdout.write(('[00:00:00.000 --> 00:00:01.000]  가나다라마바사아자차카타파하 '.repeat(10) + '\n').repeat(2000))
  for (let p = 0; p <= 100; p += 5) {
    process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`)
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
