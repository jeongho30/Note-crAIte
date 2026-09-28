# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

lecture-notes: 강의 녹음(+선택적 필기 .md/.txt)을 요약·주요 키워드·전사문이 담긴 마크다운 노트로 만드는 PC 설치형 앱 (ChatKHU 공모전, 마감 2026-10-24). Electron + TypeScript 하나로 만든다(`app/`). 무거운 일은 외부 실행 파일(whisper-cli, ffmpeg)이 하고, 메인 프로세스의 `src/core/`가 그것들을 부르고 HTTP·텍스트 처리를 한다. 결정과 실험 결과는 `docs/decisions.md`에 적는다.

처리 코드의 상당 부분은 작성자의 개인용 Python 파이프라인 `C:\ljh\Coding\STT_AutoLectureNote\pipeline\`에서 옮겨 왔다. 그 폴더는 따로 계속 쓰이므로 여기서 수정하지 않는다.

## Commands

모두 `app/`에서 실행한다. Node 24 이상이 TypeScript를 빌드 없이 바로 실행한다(type stripping).

```bash
npm ci
```

```bash
npm test
```

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-name-pattern "planChunks" "test/**/*.test.ts"
```

```bash
npm run typecheck
```

```bash
npm run cli -- run <녹음> --out <저장 폴더> [--subject 과목] [--device gpu0]
```

```bash
npm run cli -- resume <작업 ID>
```

```bash
npm run cli -- probe [--sample <16kHz 모노 WAV>]
```

```bash
npm run cli -- models download small-q5_1 silero-v6.2.0
```

```bash
npm run cli -- bench --audio <녹음> --ref <기준 whisper JSON> --start 600 --duration 600 --config wcpp:small-q5_1:cpu --config fw:small:cpu
```

```bash
npm run dev
```

```bash
npm run dist:win
```

```bash
powershell -File ../scripts/build_whisper.ps1 -SourceDir <whisper.cpp 체크아웃> [-NoVulkan]
```

`build_whisper.ps1`의 결과는 `.cache/whisper/bin/`에 모이고, 개발 중에는 그곳의 `whisper-cli.exe`와 PATH의 `ffmpeg`를 쓴다. 설치본은 `resources/bin/`(electron-builder의 `extraResources`)에서 찾는다. 설치 파일은 `dist/installer/`에 생긴다. vite는 electron-vite 5가 지원하는 7로 고정돼 있다(8로 올리지 않는다).

벤치의 `fw:`(faster-whisper) 설정만 Python을 쓴다: `py -3.14 -m venv tools/.venv && tools/.venv/Scripts/python -m pip install -r tools/requirements-bench.txt`. 앱에는 Python이 들어가지 않는다.

## Architecture (지금까지)

- `src/core/`: 처리 로직. **electron을 import하지 않는다** — 메인 프로세스, CLI(`src/cli/`), 테스트(`test/`)가 같은 코드를 그대로 쓴다. 상대 import에는 `.ts` 확장자를 붙이고, 타입은 `import type`으로 가져온다(Node type stripping 규칙, tsconfig의 `erasableSyntaxOnly`).
- `src/main/index.ts`: 화면이 부를 수 있는 처리를 `handlers`(허용 목록)에 두고 `api:call` IPC로 연다. 처리 오류(`EngineError`)는 IPC가 필드를 버려서 메시지 앞에 `[코드]`를 붙여 보내고, 화면의 `api.ts`가 다시 나눈다. 메인 → 화면 알림은 `api:event`이고 preload의 허용 목록(`setup`)에 있는 것만 받는다. `setup.ts`는 모델 받기와 속도 재기(probe) 상태를 메인에 두고 바뀔 때마다 보낸다. `secrets.ts`는 API 키를 safeStorage로 암호화해 `<데이터 폴더>/secrets.json`에 두고 화면에는 끝 4자리만 준다. 설정은 `core/settings.ts`(`settings.json`: 마법사 단계, 저장 폴더, 연결된 요약 서비스). 개발 중 `LN_DATA_DIR` 환경변수로 데이터 폴더를 바꿔 첫 실행을 따로 시험할 수 있다.
- 데이터 폴더는 `%LOCALAPPDATA%\lecture-notes`(`models/`, `bench/`, 이후 `jobs/`)다. 강의 녹음에서 나온 파일은 여기에만 쓴다.
- `audio.ts` + `wav.ts`: 16kHz 모노 WAV로 바꾼 뒤 약 10분마다 무음 지점에서 조각(`chunks/part_NNN.wav`)으로 나누고 원본 WAV는 지운다.
- `stt/base.ts`의 `transcribeChunks`: 조각별 결과를 `part_NNN.json`으로 저장해 끝난 조각은 다시 돌리지 않고, 조각 시작 시각만큼 밀어 하나로 합친다. 엔진 구현(`stt/whispercpp.ts`)은 `SttEngine`만 따르면 된다.
- `downloads.ts` + `models.ts`: 모델 URL·크기·sha256 목록과 `.part` 이어받기.
- `clean.ts`(반복·환각 정리), `corrections.ts`(교정 목록 적용), `llm.ts`·`summarize.ts`·`prompts.ts`(요약 호출 1회), `credits.ts`, `providers.ts`.
- `job.ts`: 작업 하나를 `audio→stt→clean→summarize→note→save` 단계로 돌리고 `<데이터 폴더>/jobs/<id>/job.json`에 단계 상태를 남긴다. 끝난 단계(`done`/`skipped`)는 건너뛰므로 실패·취소 뒤 `runJob`을 다시 부르면 이어서 한다. 필기는 작업 폴더에 복사해 두고, API 키는 `job.json`에 넣지 않고 실행할 때 `JobContext`로 받는다. 요약 설정(`settings.llm`)이 없으면 요약 단계는 `skipped`이고 전사만 담은 노트가 된다.
- `probe.ts`: 샘플을 CPU와 Vulkan 장치마다 돌려(로그의 장치 목록·`uma`·처리 시간) 쓸 장치와 RTF를 정한다. GPU 전사가 CPU 전사와 CER 0.3 넘게 다르면 깨진 것으로 보고, 1.2배 이상 빠를 때만 GPU를 고른다. 결과는 `<데이터 폴더>/probe.json`, `run --device auto`(기본)가 장치·예상 시간에 쓴다. `compare.ts`: CER(벤치와 공용).
- `note.ts`: 노트 마크다운(frontmatter 값은 JSON 문자열, 접는 부분은 `> [!quote]-` callout)과 저장(`<저장 폴더>/<과목|미분류>/<날짜> <제목>.md`, 겹치면 ` (2)`). `inputs.ts`: 녹음 옆 같은 이름 필기 찾기, UTF-8이 아니면 CP949로 읽기.
- 화면(`src/renderer/src/`): 색·크기는 `styles/tokens.css`의 CSS 변수만 쓰고(라이트 B2, 다크 D4, OS 설정을 따름), 부품은 `components/`(CSS Modules)에 있다. 화면은 이 부품을 조합하고 색·치수를 직접 쓰지 않는다. 본문 글꼴은 내장한 Pretendard 가변 글꼴(`assets/fonts/`, 서브셋 아님). 첫 실행 마법사는 `wizard/`(안내 → 이 PC 확인 → 요약 서비스 → 저장 폴더 → 준비 완료), 그 뒤는 `home/`(사이드바 `Shell`, `Home`: 상황 배너·끌어 놓기·진행 중·최근 노트, `ConfirmDialog`: 시작 전 확인)이다. 작업 목록·설정은 아직 자리표시다. 작업은 메인의 `main/jobs.ts`(실행기)가 한 번에 하나씩 돌리고 `jobs` 이벤트로 진행을 알린다. 작업이 있으면 `main/tray.ts`의 트레이가 생기고 창을 닫으면 트레이로 숨으며, 앱을 끝낼 때는 받아쓰기를 멈추고 작업을 대기로 되돌린다(`runner.shutdown`). 모델이 없으면 `setup.whenReady()`로 받고 속도를 잰 뒤 시작한다. 끌어 놓은 파일 경로는 preload의 `pathForFile`(`webUtils`)로 얻는다. 최근 노트는 저장 폴더의 .md(`core/recent.ts`), 녹음·필기 짝짓기는 `core/inputs.ts`의 `pairInputs`. 창의 화면 영역은 4:3(마법사 800×600, 홈 1000×750, 모니터에 맞춰 줄임, `main/fit.ts`)이고 크기 조절도 `will-resize`에서 4:3을 지킨다. 배치는 창 크기에 맞게 흐르고 본문은 `--content-max-w`(720px)까지만 넓어진다. 모든 화면은 최소 크기 800×600에서 스크롤 없이 들어가게 만든다.
- `src/cli/bench.ts`: S3용. RTF와, 기준 전사(기존 파이프라인의 large-v3 결과) 대비 CER을 잰다.

## 지금 상태와 다음 할 일 (9/28 노트북 세션 끝)

계획·화면 설계·색은 claude.ai artifact 하나(**lecture-notes 설계 모음**)에 탭으로 모여 있다: https://claude.ai/artifact/P82LYdRRnFqYerPEo7YDxX (9/29에 따로 있던 9개를 합치고 원본은 지웠다).

- 탭: 구현 계획(`#plan`: 일정, 완료 기준, 결정 기록, 접힌 "구조 전환 검토"), 화면 흐름(`#flow`: 설치부터 미리보기까지 와이어프레임, 오류 문구, 질문 표), 홈 시안(`#home`), 작업 목록 시안(`#jobs`), 최종 색(`#colors`, 안에 "색 고른 과정" 견본 `#c1`~`#c4`)
- 고치는 법: `Artifact` 도구 `action: "read"`로 받은 HTML의 `const DATA = {...}`(문서별 HTML이 `DATA.docs.<탭 id>`에 JSON 문자열로 들어 있음)에서 해당 탭만 바꿔 같은 `url`로 다시 올린다. 두 시안에 같은 Pretendard 글꼴은 한 번만(`DATA.font`, 문서 안에서는 `__FONT__` 자리표시) 들어 있다.

S3는 9/28에 정했다: 로컬 STT는 whisper.cpp, CPU 기본 `large-v3-turbo-q8_0` + greedy(`-bs 1`, 노트북 90분 강의 약 27분). 앱의 기본 모델·옵션은 이것으로 둔다(`WhisperCpp`의 `beamSize: 1`).

사용자가 정해야 하는 것:

1. **앱 이름.** W4 전에 정한다(그때까지 lecture-notes, `productName` 한 곳만 바꾸면 되게 둔다). 화면 흐름의 나머지 질문 8개는 9/28에 정했다(`docs/decisions.md`, 화면 흐름 artifact의 "질문 정리").

M1(10/4) 진행: 작업 저장·재개(`job.ts`), 노트 작성·저장(`note.ts`), CLI `run`/`resume`/`jobs`, 강의 언어(`--lang` → `-l`)는 됐다데스크톱에서 63분 강의로 확인: 외장 GPU로 30초에 전사만 담은 노트, 잘못된 키로 요약 단계에서 멈춘 뒤 `resume`하면 STT 없이 6초에 요약(10.17크레딧)까지 끝나 노트 다섯 요소가 모두 나옴. 하드웨어 감지·예상 시간(`probe`)도 됐다. 데스크톱: 외장 GPU를 고르고 내장 GPU(CPU보다 느림)는 뺌, 63분 강의 예상 약 1분에 실제 29초. 남은 M1: 노트북 CPU로 90분 강의 `run`(사용자). 감지용 샘플은 작성자가 대본(`app/resources/probe-ko.txt`)을 읽은 39초 녹음 `app/resources/probe-ko.wav`(16kHz 모노, 공개)이고, `probe`의 기본 샘플이며 설치본에는 `resources/probe-ko.wav`로 들어간다. 데스크톱에서 CPU 9.4초, 외장 GPU 0.4초, 대본과 거의 같은 전사. TTS 샘플은 쉼이 없어 RTF가 실제 강의보다 높게 나온다(예상 시간이 넉넉함). 실제 작업의 전사 시간으로 예상치를 고치는 것은 W2. 잠자기 방지는 앱에서 Electron `powerSaveBlocker`로 한다(W2). 그 뒤 W2 화면은 화면 흐름 초안을 따른다.

남은 확인: S1 새 계정 설치와 SmartScreen 문구(내려받은 설치 파일이어야 뜸), 설치 파일에 ffmpeg LGPL 빌드 넣기, 첫 실행 속도 측정에서 결과가 정상인지 보는 검사(노트북 내장 GPU는 전사가 깨졌다).

PC별 메모: 노트북(Ryzen 7 5700U)에는 모델과 `tools/.venv`가 있고 설치본을 이 계정에 깔아 두었다. 벤치용 녹음·기준 전사는 저장소 밖 `C:\ljh\2026-2\s3-data\`에 있다. 데스크톱은 TypeScript 전환 전 상태라 pull 뒤 `app/`에서 `npm ci`를 하고, 남아 있는 옛 `engine/` 폴더(`.venv`, 캐시)를 지운다. faster-whisper 벤치가 필요하면 `tools/.venv`를 새로 만든다.

## Gotchas (고치지 말 것)

- 앱은 하나만 실행된다(`requestSingleInstanceLock`, 사용자 데이터 폴더 기준). `npm run dev`와 설치본, `LN_DATA_DIR`로 띄운 것도 서로 막는다: 이미 떠 있으면 새로 띄운 쪽은 바로 끝나고 떠 있는 창이 앞으로 온다. 시험할 때는 앞의 것을 먼저 끈다(작업 중이면 트레이에 숨어 있을 수 있다).

- whisper-cli는 `-np`여도 전사 구간을 stdout으로 출력한다. stdout은 `ignore`로 두고 stderr의 `progress = N%`만 읽는다 (파이프가 차면 멈춤, `test/stt.test.ts`가 이를 검사).
- whisper-cli는 인자를 ANSI 코드 페이지로 받는다. 경로는 cwd 기준 상대 경로로 넘긴다. `-mc 0` + VAD는 긴 강의에서 같은 문장이 반복되며 내용이 사라지는 루프를 막는 설정이다.
- `app/package.json`에 `"type": "module"`을 넣지 않는다. electron-vite가 메인·preload를 ESM으로 만들게 되는데, sandbox preload는 CommonJS여야 한다. 그래서 Node로 `.ts`를 직접 돌릴 때는 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`을 붙인다(npm 스크립트에 들어 있음).
- 데스크톱의 `py -3.13`은 Microsoft Store판이라 `%LOCALAPPDATA%` 쓰기가 `...\Packages\PythonSoftwareFoundation...\LocalCache\`로 가상화된다. 벤치용 venv를 그 Python으로 만들지 않는다.
- `scripts/*.ps1`은 Windows PowerShell 5.1이 한글을 읽도록 UTF-8 BOM으로 저장한다. 네이티브 명령은 `Invoke-Checked`로 종료 코드만 본다.
- 노트북 내장 GPU(Radeon, Vulkan)로 whisper를 돌리면 느리고 전사가 깨진다. GPU 사용 여부는 속도와 결과 정상 여부를 함께 실측해 정한다.
- 사용자 파일 이름에는 점이 흔하다(예: `9.14 Lexical Analysis`). 파생 파일 이름을 확장자 바꾸기로 만들지 말고 고정 이름이나 문자열 연결을 쓴다.

## Conventions

- 공개 저장소다. 강의 녹음·전사·필기·노트·API 키를 커밋하지 않는다. 테스트는 합성 데이터만 쓴다(`.gitignore`는 오디오 확장자만 막고 전사 JSON은 못 막으니, 녹음·기준 전사는 저장소 밖에 둔다).
- 사용자에게 보이는 메시지와 코드 주석은 한국어로 쓴다.
