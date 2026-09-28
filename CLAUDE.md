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
- `src/main/index.ts`: 화면이 부를 수 있는 처리를 `handlers`(허용 목록)에 두고 `api:call` IPC로 연다.
- 데이터 폴더는 `%LOCALAPPDATA%\lecture-notes`(`models/`, `bench/`, 이후 `jobs/`)다. 강의 녹음에서 나온 파일은 여기에만 쓴다.
- `audio.ts` + `wav.ts`: 16kHz 모노 WAV로 바꾼 뒤 약 10분마다 무음 지점에서 조각(`chunks/part_NNN.wav`)으로 나누고 원본 WAV는 지운다.
- `stt/base.ts`의 `transcribeChunks`: 조각별 결과를 `part_NNN.json`으로 저장해 끝난 조각은 다시 돌리지 않고, 조각 시작 시각만큼 밀어 하나로 합친다. 엔진 구현(`stt/whispercpp.ts`)은 `SttEngine`만 따르면 된다.
- `downloads.ts` + `models.ts`: 모델 URL·크기·sha256 목록과 `.part` 이어받기.
- `clean.ts`(반복·환각 정리), `corrections.ts`(교정 목록 적용), `llm.ts`·`summarize.ts`·`prompts.ts`(요약 호출 1회), `credits.ts`, `providers.ts`.
- `src/cli/bench.ts`: S3용. RTF와, 기준 전사(기존 파이프라인의 large-v3 결과) 대비 CER을 잰다.

## 지금 상태와 다음 할 일 (9/28 노트북 세션 끝)

계획과 진행은 claude.ai artifact 두 개에 있다(`Artifact` 도구 `action: "read"`로 읽고, 고칠 때는 `url`을 넘겨 같은 artifact를 갱신한다).

- 구현 계획: https://claude.ai/artifact/QEe654uyQBhZaYgXfY5xsd (일정, 완료 기준, 결정 기록, 접힌 "구조 전환 검토")
- 화면 흐름 초안: https://claude.ai/artifact/16v7z6VAGTSd9miaCUxQZ4 (설치부터 미리보기까지 와이어프레임, 오류 문구, 열린 질문 9개)

S3는 9/28에 정했다: 로컬 STT는 whisper.cpp, CPU 기본 `large-v3-turbo-q8_0` + greedy(`-bs 1`, 노트북 90분 강의 약 27분). 앱의 기본 모델·옵션은 이것으로 둔다(`WhisperCpp`의 `beamSize: 1`).

사용자가 정해야 하는 것:

1. **화면 흐름의 열린 질문 9개.** 특히 마법사 순서('이 PC 확인'을 키보다 먼저), 창 닫기 동작, 요약 실패 시 [전사만 저장].

그다음 작업(M1, 10/4): 작업 저장·재개(job.json), 노트 작성·저장, CLI `run`/`resume`, 하드웨어 감지·예상 시간, 과목별 강의 언어(`-l`). 그 뒤 W2 화면은 화면 흐름 초안을 따른다.

남은 확인: S1 새 계정 설치와 SmartScreen 문구(내려받은 설치 파일이어야 뜸), 설치 파일에 ffmpeg LGPL 빌드 넣기, 첫 실행 속도 측정에서 결과가 정상인지 보는 검사(노트북 내장 GPU는 전사가 깨졌다).

PC별 메모: 노트북(Ryzen 7 5700U)에는 모델과 `tools/.venv`가 있고 설치본을 이 계정에 깔아 두었다. 벤치용 녹음·기준 전사는 저장소 밖 `C:\ljh\2026-2\s3-data\`에 있다. 데스크톱은 TypeScript 전환 전 상태라 pull 뒤 `app/`에서 `npm ci`를 하고, 남아 있는 옛 `engine/` 폴더(`.venv`, 캐시)를 지운다. faster-whisper 벤치가 필요하면 `tools/.venv`를 새로 만든다.

## Gotchas (고치지 말 것)

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
