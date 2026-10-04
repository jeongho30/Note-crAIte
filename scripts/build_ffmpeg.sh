#!/usr/bin/env bash
# macOS(Apple Silicon)용 ffmpeg를 LGPL로, 앱이 쓰는 기능만 넣어 빌드해 .cache/ffmpeg/bin 에 둔다 (로컬과 CI가 같이 쓴다).
# Windows는 받아 쓰지만(fetch_ffmpeg.ps1) macOS용 LGPL 빌드는 믿고 받을 곳이 없어 직접 만든다.
#
#   bash scripts/build_ffmpeg.sh
#
# 넣는 것 (앱이 쓰는 곳)
#   읽기      모든 컨테이너(demuxer)와 소리 디코더. 영상 디코더는 뺀다 (-vn으로 소리만 꺼낸다)
#   쓰기      16kHz 모노 WAV(audio.ts), opus(ChatKHU 받아쓰기, stt/chatkhu.ts), webm 그대로 복사(recordings.ts)
#   필터      silencedetect(조각 나눌 무음 찾기)와 표본화·채널 바꾸기
# 새 입력 형식을 받게 되면(inputs.ts의 AUDIO_EXTS) 아래 DECODERS에 그 코덱이 있는지 본다.
set -euo pipefail

FFMPEG_TAG="n9.0.1"
FFMPEG_COMMIT="bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa"
OPUS_TAG="v1.5.2"
OPUS_COMMIT="ddbe48383984d56acd9e1ab6a090c54ca6b735a6"
# 이 버전보다 옛 macOS에서는 실행되지 않는다. build_whisper.sh와 같게 둔다
export MACOSX_DEPLOYMENT_TARGET="12.0"

DECODERS="aac,aac_latm,mp3,mp3float,mp2,mp2float,vorbis,opus,flac,alac,ac3,eac3,amrnb,amrwb,wmav1,wmav2,wmapro,wmalossless,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw,adpcm_ms,adpcm_ima_wav"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.cache"
SRC="$CACHE/ffmpeg-src"
OPUS_SRC="$CACHE/opus-src"
PREFIX="$CACHE/ffmpeg-deps" # libopus를 설치하는 곳
OUT_DIR="$CACHE/ffmpeg/bin"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

[ "$(uname -s)" = "Darwin" ] || { echo "macOS에서만 돌린다 (Windows는 fetch_ffmpeg.ps1)" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "Apple Silicon(arm64)만 지원한다: $(uname -m)" >&2; exit 1; }
for tool in cmake pkg-config make; do
  command -v "$tool" >/dev/null || { echo "$tool 이 없다 (brew install cmake pkgconf)" >&2; exit 1; }
done

# 고정 커밋을 얕게 받는다 (커밋 해시가 내용을 고정하므로 sha256 확인을 따로 하지 않는다)
fetch() { # <폴더> <저장소> <커밋>
  if [ ! -d "$1/.git" ]; then
    mkdir -p "$1"
    git -C "$1" init -q
    git -C "$1" remote add origin "$2"
  fi
  git -C "$1" fetch -q --depth 1 origin "$3"
  git -C "$1" checkout -q --detach FETCH_HEAD
  [ "$(git -C "$1" rev-parse HEAD)" = "$3" ] || { echo "커밋이 다르다: $1" >&2; exit 1; }
}
fetch "$OPUS_SRC" https://github.com/xiph/opus.git "$OPUS_COMMIT"
fetch "$SRC" https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_COMMIT"

# libopus (BSD): ffmpeg에 든 opus 인코더는 실험 단계라 품질이 낮다
rm -rf "$PREFIX"
cmake -S "$OPUS_SRC" -B "$CACHE/opus-build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DBUILD_SHARED_LIBS=OFF -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
cmake --build "$CACHE/opus-build" -j "$JOBS"
cmake --install "$CACHE/opus-build"

# --disable-autodetect: 이 Mac에 깔린 라이브러리(Homebrew 등)를 알아서 물지 않게 한다. zlib은 macOS에 원래 있다.
# GPL·nonfree 옵션을 켜지 않으므로 LGPL v2.1 이상이다.
CONFIGURE_ARGS=(
  --prefix="$CACHE/ffmpeg-build/install"
  --arch=arm64 --cc=clang
  --disable-shared --enable-static
  --disable-doc --disable-debug --disable-ffplay --disable-ffprobe
  --disable-autodetect --enable-zlib --enable-libopus
  --disable-network --disable-devices --disable-hwaccels
  --disable-swscale
  --disable-decoders "--enable-decoder=$DECODERS"
  --disable-encoders --enable-encoder=pcm_s16le,libopus
  --disable-muxers --enable-muxer=wav,ogg,webm,matroska,null
  --disable-filters --enable-filter=silencedetect,aresample,aformat,anull
  --disable-protocols --enable-protocol=file,pipe
  --pkg-config-flags=--static
)
mkdir -p "$CACHE/ffmpeg-build"
cd "$CACHE/ffmpeg-build"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" "$SRC/configure" "${CONFIGURE_ARGS[@]}"
make -j "$JOBS"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp ffmpeg "$OUT_DIR/ffmpeg"
strip "$OUT_DIR/ffmpeg"
cp "$SRC/COPYING.LGPLv2.1" "$OUT_DIR/LICENSE-ffmpeg.txt"
cp "$OPUS_SRC/COPYING" "$OUT_DIR/LICENSE-opus.txt"

# 시스템에 원래 있는 것(/usr/lib, /System) 말고 다른 dylib에 묶였으면 다른 Mac에서 안 돈다
if otool -L "$OUT_DIR/ffmpeg" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/)'; then
  echo "ffmpeg가 위 dylib에 묶여 있다 (다른 Mac에 없는 파일)" >&2
  exit 1
fi
VERSION="$("$OUT_DIR/ffmpeg" -hide_banner -version | head -n 1)"
case "$VERSION" in
  "ffmpeg version"*) ;;
  *) echo "ffmpeg 버전을 읽지 못했다: $VERSION" >&2; exit 1 ;;
esac
# GPL 부분이 섞였으면 재배포할 때 소스 제공 의무가 생긴다
if "$OUT_DIR/ffmpeg" -hide_banner -L 2>&1 | grep -q "GNU General Public License"; then
  echo "ffmpeg가 GPL로 빌드됐다" >&2
  exit 1
fi

cat > "$OUT_DIR/FFMPEG-SOURCE.txt" <<EOF
이 프로그램에 들어 있는 ffmpeg는 FFmpeg(https://ffmpeg.org)를 LGPL v2.1 이상으로 빌드한 것이다.
$VERSION

소스: https://github.com/FFmpeg/FFmpeg 의 $FFMPEG_TAG ($FFMPEG_COMMIT), 고치지 않고 빌드했다.
함께 넣은 라이브러리: libopus $OPUS_TAG (https://github.com/xiph/opus, $OPUS_COMMIT, BSD) — LICENSE-opus.txt
빌드 스크립트: https://github.com/jeongho30/Note-crAIte 의 scripts/build_ffmpeg.sh
configure 옵션: ${CONFIGURE_ARGS[*]:1}
라이선스 전문: LICENSE-ffmpeg.txt
EOF
echo "$VERSION"
ls -lh "$OUT_DIR"
