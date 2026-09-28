import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { Engine } from './engine'

// 화면이 부를 수 있는 엔진 메서드 (허용 목록). W2에서 늘린다.
const ALLOWED = new Set(['ping'])
const engine = new Engine()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  engine.start()
  engine
    .call('ping')
    .then((result) => console.log('[engine] ping', JSON.stringify(result)))
    .catch((err) => console.error('[engine] ping 실패:', err.message))
  ipcMain.handle('engine:call', (_event, method: string, params: unknown) => {
    if (!ALLOWED.has(method)) throw new Error(`허용되지 않은 메서드: ${method}`)
    return engine.call(method, params)
  })
  createWindow()
})

app.on('window-all-closed', () => {
  engine.stop()
  app.quit()
})
