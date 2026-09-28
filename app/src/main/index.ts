import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir, statfs } from 'node:fs/promises'
import { join } from 'path'
import { EngineError } from '../core/errors.ts'
import { detect } from '../core/hardware.ts'
import { defaultDataDir, findFfmpeg, findWhisperCli } from '../core/paths.ts'
import { CREDITS_PER_90MIN_SUMMARY, PROVIDERS, verifyKey } from '../core/providers.ts'
import type { ProviderId } from '../core/providers.ts'
import { loadSettings, updateSettings } from '../core/settings.ts'
import { inspectFolder, useFolder } from '../core/vault.ts'
import { keyHint, readKey, saveKey } from './secrets.ts'
import { createSetup } from './setup.ts'

// 설치본은 extraResources로 넣은 resources/bin, 개발 중에는 저장소의 .cache/whisper/bin과 PATH의 ffmpeg.
const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : undefined
const whisperDirs = app.isPackaged
  ? [join(process.resourcesPath, 'bin', 'whisper')]
  : [join(app.getAppPath(), '..', '.cache', 'whisper', 'bin')]
const probeSample = app.isPackaged ? join(process.resourcesPath, 'probe-ko.wav') : join(app.getAppPath(), 'resources', 'probe-ko.wav')
// LN_DATA_DIR: 개발 중 첫 실행 상태를 따로 시험할 때만 쓴다 (CLI의 --data-dir과 같은 역할)
const dataDir = process.env['LN_DATA_DIR'] || defaultDataDir()

function found(find: () => string): string | null {
  try {
    return find()
  } catch {
    return null
  }
}

// 메인 → 화면 이벤트. 받는 쪽 허용 목록은 preload에 있다.
function emit(name: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('api:event', name, data)
}

const setup = createSetup({ dataDir, whisperCli: () => findWhisperCli(whisperDirs), sample: probeSample, emit: (s) => emit('setup', s) })

function providerOf(id: unknown): ProviderId {
  const p = PROVIDERS.find((x) => x.id === id && x.available)
  if (!p) throw new EngineError('input', '아직 지원하지 않는 요약 서비스예요.')
  return p.id
}

async function llmStatus(): Promise<{ provider: ProviderId | null; name?: string; keyHint?: string; credits?: number | null }> {
  const { provider } = await loadSettings(dataDir)
  const key = provider ? await readKey(dataDir, provider) : null
  if (!provider || !key) return { provider: null }
  // 잔액은 참고용이라 못 불러와도(오프라인) 연결 상태는 그대로 보인다.
  const credits = await verifyKey(provider, key).then((r) => r.credits, () => null)
  return { provider, name: PROVIDERS.find((x) => x.id === provider)?.name, keyHint: keyHint(key), credits }
}

// 화면이 부를 수 있는 처리 (허용 목록).
const handlers: Record<string, (params: unknown) => unknown> = {
  ping: () => ({
    version: app.getVersion(),
    whisperCli: found(() => findWhisperCli(whisperDirs)),
    ffmpeg: found(() => findFfmpeg(binDir))
  }),

  'settings.get': () => loadSettings(dataDir),
  // 화면이 직접 바꿀 수 있는 것은 마법사 진행 상태뿐이다. 폴더와 요약 서비스는 검사를 거치는 전용 메서드로 바꾼다.
  'settings.setWizard': (p) => {
    const { step, done } = p as { step?: number; done?: boolean }
    return updateSettings(dataDir, {
      ...(Number.isInteger(step) ? { wizardStep: step } : {}),
      ...(typeof done === 'boolean' ? { wizardDone: done } : {})
    })
  },

  'system.info': async () => {
    await mkdir(dataDir, { recursive: true })
    const [hw, fs] = await Promise.all([detect(), statfs(dataDir)])
    return { cpu: hw.cpu, cores: hw.physicalCores, ramGb: hw.ramGb, freeBytes: fs.bavail * fs.bsize }
  },

  'setup.get': () => setup.get(),
  'setup.download': () => {
    void setup.download()
    return setup.get()
  },

  'llm.providers': () => PROVIDERS.map(({ id, name, available }) => ({ id, name, available })),
  'llm.status': () => llmStatus(),
  // 키를 확인하고, 맞으면 암호화해 저장한 뒤 이 서비스를 연결한다.
  'llm.connect': async (p) => {
    const { provider, key } = p as { provider: unknown; key: unknown }
    const id = providerOf(provider)
    const apiKey = String(key ?? '').trim()
    if (!apiKey) throw new EngineError('auth', '키를 붙여 넣어 주세요.')
    const { credits } = await verifyKey(id, apiKey)
    await saveKey(dataDir, id, apiKey)
    await updateSettings(dataDir, { provider: id })
    return { provider: id, keyHint: keyHint(apiKey), credits, summariesLeft: credits === null ? null : Math.floor(credits / CREDITS_PER_90MIN_SUMMARY) }
  },
  'llm.openKeyGuide': (p) => {
    const url = PROVIDERS.find((x) => x.id === p)?.keyGuideUrl
    // 목록에 있는 http(s) 주소만 연다.
    if (url?.startsWith('https://')) void shell.openExternal(url)
  },

  'folder.default': () => join(app.getPath('documents'), '강의 노트'),
  'folder.pick': async (p) => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { defaultPath: typeof p === 'string' ? p : undefined, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  },
  'folder.inspect': (p) => inspectFolder(String(p)),
  'folder.use': async (p) => {
    const info = await useFolder(String(p))
    if (!info.writable) throw new EngineError('input', '이 폴더에는 저장할 수 없어요. 다른 폴더를 골라 주세요.')
    await updateSettings(dataDir, { outDir: info.path })
    return info
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 880,
    minHeight: 600,
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
  ipcMain.handle('api:call', async (_event, method: string, params: unknown) => {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (!handler) throw new Error(`허용되지 않은 메서드: ${method}`)
    try {
      return await handler(params)
    } catch (e) {
      // IPC는 Error의 추가 필드를 버리므로, 화면이 고를 수 있게 코드를 메시지 앞에 붙인다.
      if (e instanceof EngineError) throw new Error(`[${e.code}] ${e.message}`)
      throw e
    }
  })
  void setup.init()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
