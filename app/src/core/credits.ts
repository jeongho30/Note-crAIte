// ChatKHU 크레딧 잔액. 채팅 응답에는 차감량이 없어서, 호출 전후 잔액 차이로 잰다.
import { headers, raiseForStatus, request } from './llm.ts'

export type CreditsInfo = { total: { remaining: number | string }; [k: string]: unknown }

export async function get(creditsUrl: string, apiKey: string): Promise<CreditsInfo> {
  const resp = await request(creditsUrl, { headers: headers(apiKey) }, 15_000, '크레딧 조회')
  await raiseForStatus(resp, '크레딧 조회')
  return (await resp.json()) as CreditsInfo
}

/** 이번 달 할당분과 충전분을 합친 남은 크레딧. */
export function remaining(info: CreditsInfo): number {
  return Number(info.total.remaining)
}
