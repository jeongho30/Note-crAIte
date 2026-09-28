import shutil
import wave
from pathlib import Path

import pytest

from lnengine.stages.audio import parse_probe, parse_silences, plan_chunks, prepare_local, split_wav, wav_duration

PROBE_M4A = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'lecture.m4a':
  Metadata:
    major_brand     : mp42
    creation_time   : 2026-09-22T05:20:11.000000Z
  Duration: 01:17:17.45, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 127 kb/s (default)
      Metadata:
        creation_time   : 2026-09-22T05:20:12.000000Z
At least one output file must be specified
"""


def write_wav(path: Path, seconds: float, rate: int = 16000) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * round(seconds * rate))


def test_parse_probe_reads_duration_and_container_creation_time():
    info = parse_probe(PROBE_M4A)
    assert info["duration_s"] == pytest.approx(4637.45)
    assert info["creation_time"] == "2026-09-22T05:20:11.000000Z"
    assert info["has_audio"]


def test_parse_probe_without_duration_or_audio():
    info = parse_probe("Input #0, image2, from 'x.png':\n  Duration: N/A\n  Stream #0:0: Video: png\n")
    assert info == {"duration_s": None, "creation_time": None, "has_audio": False}


def test_parse_silences_pairs_start_and_end():
    stderr = (
        "[silencedetect @ 0000] silence_start: -0.0013\n"
        "[silencedetect @ 0000] silence_end: 1.5 | silence_duration: 1.5013\n"
        "[silencedetect @ 0000] silence_start: 598.2\n"
        "[silencedetect @ 0000] silence_end: 599.9 | silence_duration: 1.7\n"
    )
    assert parse_silences(stderr) == [(0.0, 1.5), (598.2, 599.9)]


def test_plan_chunks_cuts_at_longest_silence_near_target():
    silences = [(590.0, 590.5), (605.0, 607.0), (640.0, 650.0)]  # 마지막은 창(±30초) 밖
    chunks = plan_chunks(1300.0, silences)
    assert chunks == [(0.0, 606.0), (606.0, 1300.0)]


def test_plan_chunks_without_silence_cuts_at_target_and_keeps_last_chunk_long():
    assert plan_chunks(2000.0, []) == [(0.0, 600.0), (600.0, 1200.0), (1200.0, 2000.0)]
    assert plan_chunks(800.0, []) == [(0.0, 800.0)]


def test_split_wav_keeps_every_frame(tmp_path):
    src = tmp_path / "input.wav"
    write_wav(src, 5.0)
    parts = split_wav(src, [(0.0, 2.0), (2.0, 5.0)], tmp_path / "chunks")
    assert [p.name for p in parts] == ["part_000.wav", "part_001.wav"]
    assert [wav_duration(p) for p in parts] == [2.0, 3.0]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 필요")
def test_prepare_local_chunks_and_removes_full_wav(tmp_path):
    src = tmp_path / "rec.wav"
    write_wav(src, 5.0)  # 전부 무음 → 목표 지점 근처 무음 가운데(2.5초)에서 자름
    chunks = prepare_local(shutil.which("ffmpeg"), src, tmp_path / "job", target_s=2.0)
    assert [c["file"] for c in chunks] == ["part_000.wav", "part_001.wav"]
    assert chunks[0]["start_s"] == 0.0 and chunks[-1]["end_s"] == pytest.approx(5.0)
    assert not (tmp_path / "job" / "input.wav").exists()
