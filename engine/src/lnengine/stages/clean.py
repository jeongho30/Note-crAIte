"""STT 결과를 코드 규칙으로 정리한다: 반복 루프 잔여와 환각 문장을 지우고 문단으로 묶는다.

규칙은 실제 전사로 정했다. 작은 모델(small)에서만 같은 단어·구절이 수십 번 반복되는 루프가 나왔고
("C C C C", "C제공을 많이 구해요" x12), 흔한 환각 문장은 나오지 않았다 (docs/decisions.md S3).
"""

import re
from importlib import resources

PUNCT_RE = re.compile(r"[\s.,!?~…·'\"]")


def _key(text: str) -> str:
    return PUNCT_RE.sub("", text)


def load_hallucinations() -> set[str]:
    lines = resources.files("lnengine").joinpath("data/hallucinations_ko.txt").read_text(encoding="utf-8").splitlines()
    return {_key(line) for line in lines if line.strip() and not line.startswith("#")}


def collapse_token_loops(text: str, min_run: int = 4, max_n: int = 3) -> str:
    """같은 단어·구절(1~max_n 어절)이 min_run번 이상 연달아 나오면 한 번만 남긴다. "네 네 네"는 그대로 둔다."""
    tokens = text.split()
    for n in range(1, max_n + 1):
        out = []
        i = 0
        while i < len(tokens):
            gram = tokens[i:i + n]
            run = 1
            while tokens[i + run * n:i + (run + 1) * n] == gram:
                run += 1
            if len(gram) == n and run >= min_run:
                out += gram
                i += run * n
            else:
                out.append(tokens[i])
                i += 1
        tokens = out
    return " ".join(tokens)


def clean(segments: list[dict], *, gap_ms: int = 2000, max_chars: int = 400) -> dict:
    hallucinations = load_hallucinations()
    stats = {"segments_in": len(segments), "loops_collapsed": 0, "hallucinations_removed": 0, "repeats_removed": 0}

    items = []
    for seg in segments:
        text = seg["text"].strip()
        collapsed = collapse_token_loops(text)
        if collapsed != text:
            stats["loops_collapsed"] += 1
        key = _key(collapsed)
        if not key:
            continue
        if key in hallucinations:
            stats["hallucinations_removed"] += 1
            continue
        items.append(({**seg, "text": collapsed}, key))

    kept = []
    i = 0
    while i < len(items):
        j = i
        while j + 1 < len(items) and items[j + 1][1] == items[i][1]:
            j += 1
        run = j - i + 1
        # 같은 문장이 연달아 3번 이상이면 반복 루프로 보고 하나만 남긴다 (2번까지는 실제 발화일 수 있음)
        group = [items[i][0]] if run >= 3 else [seg for seg, _ in items[i:j + 1]]
        stats["repeats_removed"] += run - len(group)
        kept += group
        i = j + 1

    paragraphs = []
    for seg in kept:
        last = paragraphs[-1] if paragraphs else None
        if last and seg["start_ms"] - last["end_ms"] < gap_ms and len(last["text"]) < max_chars:
            last["text"] += " " + seg["text"]
            last["end_ms"] = seg["end_ms"]
        else:
            paragraphs.append({"start_ms": seg["start_ms"], "end_ms": seg["end_ms"], "text": seg["text"]})
    return {"paragraphs": paragraphs, "stats": stats}


def transcript_text(cleaned: dict) -> str:
    return "\n\n".join(p["text"] for p in cleaned["paragraphs"])
