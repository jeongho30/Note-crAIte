// 하드웨어 정보. Node에는 물리 코어 수와 전원 상태 API가 없어 OS 명령으로 읽는다.
import { availableParallelism, cpus, totalmem } from 'node:os'
import { runCapture } from './proc.ts'

export type Hardware = {
  cpu: string
  physicalCores: number
  logicalCores: number
  ramGb: number
  powerPlugged: boolean | null // 배터리가 없거나 모르면 null
}

async function windowsInfo(): Promise<{ cores?: number; battery?: number | null }> {
  // Win32_Battery.BatteryStatus: 1 = 배터리로 동작, 2 = 전원 연결
  const script = '$c = (Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum;' +
    '$b = Get-CimInstance Win32_Battery | Select-Object -First 1;' +
    '[Console]::Out.Write((@{ cores = $c; battery = $b.BatteryStatus } | ConvertTo-Json -Compress))'
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
  let powerPlugged: boolean | null = null
  if (process.platform === 'win32') {
    const info = await windowsInfo()
    physical = info.cores
    if (info.battery) powerPlugged = info.battery !== 1
  } else if (process.platform === 'darwin') {
    physical = Number((await runCapture('sysctl', ['-n', 'hw.physicalcpu'], 'hardware', true)).stdout) || undefined
  }
  return {
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    physicalCores: physical ?? Math.max(1, Math.floor(logical / 2)), // 모르면 SMT 2배로 가정
    logicalCores: logical,
    ramGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    powerPlugged
  }
}

/** PC 사용을 덜 방해하도록 물리 코어 2개는 남긴다. */
export function defaultThreads(hw: Hardware): number {
  return Math.max(1, hw.physicalCores - 2)
}
