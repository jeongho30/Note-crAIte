"""S2: ChatKHU 요약 실측. 1회 차감 크레딧, json_schema로 형식이 고정되는지, 교정 목록이 쓸 만한지 본다.

결과에는 강의 내용이 들어가므로 데이터 폴더의 s2/ 아래에만 쓴다. 키는 LN_API_KEY 환경변수로만 받는다.
"""

import json
import os
import time
from pathlib import Path

import requests

from lnengine import corrections, credits, llm
from lnengine.errors import EngineError
from lnengine.files import read_json, write_json_atomic
from lnengine.providers import PRESETS
from lnengine.stages.clean import clean, transcript_text
from lnengine.stages.summarize import summarize
from lnengine.stt.whispercpp import parse_whisper_json

CHATKHU = PRESETS["chatkhu"]


def load_segments(path: Path) -> list[dict]:
    """whisper JSON(기존 파이프라인의 work/*.json) 또는 bench가 저장한 구간 목록."""
    data = read_json(path)
    return data if isinstance(data, list) else parse_whisper_json(path)


def api_key() -> str:
    key = os.environ.get("LN_API_KEY")
    if not key:
        raise EngineError("auth", "LN_API_KEY 환경변수에 ChatKHU 키를 넣어 주세요.")
    return key


def list_models(key: str) -> list[str]:
    resp = requests.get(CHATKHU["models"], headers=llm.headers(key), timeout=15)
    llm.raise_for_status(resp, "모델 목록")
    return [m.get("id", "") for m in resp.json().get("data", [])]


def credits_spent(key: str, before: float) -> float:
    """차감이 늦게 반영될 수 있어 바로, 5초 뒤, 30초 뒤에 다시 본다."""
    for wait in (0, 5, 25):
        time.sleep(wait)
        after = credits.remaining(credits.get(CHATKHU["credits"], key))
        if after != before:
            return round(before - after, 2)
    return 0.0


def run(args) -> None:
    key = api_key()
    if args.list_models:
        print("\n".join(list_models(key)))
        return
    if not args.stt or not args.model:
        raise EngineError("input", "--stt와 --model을 하나 이상 주세요.")

    out_dir = args.data_dir / "s2" / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True)
    notes = args.notes.read_text(encoding="utf-8") if args.notes else ""
    print(f"잔액 {credits.remaining(credits.get(CHATKHU['credits'], key))}, 결과: {out_dir}")

    rows = []
    for stt_path in args.stt:
        cleaned = clean(load_segments(stt_path))
        paragraphs = [p["text"] for p in cleaned["paragraphs"]]
        text = transcript_text(cleaned)
        for model in args.model:
            for run_no in range(1, args.repeat + 1):
                before = credits.remaining(credits.get(CHATKHU["credits"], key))
                t0 = time.perf_counter()
                result = summarize(text, notes, args.subject, endpoint=CHATKHU["endpoint"], api_key=key, model=model,
                                   fallback_title=stt_path.name, use_schema=not args.no_schema)
                seconds = time.perf_counter() - t0
                spent = credits_spent(key, before)
                picked = corrections.select(result["corrections"], text)
                _, applied = corrections.apply(paragraphs, picked)
                usage = result.get("usage") or {}
                row = {
                    "input": stt_path.name, "model": model, "run": run_no, "chars": len(text),
                    "seconds": round(seconds, 1), "prompt_tokens": usage.get("prompt_tokens"),
                    "completion_tokens": usage.get("completion_tokens"), "credits": spent,
                    "parse_ok": not result["parse_failed"], "corrections": len(result["corrections"]),
                    "picked": len(picked), "applied": sum(c["count"] for c in applied), "title": result["title"],
                }
                rows.append(row)
                write_json_atomic(out_dir / f"{len(rows):02d}.json", {
                    **row, "usage": usage, "summary": result["summary"], "keywords": result["keywords"],
                    "corrections_raw": result["corrections"], "applied": applied, "clean_stats": cleaned["stats"],
                })
                print(json.dumps(row, ensure_ascii=False), flush=True)
    write_json_atomic(out_dir / "rows.json", rows)
