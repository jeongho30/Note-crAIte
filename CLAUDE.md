# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

lecture-notes: 강의 녹음(+선택적 필기 .md/.txt)을 요약·주요 키워드·전사문이 담긴 마크다운 노트로 만드는 PC 설치형 앱 (ChatKHU 공모전, 마감 2026-10-24). 화면은 Electron(`app/`, W2부터), 처리는 전부 Python 엔진(`engine/`)이 맡고 둘은 stdin/stdout 한 줄 JSON으로 통신할 예정이다. 결정과 실험 결과는 `docs/decisions.md`에 적는다.

엔진 코드의 상당 부분은 작성자의 개인용 파이프라인 `C:\ljh\Coding\STT_AutoLectureNote\pipeline\`에서 옮겨 왔다. 그 폴더는 따로 계속 쓰이므로 여기서 수정하지 않는다.

## Commands

venv는 python.org판 Python 3.14로 만든다 (아래 Gotchas 참고).

```bash
C:/Python314/python.exe -m venv engine/.venv && engine/.venv/Scripts/python -m pip install -e "engine[dev,bench]"
```

```bash
engine/.venv/Scripts/python -m pytest engine/tests
```

```bash
engine/.venv/Scripts/python -m pytest engine/tests/test_audio.py::test_plan_chunks_cuts_at_longest_silence_near_target
```

```bash
powershell -File scripts/build_whisper.ps1 -SourceDir <whisper.cpp 체크아웃> [-NoVulkan]
```

```bash
engine/.venv/Scripts/python -m lnengine models download small-q5_1 silero-v6.2.0
```

```bash
engine/.venv/Scripts/python -m lnengine bench --audio <녹음> --ref <기준 whisper JSON> --start 600 --duration 600 --config wcpp:small-q5_1:cpu --config fw:small:cpu
```

`build_whisper.ps1`의 결과는 `.cache/whisper/bin/`에 모이고, 엔진은 개발 모드에서 그곳의 `whisper-cli.exe`와 PATH의 `ffmpeg`를 쓴다 (설치본은 `--bin-dir`).

## Architecture (지금까지)

- 데이터 폴더는 `%LOCALAPPDATA%\lecture-notes`(`models/`, `bench/`, 이후 `jobs/`)다. 강의 녹음에서 나온 파일은 여기에만 쓴다.
- `stages/audio.py`: 16kHz 모노 WAV로 바꾼 뒤 약 10분마다 무음 지점에서 조각(`chunks/part_NNN.wav`)으로 나누고 원본 WAV는 지운다.
- `stt/base.py`의 `transcribe_chunks`: 조각별 결과를 `part_NNN.json`으로 저장해 끝난 조각은 다시 돌리지 않고, 조각 시작 시각만큼 밀어 하나로 합친다. 엔진 구현(`stt/whispercpp.py`)은 `SttEngine` 프로토콜만 따르면 된다.
- `downloads.py` + `data/models.json`: 모델 URL·크기·sha256 목록과 `.part` 이어받기.
- `bench.py`: S3용. RTF와, 기준 전사(기존 파이프라인의 large-v3 결과) 대비 CER을 잰다.

## Gotchas (고치지 말 것)

- whisper-cli는 `-np`여도 전사 구간을 stdout으로 출력한다. stdout은 `DEVNULL`로 두고 stderr의 `progress = N%`만 읽는다 (파이프가 차면 멈춤, `tests/test_whispercpp.py`가 이를 검사).
- whisper-cli는 인자를 ANSI 코드 페이지로 받는다. 경로는 cwd 기준 상대 경로로 넘긴다. `-mc 0` + VAD는 긴 강의에서 같은 문장이 반복되며 내용이 사라지는 루프를 막는 설정이다.
- 이 PC의 `py -3.13`은 Microsoft Store판이라 `%LOCALAPPDATA%` 쓰기가 `...\Packages\PythonSoftwareFoundation...\LocalCache\`로 가상화된다. venv를 그 Python으로 만들지 않는다.
- `scripts/*.ps1`은 Windows PowerShell 5.1이 한글을 읽도록 UTF-8 BOM으로 저장한다. 네이티브 명령은 `Invoke-Checked`로 종료 코드만 본다.
- 사용자 파일 이름에는 점이 흔하다(예: `9.14 Lexical Analysis`). 파생 파일 이름에 `with_suffix`/`stem`을 쓰지 말고 고정 이름이나 문자열 연결을 쓴다.

## Conventions

- 공개 저장소다. 강의 녹음·전사·필기·노트·API 키를 커밋하지 않는다. 테스트는 합성 데이터만 쓴다(`.gitignore`가 오디오 확장자를 막는다).
- 사용자에게 보이는 메시지와 코드 주석은 한국어로 쓴다.
