// 하드웨어 정보. Node에는 물리 코어 수와 전원 상태 API가 없어 OS 명령으로 읽는다.
import { availableParallelism, cpus, totalmem } from 'node:os'
import { runCapture } from './proc.ts'

export type Hardware = {
  cpu: string
  physicalCores: number
  /** 성능 코어 수 (macOS의 Apple Silicon만. 효율 코어가 따로 없으면 없다) */
  performanceCores?: number
  logicalCores: number
  ramGb: number
  /** 그래픽카드 이름 (Windows만, 모르면 빈 목록) */
  gpus: string[]
  powerPlugged: boolean | null // 배터리가 없거나 모르면 null
}

async function windowsInfo(): Promise<{ cores?: number; battery?: number | null; gpus?: string[] }> {
  // Win32_Battery.BatteryStatus: 1 = 배터리로 동작, 2 = 전원 연결
  // 그래픽카드는 PCI 장치만 (가상 디스플레이 드라이버는 뺀다)
  const script = '$c = (Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum;' +
    '$b = Get-CimInstance Win32_Battery | Select-Object -First 1;' +
    "$g = @(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like 'PCI*' } | ForEach-Object { $_.Name });" +
    '[Console]::Out.Write((@{ cores = $c; battery = $b.BatteryStatus; gpus = $g } | ConvertTo-Json -Compress))'
  try {
    const r = await runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 'hardware', true)
    return JSON.parse(r.stdout)
  } catch {
    return {}
  }
}

export async function detect(): Promise<Hardware> {
  const logical = availableParallelism()
  let physical: number | undefined
  let performance: number | undefined
  let powerPlugged: boolean | null = null
  let gpus: string[] = []
  if (process.platform === 'win32') {
    const info = await windowsInfo()
    physical = info.cores
    gpus = info.gpus ?? []
    if (info.battery) powerPlugged = info.battery !== 1
  } else if (process.platform === 'darwin') {
    const sysctl = async (key: string): Promise<number | undefined> => Number((await runCapture('sysctl', ['-n', key], 'hardware', true)).stdout) || undefined
    physical = await sysctl('hw.physicalcpu')
    // Apple Silicon: perflevel0이 성능 코어, perflevel1이 효율 코어 (효율 코어가 없는 Mac에는 perflevel1이 없다)
    if (await sysctl('hw.perflevel1.physicalcpu')) performance = await sysctl('hw.perflevel0.physicalcpu')
  }
  return {
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    physicalCores: physical ?? Math.max(1, Math.floor(logical / 2)), // 모르면 SMT 2배로 가정
    ...(performance ? { performanceCores: performance } : {}),
    logicalCores: logical,
    ramGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    gpus,
    powerPlugged
  }
}

/**
 * PC 사용을 덜 방해하도록 물리 코어 2개는 남긴다.
 * 성능·효율 코어가 나뉜 Mac은 성능 코어만 쓴다: 효율 코어가 남아 있어 덜 방해하고, 느린 코어가 섞이면 whisper가 오히려 느려진다.
 */
export function defaultThreads(hw: Hardware): number {
  return hw.performanceCores ?? Math.max(1, hw.physicalCores - 2)
}
