import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineError } from '../src/core/errors.ts'
import type { Job } from '../src/core/job.ts'
import { creditsFromTokens, estimateCredits90, parseModelList } from '../src/core/llmcatalog.ts'
import { creditsPer90ByModel } from '../src/core/providers.ts'
import { checkArgs, WhisperCpp } from '../src/core/stt/whispercpp.ts'
import { defaultArgs, parseArgs, previewCommand } from '../src/core/sttargs.ts'

test('기본 옵션은 스레드·반복 억제·탐색 폭·장치·VAD', () => {
  assert.equal(defaultArgs({ threads: 6, beamSize: 1, gpuDevice: 0, vad: true }).join(' '), '-t 6 -mc 0 -bs 1 -dev 0 --vad')
  assert.equal(defaultArgs({ threads: 2, gpuDevice: null, vad: false }).join(' '), '-t 2 -mc 0 -ng')
})

test('사용자 옵션은 공백으로 나누고, 앱이 정하는 옵션·경로·따옴표는 거절한다', () => {
  assert.deepEqual(parseArgs('  -t 4   -mc 0 -bs 5 --vad '), ['-t', '4', '-mc', '0', '-bs', '5', '--vad'])
  for (const bad of ['-m other.bin', '-l en', '--language=en', '-of out', '-otxt', '-vm x', '--file a.wav']) {
    assert.throws(() => parseArgs(bad), (e: EngineError) => e.code === 'input', bad)
  }
  assert.throws(() => parseArgs('-t 4 C:\\evil'), /경로/)
  assert.throws(() => parseArgs('-t "4"'), /따옴표/)
})

test('고친 옵션이 있으면 WhisperCpp는 기본 옵션 대신 쓰고, 파일·모델·언어·출력은 그대로 둔다', () => {
  const dir = join('C:', 'data')
  const engine = new WhisperCpp({ cli: ['whisper-cli'], model: join(dir, 'models', 'm.bin'), vadModel: join(dir, 'models', 'v.bin'), threads: 6, gpuDevice: 0 })
  const wav = join(dir, 'jobs', 'part_000.wav')
  const base = engine.command(wav, 'ko')
  assert.ok(base.includes('-dev') && base.includes('--vad') && base.includes('-vm'))

  engine.opts.args = ['-t', '2', '-ng', '-bs', '5']
  const cmd = engine.command(wav, 'en')
  assert.deepEqual(cmd.slice(cmd.indexOf('-np') + 1, cmd.indexOf('-vm')), ['-t', '2', '-ng', '-bs', '5'])
  assert.equal(cmd[cmd.indexOf('-l') + 1], 'en')
  assert.equal(cmd[cmd.indexOf('-f') + 1], 'part_000.wav')
  assert.ok(cmd.includes('-oj') && !cmd.includes('-dev') && !cmd.includes('--vad'))
})

test('checkArgs는 whisper-cli가 모르는 옵션을 이유와 함께 알려 준다', async () => {
  const cli = [process.execPath, join(import.meta.dirname, 'fixtures', 'fake-whisper-cli.mjs')]
  assert.equal(await checkArgs(cli, ['-t', '4', '-bs', '1']), null)
  assert.equal(await checkArgs(cli, ['-t', '4', '--bogus']), 'unknown argument: --bogus')
})

test('명령 미리보기는 잠긴 부분과 고칠 수 있는 부분으로 나뉜다', () => {
  const p = previewCommand('ggml-x.bin', 'ggml-v.bin', 'ko', ['-t', '6'])
  assert.equal(p.locked, 'whisper-cli -m models\\ggml-x.bin -f part_000.wav -l ko -oj -of part_000.wav -pp -np -vm models\\ggml-v.bin')
  assert.equal(p.editable, '-t 6')
})

test('모델 목록은 OpenAI 형식과 이름 배열을 모두 읽는다', () => {
  const data = {
    data: [
      { id: 'a', owned_by: 'openai', type: 'llm' },
      { id: 'img', owned_by: 'openai', type: 'image' },
      { id: 'b', type: 'llm' },
      { id: 'a', type: 'llm' },
      { id: 'tts', type: 'audio' }
    ]
  }
  assert.deepEqual(parseModelList(data), [{ id: 'a', owner: 'openai' }, { id: 'b', owner: null }]) // 이미지·음성 모델은 뺀다
  assert.deepEqual(parseModelList(['x', 'y']), [{ id: 'x', owner: null }, { id: 'y', owner: null }])
  assert.deepEqual(parseModelList({ models: [{ name: 'z' }] }), [{ id: 'z', owner: null }])
  assert.deepEqual(parseModelList({ nothing: true }), [])
})

test('모델별 90분 요약 크레딧은 기록을 90분으로 환산한 평균이고, 없으면 알려진 값', () => {
  const job = (model: string, credits: number | null, durationS: number, source: string | null = 'tokens'): Job =>
    ({ settings: { llm: { endpoint: '', model } }, cost: { summaryCredits: credits, ...(source && { source }) }, audio: { durationS } }) as unknown as Job
  const r = creditsPer90ByModel([job('m1', 6, 2700), job('m1', 10, 5400, 'balance'), job('m2', null, 5400), job('m3', 3, 30),
                                 job('m4', 9.44, 5400, null)])
  assert.equal(r['m1'], 11) // (12 + 10) / 2
  assert.equal(r['m2'], undefined) // 크레딧 기록 없음
  assert.equal(r['m3'], undefined) // 너무 짧은 녹음은 뺀다
  assert.equal(r['m4'], undefined) // 9/29 전 기록(잔액 차이, source 없음)은 쓰지 않는다
  assert.equal(r['gpt-6-luna'], 2.9) // 요약 모델 비교 2차 실측
})

test('단가표로 90분 요약 크레딧을 어림하고, 단가를 모르면 null', () => {
  assert.equal(estimateCredits90('gemini-3.8-flash'), 18) // 2차 비교 실측(90분 약 17크레딧)과 비슷
  assert.ok(estimateCredits90('gpt-6-luna')! < estimateCredits90('gemini-3.8-flash')!)
  assert.ok(estimateCredits90('gpt-6-sol')! > estimateCredits90('gemini-3.8-flash')!)
  assert.equal(estimateCredits90('모르는-모델'), null)
})

test('크레딧은 응답의 토큰 수 × 단가, 단가나 토큰 수를 모르면 null', () => {
  assert.equal(creditsFromTokens('gemini-3.8-flash', 12_073, 615), 11.36) // 요약 모델 비교 1차의 실제 차감
  assert.equal(creditsFromTokens('gpt-6-luna', 13_951, 1_667), 2.23)
  assert.equal(creditsFromTokens('모르는-모델', 1000, 100), null)
  assert.equal(creditsFromTokens('gpt-6-luna', undefined, 100), null)
})
