import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { documentText } from '../src/core/doctext.ts'
import { EngineError } from '../src/core/errors.ts'
import { findNotes, pairInputs, readNotes } from '../src/core/inputs.ts'
import { tempDir } from './helpers.ts'

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])))

test('docx: 문단마다 한 줄, 나뉜 글자는 잇고 표·줄 바꿈은 줄을 나눈다', () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>어휘 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">분석</w:t></w:r></w:p>
    <w:p/>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>토큰</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>a &lt; b &amp;&amp; c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>첫 줄</w:t><w:br/><w:t>둘째 줄</w:t><w:tab/><w:t>&#xAC00;&#45208;</w:t></w:r></w:p>
  </w:body></w:document>`
  const text = documentText(zip({ 'word/document.xml': xml, 'word/styles.xml': '<w:styles><w:t>아님</w:t></w:styles>' }), 'docx')
  assert.equal(text, '어휘 분석\n토큰\na < b && c\n첫 줄\n둘째 줄\n가나')
})

test('hwpx: 구역을 번호 순서로 읽고, 글자 안의 태그와 수식은 버린다', () => {
  const section = (body: string): string => `<?xml version="1.0"?><hs:sec xmlns:hp="x">${body}</hs:sec>`
  const data = zip({
    'Contents/section10.xml': section('<hp:p id="3"><hp:run><hp:t>마지막 구역</hp:t></hp:run></hp:p>'),
    'Contents/section0.xml': section(
      '<hp:p id="0"><hp:run><hp:secPr/><hp:t/></hp:run><hp:run><hp:t>파싱<hp:tab width="4000"/>LL(1)</hp:t></hp:run></hp:p>' +
      '<hp:p id="1"><hp:run><hp:t>표 앞</hp:t><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p id="2"><hp:run><hp:t>칸</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run>' +
      '<hp:run><hp:equation><hp:script>x over y</hp:script></hp:equation><hp:t>표 뒤</hp:t></hp:run></hp:p>'
    ),
    'Contents/header.xml': '<hh:head><hp:t>아님</hp:t></hh:head>'
  })
  assert.equal(documentText(data, 'hwpx'), '파싱 LL(1)\n표 앞\n칸\n표 뒤\n\n마지막 구역')
})

test('pptx: 슬라이드를 번호 순서로, 빈 줄로 나눠 읽는다', () => {
  const slide = (body: string): string => `<p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  const data = zip({
    'ppt/slides/slide2.xml': slide('<p:sp><p:txBody><a:p><a:r><a:t>FIRST 집합</a:t></a:r></a:p></p:txBody></p:sp>'),
    'ppt/slides/slide10.xml': slide('<p:pic/>'),
    'ppt/slides/slide1.xml': slide('<p:sp><p:txBody><a:bodyPr/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="ko-KR"/><a:t>구문 분석</a:t></a:r><a:br/><a:r><a:t>3주차</a:t></a:r></a:p></p:txBody></p:sp>'),
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>아님</a:t></a:r></a:p></p:notes>'
  })
  assert.equal(documentText(data, 'pptx'), '구문 분석\n3주차\n\nFIRST 집합')
})

test('문서 필기도 녹음 옆에서 찾고 readNotes로 읽는다. 읽을 수 없으면 input 오류', async () => {
  const dir = await tempDir()
  const audio = join(dir, '9.14 Lexical Analysis.m4a')
  const notes = join(dir, '9.14 Lexical Analysis.hwpx')
  await writeFile(audio, '')
  await writeFile(notes, zip({ 'Contents/section0.xml': '<hp:p><hp:run><hp:t>필기</hp:t></hp:run></hp:p>' }))
  assert.equal(findNotes(audio), notes)
  assert.deepEqual(pairInputs([audio, notes]), { recordings: [{ audio, notes }], ignored: [] })
  assert.equal(await readNotes(notes), '필기')

  // 암호를 건 문서는 ZIP이 아니고, 이름만 바꾼 파일에는 본문이 없다
  const broken = join(dir, 'broken.DOCX')
  await writeFile(broken, 'ZIP이 아님')
  await assert.rejects(readNotes(broken), (e: unknown) => e instanceof EngineError && e.code === 'input' && e.message.includes('broken.DOCX'))
  const wrong = join(dir, 'wrong.pptx')
  await writeFile(wrong, zip({ 'word/document.xml': '<w:p><w:r><w:t>글</w:t></w:r></w:p>' }))
  await assert.rejects(readNotes(wrong), EngineError)
})
