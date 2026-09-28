"""데이터 폴더와 외부 실행 파일(ffmpeg, whisper-cli)의 위치."""

import os
import shutil
import sys
from pathlib import Path

from lnengine.errors import EngineError

APP_NAME = "lecture-notes"
EXE = ".exe" if os.name == "nt" else ""
# 개발 모드에서만 쓰는 저장소 루트 (engine/src/lnengine/paths.py 기준). 설치본은 --bin-dir을 받는다.
REPO_ROOT = Path(__file__).resolve().parents[3]


def default_data_dir() -> Path:
    # 모델이 수 GB라 Windows에서는 Roaming이 아닌 Local에 둔다.
    if os.name == "nt":
        return Path(os.environ["LOCALAPPDATA"]) / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path.home() / ".local" / "share" / APP_NAME


def find_ffmpeg(bin_dir: Path | None) -> str:
    if bin_dir is not None and (bin_dir / f"ffmpeg{EXE}").exists():
        return str(bin_dir / f"ffmpeg{EXE}")
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise EngineError("ffmpeg", "ffmpeg를 찾을 수 없습니다.")


def find_whisper_cli(bin_dir: Path | None) -> Path:
    candidates = []
    if bin_dir is not None:
        candidates.append(bin_dir / "whisper" / f"whisper-cli{EXE}")
    candidates.append(REPO_ROOT / ".cache" / "whisper" / "bin" / f"whisper-cli{EXE}")
    for c in candidates:
        if c.exists():
            return c
    raise EngineError("stt_failed", "whisper-cli를 찾을 수 없습니다: " + ", ".join(map(str, candidates)))
