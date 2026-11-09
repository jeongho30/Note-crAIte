# Note-crAIte (lecture-notes)

강의 녹음(+선택적 필기 .md/.txt/.hwpx/.docx/.pptx)을 요약·주요 키워드·전사문이 담긴 마크다운 노트로 만드는 PC 설치형 앱. 사용자는 강의를 듣는 학생이고 Windows와 macOS(Apple Silicon)에 설치해 쓴다. 코드는 전부 `app/`(Electron + TypeScript + React). 무거운 일은 함께 설치되는 외부 실행 파일(whisper-cli, ffmpeg)이 하고, `app/src/core/`가 그것들을 부르고 HTTP·텍스트 처리를 한다. 화면에 보이는 이름은 `src/core/brand.ts`와 `electron-builder.yml`의 `productName`, 데이터 폴더·npm 이름은 lecture-notes.

우선순위(둘이 부딪히면 위가 이긴다):

1. 기본값에서 녹음은 PC 밖으로 나가지 않는다. 밖으로 보내는 것은 사용자가 직접 켠 실험 기능(ChatKHU 받아쓰기, Soniox)뿐이고, 요약 단계도 전사문·필기·과목 이름만 보낸다.
2. 공개 저장소에 강의 녹음·전사·필기·노트·API 키를 넣지 않는다. 테스트는 합성 데이터만 쓴다.
3. 끝난 단계는 다시 하지 않는다. 실패·취소·재시작 뒤에도 끝난 조각과 단계는 건너뛰고 이어서 한다.

처리 코드의 일부는 작성자의 개인용 Python 파이프라인 `C:\ljh\Coding\STT_AutoLectureNote\pipeline\`에서 옮겨 왔다. 그 폴더는 따로 쓰이므로 여기서 수정하지 않는다.

## 명령어

모두 `app/`에서 실행한다. Node 24 이상(type stripping으로 `.ts`를 바로 실행). 설치 세부·캐시 위치·CI 흐름은 [docs/internals/build-and-ci.md](docs/internals/build-and-ci.md).

- 설치: `npm ci` (`npm run dev`가 `Error: Electron uninstall`로 멈추면 `node node_modules/electron/install.js`)
- 개발 서버: `npm run dev` (whisper-cli는 `.cache/whisper/bin`, ffmpeg는 PATH에서 찾는다)
- 테스트 전체: `npm test`
- 테스트 하나: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-name-pattern "<이름>" "test/**/*.test.ts"`
- 타입 검사: `npm run typecheck`
- 화면 없이 노트 만들기: `npm run cli -- run <녹음> --out <저장 폴더> [--subject 과목] [--device gpu0]`. 그 밖에 `resume <작업 ID>`, `probe [--sample <16kHz 모노 WAV>]`, `models download <이름...>`, `bench --audio <녹음> --ref <기준 JSON> --config wcpp:small-q5_1:cpu`, `llm bench --text <전사.txt> --models <모델,...>`(키는 환경변수 `LN_API_KEY`)
- 설치 파일: `npm run dist:win`(먼저 `powershell -File ../scripts/fetch_ffmpeg.ps1`), `npm run dist:mac`(먼저 `bash ../scripts/build_whisper.sh`, `bash ../scripts/build_ffmpeg.sh`)
- whisper-cli 빌드(Windows): `powershell -File ../scripts/build_whisper.ps1 -SourceDir <whisper.cpp 체크아웃> [-NoVulkan]`
- 설치본 첫 실행 시험(CI의 macOS 작업이 돌린다): `node e2e/first-run.mjs`

## 절대 하지 말 것

1. 강의 녹음·전사·필기·노트·API 키를 커밋하지 않는다. 공개 저장소다. `.gitignore`는 오디오 확장자만 막고 전사 JSON은 못 막으므로, 녹음과 기준 전사는 저장소 밖(`s3-data`)에 둔다.
2. VAD를 통째로 끄지 않는다. 끄면 잡음을 말로 받아쓴다. 누락 의심 구간만 `stt/base.ts`의 `fillGaps`가 VAD 없이 다시 받아쓴다. `-mc 0` + VAD는 긴 강의의 반복 루프를 막는 설정이고, `--prompt`는 `-mc 0`에서 안 쓰이며 켜면 루프가 돌아온다(9/30 실험).
3. `app/package.json`에 `"type": "module"`을 넣지 않는다. sandbox preload는 CommonJS여야 한다. 대신 Node로 `.ts`를 돌릴 때 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`을 붙인다(npm 스크립트에 들어 있음).
4. vite를 8로 올리지 않는다. electron-vite 5가 7까지 지원한다.
5. `src/core/modelcatalog.json`의 파일 위치와 형식(version 1)을 바꾸지 않는다. 설치된 앱이 `main` 브랜치의 이 파일을 6시간마다 받아 쓴다. 값과 `updated`만 고친다.
6. `scripts/*.sh`는 LF, `scripts/*.ps1`은 UTF-8 BOM으로 둔다. CRLF면 macOS에서 실행되지 않고, BOM이 없으면 PowerShell 5.1이 한글을 깨뜨린다.
7. `C:\ljh\Coding\STT_AutoLectureNote\pipeline\`(원본 Python 파이프라인)을 수정하지 않는다.
8. 사람이 요청하지 않으면 PR을 만들거나 `main`에 push하지 않는다.

## 완료 기준

- 끝내기 전 `app/`에서 `npm run typecheck`와 `npm test`를 통과시킨다. 작업 중에는 바꾼 모듈의 테스트만 돌리고 전체는 끝낼 때 한 번.
- 버그 수정은 수정 없이 실패하는 테스트를 먼저 추가한다(합성 데이터만).
- 실제로 돌린 것만 보고한다. 설치본·실제 Mac·실제 API 키로 못 본 것은 못 봤다고 쓴다. 지금까지 못 본 것의 목록은 [docs/plans/2026-10-12-status.md](docs/plans/2026-10-12-status.md).
- 실험을 했거나 기본값·방식을 정한 것이 있으면 `docs/decisions.md`에 `### 제목 (M/D, 기기)` 절로 남긴다. 기능을 더하거나 고치기만 했으면 적지 않는다.
- 하지 않아도 되는 것: `dist:*`·e2e·CI 돌리기(CI가 push마다 타입 검사와 테스트를 돈다), 바꾸지 않은 파일의 포매팅, 코드 변경마다 `docs/internals/architecture.md` 수정(구조나 경계가 바뀔 때만).

## 코드 위치

흐름: 녹음 → `audio.ts`(16kHz WAV, 10분 조각) → `stt/`(whisper-cli 또는 ChatKHU) → `clean.ts`·`corrections.ts` → (`polish.ts`) → `summarize.ts`(`llm.ts`) → `note.ts` → 저장. `job.ts`가 단계 상태를 `<데이터 폴더>/jobs/<id>/job.json`에 남기고 끝난 단계는 건너뛴다.

- `app/src/core/` 처리 로직. electron을 import하지 않는다(메인·CLI·테스트가 같이 쓴다). 모듈별 설명은 [docs/internals/architecture.md](docs/internals/architecture.md)에서 고치려는 모듈 항목만 읽는다.
- `app/src/main/` 메인 프로세스. `index.ts`(IPC 허용 목록 `handlers`), `jobs.ts`(작업을 한 번에 하나씩), `tray.ts`, `watcher.ts`(폴더 감시), `recorder.ts`(녹음 파일 쓰기), `fit.ts`(4:3 창)
- `app/src/preload/` 화면이 받을 수 있는 이벤트 허용 목록
- `app/src/renderer/src/` 화면(React). `wizard/` `home/` `notes/` `preview/` `settings/` `components/`(공용 부품) `styles/tokens.css`(색·치수 변수) `platform.ts`(OS별 낱말)
- `app/src/cli/` 화면 없는 실행과 벤치
- `app/test/` node:test, 합성 데이터만. `app/e2e/` Playwright 첫 실행 시험
- `app/resources/` 아이콘, 속도 재기 샘플. 설치본의 whisper-cli·ffmpeg는 `resources/bin/`(electron-builder `extraResources`)
- `scripts/` whisper·ffmpeg 빌드·내려받기. `dev/` 벤치 보조(Python은 여기만)
- `docs/decisions.md` 실험·결정 기록. `docs/internals/` 구조와 빌드의 배경. `docs/plans/` 끝난 계획과 남은 할 일
- 생성·캐시(직접 고치지 않는다): `.cache/`(빌드한 whisper·ffmpeg), `app/out/`, `dist/`, `app/resources/icon.ico`·`icon.icns`(`node scripts/icon.mjs`로 다시 만든다)
- 데이터 폴더(저장소 밖): Windows `%LOCALAPPDATA%\lecture-notes`, macOS `~/Library/Application Support/lecture-notes`. `LN_DATA_DIR`로 바꿔 첫 실행을 따로 시험한다. 경로 규칙은 `core/paths.ts`.

## 변경 지도

- 화면에서 부를 처리 추가 → `main/index.ts`의 `handlers`에 넣고 화면은 `renderer/src/api.ts`로 부른다. 메인→화면 알림은 `api:event`이고 preload 허용 목록에 이름을 넣어야 받는다. 처리 오류는 `EngineError`로 던진다(IPC가 `[코드]` 접두로 전달).
- 설정 항목 추가 → `core/settings.ts`(타입·기본값) → `main/index.ts`의 `handlers`에 그 항목용 `settings.setX` 추가(범용 `settings.update`는 없다. `settings.setTheme`가 본보기) → `renderer/src/settings/Settings.tsx`의 해당 섹션. 작업이 읽는 값이면 `core/job.ts`의 `JobSettings`에 넣고, 작업을 만드는 두 곳(`main/jobs.ts`의 `createJob`, `cli/cli.ts`)에서 스냅샷으로 넣는다(설정을 바꿔도 진행 중인 작업은 그대로). 옛 `settings.json`·`job.json`에 없는 값은 기본값으로 읽혀야 한다.
- 노트 파일 이름 모양(`<날짜> <제목>.md`) → 세 곳이 같은 규칙을 공유한다: `core/note.ts`(만들기), `core/noteedit.ts`(제목·날짜 수정 때 다시 만들기), `core/recent.ts`의 `DATED`(목록에서 되읽기). 하나를 바꾸면 셋 다, 그리고 옛 이름도 계속 읽혀야 한다.
- 요약 서비스 추가 → `core/providers.ts`의 `PRESETS` → `core/llm.ts`의 `chat` 분기(형식이 다르면 `anthropic.ts`처럼 별도 모듈) → `test/providers.test.ts`에 가짜 응답 테스트.
- 모델 추천·단가·숨김 변경 → 코드가 아니라 `src/core/modelcatalog.json`의 값과 `updated`. `main`에 올라가면 설치본이 받는다.
- whisper-cli 옵션 → `core/sttargs.ts`(기본값, 잠긴 옵션) → `stt/whispercpp.ts`. 새 STT 엔진은 `SttEngine`만 따르면 된다.
- 작업 단계 추가 → `core/job.ts`의 단계 목록. 끝난 단계 건너뛰기와 옛 `job.json` 호환을 깨지 않는다.
- 화면 색·치수 → `styles/tokens.css`의 변수만. 부품 안에서 색·치수를 직접 쓰지 않는다. OS별 문구 → `renderer/src/platform.ts`, 메인 쪽은 `main/index.ts`의 `MAC`·`PC_OBJ`.
- 데이터 폴더 이름 → `core/paths.ts`의 `APP_NAME`과 `app/installer.nsh`를 함께 바꾼다.
- 경계: `core/`는 electron을 모른다. 강의에서 나온 파일은 데이터 폴더에만 쓴다. API 키는 `job.json`에 넣지 않고 실행할 때 `JobContext`로 받는다.

## 컨벤션

- 사용자에게 보이는 메시지, 코드 주석, 커밋 메시지는 한국어. 커밋 제목은 `영역: 무엇을 했는지 한 문장`(예: `설정: 데이터 폴더 경로를 OS에 맞게 보임`).
- `core/`의 상대 import에는 `.ts` 확장자를 붙이고 타입은 `import type`으로(type stripping, tsconfig `erasableSyntaxOnly`).
- JSON 파일은 `files.ts`의 `writeJsonAtomic`으로 쓴다(Windows 백신 잠금 재시도). 외부 실행 파일은 `proc.ts`의 `runCapture`로 돌린다.
- 파생 파일 이름은 확장자 바꾸기로 만들지 않고 고정 이름이나 문자열 연결을 쓴다. 사용자 파일 이름에는 점이 흔하다(`9.14 Lexical Analysis`).
- 코드 주석에서 결정의 근거를 가리킬 때는 `docs/decisions.md`의 절 제목을 적는다.

## 함정

- 앱은 하나만 뜬다(`requestSingleInstanceLock`). `npm run dev`, 설치본, `LN_DATA_DIR`로 띄운 것이 서로 막으므로 시험 전에 떠 있는 것을 끈다(작업 중이면 트레이에 숨어 있다).
- whisper-cli는 `-np`여도 stdout에 전사를 쓴다. stdout은 `ignore`, 진행은 stderr의 `progress = N%`만 읽는다(파이프가 차면 멈춤). 인자는 ANSI 코드 페이지로 받으므로 경로는 cwd 기준 상대 경로로, 한글 인자는 응답 파일(`@파일`, 한 줄에 하나, UTF-8)로 넘긴다.
- 노트북 내장 GPU(Radeon, Vulkan)는 느리고 전사가 깨진다. GPU 사용은 `probe.ts`가 속도와 CER을 실측해 정한다. 코드로 단정하지 않는다.
- `.cache/ffmpeg`는 저장소에 없다. `dist:win`이나 `notices.mjs` 전에 `fetch_ffmpeg.ps1`로 받는다.
- Claude 데스크톱 앱(MSIX) 안에서 띄운 프로세스가 `%LOCALAPPDATA%`에 쓴 파일은 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\lecture-notes\`로 가상화된다. 사용자가 자기 터미널에서 띄운 앱은 그 파일을 못 본다. 사용자 앱이 쓸 모델·데이터는 사용자 터미널에서 받게 한다.
- macOS 러너·VAD 스레드·임시 서명 같은 빌드·CI 함정은 [docs/internals/build-and-ci.md](docs/internals/build-and-ci.md).

## 문서

- 실험 결과와 결정: `docs/decisions.md`에 `### 제목 (M/D, 기기)` 절로 추가한다. 읽을 때는 절 제목을 검색해 해당 절만 읽는다(900줄이 넘는다. 통째로 올리지 않는다).
- 모듈별 동작과 화면 설계 원본(claude.ai artifact 링크): `docs/internals/architecture.md`. 고치려는 모듈 항목만 읽는다.
- 빌드·외부 실행 파일·CI: `docs/internals/build-and-ci.md`. 그것들을 바꾸기 전에만.
- 남은 할 일과 아직 못 본 것: `docs/plans/2026-10-12-status.md`. 새 계획은 `docs/plans/YYYY-MM-DD-<이름>.md`로 두고, 끝나도 지우지 않는다.
- 사용자용 설명(설치, 사양, 크레딧): `README.md`. 사용자에게 보이는 동작이 바뀌면 같은 PR에서 고친다.
- 구조·경계·명령어가 바뀌면 같은 PR에서 이 파일과 해당 `internals` 문서를 고친다.

이 문서의 규칙이 지금 작업과 충돌하면 멈추고 사람에게 알린다.
