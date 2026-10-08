// 모델 카탈로그(단가·추천 순서)를 저장소에서 받아 온다: 새 모델이 나와도 설치 파일을 다시 내지 않고 반영하려는 것.
// 받은 것은 <데이터 폴더>/model-catalog.json에 두어 다음 실행 때 인터넷 없이도 쓴다. 보내는 것은 없다(GET 한 번).
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './files.ts'
import { EngineError } from './errors.ts'
import { request } from './llm.ts'
import { BUILTIN, catalog, parseCatalog, setCatalog } from './llmcatalog.ts'
import type { Catalog } from './llmcatalog.ts'

/** main 브랜치의 카탈로그. 설치된 앱들이 이 주소를 읽으니 파일을 옮기지 않는다. */
export const CATALOG_URL = 'https://raw.githubusercontent.com/jeongho30/Note-crAIte/main/app/src/core/modelcatalog.json'

const CACHE_FILE = 'model-catalog.json'
const MAX_CHARS = 200_000

/** 앱에 든 것보다 오래되지 않았을 때만 쓴다 (새 설치본에 옛 캐시가 남아 있거나, 저장소가 앱보다 뒤처진 경우) */
function adopt(c: Catalog | null): boolean {
  if (!c || c.updated < BUILTIN.updated) return false
  setCatalog(c)
  return true
}

/** 지난번에 받아 둔 카탈로그를 쓴다. 썼으면 true. */
export async function loadCachedCatalog(dataDir: string): Promise<boolean> {
  return adopt(parseCatalog(await readJson(join(dataDir, CACHE_FILE)).catch(() => null)))
}

/** 저장소의 카탈로그를 받아 쓰고 데이터 폴더에 남긴다. 지금 것과 달라졌으면 true. 못 받았거나 형식이 다르면 던진다(지금 것은 그대로). */
export async function refreshCatalog(dataDir: string, url: string = CATALOG_URL): Promise<boolean> {
  const resp = await request(url, {}, 10_000, '모델 카탈로그')
  if (resp.status !== 200) throw new EngineError('network', `모델 카탈로그를 받지 못했어요: HTTP ${resp.status}`)
  const text = await resp.text()
  let data: unknown = null
  if (text.length <= MAX_CHARS) {
    try {
      data = JSON.parse(text)
    } catch {
      // 아래에서 형식 오류로 던진다
    }
  }
  const next = parseCatalog(data)
  if (!next) throw new EngineError('input', '받은 모델 카탈로그의 형식이 달라요.')
  const before = JSON.stringify(catalog())
  if (!adopt(next)) return false
  await writeJsonAtomic(join(dataDir, CACHE_FILE), next)
  return JSON.stringify(next) !== before
}
