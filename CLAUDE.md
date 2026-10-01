# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

lecture-notes(앱 이름 **NotecrAIte**, 읽는 법 "노트크리에이트", 부제 "강의 녹음을 노트로". 화면에 보이는 이름은 `src/core/brand.ts`와 `electron-builder.yml`의 `productName`, 데이터 폴더·저장소·npm 이름은 lecture-notes 그대로): 강의 녹음(+선택적 필기 .md/.txt)을 요약·주요 키워드·전사문이 담긴 마크다운 노트로 만드는 PC 설치형 앱 (ChatKHU 공모전, 마감 2026-10-24). Electron + TypeScript 하나로 만든다(`app/`). 무거운 일은 외부 실행 파일(whisper-cli, ffmpeg)이 하고, 메인 프로세스의 `src/core/`가 그것들을 부르고 HTTP·텍스트 처리를 한다. 결정과 실험 결과는 `docs/decisions.md`에 적는다.

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
npm run cli -- llm bench --text <고친 전사.txt> --minutes 82 --subject <과목> --models gemini-3.8-flash,gpt-6-luna
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

```bash
powershell -File ../scripts/fetch_ffmpeg.ps1
```

`npm ci` 뒤에 `npm run dev`가 `Error: Electron uninstall`로 멈추면 Electron 바이너리가 없는 것이다. npm 11이 설치 스크립트를 막아 `node_modules/electron/dist`·`path.txt`가 안 생기므로 `node node_modules/electron/install.js`로 받는다(`npx electron .`은 스스로 받지만 electron-vite는 `path.txt`를 먼저 찾는다).

`build_whisper.ps1`의 결과는 `.cache/whisper/bin/`에, `fetch_ffmpeg.ps1`(BtbN LGPL 빌드, 고정 태그·sha256)의 결과는 `.cache/ffmpeg/bin/`에 모인다. 개발 중에는 `.cache/whisper/bin`의 `whisper-cli.exe`와 PATH의 `ffmpeg`를 쓴다. 설치본은 둘 다 `resources/bin/`(electron-builder의 `extraResources`)에서 찾는다. 설치 파일은 `dist/installer/`에 생긴다. CI(`.github/workflows/installer.yml`, 수동 실행 또는 `v*` 태그)는 whisper 빌드(캐시) → ffmpeg → 타입 검사·테스트 → 설치 파일을 만들어 아티팩트 `NotecrAIte-windows`로 올린다(Release에는 올리지 않음). vite는 electron-vite 5가 지원하는 7로 고정돼 있다(8로 올리지 않는다).

`scripts/s3_laptop.ps1`은 빌드 도구가 없는 노트북에서 데스크톱의 whisper-cli를 복사해 와 S3 벤치(`cli bench`)를 여러 설정으로 돌린다.

벤치의 `fw:`(faster-whisper) 설정만 Python을 쓴다: `py -3.14 -m venv tools/.venv && tools/.venv/Scripts/python -m pip install -r tools/requirements-bench.txt`. 앱에는 Python이 들어가지 않는다.

## Architecture (지금까지)

- `src/core/`: 처리 로직. **electron을 import하지 않는다** — 메인 프로세스, CLI(`src/cli/`), 테스트(`test/`)가 같은 코드를 그대로 쓴다. 상대 import에는 `.ts` 확장자를 붙이고, 타입은 `import type`으로 가져온다(Node type stripping 규칙, tsconfig의 `erasableSyntaxOnly`).
- `src/main/index.ts`: 화면이 부를 수 있는 처리를 `handlers`(허용 목록)에 두고 `api:call` IPC로 연다. 처리 오류(`EngineError`)는 IPC가 필드를 버려서 메시지 앞에 `[코드]`를 붙여 보내고, 화면의 `api.ts`가 다시 나눈다. 메인 → 화면 알림은 `api:event`이고 preload의 허용 목록(`setup`)에 있는 것만 받는다. `setup.ts`는 모델 받기와 속도 재기(probe) 상태를 메인에 두고 바뀔 때마다 보낸다. 쓰는 받아쓰기 모델은 설정(`sttModel`)을 따르고, 바꾸면 받은 뒤 다시 잰다. 작업이 받아쓰기 중이면(`runner.transcribing()`) 속도 재기는 작업이 끝난 뒤로 미룬다. `log.ts`는 `<데이터 폴더>/logs/YYYY-MM-DD.log`(14일치)에 작업 상태 변화·실패 이유·IPC 오류를 남긴다(키·전사·요약 내용은 적지 않음). `secrets.ts`는 API 키를 safeStorage로 암호화해 `<데이터 폴더>/secrets.json`에 두고 화면에는 끝 4자리만 준다. 설정은 `core/settings.ts`(`settings.json`: 마법사 단계, 저장 폴더, 연결된 요약 서비스, 요약 모델, 전사문 다듬기 모델(`polishModel`, null이면 끔), 받아쓰기 모델, 고친 whisper-cli 옵션, 과목별 언어, 화면 색). 9/30 전 설정 파일에 남은 `verifyModel`은 읽히지만 쓰이지 않는다. 개발 중 `LN_DATA_DIR` 환경변수로 데이터 폴더를 바꿔 첫 실행을 따로 시험할 수 있다.
- 데이터 폴더는 `%LOCALAPPDATA%\lecture-notes`(`models/`, `bench/`, 이후 `jobs/`)다. 강의 녹음에서 나온 파일은 여기에만 쓴다. 기본 데이터 폴더와 whisper-cli·ffmpeg 찾기(설치본 `resources/bin` → 개발 중 `.cache/whisper/bin`·PATH)는 `core/paths.ts`, `LN_DATA_DIR`은 `main/index.ts`(CLI는 `--data-dir`)가 본다.
- `audio.ts` + `wav.ts`: 16kHz 모노 WAV로 바꾼 뒤 약 10분마다 무음 지점에서 조각(`chunks/part_NNN.wav`)으로 나누고 원본 WAV는 지운다.
- `stt/base.ts`의 `transcribeChunks`: 조각별 결과를 `part_NNN.json`으로 저장해 끝난 조각은 다시 돌리지 않고, 조각 시작 시각만큼 밀어 하나로 합친다. 60초 넘는데 60자 미만인 구간(`sparseSegments`)이 있는 조각만 VAD 없이(`withoutVad`) 한 번 더 받아써 그 구간을 바꿔 끼운다(`fillGaps`). 엔진 구현(`stt/whispercpp.ts`)은 `SttEngine`만 따르면 된다. `stt/chatkhu.ts`는 ChatKHU 받아쓰기(Soniox `stt-async-v5`, 1분에 6크레딧): 조각을 opus로 줄여 올리고 상태를 물어 받는다. 올리면 과금되고 환불이 없어서 조각마다 `stt/<조각>.op.json`(operation_id·크레딧)을 먼저 남겨 재시도 때 다시 올리지 않고, 서버에서 실패한 조각은 `.failed-<시각>`으로 이름만 바꿔 크레딧 합계(`chargedCredits` → `job.cost.sttCredits`)에 넣는다. 화자 구간을 문장으로 나누고 시각은 글자 위치로 어림한다(`splitSegments`). 작업의 `settings.sttService`가 `chatkhu`일 때만 쓰이고(설정 `chatkhuStt` + ChatKHU 연결, 메인의 `sttService()`), 그 작업은 받아쓰기 모델·속도 재기·녹음 중 멈춤을 기다리지 않는다. 멈추면 작업 목록의 [이 PC에서 받아쓰기](`runner.localStt`).
- `downloads.ts` + `models.ts`: 모델 URL·크기·sha256 목록과 `.part` 이어받기.
- `clean.ts`(반복·환각 정리), `corrections.ts`(교정 목록 적용, 한글로 시작하는 교정은 앞 글자가 한글이면 바꾸지 않음), `llm.ts`(OpenAI 호환 호출, 스트리밍으로 받아 524를 피함, 504·524는 `timeout` 오류)·`summarize.ts`·`prompts.ts`(요약 호출 1회), `polish.ts`(선택 기능 전사문 다듬기: 2000자 조각을 4개씩 동시에 다시 쓰고, 문단 수가 다르거나 길이가 0.85~1.2배를 벗어나면 원문), `verify.ts`(교정 검증, 앱은 쓰지 않고 CLI `run --verify-model`로만), `credits.ts`, `providers.ts`. 작업의 크레딧은 응답 토큰 수 × 단가(`creditsFromTokens`), 단가표 밖 모델만 잔액 차이.
- `job.ts`: 작업 하나를 `audio→stt→clean→polish→summarize→note→save` 단계로(polish는 전사문 다듬기를 켠 작업만, 9/30 전 작업에는 없음) 돌리고 `<데이터 폴더>/jobs/<id>/job.json`에 단계 상태를 남긴다. 끝난 단계(`done`/`skipped`)는 건너뛰므로 실패·취소 뒤 `runJob`을 다시 부르면 이어서 한다. 필기는 작업 폴더에 복사해 두고, API 키는 `job.json`에 넣지 않고 실행할 때 `JobContext`로 받는다. 요약 설정(`settings.llm`)이 없으면 요약 단계는 `skipped`이고 전사만 담은 노트가 된다.
- `probe.ts`: 샘플을 CPU와 Vulkan 장치마다 돌려(로그의 장치 목록·`uma`·처리 시간) 쓸 장치와 RTF를 정한다. GPU 전사가 CPU 전사와 CER 0.3 넘게 다르면 깨진 것으로 보고, 1.2배 이상 빠를 때만 GPU를 고른다. 결과는 `<데이터 폴더>/probe.json`, `run --device auto`(기본)가 장치·예상 시간에 쓴다. `compare.ts`: CER(벤치와 공용).
- `sttargs.ts`: 설정 > 고급에서 고칠 수 있는 whisper-cli 옵션(기본값, 잠긴 옵션 거절, 명령 미리보기). 옵션이 있으면 `WhisperCpp`는 threads·beamSize·장치 대신 그것을 쓰고, 저장 전에 `checkArgs`로 whisper-cli에 한 번 읽혀 본다(없는 입력 파일로 실행하면 옵션을 읽은 뒤 바로 끝남). `probe.ts`의 `testSample`은 [샘플로 시험하기]. `providers.ts`의 `creditsPer90ByModel`은 작업 기록으로 모델별 90분 요약 크레딧을 잰다.
- `note.ts`: 노트 마크다운(frontmatter 값은 JSON 문자열, 접는 부분은 `> [!quote]-` callout)과 저장(`<저장 폴더>/<과목|미분류>/<날짜> <제목>.md`, 겹치면 ` (2)`). `inputs.ts`: 녹음 옆 같은 이름 필기 찾기(`pairInputs`), 이미 목록에 있는 녹음에 나중에 넣은 필기 붙이기(`attachNotes`: 같은 폴더·이름 우선, 없으면 이름만 같은 녹음이 하나일 때), UTF-8이 아니면 CP949로 읽기.
- 화면(`src/renderer/src/`):
  - 색·크기는 `styles/tokens.css`의 CSS 변수만 쓴다(라이트 B2, 다크 D4, OS 설정을 따름). 화면은 `components/`(CSS Modules)의 부품을 조합하고 색·치수를 직접 쓰지 않는다. 본문 글꼴은 내장한 Pretendard 가변 글꼴(`assets/fonts/`, 서브셋 아님).
  - 창의 화면 영역은 4:3(마법사 800×600, 홈 1000×750, 모니터에 맞춰 줄임, `main/fit.ts`)이고 크기 조절도 `will-resize`에서 4:3을 지킨다. 본문은 `--content-max-w`(720px)까지만 넓어진다. 모든 화면은 최소 크기 800×600에서 스크롤 없이 들어가게 만든다.
  - 폴더: `wizard/`(첫 실행 마법사), `home/`(사이드바 `Shell`, 홈, 시작 전 확인 `ConfirmDialog`, 작업 목록 `JobList`), `notes/`(노트 목록), `preview/`(노트 미리보기), `settings/`(설정). 화면 흐름·배치·문구는 아래 설계 모음 artifact의 시안이 기준이다.
  - 미리보기: `markdown.ts`가 머리말·callout·키워드를 나누고 나머지는 markdown-it(HTML 끔, cjk-friendly로 조사가 붙은 굵게도 인식, @vscode/markdown-it-katex로 수식)으로 그린다. KaTeX CSS는 Node 테스트가 못 읽으니 markdown.ts가 아니라 NotePreview.tsx에서 import한다. 미리보기는 앞 화면을 숨겨 둔 채 열어 돌아가면 상태가 그대로다. [요약 다시 만들기]는 `runner.resummarize`로 요약부터 다시 해 같은 파일에 덮어쓴다.
  - 작업은 메인의 `main/jobs.ts`(실행기)가 한 번에 하나씩 돌리고 `jobs` 이벤트로 진행을 알린다. 작업이 있으면 `main/tray.ts`의 트레이가 생기고 창을 닫으면 트레이로 숨으며, 앱을 끝낼 때는 받아쓰기를 멈추고 작업을 대기로 되돌린다(`runner.shutdown`). 모델이 없으면 `setup.whenReady()`로 받고 속도를 잰 뒤 시작한다. 끌어 놓은 파일 경로는 preload의 `pathForFile`(`webUtils`)로 얻는다.
- `llmcatalog.ts`: 요약 모델 목록(글 모델만), 단가표(`PRICES`), 90분 요약 크레딧 어림(`estimateCredits90`), 추천 순서(`RANKED`, 2차 비교 기준 12개, 앞 `RECOMMENDED_COUNT`=5개가 추천). 설정의 `settings/ModelPicker.tsx`는 선택 칸에 "추천 모델 목록" 5개를 보이고, [전체 모델 보기] 창에 12개를 추천 순서대로, [직접 모델 입력]으로 그 밖의 이름을 받는다(목록을 불러왔으면 서비스의 글 모델 이름인지 확인). 다듬기 모델도 같은 부품(`kind="polish"`, 핸들러 `llm.steps`)이고 추천은 `POLISH_RECOMMENDED`(luna·gemma·grok·deepseek, 90분 약 20~30크레딧인 모델), 크레딧 어림은 `STEP_TOKENS_PER_90MIN.polish`(luna 90분 약 30). `src/cli/llmbench.ts`(`llm models`, `llm bench`)는 요약 모델 비교용이고 키는 환경변수 `LN_API_KEY`로만 받는다(결과는 강의 내용이라 데이터 폴더의 `bench/`에만). `secrets.ts`는 키를 풀지 못하면(암호화 키가 바뀜) 연결 안 된 것으로 본다.
- 자동 처리(폴더 감시): `core/watch.ts`(폴더 읽기, 복사가 끝났는지 판단 `settled`, 같은 녹음 `fingerprint`, `처리됨`으로 옮기기, 처리 기록 `<데이터 폴더>/watch.json`)와 `main/watcher.ts`(20초 폴링, `runner.start`로 작업을 넘기고 `onDone`에서 녹음을 옮김, `watch` 이벤트). 설정은 `settings.watch`(enabled·folder·paused), 화면은 `settings/AutoSection.tsx`. 켜져 있으면 창을 닫아도 트레이에 남고, 트레이 메뉴(`main/tray.ts`)에서 멈추기/다시 시작. PC를 켜면 자동 실행은 `--hidden`으로 등록해 창 없이 시작하고 설치본에서만 된다.
- 앱에서 녹음하기: 화면의 `home/recording.ts`(React 밖 상태: MediaRecorder webm/opus, 5초마다 `rec.chunk`로 보냄, 소리 크기·무음 경고)와 `home/Recorder.tsx`(시작 창·녹음 중 카드). 메인의 `main/recorder.ts`가 `<데이터 폴더>/recordings/<이름>.recording.webm`에 덧붙여 쓰고(녹음 중 잠자기 방지), 끝나면 `core/recordings.ts`의 `finishRecording`이 ffmpeg `-c copy`로 길이 정보를 넣어 `<이름>.webm`으로 만든다. 앱이 꺼져 남은 `.recording.webm`은 다음 실행 때 `repairRecordings`가 고친다. 작업으로 넘긴 녹음은 `recordings/processed.json`에 적고, 나머지가 홈의 "노트로 만들지 않은 녹음" 배너다. 컴퓨터 소리는 메인의 `setDisplayMediaRequestHandler`가 loopback을 준다(Windows만). 녹음 중에는 `runner`의 `holdStt`로 받아쓰기가 남은 작업을 건너뛰고(`nextPending`), 시작할 때 도는 받아쓰기는 `holdNow`로 멈춰 대기로 되돌린다(설정 `sttWhileRecording`이면 안 멈춤). 속도 재기도 녹음 중에는 미룬다. 설정 > 고급의 마지막 칸 "실험 기능"에 `sttWhileRecording`과 `chatkhuStt`가 토글 스위치(`components/Switch`, 바로 저장)로 있다.
- `noteedit.ts`: 노트 정보(제목·과목·날짜) 수정. 이 앱이 만든 노트(머리말에 title·date·source·stt)만, 머리말·첫 `# ` 줄·파일 이름·과목 폴더를 함께 바꾸고 본문은 그대로 둔다(과목 태그만 갈고 사용자가 더한 태그는 유지, 과목이 바뀔 때만 폴더, 제목·날짜가 바뀔 때만 파일 이름). 메인의 `notes.editInfo`·`notes.edit`가 부르고, 그 노트를 만든 작업의 `output.notePath`·`input.subject`·`edits`(제목·날짜)를 함께 고쳐 [요약 다시 만들기]가 옛 경로로 덮어쓰거나 수정한 값을 되돌리지 않게 한다(`runner.noteEdited`). 요약을 만드는 중인 노트는 못 고친다(`runner.noteBusy`). 화면은 노트 목록 줄과 미리보기 버튼 줄 끝의 [...] 메뉴(`components/MoreMenu`)에서 [수정](`notes/NotePropsDialog`)과 [삭제](`notes/NoteDeleteDialog`)를 연다. 삭제는 `notes.delete`가 파일을 휴지통으로 옮기고(`shell.trashItem`, 되살릴 수 있음) 그 작업의 `output`을 비운다(`runner.noteDeleted`). 이 앱이 만들지 않은 노트도 삭제할 수 있다(수정은 못 함).
- 작은 공용 모듈: `files.ts`(`writeJsonAtomic`: 임시 파일 뒤 rename, Windows 백신 잠금 때문에 재시도. 작업·설정 JSON은 이것으로 쓴다), `proc.ts`(`runCapture`: 외부 실행 파일을 창 없이 돌림), `vault.ts`(저장 폴더가 쓸 수 있는지·옵시디언 볼트 안인지·기존 과목 폴더), `hardware.ts`(물리 코어·전원 상태는 OS 명령으로 읽음), `errors.ts`(`EngineError`).
- `src/cli/bench.ts`: S3용. RTF와, 기준 전사(기존 파이프라인의 large-v3 결과) 대비 CER을 잰다.

## 지금 상태와 다음 할 일

계획·화면 설계·색은 claude.ai artifact 하나(**lecture-notes 설계 모음**)에 탭으로 모여 있다: https://claude.ai/artifact/P82LYdRRnFqYerPEo7YDxX

- 탭: 구현 계획(`#plan`: 진행 상황, 일정, 완료 기준, 결정 기록, 접힌 "구조 전환 검토"), 화면 흐름(`#flow`: 설치부터 미리보기까지 와이어프레임, 오류 문구, 질문 표), 홈 시안(`#home`), 작업 목록 시안(`#jobs`), 노트 목록 시안(`#notelist`), 노트 미리보기 시안(`#preview`), 설정 시안(`#settings`), 최종 색(`#colors`)
- 고치는 법: `Artifact` 도구 `action: "read"`로 받은 HTML의 `const DATA = {...}`(문서별 HTML이 `DATA.docs.<탭 id>`에 JSON 문자열로 들어 있음)에서 해당 탭만 바꿔 같은 `url`로 다시 올린다. 두 시안에 같은 Pretendard 글꼴은 한 번만(`DATA.font`, 문서 안에서는 `__FONT__` 자리표시) 들어 있다.

S3(9/28): 로컬 STT는 whisper.cpp, CPU 기본 `large-v3-turbo-q8_0` + greedy(`-bs 1`). 앱의 기본 모델·옵션은 이것으로 둔다(`WhisperCpp`의 `beamSize: 1`).

지난 진행 기록(된 것, 실측값, PC별 메모, 크레딧 사용, 저장소 밖 실험 자료 위치)은 `docs/decisions.md`의 "CLAUDE.md에서 옮긴 기록"에 있다. 세션이 끝날 때 된 일은 여기가 아니라 그쪽에 적는다.

**다음 할 일** (최소 제출선 10/11 = W2 끝, 마감 10/24)

1. 실제 작업의 받아쓰기 시간으로 예상치 보정. 노트북 예상이 90분에 약 74분으로 S3 실측(약 27분)보다 크게 나온다.2. GPU 없는 노트북에서 CI 설치 파일로 완주하는 1차 테스트. 자동 처리의 PC를 켜면 자동 실행 등록은 설치본에서 확인해야 한다.
3. W3: 1차 테스트 수정, ChatKHU STT 선택지, OpenAI·Gemini 프리셋. W4: Ollama(설정의 로컬 LLM), Mac 베타.
4. 요약 프롬프트 다듬기: 기준·시험 방법·분량 시험용 초안은 `docs/prompt-quality-plan.md`(10/1 세움, 시험 전). 채점 틀 고치기 → 분량 시험 → 한 가지씩 수정 순서이고, 시험은 채점표·판정표가 있는 데스크톱에서 한다.
5. 받아쓰기 정답 전사: 작성자가 10분 조각을 들으며 고쳐 정답을 만들고 기존 조건들을 다시 채점한다. 설계는 `docs/stt-reference-plan.md`(10/1). 조각 수·적는 규칙·조각 고르기는 아직 안 정했고 데스크톱에서 도구(준비·채점 스크립트)를 만들 때 정한다.

사용자가 할 것·정할 것:

1. 노트북 CPU로 90분 강의를 CI 설치 파일로 처리(예상치 보정의 실측값, CPU에서 누락 구간 다시 받아쓰기 시간).
2. S1 새 Windows 계정 설치와 SmartScreen 문구.
3. 옵시디언에서 `**파싱(Parsing)**을`처럼 닫는 `**` 앞이 문장부호이고 뒤에 조사가 붙은 굵게가 안 보이는지 확인. 안 보이면 노트를 쓸 때 그 부분만 `<strong>`으로 바꾸는 안이 있다(프롬프트는 고치지 않기로 함).

## Gotchas (고치지 말 것)

- 앱은 하나만 실행된다(`requestSingleInstanceLock`, 사용자 데이터 폴더 기준). `npm run dev`와 설치본, `LN_DATA_DIR`로 띄운 것도 서로 막는다: 이미 떠 있으면 새로 띄운 쪽은 바로 끝나고 떠 있는 창이 앞으로 온다. 시험할 때는 앞의 것을 먼저 끈다(작업 중이면 트레이에 숨어 있을 수 있다).

- whisper-cli는 `-np`여도 전사 구간을 stdout으로 출력한다. stdout은 `ignore`로 두고 stderr의 `progress = N%`만 읽는다 (파이프가 차면 멈춤, `test/stt.test.ts`가 이를 검사).
- whisper-cli는 인자를 ANSI 코드 페이지로 받는다. 경로는 cwd 기준 상대 경로로 넘긴다. `-mc 0` + VAD는 긴 강의에서 같은 문장이 반복되며 내용이 사라지는 루프를 막는 설정이다.
- `-mc 0`이면 `--prompt`(초기 프롬프트)도 쓰이지 않는다. 쓰려면 `--carry-initial-prompt`와 `-mc`를 올려야 하는데 루프가 돌아오고, 9/30 실험에서 품질도 나빠졌다. 한글 인자는 명령줄로 넘기면 깨지므로 응답 파일(`whisper-cli @파일`, 한 줄에 인자 하나, UTF-8)로 넘겨야 한다.
- VAD를 켜면 조각 시작 위치에 따라 whisper가 몇 분씩 건너뛰고(조각 하나가 2초 만에 끝남), 끄면 잡음을 "고춧가루" 같은 말로 받아쓴다. 그래서 VAD는 켜 두고 의심 구간만 VAD 없이 다시 받아쓴다(`stt/base.ts`). VAD를 통째로 끄지 않는다.
- `app/package.json`에 `"type": "module"`을 넣지 않는다. electron-vite가 메인·preload를 ESM으로 만들게 되는데, sandbox preload는 CommonJS여야 한다. 그래서 Node로 `.ts`를 직접 돌릴 때는 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`을 붙인다(npm 스크립트에 들어 있음).
- `scripts/*.ps1`은 Windows PowerShell 5.1이 한글을 읽도록 UTF-8 BOM으로 저장한다. 네이티브 명령은 `Invoke-Checked`로 종료 코드만 본다.
- 노트북 내장 GPU(Radeon, Vulkan)로 whisper를 돌리면 느리고 전사가 깨진다. GPU 사용 여부는 속도와 결과 정상 여부를 함께 실측해 정한다.
- 사용자 파일 이름에는 점이 흔하다(예: `9.14 Lexical Analysis`). 파생 파일 이름을 확장자 바꾸기로 만들지 말고 고정 이름이나 문자열 연결을 쓴다.
- Claude 데스크톱 앱(MSIX)에서 실행한 명령·앱이 `%LOCALAPPDATA%`에 새로 쓴 파일은 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\lecture-notes\`로 가상화된다. Claude 안의 프로세스는 두 곳을 합쳐 보지만, 사용자가 자기 터미널에서 띄운 앱은 실제 폴더만 본다. 사용자 앱이 쓸 모델·데이터는 사용자 터미널에서 받거나 옮기게 하고, Claude 쪽에서는 실제 폴더에 쓸 수 없다. 앱이 켜질 때 로그에 모델 폴더와 파일 크기를 남긴다(`받아쓰기 모델: ...`).
- 데스크톱의 `py -3.13`은 Microsoft Store판이라 `%LOCALAPPDATA%` 쓰기가 `...\Packages\PythonSoftwareFoundation...\LocalCache\`로 가상화된다. 벤치용 venv를 그 Python으로 만들지 않는다.
- `.cache/ffmpeg`는 저장소에 없어 PC마다 `fetch_ffmpeg.ps1`로 받아야 한다. `dist:win`이나 `notices.mjs`를 돌리기 전에 먼저 받는다.

## Conventions

- 공개 저장소다. 강의 녹음·전사·필기·노트·API 키를 커밋하지 않는다. 테스트는 합성 데이터만 쓴다(`.gitignore`는 오디오 확장자만 막고 전사 JSON은 못 막으니, 녹음·기준 전사는 저장소 밖에 둔다).
- 사용자에게 보이는 메시지와 코드 주석은 한국어로 쓴다.
