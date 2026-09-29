// 설치본에 넣는 오픈소스 고지(build/THIRD_PARTY_NOTICES.txt)를 만든다. dist:win이 electron-builder 앞에서 부른다.
// 화면 번들에 들어가는 npm 패키지는 node_modules에서 라이선스 전문을 읽고, 함께 배포하는 실행 파일·글꼴·모델은 아래 목록으로 적는다.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const APP = join(import.meta.dirname, '..')
const REPO = join(APP, '..')
const OUT = join(APP, 'build', 'THIRD_PARTY_NOTICES.txt')

// 화면 번들(out/renderer)에 들어가는 패키지. 메인·preload는 Node·Electron 기능만 쓴다.
const ROOTS = ['react', 'react-dom', 'markdown-it', 'markdown-it-cjk-friendly']
// markdown-it의 argparse는 명령줄 도구에서만 써서 번들에 들어가지 않는다
const SKIP = new Set(['argparse'])

function pkgDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return p
    if (dirname(dir) === dir) throw new Error(`패키지를 찾지 못함: ${name}`)
  }
}

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^licen[cs]e(-mit)?(\.md|\.txt)?$/i.test(n))
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null
}

const seen = new Map()
function walk(name, from) {
  if (SKIP.has(name) || seen.has(name)) return
  const dir = pkgDir(name, from)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  seen.set(name, { version: pkg.version, license: pkg.license, text: licenseText(dir) })
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir)
}
for (const r of ROOTS) walk(r, APP)

const read = (p) => readFileSync(p, 'utf8').trim()
const rule = '='.repeat(72)
const parts = [
  `NotecrAIte 오픈소스 고지 (Third-party notices)

이 프로그램은 아래 오픈소스 소프트웨어를 포함하거나 실행 중에 내려받는다. 각 항목의 라이선스를 따른다.
Electron과 Chromium의 고지는 설치 폴더의 LICENSE.electron.txt, LICENSES.chromium.html에 있다.`
]

parts.push(`whisper.cpp / ggml (resources/bin/whisper) — MIT
https://github.com/ggml-org/whisper.cpp

${read(join(REPO, '.cache', 'whisper', 'bin', 'LICENSE-whisper.cpp.txt'))}`)

parts.push(`FFmpeg (resources/bin/ffmpeg.exe) — LGPL v2.1 이상
라이선스 전문: resources/bin/LICENSE-ffmpeg.txt

${read(join(REPO, '.cache', 'ffmpeg', 'bin', 'FFMPEG-SOURCE.txt'))}`)

parts.push(`Microsoft Visual C++ 런타임 (resources/bin/whisper의 msvcp140*.dll, vcruntime140*.dll, vcomp140.dll, concrt140.dll, vccorlib140.dll)
Visual Studio의 재배포 가능 파일(Redistributable)로, Microsoft 소프트웨어 사용 조건에 따라 함께 배포한다.`)

parts.push(`Pretendard (화면 글꼴) — SIL Open Font License 1.1
https://github.com/orioncactus/pretendard

${read(join(APP, 'src', 'renderer', 'src', 'assets', 'fonts', 'LICENSE-Pretendard.txt'))}`)

parts.push(`실행 중에 내려받는 모델 (설치 파일에는 없음)
- Whisper 모델 가중치 — MIT, OpenAI (https://github.com/openai/whisper)
- ggml 형식으로 바꾼 Whisper 모델 — MIT, https://huggingface.co/ggerganov/whisper.cpp
- Silero VAD — MIT, https://github.com/snakers4/silero-vad (ggml 형식: https://huggingface.co/ggml-org/whisper-vad)`)

for (const [name, p] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
  if (!p.text) throw new Error(`라이선스 파일이 없음: ${name}`)
  parts.push(`${name} ${p.version} — ${p.license}\n\n${p.text}`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, parts.join(`\n\n${rule}\n\n`) + '\n')
console.log(`${OUT}: npm 패키지 ${seen.size}개 (${[...seen.keys()].join(', ')})`)
