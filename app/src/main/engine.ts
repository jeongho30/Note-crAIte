import { ChildProcess, spawn } from 'child_process'
import { app } from 'electron'
import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void }

type Message = { id?: number; result?: unknown; error?: { code: string; message: string } }

/** Python 엔진 프로세스. stdin/stdout으로 한 줄에 JSON 하나씩 주고받는다. */
export class Engine {
  private proc: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  start(): void {
    const [command, ...args] = engineCommand()
    const proc = spawn(command, [...args, 'serve', '--parent-pid', String(process.pid)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // 엔진의 stderr는 항상 읽어서 로그 파일로 보낸다. 읽지 않으면 파이프가 차서 엔진이 멈춘다.
    const logDir = app.getPath('logs')
    mkdirSync(logDir, { recursive: true })
    proc.stderr?.pipe(createWriteStream(join(logDir, 'engine.log'), { flags: 'a' }))
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line))
    proc.on('error', (err) => this.fail(`엔진을 실행하지 못했습니다: ${err.message}`))
    proc.on('exit', (code) => this.fail(`엔진이 종료됐습니다 (code ${code})`))
    this.proc = proc
  }

  call(method: string, params: unknown = {}): Promise<unknown> {
    const stdin = this.proc?.stdin
    if (!stdin) return Promise.reject(new Error('엔진이 실행 중이 아닙니다.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  stop(): void {
    this.proc?.stdin?.end() // stdin이 닫히면 엔진이 스스로 종료한다
  }

  private onLine(line: string): void {
    let msg: Message
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === undefined) return // 진행 이벤트는 W2에서 화면으로 넘긴다
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
    else p.resolve(msg.result)
  }

  private fail(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
    this.proc = null
  }
}

/** 설치본은 함께 넣은 engine.exe로, 개발 중에는 저장소의 venv로 엔진을 띄운다. */
function engineCommand(): string[] {
  if (app.isPackaged) return [join(process.resourcesPath, 'engine', 'engine.exe')]
  return [join(app.getAppPath(), '..', 'engine', '.venv', 'Scripts', 'python.exe'), '-m', 'lnengine']
}
