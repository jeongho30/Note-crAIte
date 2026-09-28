"""오디오 준비: 16kHz 모노 WAV 변환, 길이·녹음 시각 읽기, 무음 지점에서 조각 나누기.

convert_to_wav는 pipeline/process_lecture.py에서 옮겨 온 것이다.
"""

import re
import subprocess
import wave
from pathlib import Path

from lnengine.errors import EngineError

RUN = dict(capture_output=True, text=True, encoding="utf-8", errors="replace",
           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
CREATION_RE = re.compile(r"creation_time\s*:\s*(\S+)")
AUDIO_STREAM_RE = re.compile(r"Stream #\d+:\d+.*?: Audio:")
SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
SILENCE_END_RE = re.compile(r"silence_end:\s*(\d+(?:\.\d+)?)")


def convert_to_wav(ffmpeg: str, src: Path, dst: Path) -> None:
    # -vn: mp4·webm 같은 영상 컨테이너도 받으므로 영상 스트림은 버린다.
    cmd = [ffmpeg, "-y", "-i", str(src), "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)]
    result = subprocess.run(cmd, **RUN)
    if result.returncode != 0:
        raise EngineError("ffmpeg", f"ffmpeg 변환 실패:\n{result.stderr[-2000:]}")


def parse_probe(stderr: str) -> dict:
    m = DURATION_RE.search(stderr)
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
    c = CREATION_RE.search(stderr)  # 처음 나오는 것이 컨테이너 수준 메타데이터
    return {
        "duration_s": duration,
        "creation_time": c.group(1) if c else None,
        "has_audio": bool(AUDIO_STREAM_RE.search(stderr)),
    }


def probe(ffmpeg: str, src: Path) -> dict:
    # ffprobe를 따로 넣지 않으려고 `ffmpeg -i`의 정보 출력을 읽는다 (출력 파일이 없어 종료 코드는 1).
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(src)], **RUN)
    info = parse_probe(result.stderr)
    if not info["has_audio"]:
        raise EngineError("input", f"오디오를 읽을 수 없는 파일입니다: {src.name}")
    return info


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


def parse_silences(stderr: str) -> list[tuple[float, float]]:
    silences = []
    start = None
    for line in stderr.splitlines():
        if m := SILENCE_START_RE.search(line):
            start = max(0.0, float(m.group(1)))
        elif (m := SILENCE_END_RE.search(line)) and start is not None:
            silences.append((start, float(m.group(1))))
            start = None
    return silences


def detect_silences(ffmpeg: str, wav: Path, noise_db: float = -30.0, min_len_s: float = 0.4) -> list[tuple[float, float]]:
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-i", str(wav),
           "-af", f"silencedetect=noise={noise_db}dB:d={min_len_s}", "-f", "null", "-"]
    result = subprocess.run(cmd, **RUN)
    if result.returncode != 0:
        raise EngineError("ffmpeg", f"무음 구간 검출 실패:\n{result.stderr[-2000:]}")
    return parse_silences(result.stderr)


def plan_chunks(duration_s: float, silences: list[tuple[float, float]],
                target_s: float = 600.0, window_s: float = 30.0) -> list[tuple[float, float]]:
    """target_s마다, 앞뒤 window_s 안에서 가장 긴 무음의 가운데를 자른다. 무음이 없으면 목표 지점에서 자른다."""
    cuts = []
    last = 0.0
    while duration_s - last > target_s * 1.5:  # 마지막 조각이 너무 짧아지지 않게
        target = last + target_s
        best = None
        for s, e in silences:
            mid = (s + e) / 2
            if abs(mid - target) <= window_s and (best is None or e - s > best[0]):
                best = (e - s, mid)
        last = best[1] if best else target
        cuts.append(last)
    bounds = [0.0, *cuts, duration_s]
    return list(zip(bounds[:-1], bounds[1:]))


def split_wav(src: Path, bounds: list[tuple[float, float]], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    with wave.open(str(src), "rb") as r:
        rate = r.getframerate()
        params = r.getparams()
        for i, (start, end) in enumerate(bounds):
            first, last = round(start * rate), round(end * rate)
            r.setpos(first)
            frames = r.readframes(last - first)
            path = out_dir / f"part_{i:03d}.wav"
            with wave.open(str(path), "wb") as w:
                w.setparams(params)
                w.writeframes(frames)
            paths.append(path)
    return paths


def prepare_local(ffmpeg: str, src: Path, work_dir: Path, target_s: float = 600.0) -> list[dict]:
    """로컬 STT용 조각을 만든다. 조각을 만든 뒤 원본 WAV는 지운다 (90분에 약 170MB)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    wav = work_dir / "input.wav"
    convert_to_wav(ffmpeg, src, wav)
    duration = wav_duration(wav)
    if target_s > 0 and duration > target_s * 1.5:
        bounds = plan_chunks(duration, detect_silences(ffmpeg, wav), target_s)
    else:
        bounds = [(0.0, duration)]
    paths = split_wav(wav, bounds, work_dir / "chunks")
    wav.unlink()
    return [{"file": p.name, "start_s": s, "end_s": e} for p, (s, e) in zip(paths, bounds)]
