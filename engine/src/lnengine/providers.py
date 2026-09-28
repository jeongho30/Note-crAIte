"""요약 공급자 프리셋. 엔드포인트는 전체 URL로 둔다 (ChatKHU는 문서대로 끝에 /를 붙인다).

OpenAI·Gemini는 W3, Ollama(네이티브 /api/chat)는 W4에 붙인다.
"""

CHATKHU_BASE = "https://factchat-cloud.mindlogic.ai/v1/gateway"

PRESETS = {
    "chatkhu": {
        "endpoint": f"{CHATKHU_BASE}/chat/completions/",
        "credits": f"{CHATKHU_BASE}/credits/",
        "models": f"{CHATKHU_BASE}/models/",
        "model": "gemini-3.8-flash",
    },
}
