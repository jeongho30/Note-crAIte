// 요약 공급자 프리셋. 엔드포인트는 전체 URL로 둔다 (ChatKHU는 문서대로 끝에 /를 붙인다).
// OpenAI·Gemini는 W3, Ollama(네이티브 /api/chat)는 W4에 붙인다.

export const CHATKHU_BASE = 'https://factchat-cloud.mindlogic.ai/v1/gateway'

export type Preset = { endpoint: string; credits?: string; models?: string; model: string }

export const PRESETS: Record<string, Preset> = {
  chatkhu: {
    endpoint: `${CHATKHU_BASE}/chat/completions/`,
    credits: `${CHATKHU_BASE}/credits/`,
    models: `${CHATKHU_BASE}/models/`,
    model: 'gemini-3.8-flash'
  }
}
