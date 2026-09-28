import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  call: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('engine:call', method, params)
})
