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

## Gotchas (고치지 말 것)

- whisper-cli는 `-np`여도 전사 구간을 stdout으로 출력한다. stdout은 `ignore`로 두고 stderr의 `progress = N%`만 읽는다 (파이프가 차면 멈춤, `test/stt.test.ts`가 이를 검사).
- whisper-cli는 인자를 ANSI 코드 페이지로 받는다. 경로는 cwd 기준 상대 경로로 넘긴다. `-mc 0` + VAD는 긴 강의에서 같은 문장이 반복되며 내용이 사라지는 루프를 막는 설정이다.
- `app/package.json`에 `"type": "module"`을 넣지 않는다. electron-vite가 메인·preload를 ESM으로 만들게 되는데, sandbox preload는 CommonJS여야 한다. 그래서 Node로 `.ts`를 직접 돌릴 때는 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`을 붙인다(npm 스크립트에 들어 있음).
- 데스크톱의 `py -3.13`은 Microsoft Store판이라 `%LOCALAPPDATA%` 쓰기가 `...\Packages\PythonSoftwareFoundation...\LocalCache\`로 가상화된다. 벤치용 venv를 그 Python으로 만들지 않는다.
- `scripts/*.ps1`은 Windows PowerShell 5.1이 한글을 읽도록 UTF-8 BOM으로 저장한다. 네이티브 명령은 `Invoke-Checked`로 종료 코드만 본다.
- 사용자 파일 이름에는 점이 흔하다(예: `9.14 Lexical Analysis`). 파생 파일 이름을 확장자 바꾸기로 만들지 말고 고정 이름이나 문자열 연결을 쓴다.

## Conventions

- 공개 저장소다. 강의 녹음·전사·필기·노트·API 키를 커밋하지 않는다. 테스트는 합성 데이터만 쓴다(`.gitignore`가 오디오 확장자를 막는다).
- 사용자에게 보이는 메시지와 코드 주석은 한국어로 쓴다.
