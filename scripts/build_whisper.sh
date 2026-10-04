#!/usr/bin/env bash
# macOS(Apple Silicon)용 whisper.cpp를 배포용 옵션으로 빌드해 .cache/whisper/bin 에 모은다 (로컬과 CI가 같이 쓴다).
# Windows의 build_whisper.ps1과 같은 고정 커밋을 쓴다. 커밋을 바꿀 때는 둘을 함께 바꾼다.
#
#   bash scripts/build_whisper.sh [whisper.cpp 체크아웃]
#   체크아웃을 생략하면 고정 커밋을 .cache/whisper-src 에 받는다.
#
# 옵션을 이렇게 둔 이유
#   BUILD_SHARED_LIBS=OFF            실행 파일 하나로 만든다 (dylib 경로와 서명할 파일이 늘지 않게).
#   GGML_METAL_EMBED_LIBRARY=ON      Metal 셰이더를 실행 파일에 넣는다 (default.metallib을 따로 배포하지 않게).
#   GGML_NATIVE=OFF                  빌드한 Mac의 CPU에 묶이지 않게 한다.
#   GGML_OPENMP=OFF                  Homebrew의 libomp가 있으면 그 dylib에 묶여 다른 Mac에서 안 돈다.
#   Core ML은 넣지 않는다              인코더 모델을 따로 받아야 하고 첫 실행 때 변환이 오래 걸린다.
set -euo pipefail

COMMIT="1da4dc82fa7996d4edda05890dca65aeceaafd6d"
# 이 버전보다 옛 macOS에서는 실행되지 않는다. Electron이 지원하는 최소 버전과 맞춘다
export MACOSX_DEPLOYMENT_TARGET="12.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.cache"
BUILD_DIR="$CACHE/whisper-build"
OUT_DIR="$CACHE/whisper/bin"
SOURCE_DIR="${1:-}"

[ "$(uname -s)" = "Darwin" ] || { echo "macOS에서만 돌린다 (Windows는 build_whisper.ps1)" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "Apple Silicon(arm64)만 지원한다: $(uname -m)" >&2; exit 1; }
command -v cmake >/dev/null || { echo "cmake가 없다 (brew install cmake)" >&2; exit 1; }

if [ -z "$SOURCE_DIR" ]; then
  SOURCE_DIR="$CACHE/whisper-src"
  if [ ! -d "$SOURCE_DIR/.git" ]; then
    mkdir -p "$SOURCE_DIR"
    git -C "$SOURCE_DIR" init -q
    git -C "$SOURCE_DIR" remote add origin https://github.com/ggml-org/whisper.cpp.git
  fi
  git -C "$SOURCE_DIR" fetch -q --depth 1 origin "$COMMIT"
  git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD
fi
HEAD="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[ "$HEAD" = "$COMMIT" ] || { echo "whisper.cpp 커밋이 다르다: $HEAD (필요: $COMMIT)" >&2; exit 1; }

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF
cmake --build "$BUILD_DIR" --target whisper-cli -j "$(sysctl -n hw.ncpu)"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/bin/whisper-cli" "$OUT_DIR/"
cp "$SOURCE_DIR/LICENSE" "$OUT_DIR/LICENSE-whisper.cpp.txt"

# 시스템에 원래 있는 것(/usr/lib, /System) 말고 다른 dylib에 묶였으면 다른 Mac에서 안 돈다
if otool -L "$OUT_DIR/whisper-cli" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/)'; then
  echo "whisper-cli가 위 dylib에 묶여 있다 (다른 Mac에 없는 파일)" >&2
  exit 1
fi
"$OUT_DIR/whisper-cli" --help >/dev/null 2>&1 || { echo "whisper-cli 실행 확인 실패" >&2; exit 1; }
ls -lh "$OUT_DIR"
