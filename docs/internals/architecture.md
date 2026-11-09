# 구조 (영역별)

언제 읽나: `app/src/` 안의 모듈을 고치거나 새 모듈을 넣기 전에, 고치려는 영역의 절만 읽는다. 여기에는 파일이 어디 있고 무엇을 맡는지와, 파일 둘 이상에 걸친 약속만 둔다. 파일 하나가 혼자 하는 일과 그 까닭은 그 파일의 머리 주석에 있고 여기 되풀이하지 않는다. 폴더 지도·변경 지도·금지 사항은 [AGENTS.md](../../AGENTS.md), 결정의 이유와 실험 수치는 [decisions.md](../decisions.md), 빌드·외부 실행 파일·CI는 [build-and-ci.md](build-and-ci.md).

`app/`로 시작하지 않는 경로는 `app/src/` 기준이다. 괄호 안 날짜(M/D)는 2026년의 구현 시점이다. 구조나 경계가 바뀌면 그 PR에서 해당 절을 고친다.

## 화면 설계의 원본

화면 흐름·배치·문구·색은 claude.ai artifact **lecture-notes 설계 모음**이 기준이다: https://claude.ai/artifact/P82LYdRRnFqYerPEo7YDxX

- 탭: 구현 계획(`#plan`), 화면 흐름(`#flow`: 설치부터 미리보기까지 와이어프레임, 오류 문구, 질문 표), 홈 시안(`#home`), 작업 목록 시안(`#jobs`), 노트 목록 시안(`#notelist`), 노트 미리보기 시안(`#preview`), 설정 시안(`#settings`), 최종 색(`#colors`)
- 고치는 법: `Artifact` 도구 `action: "read"`로 받은 HTML의 `const DATA = {...}`(문서별 HTML이 `DATA.docs.<탭 id>`에 JSON 문자열로 들어 있음)에서 해당 탭만 바꿔 같은 `url`로 다시 올린다. 두 시안에 같은 Pretendard 글꼴은 한 번만(`DATA.font`, 문서 안에서는 `__FONT__` 자리표시) 들어 있다.

## core 공통

`core/`는 처리 로직이고 electron을 모른다. 메인, CLI(`cli/`), 테스트(`app/test/`)가 같은 코드를 쓴다(import 규칙은 AGENTS.md 컨벤션). 작은 공용 모듈: `core/files.ts`(`writeJsonAtomic`, 파일 이름 정규화 `diskName`), `core/proc.ts`(`runCapture`), `core/errors.ts`(`EngineError`), `core/paths.ts`(데이터 폴더, whisper-cli·ffmpeg 찾기), `core/brand.ts`(제품 이름), `core/hardware.ts`(물리 코어·전원), `core/vault.ts`(저장 폴더 검사), `core/compare.ts`(CER, 벤치와 공용).

## 처리 파이프라인(작업)

- `core/job.ts`: 작업 하나를 `audio→stt→clean→polish→summarize→note→save` 단계로 돌리고 `<데이터 폴더>/jobs/<id>/job.json`에 단계 상태를 남긴다. API 키는 `job.json`에 넣지 않고 `JobContext`로 받는다. 단계별 담당은 `core/audio.ts`+`core/wav.ts`(16kHz WAV, 10분 조각), `stt/`, `core/clean.ts`·`core/corrections.ts`, `core/polish.ts`, `core/summarize.ts`, `core/note.ts`.
- 다시 시작할 때 건너뛸 조각은 각 모듈이 작업 폴더에 남긴다: 받아쓰기 `part_NNN.json`과 ChatKHU의 `stt/<조각>.op.json`, 다듬기 `polish/part_NNN.json`. 단계 상태는 `job.json`. 끝난 조각·단계를 다시 하지 않는 것은 AGENTS.md 우선순위 3.

## 받아쓰기

- `core/stt/base.ts`: `SttEngine` 인터페이스와 공통 흐름 `transcribeChunks`(조각별 저장·합치기, 누락 구간 다시 받아쓰기 `fillGaps`). 엔진은 `core/stt/whispercpp.ts`(whisper-cli)와 `core/stt/chatkhu.ts`(ChatKHU 받아쓰기, Soniox).
- ChatKHU 받아쓰기 작업(`settings.sttService`가 `chatkhu`. 설정 `chatkhuStt` + ChatKHU 연결, 메인의 `sttService()`)은 받아쓰기 모델·속도 재기·녹음 중 멈춤을 기다리지 않는다. 멈추면 작업 목록의 [이 PC에서 받아쓰기] 단추로 돌린다(`runner.localStt`). 크레딧은 `job.cost.sttCredits`.
- `core/sttargs.ts`: whisper-cli 옵션의 기본값과 잠긴 옵션. 저장 전 검사 `checkArgs`는 `core/stt/whispercpp.ts`에, [샘플로 시험하기] `testSample`은 `core/probe.ts`에 있다.
- `core/probe.ts`: 속도 재기. 장치별로 샘플을 돌려 쓸 장치와 RTF를 정해 `<데이터 폴더>/probe.json`에 남기고, `run --device auto`(기본)가 읽는다. 진행 상태는 `main/setup.ts`가 든다.
- `core/recommend.ts`(10/11): 받아쓰기 모델 자동 선택(설정 `sttAuto`. 처음에는 `firstModel`, 속도 재기 뒤에는 `afterProbe`).
- `core/downloads.ts`+`core/models.ts`: 모델 목록(URL·크기·sha256)과 이어받기.

## 요약·LLM

- 입구는 `core/llm.ts`의 `chat`. 옵션의 `service`가 Claude면 `core/anthropic.ts`, `ollama`가 있으면 `core/ollama.ts`로 넘기고 나머지는 OpenAI 호환으로 부른다.
- `core/providers.ts`: 서비스 목록(`ProviderId`·`PROVIDERS`), 주소·기본 모델(`PRESETS`), 크레딧 여부(`usesCredits`: ChatKHU만), 단계별 대상 결정 `resolveSteps`(설정 → 작업의 `settings.llm`·`settings.polishLlm`). 한 번에 한 서비스만 연결한다(`settings.provider`, 키는 서비스별로 `secrets.json`에 남음).
- 로컬 LLM(Ollama, 10/2) 단계는 API 키 없이 돌고 크레딧을 적지 않는다. 화면은 `llm.status`의 `summary`·`polish`로 요약을 할 수 있는지·무엇으로 하는지를 본다(`provider`는 키로 연결한 서비스일 뿐). 화면 `renderer/src/settings/OllamaBlock.tsx`, 핸들러 `ollama.get`·`ollama.save`·`ollama.test`.
- 크레딧: 작업의 크레딧은 응답 토큰 수 × 단가(`core/llmcatalog.ts`의 `creditsFromTokens`, 단가는 `core/modelcatalog.json`의 `prices`). ChatKHU가 아닌 서비스는 토큰 수(`job.usage`)만 남긴다. 잔액은 `core/credits.ts`, 작업 기록으로 재는 모델별 90분 크레딧은 `core/providers.ts`의 `creditsPer90ByModel`.
- 모델 목록·추천·숨김: `core/llmcatalog.ts`가 `core/modelcatalog.json`을 읽고 `core/catalogsync.ts`가 `main`의 같은 파일로 갱신한다(값 고치는 법과 금지는 AGENTS.md). 화면은 `renderer/src/settings/ModelPicker.tsx`(요약·다듬기 공용, 핸들러 `llm.models`·`llm.steps`. ChatKHU가 아니면 추천 없이 서비스의 글 모델 목록 `plainModels`).
- `core/summarize.ts`·`core/prompts.ts`: 요약 호출과 프롬프트. 사용자가 고친 프롬프트(설정 `summaryExtra`·`summaryPrompt`, 10/7)는 작업 시작 때 `JobContext.summaryPrompt`로 들어간다. 화면 `renderer/src/settings/SummaryPrompt.tsx`, 핸들러 `prompt.get`·`prompt.save`.
- `core/polish.ts`: 선택 기능 전사문 다듬기(원문으로 돌아간 조각 수는 `job.polish`, 작업 목록에 보임). `core/verify.ts`: 교정 검증(CLI 전용). `core/clean.ts`·`core/corrections.ts`: 전사문 정리와 교정.

## 노트·입력

- `core/note.ts`(만들기·저장), `core/noteedit.ts`(제목·과목·날짜 수정), `core/recent.ts`(저장 폴더의 노트 목록)가 노트 파일 이름 규칙을 공유한다(AGENTS.md 변경 지도, `app/test/notename.test.ts`). 노트는 `<저장 폴더>/<과목|미분류>/<날짜> <제목>.md`.
- `core/inputs.ts`: 녹음 옆 필기 찾기(`pairInputs`)와 나중에 붙이기(`attachNotes`). `core/doctext.ts`: 문서 필기(.hwpx·.docx·.pptx)에서 글자 뽑기.
- 노트 수정·삭제: 메인 `notes.editInfo`·`notes.edit`·`notes.delete`가 파일과, 그 노트를 만든 작업의 기록(`output.notePath`·`input.subject`·`edits`)을 함께 고쳐 [요약 다시 만들기]가 옛 경로나 옛 값으로 돌아가지 않게 한다(`runner.noteEdited`·`noteDeleted`·`noteBusy`). 화면은 노트 목록 줄과 미리보기 버튼 줄의 [...] 메뉴(`components/MoreMenu`)에서 `notes/NotePropsDialog`·`notes/NoteDeleteDialog`를 연다.
- 녹음 이름에서 온 노트 제목·`source`와 노트 목록의 제목은 어디서나 NFC다(macOS의 Finder는 NFD로 준다. `core/files.ts`의 `diskName`).

## 메인·실행기

- `main/index.ts`: 화면이 부를 처리의 허용 목록 `handlers`(`api:call`)와 메인→화면 알림 `api:event`(preload 허용 목록에 있는 것만). 창·트레이·메뉴·자동 실행·OS 분기 같은 Electron 쪽도 여기.
- `main/jobs.ts`(실행기 `runner`): 작업을 한 번에 하나씩 돌리고 `jobs` 이벤트로 알린다. 모델이 없으면 `setup.whenReady()`로 받고 속도를 잰 뒤 시작한다. 녹음 중 멈춤(`holdStt`·`holdNow`), ChatKHU 받아쓰기, 앱 종료(`shutdown`), 노트 수정·삭제와의 얽힘은 이 파일의 주석.
- `main/setup.ts`: 모델 받기와 속도 재기 상태. 작업이 받아쓰기 중이면(`runner.transcribing()`) 속도 재기를 미룬다.
- 자동 처리(폴더 감시): `core/watch.ts`(판단과 기록 `<데이터 폴더>/watch.json`) → `main/watcher.ts`(폴링, `runner.start`) → `main/tray.ts`(멈추기/다시 시작). 설정 `settings.watch`, 화면 `renderer/src/settings/AutoSection.tsx`. 켜져 있으면 창을 닫아도 트레이에 남고, PC를 켤 때 자동 실행은 설치본에서만 된다.
- 앱에서 녹음하기: 화면 `renderer/src/home/recording.ts`(React 밖 상태, MediaRecorder)+`renderer/src/home/Recorder.tsx` → 메인 `main/recorder.ts`(`<데이터 폴더>/recordings/`에 덧붙여 쓰기) → `core/recordings.ts`(끝내기·복구·`processed.json`). 녹음 중 받아쓰기를 멈추는 것은 `runner`(설정 `sttWhileRecording`이면 안 멈춤). 실험 기능 토글(`sttWhileRecording`·`chatkhuStt`)은 `renderer/src/settings/AdvancedSection.tsx`.
- `main/fit.ts`: 4:3 창 크기(electron 없이 시험). `main/log.ts`·`main/secrets.ts`: 아래 데이터·설정·로그.

## 화면

규칙(색·치수 토큰, 창 맨 위 띠, 4:3, OS별 낱말, 폴더 목록, 메인과의 통신)은 [app/src/renderer/AGENTS.md](../../app/src/renderer/AGENTS.md). 흐름·배치·문구는 위 "화면 설계의 원본". 화면이 쓰는 순수 로직은 파일로 빼서 테스트한다(`renderer/src/preview/markdown.ts`·`renderer/src/preview/find.ts`·`renderer/src/notes/filter.ts` → `app/test/preview.test.ts`).

- `renderer/src/home/ConfirmDialog.tsx`(10/3): 시작 전 확인. 과목 칸·언어, 끌어 옮기기, 첫 안내(`Intro`, 설정 `confirmIntroSeen`, 핸들러 `settings.introSeen`). 필기는 `inputs.pickNotes`.
- `renderer/src/home/Shell.tsx`: 사이드바와 화면 전환. 미리보기는 앞 화면을 숨긴 채 열어 돌아가면 상태가 그대로다.
- `renderer/src/preview/NotePreview.tsx`+`renderer/src/preview/markdown.ts`: 노트 미리보기. [요약 다시 만들기]는 `runner.resummarize`(같은 파일에 덮어쓰고 제목이 바뀌면 파일 이름도 바꾸며, 미리보기는 `onMoved`로 따라감).
- `renderer/src/home/Recorder.tsx`: 녹음 시작 창·녹음 중 카드. 첫 안내는 설정 `recordIntroSeen`(10/11).

## 데이터·설정·로그

- 데이터 폴더: Windows `%LOCALAPPDATA%\lecture-notes`, macOS `~/Library/Application Support/lecture-notes`. 안에 `models/` `jobs/` `recordings/` `logs/` `bench/`와 `settings.json` `secrets.json` `probe.json` `watch.json` `model-catalog.json`. 경로 규칙은 `core/paths.ts`, 개발 중에는 `LN_DATA_DIR`(CLI는 `--data-dir`). 강의에서 나온 파일은 여기와 저장 폴더에만 쓴다.
- 설정 `core/settings.ts`(필드마다 주석). 키는 `main/secrets.ts`(safeStorage로 암호화, 화면에는 끝 4자리만. 풀지 못하면 연결 안 된 것으로 봄).
- 로그 `main/log.ts`(`logs/YYYY-MM-DD.log`, 14일치)와 테스터 로그용 한 줄 JSON(`core/joblog.ts`, 10/12). 키·전사·요약 내용은 적지 않는다.
- Windows에서 제거할 때 데이터 폴더를 지울지는 `app/installer.nsh`가 묻는다(10/13). macOS는 제거 프로그램이 없어 README에 지울 폴더만 적었다. 폴더 이름은 `core/paths.ts`의 `APP_NAME`과 `app/installer.nsh`에 같이 있다.

## 플랫폼(macOS)

Apple Silicon만(10/8). 목표는 Windows 앱과 같게 도는 것이다. OS 분기는 세 곳에 모인다: 화면 낱말 `renderer/src/platform.ts`, 메인 낱말·창 버튼·메뉴·알림·자동 실행 `main/index.ts`(`MAC`·`PC_OBJ`·`TRAY_ICON`), 받아쓰기 장치 `core/probe.ts`·`core/stt/whispercpp.ts`·`core/hardware.ts`(Metal, 성능 코어). 뺀 기능: 컴퓨터 소리 녹음(Electron `loopback`이 Windows만), 바탕화면 바로가기. 패키징·서명·러너 함정은 build-and-ci.md.

## 빌드·CLI

- 모두 `app/`에서 `npm run cli -- <명령>`으로 돌린다. `cli/cli.ts`: 화면 없는 실행. `run <녹음> --out <저장 폴더> [--subject 과목] [--device gpu0]`, `resume <작업 ID>`, `probe [--sample <16kHz 모노 WAV>]`, `models download <이름...>`. `cli/bench.ts`: S3 벤치 `bench --audio <녹음> --ref <기준 JSON> --config wcpp:small-q5_1:cpu`(RTF와 기준 전사 대비 CER). `cli/llmbench.ts`: 요약 모델 비교 `llm models`, `llm bench --text <전사.txt> --models <모델,...>`(키는 환경변수 `LN_API_KEY`). 벤치 결과는 강의 내용이라 데이터 폴더의 `bench/`에만 쓴다.
- `app/scripts/icon.mjs`(`resources/icon.ico`·`icon.icns`, 10/3. 설치 파일·창·트레이가 같은 파일을 씀), `app/scripts/notices.mjs`(오픈소스 고지. `.cache/`의 라이선스 파일에서 자동으로 만들므로 손으로 고치지 않는다. 빌드하는 OS에 맞춤), `app/electron-builder.yml`, `app/e2e/first-run.mjs`(Playwright 첫 실행 시험, CI의 macOS 작업). 빌드 흐름은 build-and-ci.md.
