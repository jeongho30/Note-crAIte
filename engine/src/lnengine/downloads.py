"""모델 파일 다운로드: .part 이어받기(HTTP Range), 크기·sha256 확인 후 제자리에 옮긴다."""

import hashlib
import json
import os
import shutil
import threading
from importlib import resources
from pathlib import Path
from typing import Callable

import requests

from lnengine.errors import EngineError

CHUNK = 1 << 20

Progress = Callable[[int, int], None]


def catalog() -> dict:
    return json.loads(resources.files("lnengine").joinpath("data/models.json").read_text(encoding="utf-8"))


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def download(url: str, dest: Path, size: int, sha256: str,
             on_progress: Progress | None = None, cancel: threading.Event | None = None) -> Path:
    # 완성본은 검증을 통과한 .part를 옮긴 것뿐이라, 매번 수 GB를 다시 해시하지 않고 크기만 본다.
    if dest.exists() and dest.stat().st_size == size:
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0

    if have < size:
        if shutil.disk_usage(dest.parent).free < size - have:
            raise EngineError("disk", f"디스크 공간이 부족합니다 ({(size - have) / 1e9:.1f}GB 필요).")
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(url, headers=headers, stream=True, timeout=30) as resp:
                if resp.status_code == 200:
                    have = 0  # 서버가 Range를 무시하면 처음부터 받는다
                elif resp.status_code != 206:
                    raise EngineError("download", f"다운로드 실패 ({resp.status_code}): {url}")
                with open(part, "ab" if have else "wb") as f:
                    for chunk in resp.iter_content(CHUNK):
                        if cancel is not None and cancel.is_set():
                            raise EngineError("cancelled", "다운로드를 취소했습니다.")
                        f.write(chunk)
                        have += len(chunk)
                        if on_progress is not None:
                            on_progress(have, size)
        except requests.exceptions.RequestException as e:
            raise EngineError("network", f"다운로드 중 네트워크 오류가 났습니다. 다시 시도하면 이어서 받습니다: {e}") from e

    if part.stat().st_size != size or sha256_of(part) != sha256:
        part.unlink()
        raise EngineError("download", f"받은 파일이 손상됐습니다. 다시 받아 주세요: {dest.name}")
    os.replace(part, dest)
    return dest


def ensure_model(kind: str, name: str, models_dir: Path,
                 on_progress: Progress | None = None, cancel: threading.Event | None = None) -> Path:
    entries = catalog()[kind]
    if name not in entries:
        raise EngineError("input", f"모르는 모델입니다: {name}")
    e = entries[name]
    return download(e["url"], models_dir / e["file"], e["size"], e["sha256"], on_progress, cancel)
