import json

import pytest

from lnengine import llm
from lnengine.errors import EngineError
from lnengine.stages.summarize import build_messages, parse_response, summarize

GOOD = {"title": "렉시컬 분석", "summary": "요약", "keywords": ["Token", " "], "corrections": [{"wrong": "a", "right": "b"}]}


class FakeResponse:
    def __init__(self, status: int, payload=None, text: str = ""):
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


def chat_payload(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}


def test_parse_response_strips_code_fence_and_cleans_fields():
    parsed = parse_response("```json\n" + json.dumps(GOOD, ensure_ascii=False) + "\n```", "파일 이름")
    assert parsed["title"] == "렉시컬 분석"
    assert parsed["keywords"] == ["Token"]
    assert parsed["corrections"] == [{"wrong": "a", "right": "b"}]
    assert parsed["parse_failed"] is False


def test_parse_response_falls_back_to_raw_text():
    parsed = parse_response("JSON이 아닌 응답", "9.14 Lexical Analysis")
    assert parsed["title"] == "9.14 Lexical Analysis"
    assert parsed["summary"] == "JSON이 아닌 응답"
    assert parsed["corrections"] == [] and parsed["parse_failed"] is True


def test_build_messages_marks_missing_inputs():
    user = build_messages("전사", "", None)[1]["content"]
    assert "[과목]\n(미지정)" in user and "[필기노트]\n(없음)" in user and user.endswith("[전사]\n전사")


def test_summarize_sends_json_schema_and_returns_usage(monkeypatch):
    sent = {}

    def fake_post(url, headers, json, timeout):
        sent.update(url=url, headers=headers, body=json)
        return FakeResponse(200, chat_payload(__import__("json").dumps(GOOD, ensure_ascii=False)))

    monkeypatch.setattr(llm.requests, "post", fake_post)
    result = summarize("전사", "필기", "컴파일러", endpoint="https://x/chat/completions/", api_key="secret",
                       model="m", fallback_title="t")
    assert sent["body"]["response_format"]["json_schema"]["strict"] is True
    assert sent["headers"]["Authorization"] == "Bearer secret"
    assert result["title"] == "렉시컬 분석" and result["usage"]["completion_tokens"] == 5


@pytest.mark.parametrize("status,code", [(401, "auth"), (402, "credits"), (413, "too_large"), (429, "rate_limit"),
                                         (503, "network"), (400, "llm")])
def test_http_errors_map_to_codes_without_leaking_key(monkeypatch, status, code):
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: FakeResponse(status, text="bad"))
    with pytest.raises(EngineError) as e:
        llm.chat("https://x/", "secret-key", "m", [])
    assert e.value.code == code
    assert "secret-key" not in e.value.message


def test_empty_content_is_an_error(monkeypatch):
    monkeypatch.setattr(llm.requests, "post", lambda *a, **k: FakeResponse(200, chat_payload("")))
    with pytest.raises(EngineError) as e:
        llm.chat("https://x/", None, "m", [])
    assert e.value.code == "llm"
