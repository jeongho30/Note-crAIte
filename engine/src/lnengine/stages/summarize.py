"""요약 호출 한 번으로 제목·요약·키워드·교정 목록을 받는다 (API 통합 모드).

응답 파싱과 폴백은 pipeline/process_lecture.py의 generate_note()를 옮겨 온 것이다.
"""

import json
from importlib import resources

from lnengine import llm

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"wrong": {"type": "string"}, "right": {"type": "string"}},
                "required": ["wrong", "right"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "summary", "keywords", "corrections"],
    "additionalProperties": False,
}


def build_messages(transcript: str, notes: str, subject: str | None) -> list[dict]:
    system = resources.files("lnengine").joinpath("prompts/summary_unified.txt").read_text(encoding="utf-8")
    user = f"[과목]\n{subject or '(미지정)'}\n\n[필기노트]\n{notes or '(없음)'}\n\n[전사]\n{transcript}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_response(raw: str, fallback_title: str) -> dict:
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # 파싱에 실패하면 원문을 요약란에 넣는다 (기존 파이프라인과 같은 폴백). 교정은 적용하지 않는다.
        return {"title": fallback_title, "summary": raw, "keywords": [], "corrections": [], "parse_failed": True}
    keywords = parsed.get("keywords")
    corrections = parsed.get("corrections")
    return {
        "title": str(parsed.get("title") or fallback_title).strip(),
        "summary": str(parsed.get("summary") or "").strip(),
        "keywords": [str(k).strip() for k in keywords if str(k).strip()] if isinstance(keywords, list) else [],
        "corrections": corrections if isinstance(corrections, list) else [],
        "parse_failed": False,
    }


def summarize(transcript: str, notes: str, subject: str | None, *, endpoint: str, api_key: str | None, model: str,
              fallback_title: str, use_schema: bool = True, max_tokens: int = 8192) -> dict:
    response_format = None
    if use_schema:
        response_format = {"type": "json_schema", "json_schema": {"name": "lecture_note", "strict": True, "schema": SCHEMA}}
    content, usage = llm.chat(endpoint, api_key, model, build_messages(transcript, notes, subject),
                              max_tokens=max_tokens, response_format=response_format)
    result = parse_response(content, fallback_title)
    result["usage"] = usage
    return result
