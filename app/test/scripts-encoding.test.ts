// Windows PowerShell 5.1은 BOM 없는 UTF-8 스크립트의 한글을 깨뜨린다. 저장소의 .ps1은 모두 UTF-8 BOM으로 둔다.
// (.sh의 LF는 .gitattributes가 지키므로 여기서 보지 않는다.)
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..', '..')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

async function ps1Files(dir: string): Promise<string[]> {
  const names = await readdir(join(ROOT, dir))
  return names.filter((n) => n.toLowerCase().endsWith('.ps1')).map((n) => join(ROOT, dir, n))
}

test('scripts/*.ps1, dev/*.ps1은 UTF-8 BOM으로 시작한다 (Windows PowerShell 5.1이 한글을 읽게)', async () => {
  const files = [...(await ps1Files('scripts')), ...(await ps1Files('dev'))]
  assert.ok(files.length >= 3, `.ps1 파일을 찾지 못했다 (${files.length}개). 폴더가 옮겨졌으면 이 테스트의 경로를 고친다.`)
  for (const f of files) {
    const head = (await readFile(f)).subarray(0, 3)
    assert.ok(
      head.equals(BOM),
      `${f}: UTF-8 BOM(EF BB BF)이 없다. Windows PowerShell 5.1이 한글 문자열을 깨뜨린다. 편집기에서 "UTF-8 with BOM"으로 저장한다.`
    )
  }
})
