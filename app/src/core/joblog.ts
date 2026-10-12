// 로그에 남기는 요약: 테스터의 로그만 받아 PC별 속도와 예상 시간이 맞았는지를 볼 수 있게 한다.
// 한 줄 JSON으로 적어 여러 사람의 로그를 스크립트로 모으기 쉽게 하고, 녹음·노트의 파일 이름과 경로는 넣지 않는다.
import { polishTarget, STAGES } from './job.ts'
import type { Job, LlmSettings, StageName } from './job.ts'
import type { ProbeResult } from './probe.ts'

const round = (n: number, digits: number): number => Math.round(n * 10 ** digits) / 10 ** digits

const deviceWord = (device: number | null): string => (device === null ? 'cpu' : `gpu${device}`)

const llmWord = (llm: LlmSettings | null | undefined): { service: string; model: string } | null =>
  llm ? { service: llm.ollama ? 'ollama' : (llm.service ?? 'chatkhu'), model: llm.model } : null

export type JobSummaryExtra = {
  /** 받아쓴 그래픽카드 이름 (CPU면 null) */
  gpuName?: string | null
  /**
   * 시작할 때 계산한 예상 시간(초). 모르면 null (ChatKHU 받아쓰기, 속도를 잰 적 없음).
   * from은 받아쓰기 속도의 근거: probe는 잰 속도 × 보정, history는 끝낸 작업들의 실제 속도
   */
  expected?: { sttS: number; totalS: number; from: 'probe' | 'history' } | null
  /** 배터리로 돌았는지 (작업을 시작할 때와 끝날 때) */
  onBattery?: { start: boolean; end: boolean }
  /** 앞서 끝낸 단계가 있는 채로 다시 돌린 것 (다시 시도, 요약 다시 만들기, 앱을 껐다 켬): 단계 시간에 앞의 실행분이 섞여 있다 */
  continued?: boolean
}

/** 끝났거나 멈춘 작업 하나의 요약 (로그의 "작업 요약:" 줄) */
export function jobSummary(job: Job, extra: JobSummaryExtra = {}): Record<string, unknown> {
  const stageS: Partial<Record<StageName, number>> = {}
  const resumed: StageName[] = []
  for (const name of STAGES) {
    const s = job.stages[name]
    if (!s) continue // polish는 9/30 전 작업에 없다
    if (s.status !== 'skipped' && s.startedAt && s.endedAt) stageS[name] = round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000, 1)
    if (s.resumed) resumed.push(name)
  }
  const durationS = job.audio?.durationS ?? null
  const cloud = job.settings.sttService === 'chatkhu'
  const sttS = job.stages.stt.status === 'done' && !job.stages.stt.resumed ? stageS.stt : undefined
  return {
    id: job.id,
    status: job.status,
    from: job.input.from ?? 'manual',
    notes: job.input.notes !== null,
    language: job.settings.language,
    durationS: durationS === null ? null : Math.round(durationS),
    chunks: job.audio?.chunks.length ?? null,
    stt: cloud
      ? { service: 'chatkhu' }
      : {
          service: 'whisper',
          model: job.settings.model,
          device: deviceWord(job.settings.gpuDevice),
          gpuName: job.settings.gpuDevice === null ? null : (extra.gpuName ?? null),
          threads: job.settings.threads,
          beamSize: job.settings.beamSize,
          args: job.settings.args ?? null
        },
    polish: llmWord(polishTarget(job.settings)),
    summary: llmWord(job.settings.llm),
    stageS,
    totalS: round(Object.values(stageS).reduce((n, s) => n + s, 0), 1),
    // 받아쓰기에 걸린 시간 ÷ 녹음 길이. 이어서 한 받아쓰기는 걸린 시간이 일부라 적지 않는다
    sttRtf: sttS && durationS ? round(sttS / durationS, 4) : null,
    expected: extra.expected ?? null,
    ...(extra.onBattery ? { onBattery: extra.onBattery } : {}),
    ...(resumed.length ? { resumed } : {}),
    ...(extra.continued ? { continued: true } : {}),
    ...(job.usage ? { usage: job.usage } : {}),
    ...(job.polish ? { polishChunks: job.polish.chunks, polishFallback: job.polish.fallbackChunks } : {}),
    ...(job.error ? { error: { stage: job.error.stage, code: job.error.code } } : {})
  }
}

/** 속도 재기에서 장치마다 나온 결과 (로그의 "속도 재기 상세:" 줄) */
export function probeSummary(p: ProbeResult): Record<string, unknown> {
  const tried = new Set(p.trials.map((t) => t.device))
  return {
    model: p.model,
    threads: p.threads,
    sampleS: round(p.sampleS, 1),
    chosen: deviceWord(p.gpuDevice),
    rtf: round(p.rtf, 4),
    loadS: round(p.loadS, 2),
    trials: p.trials.map((t) => ({
      device: deviceWord(t.device),
      name: t.name,
      ...(t.device === null ? {} : { integrated: p.devices.find((d) => d.index === t.device)?.integrated ?? null }),
      ok: t.ok,
      processS: round(t.processMs / 1000, 2),
      loadS: round(t.loadMs / 1000, 2),
      ...(t.cer === undefined ? {} : { cer: round(t.cer, 3) }),
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.tail?.length ? { tail: t.tail } : {})
    })),
    // 앞의 외장 GPU가 충분히 빨라 재지 않은 장치
    skipped: p.devices.filter((d) => !tried.has(d.index)).map((d) => d.name)
  }
}
