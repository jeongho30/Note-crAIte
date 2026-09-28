"""S3: STT 엔진·모델·장치별 속도(RTF)와 기준 전사 대비 CER 비교.

결과에는 강의 전사가 들어가므로 저장소가 아니라 데이터 폴더의 bench/ 아래에만 쓴다.
"""

import csv
import os
import platform
import re
import shutil
import subprocess
import time
from pathlib import Path

import psutil

from lnengine import downloads, paths
from lnengine.errors import EngineError
from lnengine.files import write_json_atomic
from lnengine.stages.audio import RUN, prepare_local, wav_duration
from lnengine.stt.base import transcribe_chunks
from lnengine.stt.whispercpp import WhisperCpp, parse_whisper_json

NORMALIZE_RE = re.compile(r"[^0-9A-Za-z가-힣]")
BACKEND_RE = re.compile(r"using (\S+) backend")
FIELDS = ["config", "engine", "model", "device", "backend", "threads", "audio_s", "prep_s", "stt_s", "rtf", "cer",
          "chars"]


def normalize(text: str) -> str:
    """띄어쓰기·문장부호 차이는 오류로 세지 않는다."""
    return NORMALIZE_RE.sub("", text).lower()


def cer(ref: str, hyp: str) -> float:
    from rapidfuzz.distance import Levenshtein  # 90분 전사끼리도 빠르게 비교하려고 C 구현을 쓴다

    r, h = normalize(ref), normalize(hyp)
    return Levenshtein.distance(r, h) / max(1, len(r))


def default_threads() -> int:
    return max(1, (psutil.cpu_count(logical=False) or 2) - 2)


def text_in_range(segments: list[dict], start_ms: float, end_ms: float) -> str:
    return " ".join(s["text"] for s in segments if start_ms <= s["start_ms"] < end_ms)


def backend_used(log: list[str]) -> str:
    """gpu 설정이어도 쓸 GPU가 없으면 whisper는 CPU로 돈다. 로그로 실제 백엔드를 확인한다."""
    for line in log:
        if m := BACKEND_RE.search(line):
            return m.group(1)
    return "CPU"


def cpu_name() -> str:
    if os.name == "nt":
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
            return winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
    return platform.processor()


def _run_wcpp(model_name: str, device: str, sample: Path, work: Path, args,
              threads: int) -> tuple[float, list[dict], str]:
    models_dir = args.data_dir / "models"
    model = downloads.ensure_model("whisper", model_name, models_dir)
    vad = downloads.ensure_model("vad", "silero-v6.2.0", models_dir)
    gpu = None if device == "cpu" else int(device.removeprefix("gpu"))
    engine = WhisperCpp([str(paths.find_whisper_cli(args.bin_dir))], model, vad_model=vad, threads=threads,
                        gpu_device=gpu, quiet=False)
    t0 = time.perf_counter()
    chunks = prepare_local(paths.find_ffmpeg(args.bin_dir), sample, work, target_s=args.chunk_s)
    prep_s = time.perf_counter() - t0

    def show(frac: float) -> None:
        print(f"\r  {frac * 100:5.1f}%", end="", flush=True)

    segments = transcribe_chunks(engine, chunks, work / "chunks", work / "stt", language=args.lang, on_progress=show)
    print()
    return prep_s, segments, backend_used(engine.last_log)


def _run_fw(model_name: str, device: str, sample: Path, args, threads: int) -> list[dict]:
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    if device != "cpu":
        raise EngineError("input", "faster-whisper 벤치는 CPU만 지원합니다 (NVIDIA는 W3에 실측).")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads,
                         download_root=str(args.data_dir / "models" / "faster-whisper"))
    segments, _ = BatchedInferencePipeline(model=model).transcribe(str(sample), language=args.lang,
                                                                   vad_filter=True, batch_size=8)
    return [{"start_ms": round(s.start * 1000), "end_ms": round(s.end * 1000), "text": s.text.strip()}
            for s in segments if s.text.strip()]


def run(args) -> None:
    threads = args.threads or default_threads()
    ffmpeg = paths.find_ffmpeg(args.bin_dir)
    out_dir = args.data_dir / "bench" / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True)

    sample = out_dir / "sample.wav"
    cut = ["-ss", str(args.start)] + (["-t", str(args.duration)] if args.duration else [])
    result = subprocess.run([ffmpeg, "-y", *cut, "-i", str(args.audio), "-vn", "-ar", "16000", "-ac", "1",
                             "-c:a", "pcm_s16le", str(sample)], **RUN)
    if result.returncode != 0:
        raise EngineError("ffmpeg", f"샘플 추출 실패:\n{result.stderr[-2000:]}")
    audio_s = wav_duration(sample)

    ref_text = None
    if args.ref:
        start_ms = args.start * 1000
        ref_text = text_in_range(parse_whisper_json(args.ref), start_ms, start_ms + audio_s * 1000)

    battery = psutil.sensors_battery()
    write_json_atomic(out_dir / "meta.json", {
        "cpu": cpu_name(),
        "physical_cores": psutil.cpu_count(logical=False),
        "logical_cores": psutil.cpu_count(logical=True),
        "ram_gb": round(psutil.virtual_memory().total / 2**30, 1),
        "power_plugged": battery.power_plugged if battery else None,
        "threads": threads,
        "audio": str(args.audio),
        "start_s": args.start,
        "audio_s": audio_s,
        "chunk_s": args.chunk_s,
        "configs": args.config,
    })
    print(f"샘플 {audio_s / 60:.1f}분, 스레드 {threads}, 결과: {out_dir}")

    with open(out_dir / "results.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for i, config in enumerate(args.config):
            engine, model_name, device = config.split(":")
            print(f"[{i + 1}/{len(args.config)}] {config}")
            work = out_dir / f"work-{i:02d}"
            t0 = time.perf_counter()
            if engine == "wcpp":
                prep_s, segments, backend = _run_wcpp(model_name, device, sample, work, args, threads)
            elif engine == "fw":
                prep_s, segments, backend = 0.0, _run_fw(model_name, device, sample, args, threads), "CPU"
            else:
                raise EngineError("input", f"모르는 엔진입니다: {engine} (wcpp 또는 fw)")
            stt_s = time.perf_counter() - t0 - prep_s
            shutil.rmtree(work, ignore_errors=True)

            hyp = " ".join(s["text"] for s in segments)
            (out_dir / f"{i:02d}-{config.replace(':', '_')}.txt").write_text(hyp, encoding="utf-8")
            row = {
                "config": config, "engine": engine, "model": model_name, "device": device, "backend": backend,
                "threads": threads,
                "audio_s": round(audio_s, 1), "prep_s": round(prep_s, 1), "stt_s": round(stt_s, 1),
                "rtf": round(stt_s / audio_s, 3),
                "cer": round(cer(ref_text, hyp), 4) if ref_text else "",
                "chars": len(normalize(hyp)),
            }
            writer.writerow(row)
            f.flush()
            print(f"  STT {stt_s:.0f}초 (RTF {row['rtf']}), CER {row['cer']}")
