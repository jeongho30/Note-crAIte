import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { findFfmpeg, findWhisperCli } from '../core/paths.ts'

// 설치본은 extraResources로 넣은 resources/bin, 개발 중에는 저장소의 .cache/whisper/bin과 PATH의 ffmpeg.
const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : undefined
const whisperDirs = app.isPackaged
  ? [join(process.resourcesPath, 'bin', 'whisper')]
  : [join(app.getAppPath(), '..', '.cache', 'whisper', 'bin')]

function found(find: () => string): string | null {
  try {
    return find()
  } catch {
    return null
  }
}

// 화면이 부를 수 있는 처리 (허용 목록). W2에서 늘린다.
const handlers: Record<string, (params: unknown) => unknown> = {
  ping: () => ({
    version: app.getVersion(),
    whisperCli: found(() => findWhisperCli(whisperDirs)),
    ffmpeg: found(() => findFfmpeg(binDir))
  })
}

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
  ipcMain.handle('api:call', (_event, method: string, params: unknown) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (!handler) throw new Error(`허용되지 않은 메서드: ${method}`)
    return handler(params)
  })
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
