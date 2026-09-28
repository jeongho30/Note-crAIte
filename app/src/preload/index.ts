import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

// 화면이 받을 수 있는 메인 이벤트 (허용 목록)
const EVENTS = ['setup', 'jobs']

contextBridge.exposeInMainWorld('api', {
  call: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('api:call', method, params),
  on: (name: string, cb: (data: unknown) => void): (() => void) => {
    if (!EVENTS.includes(name)) throw new Error(`허용되지 않은 이벤트: ${name}`)
    const listener = (_e: IpcRendererEvent, event: string, data: unknown): void => {
      if (event === name) cb(data)
    }
    ipcRenderer.on('api:event', listener)
    return () => ipcRenderer.removeListener('api:event', listener)
  },
  // 끌어 놓은 파일의 경로 (Electron 32부터 File.path가 없다)
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
})
