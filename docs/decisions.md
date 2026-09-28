# 결정 기록

## 0주차 실험

### S3 로컬 STT 엔진 (진행 중)

- 판정 규칙: 노트북 결과가 기준이다. whisper.cpp의 가장 빠른 설정이 faster-whisper CPU보다 1.5배 넘게 느리지 않고 한국어 품질이 비슷하면 whisper.cpp로 통일한다.
- 측정 조건: 전원 연결, 앱이 실제로 쓸 스레드 수, 10분 샘플과 90분 강의. CER은 기존 파이프라인의 large-v3 결과를 기준으로 띄어쓰기·문장부호를 지우고 잰다(정답이 아니라 상대 비교용).
- 결과: (측정 후 기록)

### S2 ChatKHU 실측 (9/30 예정)

(측정 후 기록)

### S1 걷는 뼈대 (9/29 예정)

(측정 후 기록)

## 구현 결정

| 날짜 | 결정 | 이유 |
|---|---|---|
| 9/28 | 로컬 STT는 whisper.cpp 기준으로 짜고 S3로 확정 | 기존 명령과 반복 루프 해결책(`-mc 0` + VAD)을 그대로 쓰고 AMD·Intel·Mac GPU를 한 경로로 지원. faster-whisper가 이기면 `stt/` 어댑터 하나를 추가 |
| 9/28 | STT를 약 10분 무음 조각 단위로 저장 | 노트북 CPU로 오래 걸리는 STT를 전원·종료로 날리지 않게. 분할 코드는 ChatKHU STT 분할(110분 초과)에도 씀 |
| 9/28 | 엔진 Python은 python.org판 3.14 | 이 PC의 3.13은 Microsoft Store판이라 `%LOCALAPPDATA%` 쓰기가 가상화되고 PyInstaller 문제가 날 수 있음. 필요한 wheel(ctranslate2, onnxruntime, av)이 3.14용으로 모두 있음 |
| 9/28 | whisper.cpp는 공식 바이너리 대신 직접 빌드 | 공식 Windows x64 빌드는 CPU·BLAS·CUDA뿐이고 Vulkan이 없음 (커밋 1da4dc82의 `release.yml`) |
| 9/28 | MSVC 런타임 DLL을 whisper-cli 옆에 함께 배포 | `GGML_BACKEND_DL`은 DLL 여러 개로 나뉘어, 정적 CRT(/MT)면 DLL마다 힙이 따로 생겨 경계를 넘는 해제가 위험함 |
| 9/28 | `ggml-vulkan.dll`은 설치 파일에 포함 | artifact의 "GPU 파일은 필요할 때 다운로드"는 수백 MB인 CUDA 파일을 전제로 한 결정. S1에서 설치 파일이 너무 크면 다운로드로 바꿈 |
| 9/28 | Ollama는 네이티브 `/api/chat` | OpenAI 호환 엔드포인트는 요청마다 컨텍스트 길이를 못 정해, VRAM 24GB 미만에서는 4k로 잘림 (Ollama 문서) |
| 9/28 | 폴더 감시는 watchdog 대신 기존 폴링 | 클라우드 동기화 폴더에서 변경 이벤트가 누락될 수 있음. 기존 `watch_inbox.py` 방식은 검증됨 |
