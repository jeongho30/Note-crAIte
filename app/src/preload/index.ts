import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  call: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('api:call', method, params)
})
