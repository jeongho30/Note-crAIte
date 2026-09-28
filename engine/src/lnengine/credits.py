"""ChatKHU 크레딧 잔액. 채팅 응답에는 차감량이 없어서, 호출 전후 잔액 차이로 잰다."""

import requests

from lnengine.errors import EngineError
from lnengine.llm import headers, raise_for_status


def get(credits_url: str, api_key: str) -> dict:
    try:
        resp = requests.get(credits_url, headers=headers(api_key), timeout=15)
    except requests.exceptions.RequestException as e:
        raise EngineError("network", f"크레딧 잔액을 확인하지 못했어요: {type(e).__name__}") from e
    raise_for_status(resp, "크레딧 조회")
    return resp.json()


def remaining(info: dict) -> float:
    """이번 달 할당분과 충전분을 합친 남은 크레딧."""
    return float(info["total"]["remaining"])
