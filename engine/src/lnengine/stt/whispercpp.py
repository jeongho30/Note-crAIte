"""whisper.cpp(whisper-cli) 어댑터. pipeline/process_lecture.py의 transcribe()를 옮겨 온 것이다."""

import collections
import json
import os
import re
import subprocess
import threading
from pathlib import Path

from lnengine.errors import EngineError
from lnengine.stt.base import OnProgress

PROGRESS_RE = re.compile(r"progress\s*=\s*(\d+)%")
# 낮은 우선순위로 돌려 PC 사용을 덜 방해하고, 콘솔 창을 띄우지 않는다.
CREATION_FLAGS = (subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW) if os.name == "nt" else 0


def parse_whisper_json(path: Path) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    segments = []
    for seg in data.get("transcription", []):
        text = seg.get("text", "").strip()
        if not text:
            continue
        offsets = seg.get("offsets", {})
        segments.append({"start_ms": offsets.get("from", 0), "end_ms": offsets.get("to", 0), "text": text})
    return segments


def _arg_path(p: Path, cwd: Path) -> str:
    # whisper-cli는 인자를 ANSI 코드 페이지로 받는다. cwd 기준 상대 경로로 넘겨 사용자 이름 같은
    # 비ASCII 경로 조각을 피한다. 드라이브가 달라 상대 경로를 못 만들면 절대 경로를 쓴다.
    try:
        return os.path.relpath(p, cwd)
    except ValueError:
        return str(p)


def _kill_on_cancel(proc: subprocess.Popen, cancel: threading.Event) -> None:
    while proc.poll() is None:
        if cancel.wait(0.5):
            proc.kill()
            return


class WhisperCpp:
    def __init__(self, cli: list[str], model: Path, *, vad_model: Path | None, threads: int,
                 gpu_device: int | None, quiet: bool = True):
        self.cli = cli  # 실행 명령 (테스트에서는 가짜 스크립트)
        self.model = model
        self.vad_model = vad_model
        self.threads = threads
        self.gpu_device = gpu_device  # None이면 CPU만 쓴다
        self.quiet = quiet  # False면 -np 없이 돌려 백엔드 선택·처리 시간 로그를 last_log에 남긴다
        self.last_log: list[str] = []

    def command(self, wav: Path, language: str) -> list[str]:
        cwd = wav.parent
        cmd = [*self.cli,
               "-m", _arg_path(self.model, cwd),
               "-f", _arg_path(wav, cwd),
               "-l", language,
               "-t", str(self.threads),
               # 긴 강의에서 같은 문장을 반복 출력하며 내용을 통째로 날리는 루프를 막는다 (VAD와 함께).
               "-mc", "0",
               "-oj", "-of", _arg_path(wav, cwd),  # 결과: <wav 이름>.json
               "-pp"]
        if self.quiet:
            cmd.append("-np")
        cmd += ["-ng"] if self.gpu_device is None else ["-dev", str(self.gpu_device)]
        if self.vad_model is not None:
            cmd += ["--vad", "-vm", _arg_path(self.vad_model, cwd)]
        return cmd

    def transcribe(self, wav: Path, *, language: str, on_progress: OnProgress | None = None,
                   cancel: threading.Event | None = None) -> list[dict]:
        out_json = wav.with_name(wav.name + ".json")
        out_json.unlink(missing_ok=True)
        tail = collections.deque(maxlen=40)
        # 로그를 켜면 VAD가 구간마다 줄을 남겨 앞쪽의 백엔드 선택 줄이 밀려나므로 전부 보관한다.
        log = None if self.quiet else []
        # -np여도 전사 구간은 stdout으로 나온다 (whisper.cpp examples/cli/cli.cpp). 읽지 않으면
        # 파이프가 가득 차 whisper가 멈추므로 버리고, 결과는 -oj JSON 파일에서 읽는다.
        proc = subprocess.Popen(self.command(wav, language), cwd=wav.parent, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=CREATION_FLAGS)
        if cancel is not None:
            threading.Thread(target=_kill_on_cancel, args=(proc, cancel), daemon=True).start()
        for raw in proc.stderr:
            line = raw.decode("utf-8", errors="replace").rstrip()
            m = PROGRESS_RE.search(line)
            if m and on_progress is not None:
                on_progress(int(m.group(1)) / 100)
            elif line:
                tail.append(line)
                if log is not None:
                    log.append(line)
        rc = proc.wait()
        self.last_log = list(tail) if log is None else log
        if cancel is not None and cancel.is_set():
            raise EngineError("cancelled", "전사를 취소했습니다.")
        if rc != 0:
            raise EngineError("stt_failed", "whisper-cli 실행 실패:\n" + "\n".join(tail))
        if not out_json.exists():
            raise EngineError("stt_failed", f"whisper JSON 출력을 찾을 수 없습니다: {out_json}")
        return parse_whisper_json(out_json)
