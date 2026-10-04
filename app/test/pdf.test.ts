import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findNotes, notesProblem, pairInputs, readNotes } from '../src/core/inputs.ts'
import { pagesProblem, pagesToNotes } from '../src/core/pdf.ts'

/**
 * 합성 PDF. 쪽마다 줄 목록을 받아, 한글 PDF(한글·파워포인트에서 내보낸 것)처럼 Type0 글꼴(Identity-H)과
 * ToUnicode로 글자를 적는다. 글꼴 파일은 넣지 않는다 (글자 뽑기는 ToUnicode만 본다).
 */
function makePdf(pages: string[][]): Buffer {
  const chars = [...new Set(pages.flat().join(''))]
  const cid = (c: string): string => (chars.indexOf(c) + 1).toString(16).padStart(4, '0')
  const hex = (n: number): string => n.toString(16).padStart(4, '0')
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Synth def /CMapType 2 def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    `${chars.length} beginbfchar`,
    ...chars.map((c) => `<${cid(c)}> <${[...Buffer.from(c, 'utf16le')].reduce((s, b, i, a) => (i % 2 ? s : s + hex((a[i + 1] << 8) | b)), '')}>`),
    'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
  ].join('\n')
  const objs: string[] = []
  const add = (body: string): number => objs.push(body)
  const catalog = add('')
  const pagesObj = add('')
  const font = add('')
  const cidFont = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synth /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>')
  const toUni = add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`)
  objs[font - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /Synth /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUni} 0 R >>`
  const kids = pages.map((lines) => {
    const ops = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td <${[...l].map(cid).join('')}> Tj ET`).join('\n')
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`)
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`)
  })
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.7\n'
  const offsets = objs.map((body, i) => {
    const at = Buffer.byteLength(out)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

test('PDF 필기: 쪽마다 한글 글자를 뽑고 쪽 번호를 단다 (빈 쪽은 뺌)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ln-pdf-'))
  const path = join(dir, '9.14 어휘 분석.pdf')
  await writeFile(path, makePdf([['어휘 분석', '토큰은 최소 단위'], [], ['LL(1) 파서와 FIRST 집합']]))
  assert.equal(await notesProblem(path), null)
  const notes = await readNotes(path)
  assert.match(notes, /^\[1쪽\]\n어휘 분석/)
  assert.match(notes, /토큰은 최소 단위/)
  assert.match(notes, /\[3쪽\]\nLL\(1\) 파서와 FIRST 집합$/)
  assert.doesNotMatch(notes, /\[2쪽\]/)
})

test('PDF 필기: 녹음 옆의 같은 이름 PDF를 찾고, 함께 넣은 PDF를 짝짓는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ln-pdf-'))
  const audio = join(dir, '9.14 Lexical.m4a')
  await writeFile(audio, '')
  await writeFile(join(dir, '9.14 Lexical.pdf'), makePdf([['필기']]))
  assert.equal(findNotes(audio), join(dir, '9.14 Lexical.pdf'))
  // 텍스트 필기가 있으면 그것이 먼저
  await writeFile(join(dir, '9.14 Lexical.md'), '# 필기')
  assert.equal(findNotes(audio), join(dir, '9.14 Lexical.md'))
  const { recordings, ignored } = pairInputs([audio, join(dir, '9.14 Lexical.pdf')])
  assert.equal(recordings[0].notes, join(dir, '9.14 Lexical.pdf'))
  assert.deepEqual(ignored, [])
})

test('PDF 필기: 글자가 없는 PDF(스캔본)와 열리지 않는 파일은 이유를 돌려준다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ln-pdf-'))
  const scanned = join(dir, 'scan.pdf')
  await writeFile(scanned, makePdf([[], []]))
  assert.match((await notesProblem(scanned))!, /글자가 없는 PDF/)
  await assert.rejects(readNotes(scanned), /글자가 없는 PDF/)
  const broken = join(dir, 'broken.pdf')
  await writeFile(broken, 'PDF가 아님')
  assert.match((await notesProblem(broken))!, /PDF를 열지 못했어요/)
  // 텍스트 필기는 열어 보지 않는다
  assert.equal(await notesProblem(join(dir, 'x.md')), null)
})

test('pagesProblem: 대체 문자·사용자 정의 영역 글자가 많으면 깨진 PDF로 본다', () => {
  const bad = String.fromCharCode(0xfffd).repeat(20) + String.fromCharCode(0xe000).repeat(20) + '정상 글자 열 개 남짓'
  assert.match(pagesProblem([bad])!, /깨져/)
  assert.equal(pagesProblem(['정상적인 강의 슬라이드 글자가 충분히 들어 있다', String.fromCharCode(0xfffd)]), null)
  assert.equal(pagesToNotes(['  a  \n\n\n\nb ', '', 'c']), '[1쪽]\na\n\nb\n\n[3쪽]\nc')
})
