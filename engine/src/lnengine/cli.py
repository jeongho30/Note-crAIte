"""명령줄 진입점. 지금은 모델 다운로드와 S3 벤치만 있고 run/resume/serve는 이후에 붙인다."""

import argparse
import sys
from pathlib import Path

from lnengine import downloads, paths
from lnengine.errors import EngineError


def _progress_printer(label: str):
    last = [-1]

    def cb(done: int, total: int) -> None:
        pct = done * 100 // total if total else 0
        if pct != last[0]:
            last[0] = pct
            print(f"\r{label}: {pct}% ({done / 1e6:.0f}/{total / 1e6:.0f}MB)", end="", flush=True)

    return cb


def cmd_models_download(args) -> None:
    cat = downloads.catalog()
    for name in args.names:
        kind = "vad" if name in cat["vad"] else "whisper"
        path = downloads.ensure_model(kind, name, args.data_dir / "models", on_progress=_progress_printer(name))
        print(f"\n{name}: {path}")


def cmd_bench(args) -> None:
    from lnengine import bench  # faster-whisper 등 [bench] 의존성은 벤치에서만 필요

    bench.run(args)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lnengine", description="강의 녹음을 마크다운 노트로 만드는 엔진")
    parser.add_argument("--data-dir", type=Path, default=paths.default_data_dir())
    parser.add_argument("--bin-dir", type=Path, default=None, help="ffmpeg·whisper 실행 파일 폴더 (설치본에서 앱이 넘김)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    models = sub.add_parser("models", help="모델 관리")
    models_sub = models.add_subparsers(dest="models_cmd", required=True)
    dl = models_sub.add_parser("download", help="모델 받기 (이어받기, sha256 확인)")
    dl.add_argument("names", nargs="+")
    dl.set_defaults(func=cmd_models_download)

    b = sub.add_parser("bench", help="S3: STT 엔진·모델·장치별 속도와 품질 비교")
    b.add_argument("--audio", type=Path, required=True)
    b.add_argument("--ref", type=Path, help="기준 전사 (whisper JSON)")
    b.add_argument("--start", type=float, default=0.0, help="샘플 시작 (초)")
    b.add_argument("--duration", type=float, default=None, help="샘플 길이 (초). 생략하면 끝까지")
    b.add_argument("--config", action="append", required=True,
                   help="엔진:모델:장치. 예) wcpp:small-q5_1:cpu, wcpp:large-v3-turbo-q5_0:gpu0, fw:small:cpu")
    b.add_argument("--threads", type=int, default=None, help="기본: 물리 코어 - 2")
    b.add_argument("--lang", default="ko")
    b.add_argument("--chunk-s", type=float, default=600.0, help="whisper.cpp 조각 길이 (초). 0이면 나누지 않음")
    b.set_defaults(func=cmd_bench)

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except EngineError as e:
        print(f"\n[오류] {e.message}", file=sys.stderr)
        return 1
    return 0
