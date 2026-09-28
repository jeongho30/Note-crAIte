"""요약 호출이 돌려준 "오인식 → 정정" 목록을 전사문에 적용한다 (API 통합 모드).

전사문 전체를 LLM이 다시 쓰게 하면 출력 비용이 크므로, 짧은 목록만 받아 코드가 치환한다.
"""

import re
from collections import Counter

MAX_ITEMS = 40


LETTER_RE = re.compile(r"[A-Za-z가-힣]")
ASCII_WORD_RE = re.compile(r"[A-Za-z0-9]")


def select(corrections: list, text: str) -> list[dict]:
    """전사에 실제로 있고, 2자 이상이며, 정정어와 다른 항목만 최대 MAX_ITEMS개 고른다.

    실제 강의로 본 오치환(S2)도 막는다: 숫자·기호만인 표현("80→Parsing"), 대소문자만 바꾸는 교정.
    """
    picked = []
    seen = set()
    for c in corrections:
        if not isinstance(c, dict):
            continue
        wrong = str(c.get("wrong", "")).strip()
        right = str(c.get("right", "")).strip()
        if len(wrong) < 2 or not right or wrong.casefold() == right.casefold() or wrong in seen:
            continue
        if not LETTER_RE.search(wrong) or wrong not in text:
            continue
        seen.add(wrong)
        picked.append({"wrong": wrong, "right": right})
        if len(picked) == MAX_ITEMS:
            break
    return picked


def _pattern(wrong: str) -> str:
    # 영문·숫자로 시작하거나 끝나면 단어 경계를 지킨다 ("IDE"가 "IDEA" 안에서 바뀌지 않게).
    # 한글은 조사가 바로 붙으므로 경계를 두지 않는다.
    p = re.escape(wrong)
    if ASCII_WORD_RE.match(wrong[0]):
        p = r"(?<![A-Za-z0-9])" + p
    if ASCII_WORD_RE.match(wrong[-1]):
        p += r"(?![A-Za-z0-9])"
    return p


def apply(texts: list[str], corrections: list[dict]) -> tuple[list[str], list[dict]]:
    """긴 것부터 정규식 하나로 한 번에 치환한다 (치환 결과가 다시 치환되지 않게). 항목별 적용 횟수를 돌려준다."""
    if not corrections:
        return texts, []
    items = sorted(corrections, key=lambda c: len(c["wrong"]), reverse=True)
    pattern = re.compile("|".join(_pattern(c["wrong"]) for c in items))
    mapping = {c["wrong"]: c["right"] for c in items}
    counts = Counter()

    def repl(m: re.Match) -> str:
        counts[m.group(0)] += 1
        return mapping[m.group(0)]

    fixed = [pattern.sub(repl, t) for t in texts]
    applied = [{**c, "count": counts[c["wrong"]]} for c in items if counts[c["wrong"]]]
    applied.sort(key=lambda c: -c["count"])
    return fixed, applied
