import sys
import threading
import time
from pathlib import Path

import pytest

from lnengine.errors import EngineError
from lnengine.stt.whispercpp import WhisperCpp

FAKE = Path(__file__).with_name("fake_whisper_cli.py")


def make_engine(tmp_path: Path, gpu_device=None) -> WhisperCpp:
    model = tmp_path / "models" / "ggml-test.bin"
    model.parent.mkdir()
    model.write_bytes(b"")
    return WhisperCpp([sys.executable, str(FAKE)], model, vad_model=None, threads=2, gpu_device=gpu_device)


def run_with_timeout(fn, timeout: float = 30.0):
    box = {}

    def target():
        try:
            box["value"] = fn()
        except Exception as e:  # 스레드 밖에서 다시 던진다
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "whisper 어댑터가 멈췄습니다 (stdout 파이프가 찼을 가능성)"
    if "error" in box:
        raise box["error"]
    return box["value"]


def test_transcribe_drains_stdout_and_reports_progress(tmp_path):
    wav = tmp_path / "jobs" / "part_000.wav"
    wav.parent.mkdir()
    wav.write_bytes(b"")
    progress = []
    engine = make_engine(tmp_path)

    segments = run_with_timeout(lambda: engine.transcribe(wav, language="ko", on_progress=progress.append))

    assert segments == [
        {"start_ms": 0, "end_ms": 1500, "text": "안녕하세요"},
        {"start_ms": 2000, "end_ms": 3000, "text": "강의를 시작합니다"},
    ]
    assert progress[0] == 0.0 and progress[-1] == 1.0


def test_command_uses_relative_paths_and_device_flags(tmp_path):
    wav = tmp_path / "jobs" / "part_000.wav"
    cmd = make_engine(tmp_path).command(wav, "ko")
    assert cmd[cmd.index("-m") + 1] == str(Path("..") / "models" / "ggml-test.bin")
    assert cmd[cmd.index("-f") + 1] == "part_000.wav"
    assert cmd[cmd.index("-mc") + 1] == "0"
    assert "-ng" in cmd and "-dev" not in cmd

    gpu_dir = tmp_path / "gpu"
    gpu_dir.mkdir()
    gpu_cmd = make_engine(gpu_dir, gpu_device=1).command(wav, "ko")
    assert gpu_cmd[gpu_cmd.index("-dev") + 1] == "1" and "-ng" not in gpu_cmd


def test_failure_raises_with_stderr_tail(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_WHISPER_MODE", "fail")
    wav = tmp_path / "part_000.wav"
    wav.write_bytes(b"")
    with pytest.raises(EngineError) as e:
        make_engine(tmp_path).transcribe(wav, language="ko")
    assert e.value.code == "stt_failed"
    assert "failed to load model" in e.value.message


def test_cancel_kills_process(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_WHISPER_MODE", "hang")
    wav = tmp_path / "part_000.wav"
    wav.write_bytes(b"")
    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    started = time.monotonic()
    with pytest.raises(EngineError) as e:
        run_with_timeout(lambda: make_engine(tmp_path).transcribe(wav, language="ko", cancel=cancel))
    assert e.value.code == "cancelled"
    assert time.monotonic() - started < 10
