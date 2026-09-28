"""OpenAI 호환 chat completions 호출. pipeline/process_lecture.py의 generate_note() 호출부를 옮겨 온 것이다.

API 키는 요청 헤더에만 쓰고 로그·예외 메시지에 넣지 않는다.
"""

import requests

from lnengine.errors import EngineError

STATUS_ERRORS = {
    401: ("auth", "API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요."),
    403: ("auth", "API 키에 이 기능을 쓸 권한이 없어요."),
    402: ("credits", "크레딧이 부족해요."),
    413: ("too_large", "전사문이 너무 길어 요약 서버가 받지 않았어요."),
    429: ("rate_limit", "요청이 너무 많아요. 잠시 후 다시 시도해 주세요."),
}


def raise_for_status(resp: requests.Response, what: str) -> None:
    if resp.status_code == 200:
        return
    if resp.status_code in STATUS_ERRORS:
        code, message = STATUS_ERRORS[resp.status_code]
        raise EngineError(code, message)
    if resp.status_code >= 500:
        raise EngineError("network", f"{what} 서버 오류({resp.status_code})예요. 잠시 후 다시 시도해 주세요.")
    raise EngineError("llm", f"{what} 오류 ({resp.status_code}): {resp.text[:500]}")


def headers(api_key: str | None) -> dict:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def chat(endpoint: str, api_key: str | None, model: str, messages: list[dict], *, max_tokens: int = 8192,
         response_format: dict | None = None, timeout: float = 300) -> tuple[str, dict | None]:
    """(응답 본문, usage)를 돌려준다."""
    body = {"model": model, "messages": messages, "max_tokens": max_tokens}
    if response_format is not None:
        body["response_format"] = response_format
    try:
        resp = requests.post(endpoint, headers=headers(api_key), json=body, timeout=timeout)
    except requests.exceptions.Timeout as e:
        raise EngineError("network", "요약 서버가 제때 답하지 않았어요. 다시 시도해 주세요.") from e
    except requests.exceptions.RequestException as e:
        raise EngineError("network", f"요약 서버에 연결하지 못했어요: {type(e).__name__}") from e
    raise_for_status(resp, "요약")
    data = resp.json()
    content = (data["choices"][0]["message"].get("content") or "").strip()
    if not content:
        # 추론 모델은 max_tokens 안에서 생각하다 본문 없이 끝날 수 있다 (ChatKHU 문서)
        raise EngineError("llm", "요약 모델이 빈 응답을 돌려줬어요.")
    return content, data.get("usage")
