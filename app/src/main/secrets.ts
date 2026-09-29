// 요약 서비스 API 키 보관. Electron safeStorage(Windows는 DPAPI)로 암호화해 <데이터 폴더>/secrets.json에 둔다.
// 키는 화면으로 돌려주지 않는다(끝 4자리만).
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../core/files.ts'
import type { ProviderId } from '../core/providers.ts'

type Store = Partial<Record<ProviderId, string>> // base64 암호문

function storePath(dataDir: string): string {
  return join(dataDir, 'secrets.json')
}

async function load(dataDir: string): Promise<Store> {
  try {
    return await readJson<Store>(storePath(dataDir))
  } catch {
    return {}
  }
}

export async function saveKey(dataDir: string, id: ProviderId, apiKey: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC에서는 키를 암호화해 저장할 수 없어요.')
  const store = await load(dataDir)
  store[id] = safeStorage.encryptString(apiKey).toString('base64')
  await writeJsonAtomic(storePath(dataDir), store)
}

/** 연결 끊기: 이 서비스의 키를 지운다. */
export async function removeKey(dataDir: string, id: ProviderId): Promise<void> {
  const store = await load(dataDir)
  if (!(id in store)) return
  delete store[id]
  await writeJsonAtomic(storePath(dataDir), store)
}

export async function readKey(dataDir: string, id: ProviderId): Promise<string | null> {
  const enc = (await load(dataDir))[id]
  return enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : null
}

export function keyHint(apiKey: string): string {
  return apiKey.slice(-4)
}
