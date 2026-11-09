# 빌드, 외부 실행 파일, CI

언제 읽나: whisper-cli·ffmpeg 빌드 스크립트(`scripts/`), `app/electron-builder.yml`, `.github/workflows/`를 바꾸기 전에. 설치 파일을 만들거나 CI 실패를 볼 때. 일상적인 코드 수정에는 필요 없다(명령어는 [AGENTS.md](../../AGENTS.md)).

2026-10-12 기준 CLAUDE.md에서 옮겼다.

## 설치, 캐시 위치, CI 흐름

npm 11은 의존 패키지의 설치 스크립트를 막아 `npm ci`만으로는 Electron 바이너리(`node_modules/electron/dist`·`path.txt`)가 안 생긴다. 그래서 `package.json`의 `postinstall`이 `node node_modules/electron/install.js`를 돌린다(10/1). 그래도 `npm run dev`가 `Error: Electron uninstall`로 멈추면 그 명령을 직접 돌린다.

`build_whisper.ps1`의 결과는 `.cache/whisper/bin/`에, `fetch_ffmpeg.ps1`(BtbN LGPL 빌드, 고정 태그·sha256)의 결과는 `.cache/ffmpeg/bin/`에 모인다. 개발 중에는 `.cache/whisper/bin`의 `whisper-cli.exe`와 PATH의 `ffmpeg`를 쓴다. 설치본은 둘 다 `resources/bin/`(electron-builder의 `extraResources`)에서 찾는다. 설치 파일은 `dist/installer/`에 생긴다. macOS(Apple Silicon)는 `build_whisper.sh`(같은 고정 커밋, Metal, 정적 링크)와 `build_ffmpeg.sh`(FFmpeg와 libopus를 고정 커밋으로 받아 LGPL로, 앱이 쓰는 기능만 넣어 약 6MB)가 같은 폴더에 만들고, `dist:mac`이 DMG를 임시(ad-hoc) 서명으로 만든다. CI(`.github/workflows/installer.yml`, 수동 실행 또는 `v*` 태그)는 whisper 빌드(캐시) → ffmpeg → 타입 검사·테스트 → 설치 파일을 만들어 아티팩트 `Note-crAIte-windows`로 올린다(Release에는 올리지 않음). macOS 작업은 같은 순서에 더해, 만든 whisper-cli·ffmpeg로 샘플을 실제로 받아써 보고(`cli probe`·`cli run`, 작은 모델), DMG를 만든 뒤 서명을 확인하고, 만든 앱을 띄워 `app/e2e/first-run.mjs`(Playwright: 첫 실행 마법사 → 녹음 고르기 → 작업 → 노트 미리보기 → 설정, 단계마다 화면 캡처)를 돌린다. 아티팩트는 `Note-crAIte-mac`(.dmg)와 `mac-screenshots`. 수동 실행의 `os` 입력으로 한쪽만 돌릴 수 있다(`gh workflow run installer.yml --ref <브랜치> -f os=macos`). `check.yml`은 브랜치에 push할 때마다(문서만 바뀐 push 제외) ffmpeg 받기 → 타입 검사 → 테스트만 돌린다(Windows와 macOS. macOS의 ffmpeg는 `build_ffmpeg.sh`로 만들어 캐시한다). vite는 electron-vite 5가 지원하는 7로 고정돼 있다(8로 올리지 않는다).

`dev/s3_laptop.ps1`은 빌드 도구가 없는 노트북에서 데스크톱의 whisper-cli를 복사해 와 S3 벤치(`cli bench`)를 여러 설정으로 돌린다.

벤치의 `fw:`(faster-whisper) 설정만 Python을 쓴다: `py -3.14 -m venv dev/.venv && dev/.venv/Scripts/python -m pip install -r dev/requirements-bench.txt`. 앱에는 Python이 들어가지 않는다.


## 빌드·CI에서 걸리는 것

- `scripts/*.ps1`은 Windows PowerShell 5.1이 한글을 읽도록 UTF-8 BOM으로 저장한다. 네이티브 명령은 `Invoke-Checked`로 종료 코드만 본다.
- 데스크톱의 `py -3.13`은 Microsoft Store판이라 `%LOCALAPPDATA%` 쓰기가 `...\Packages\PythonSoftwareFoundation...\LocalCache\`로 가상화된다. 벤치용 venv를 그 Python으로 만들지 않는다.
- `.cache/ffmpeg`는 저장소에 없어 PC마다 `fetch_ffmpeg.ps1`로 받아야 한다. `dist:win`이나 `notices.mjs`를 돌리기 전에 먼저 받는다.
- GitHub의 macOS 러너는 가상 머신이라 Metal(`Apple Paravirtual device`)이 CPU보다 느리다(10/8, 작은 모델로 39초 샘플: CPU 3.6초, Metal 20초). 러너에서 속도 재기가 CPU를 고르는 것은 정상이고, 실제 Mac의 Metal 속도는 러너로 알 수 없다. 러너 크기도 실행마다 다르다(5코어 M2 Pro, 3코어 M1).
- whisper의 VAD는 `-t`와 상관없이 스레드 4개로 돈다(whisper.cpp 안에 고정). macOS 빌드는 OpenMP 없이 ggml의 스레드 풀을 쓰는데, 코어가 4개보다 적으면 VAD가 수백 배 느려진다(10/8, 3코어 러너: 39초 샘플의 VAD만 약 220초, 5코어 러너는 1초 안쪽). 받아쓰기 스레드 수를 바꿔도 같다. Apple Silicon Mac은 모두 코어가 8개 이상이라 해당하지 않지만, 3코어 러너에서는 설치 파일 작업의 받아쓰기 단계마다 몇 분씩 걸린다.
- macOS 설치본은 서명이 임시(ad-hoc)라 받은 사람이 시스템 설정에서 [그래도 열기]를 눌러야 한다. Electron 44는 macOS 13부터다(`LSMinimumSystemVersion`). whisper·ffmpeg의 배포 대상은 12.0으로 그보다 낮게 둔다.
- `scripts/*.sh`는 LF로 둔다(`.gitattributes`). CRLF면 macOS에서 실행되지 않는다. 스크립트를 고치면 CI의 캐시 키(스크립트 해시)가 바뀌어 다시 빌드한다(whisper 약 1분, ffmpeg 약 3분).
