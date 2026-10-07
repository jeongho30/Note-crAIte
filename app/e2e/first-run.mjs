// 앱을 새 데이터 폴더로 띄워 첫 실행 마법사부터 노트 미리보기까지 눌러 본다 (요약 서비스 없이, 전사문만 담은 노트).
// 화면 흐름이 그 OS에서 실제로 도는지 보는 용도다: 마법사, 속도 재기, 폴더·파일 고르기, 작업 실행, 트레이, 미리보기.
// CI의 설치 파일 작업이 만든 앱으로 돌린다. 개발 중에는 `electron-vite build` 뒤 E2E_APP 없이 돌리면 저장소의 Electron으로 띄운다.
//
//   E2E_APP     만든 앱의 실행 파일 (없으면 개발 실행)
//   E2E_MODELS  받아쓰기 모델(ggml-small-q5_1.bin)과 VAD 모델이 있는 폴더. 데이터 폴더로 복사해 받는 시간을 줄인다
//   E2E_OUT     화면 캡처와 기록을 남길 폴더 (기본: 임시 폴더)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const APP_DIR = join(import.meta.dirname, '..')
const MODEL = 'small-q5_1'
const MODEL_FILES = [`ggml-${MODEL}.bin`, 'ggml-silero-v6.2.0.bin']
const work = mkdtempSync(join(tmpdir(), 'ln-e2e-'))
const out = process.env.E2E_OUT || join(work, 'out')
const dataDir = join(work, 'data')
const notesDir = join(work, '강의 노트') // 한글 경로도 함께 본다
const audio = join(work, '9.21 컴파일러 강의.wav') // 이름의 점과 한글
mkdirSync(out, { recursive: true })
mkdirSync(join(dataDir, 'models'), { recursive: true })
cpSync(join(APP_DIR, 'resources', 'probe-ko.wav'), audio)
if (process.env.E2E_MODELS) {
  for (const f of MODEL_FILES) cpSync(join(process.env.E2E_MODELS, f), join(dataDir, 'models', f))
}

const mainLog = []
let page
let shots = 0

async function shot(name) {
  const file = join(out, `${String(++shots).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

/** 화면 전체 (macOS의 메뉴 막대 아이콘까지). 못 찍어도 넘어간다 */
function screenShot(name) {
  if (process.platform !== 'darwin') return
  try {
    execFileSync('screencapture', ['-x', join(out, `screen-${name}.png`)])
  } catch (e) {
    console.log(`화면 전체를 찍지 못함: ${e.message}`)
  }
}

async function step(name, fn) {
  const started = Date.now()
  process.stdout.write(`· ${name} ... `)
  await fn()
  console.log(`됨 (${((Date.now() - started) / 1000).toFixed(1)}초)`)
}

const button = (name) => page.getByRole('button', { name, exact: true })

const launch = process.env.E2E_APP
  ? { executablePath: process.env.E2E_APP, args: [`--user-data-dir=${join(work, 'user-data')}`] }
  : { args: [APP_DIR, `--user-data-dir=${join(work, 'user-data')}`] }
const app = await electron.launch({ ...launch, env: { ...process.env, LN_DATA_DIR: dataDir }, timeout: 60_000 })
app.process().stderr?.on('data', (b) => mainLog.push(String(b)))
app.process().stdout?.on('data', (b) => mainLog.push(String(b)))

/** 파일·폴더 고르는 창은 누를 수 없어서, 메인 프로세스에서 고른 것처럼 답하게 한다 */
const answerDialog = (paths) =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)

try {
  page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && mainLog.push(`[화면] ${m.text()}\n`))
  page.on('pageerror', (e) => mainLog.push(`[화면 오류] ${e.message}\n`))

  await step('안내', async () => {
    await page.getByRole('heading', { name: '강의 녹음을 노트로 만들어 드려요' }).waitFor()
    await shot('welcome')
    await button('시작하기').click()
  })

  await step('받아쓰기 준비: 모델 고르고 속도 재기', async () => {
    await page.getByText('프로세서', { exact: true }).waitFor()
    await button('다른 모델 고르기').click()
    await page.locator('label', { hasText: '가볍게' }).click()
    // 모델이 데이터 폴더에 있으면 바로, 없으면 받는다
    const start = button('받기 시작')
    if (await start.isVisible().catch(() => false)) await start.click()
    await page.getByText('다 받았어요.').waitFor({ timeout: 600_000 })
    await page.getByText(/로 받아써요/).waitFor({ timeout: 300_000 })
    await shot('pc')
    await button('다음').click()
  })

  await step('요약 서비스: 요약 없이 계속', async () => {
    await page.getByRole('heading', { name: '요약에 쓸 서비스를 연결해 주세요' }).waitFor()
    await shot('provider')
    await button('요약 없이 계속').click()
  })

  await step('저장 폴더: 바꾸기', async () => {
    await page.getByRole('heading', { name: '노트를 저장할 폴더를 골라 주세요' }).waitFor()
    await shot('folder-default')
    await answerDialog([notesDir])
    await button('바꾸기').click()
    await page.waitForFunction((path) => [...document.querySelectorAll('input')].some((i) => i.value === path), notesDir)
    await button('다음').click()
  })

  await step('준비 완료', async () => {
    await page.getByRole('heading', { name: '준비됐어요' }).waitFor()
    await shot('ready')
    await button('첫 녹음 넣기').click()
  })

  await step('홈: 녹음 고르기 → 시작 전 확인 → 시작', async () => {
    await page.getByRole('heading', { name: '녹음 파일을 여기에 끌어 놓으세요' }).waitFor()
    await shot('home')
    await answerDialog([audio])
    await button('파일 고르기').click()
    await page.getByText('시작하기 전에 확인해 주세요').waitFor()
    await page.getByText('9.21 컴파일러 강의').first().waitFor()
    await shot('confirm')
    await button('시작').click()
  })

  await step('작업 목록: 끝날 때까지', async () => {
    await page.getByRole('navigation', { name: '메뉴' }).getByText('작업 목록').click()
    await shot('jobs-running')
    screenShot('running') // 메뉴 막대(트레이) 아이콘이 보여야 한다
    await button('노트 보기').waitFor({ timeout: 300_000 })
    await shot('jobs-done')
  })

  await step('노트 미리보기', async () => {
    await button('노트 보기').click()
    await page.getByText('전사문').first().waitFor()
    await shot('preview')
  })

  await step('저장된 노트 파일', async () => {
    const dir = join(notesDir, '미분류')
    const notes = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []
    if (notes.length !== 1) throw new Error(`노트가 하나여야 하는데 ${notes.length}개: ${dir}`)
    const text = readFileSync(join(dir, notes[0]), 'utf8')
    if (!text.includes('컴파일러') || !text.includes('전사문')) throw new Error(`노트에 전사문이 없음: ${notes[0]}`)
    console.log(`\n  ${notes[0]} (${text.length}자)`)
  })

  await step('설정 화면', async () => {
    await page.getByRole('navigation', { name: '메뉴' }).getByText('설정').click()
    await page.getByText(/로 받아써요/).first().waitFor()
    await shot('settings')
  })

  console.log('끝까지 됨')
} catch (e) {
  console.log(`\n실패: ${e.message}`)
  if (page) {
    await shot('fail').catch(() => {})
    console.log('--- 화면의 글 ---')
    console.log(await page.evaluate(() => document.body.innerText).catch(() => '(읽지 못함)'))
  }
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
  const logs = join(dataDir, 'logs')
  const appLog = existsSync(logs) ? readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('') : ''
  writeFileSync(join(out, 'app.log'), appLog)
  writeFileSync(join(out, 'main-output.txt'), mainLog.join(''))
  console.log('--- 앱 기록 ---')
  console.log(appLog.trim() || '(없음)')
  const noise = /DevTools listening|Debugger listening|For help, see|^\s*$/
  const errors = mainLog.join('').split('\n').filter((l) => !noise.test(l))
  if (errors.length) console.log('--- 메인 프로세스 출력 ---\n' + errors.slice(-40).join('\n'))
  console.log(`캡처와 기록: ${out}`)
}
