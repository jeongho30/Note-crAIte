"""벤치 전용: faster-whisper(CPU int8 배치)로 전사해 구간 JSON을 쓴다. 앱에는 들어가지 않는다.

app/src/core/bench.ts가 `fw:<모델>:cpu` 설정에서 이 스크립트를 부른다.
설치: py -3.14 -m venv tools/.venv && tools/.venv/Scripts/python -m pip install -r tools/requirements-bench.txt
"""

import argparse
import json

from faster_whisper import BatchedInferencePipeline, WhisperModel

p = argparse.ArgumentParser()
p.add_argument("--audio", required=True)
p.add_argument("--model", required=True)
p.add_argument("--threads", type=int, required=True)
p.add_argument("--lang", default="ko")
p.add_argument("--model-dir", required=True)
p.add_argument("--out", required=True)
args = p.parse_args()

model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads,
                     download_root=args.model_dir)
segments, _ = BatchedInferencePipeline(model=model).transcribe(args.audio, language=args.lang, vad_filter=True,
                                                               batch_size=8)
result = [{"startMs": round(s.start * 1000), "endMs": round(s.end * 1000), "text": s.text.strip()}
          for s in segments if s.text.strip()]
with open(args.out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)
