"""STT 엔진 공통: 조각별로 전사해 저장하고, 조각 시작 시각만큼 밀어서 하나로 합친다."""

import threading
from pathlib import Path
from typing import Callable, Protocol

from lnengine.files import read_json, write_json_atomic

OnProgress = Callable[[float], None]


class SttEngine(Protocol):
    def transcribe(self, wav: Path, *, language: str, on_progress: OnProgress | None = None,
                   cancel: threading.Event | None = None) -> list[dict]:
        """[{start_ms, end_ms, text}]를 돌려준다."""
        ...


def transcribe_chunks(engine: SttEngine, chunks: list[dict], chunk_dir: Path, parts_dir: Path, *,
                      language: str, on_progress: OnProgress | None = None,
                      cancel: threading.Event | None = None) -> list[dict]:
    """끝난 조각(part_NNN.json)은 다시 돌리지 않는다. 앱이 꺼져도 끝난 조각부터 이어간다."""
    parts_dir.mkdir(parents=True, exist_ok=True)
    total = sum(c["end_s"] - c["start_s"] for c in chunks) or 1.0
    done = 0.0
    merged = []
    for i, c in enumerate(chunks):
        span = c["end_s"] - c["start_s"]
        part = parts_dir / f"part_{i:03d}.json"
        if part.exists():
            segments = read_json(part)
        else:
            def chunk_progress(frac: float, base: float = done, span: float = span) -> None:
                if on_progress is not None:
                    on_progress((base + frac * span) / total)

            segments = engine.transcribe(chunk_dir / c["file"], language=language,
                                         on_progress=chunk_progress, cancel=cancel)
            write_json_atomic(part, segments)
        offset = round(c["start_s"] * 1000)
        merged += [{**s, "start_ms": s["start_ms"] + offset, "end_ms": s["end_ms"] + offset} for s in segments]
        done += span
        if on_progress is not None:
            on_progress(done / total)
    return merged
