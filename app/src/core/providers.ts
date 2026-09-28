// 요약 공급자 프리셋. 엔드포인트는 전체 URL로 둔다 (ChatKHU는 문서대로 끝에 /를 붙인다).
// OpenAI·Gemini는 W3, Ollama(네이티브 /api/chat)는 W4에 붙인다.
import * as credits from './credits.ts'
import { EngineError } from './errors.ts'

export const CHATKHU_BASE = 'https://factchat-cloud.mindlogic.ai/v1/gateway'

export type ProviderId = 'chatkhu' | 'openai' | 'claude' | 'gemini'

/** 화면에 보이는 요약 서비스 목록. available이 false면 "곧 지원"으로 흐리게 보인다. */
export const PROVIDERS: { id: ProviderId; name: string; available: boolean; keyGuideUrl?: string }[] = [
  { id: 'chatkhu', name: 'ChatKHU', available: true, keyGuideUrl: 'https://chat.khu.ac.kr/' },
  { id: 'openai', name: 'OpenAI', available: false },
  { id: 'claude', name: 'Claude', available: false },
  { id: 'gemini', name: 'Gemini', available: false }
]

/** 90분 강의 요약 1회의 크레딧. S2 실측(63분, turbo 전사 7.3~9.3크레딧)을 90분으로 환산했다. */
export const CREDITS_PER_90MIN_SUMMARY = 12

/** 키를 확인한다. 잔액을 볼 수 있는 서비스(ChatKHU)는 남은 크레딧을 돌려준다. 요금이 드는 호출은 하지 않는다. */
export async function verifyKey(id: ProviderId, apiKey: string): Promise<{ credits: number | null }> {
  if (id === 'chatkhu') return { credits: credits.remaining(await credits.get(PRESETS['chatkhu'].credits!, apiKey)) }
  throw new EngineError('input', '아직 지원하지 않는 요약 서비스예요.')
}

export type Preset = { endpoint: string; credits?: string; models?: string; model: string }

export const PRESETS: Record<string, Preset> = {
  chatkhu: {
    endpoint: `${CHATKHU_BASE}/chat/completions/`,
    credits: `${CHATKHU_BASE}/credits/`,
    models: `${CHATKHU_BASE}/models/`,
    model: 'gemini-3.8-flash'
  }
}
