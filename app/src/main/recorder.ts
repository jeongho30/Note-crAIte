// 앱에서 녹음하기: 화면의 MediaRecorder가 몇 초마다 보내는 조각을 데이터 폴더의 파일에 덧붙여 쓴다.
// 녹음하는 동안에는 PC가 잠들지 않게 하고, 끝나면 길이 정보를 넣은 녹음 파일로 만든다(core/recordings.ts).
import { powerSaveBlocker } from 'electron'
import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { basename } from 'node:path'
import { EngineError } from '../core/errors.ts'
import { finishRecording, newRecordingPath } from '../core/recordings.ts'

export type RecordSource = 'mic' | 'system'

type Deps = {
  dataDir: string
  ffmpeg: () => string
  log: (line: string) => void
  /** 녹음을 시작하거나 끝냈을 때 */
  onChange: (active: boolean) => void
}

type Active = { temp: string; startedAt: Date; source: RecordSource; stream: WriteStream; blocker: number; bytes: number }

export function createRecorder(d: Deps) {
  let active: Active | null = null

  function closeStream(a: Active): Promise<void> {
    return new Promise((resolve) => a.stream.end(resolve))
  }

  async function begin(source: RecordSource): Promise<void> {
    // 화면을 새로 고치는 등으로 앞 녹음이 끝나지 않았으면 그것부터 마무리한다 (처리하지 않은 녹음으로 남음)
    if (active) await end()
    const temp = await newRecordingPath(d.dataDir)
    const stream = createWriteStream(temp, { flags: 'a' })
    active = { temp, startedAt: new Date(), source, stream, blocker: powerSaveBlocker.start('prevent-app-suspension'), bytes: 0 }
    d.log(`녹음 시작: ${source === 'mic' ? '마이크' : '컴퓨터 소리'}`)
    d.onChange(true)
  }

  function chunk(bytes: unknown): Promise<void> {
    const a = active
    if (!a) throw new EngineError('input', '녹음 중이 아니에요.')
    if (!(bytes instanceof Uint8Array)) throw new EngineError('input', '녹음 조각이 올바르지 않아요.')
    a.bytes += bytes.length
    return new Promise((resolve, reject) =>
      a.stream.write(bytes, (e) => (e ? reject(new EngineError('input', '녹음을 저장하지 못했어요: ' + e.message)) : resolve()))
    )
  }

  /** 녹음을 끝내고 녹음 파일 경로를 돌려준다. 받은 소리가 없으면 null */
  async function end(): Promise<string | null> {
    const a = active
    if (!a) return null
    active = null
    powerSaveBlocker.stop(a.blocker)
    await closeStream(a)
    const path = await finishRecording(d.ffmpeg(), a.temp, a.startedAt).catch(() => null)
    const minutes = Math.round((Date.now() - a.startedAt.getTime()) / 60000)
    d.log(`녹음 끝: ${path ? basename(path) : '받은 소리 없음'} · 약 ${minutes}분 · ${Math.round(a.bytes / 1e6)}MB`)
    d.onChange(false)
    return path
  }

  /** 앱을 끝낼 때: 받은 데까지 파일을 닫는다. 녹음 중 파일로 남기고, 다음에 켜면 repairRecordings가 녹음 파일로 만든다 */
  async function close(): Promise<void> {
    const a = active
    if (!a) return
    active = null
    powerSaveBlocker.stop(a.blocker)
    await closeStream(a)
    d.log('앱을 끝내 녹음을 여기까지 저장함')
  }

  return {
    begin,
    chunk,
    end,
    close,
    active: () => active !== null,
    /** 지금 쓰는 녹음 중 파일 (남은 파일을 고칠 때 빼려고) */
    activePath: () => active?.temp ?? null
  }
}
