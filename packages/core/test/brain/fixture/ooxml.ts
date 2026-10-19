// Word, PowerPoint and Excel files built from XML strings with fflate, and raw zip archives for the limit tests (a
// bomb, too many entries, a lying header). Nothing binary is committed.

import { Deflate, strToU8, zipSync } from "fflate"

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

export function zip(files: Record<string, string | Uint8Array>) {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data]),
    ),
  )
}

function rels(items: readonly { id: string; type: string; target: string; external?: boolean }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      (item) =>
        `<Relationship Id="${item.id}" Type="${REL}/${item.type}" Target="${item.target}"${item.external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("")}</Relationships>`
}

function core(title?: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${title ? `<dc:title>${title}</dc:title>` : ""}</cp:coreProperties>`
}

const TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'

// --- Word -------------------------------------------------------------------------------------------------------------

/** A run: plain text, or text with properties. */
export type Run =
  | string
  | {
      readonly text: string
      readonly vanish?: boolean
      readonly white?: boolean
      readonly mono?: boolean
      readonly tiny?: boolean
    }

/** A paragraph in a style ("Heading1", "Title", "Code", "Quote", "ListBullet"), or numbered (numId 1 bullets, 2 numbers). */
export type Paragraph = {
  readonly style?: string
  readonly runs: readonly Run[]
  readonly num?: { readonly id: number; readonly level?: number }
  readonly outline?: number
  readonly pageBreakBefore?: boolean
}

export function p(text: string, style?: string): Paragraph {
  return { runs: [text], ...(style ? { style } : {}) }
}

export function wordRun(run: Run) {
  if (typeof run === "string") return `<w:r><w:t xml:space="preserve">${escape(run)}</w:t></w:r>`
  const properties = [
    run.vanish ? "<w:vanish/>" : "",
    run.white ? '<w:color w:val="FFFFFF"/>' : "",
    run.mono ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : "",
    run.tiny ? '<w:sz w:val="2"/>' : "",
  ].join("")
  return `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${escape(run.text)}</w:t></w:r>`
}

export function wordParagraph(paragraph: Paragraph) {
  const properties = [
    paragraph.style ? `<w:pStyle w:val="${paragraph.style}"/>` : "",
    paragraph.num
      ? `<w:numPr><w:ilvl w:val="${paragraph.num.level ?? 0}"/><w:numId w:val="${paragraph.num.id}"/></w:numPr>`
      : "",
    paragraph.outline !== undefined ? `<w:outlineLvl w:val="${paragraph.outline}"/>` : "",
  ].join("")
  const brk = paragraph.pageBreakBefore ? "<w:r><w:lastRenderedPageBreak/></w:r>" : ""
  return `<w:p><w:pPr>${properties}</w:pPr>${brk}${paragraph.runs.map(wordRun).join("")}</w:p>`
}

export function wordTable(rows: readonly (readonly string[])[]) {
  return `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p>${wordRun(cell)}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${[
  ["Title", "Title"],
  ["Heading1", "heading 1"],
  ["Heading2", "heading 2"],
  ["Heading3", "heading 3"],
  ["Code", "Code"],
  ["Quote", "Quote"],
  ["Normal", "Normal"],
]
  .map(
    ([id, name]) =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${id === "Heading2" ? '<w:basedOn w:val="Heading1"/>' : ""}</w:style>`,
  )
  .join(
    "",
  )}<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num></w:numbering>`

/** A .docx whose body is the given XML (paragraphs from `wordParagraph`, tables from `wordTable`, or anything else). */
export function docx(input: {
  readonly body: readonly (Paragraph | string)[]
  readonly title?: string
  readonly footnotes?: readonly string[]
  readonly links?: readonly string[]
  readonly external?: string
  readonly macros?: boolean
  readonly extra?: Record<string, string | Uint8Array>
}) {
  const body = input.body.map((item) => (typeof item === "string" ? item : wordParagraph(item))).join("")
  return zip({
    "[Content_Types].xml": TYPES,
    "_rels/.rels": rels([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": STYLES,
    "word/numbering.xml": NUMBERING,
    "word/_rels/document.xml.rels": rels([
      ...(input.links ?? []).map((link, index) => ({
        id: `rLink${index}`,
        type: "hyperlink",
        target: link,
        external: true,
      })),
      ...(input.external
        ? [{ id: "rTemplate", type: "attachedTemplate", target: input.external, external: true }]
        : []),
    ]),
    ...(input.footnotes
      ? {
          "word/footnotes.xml": `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W}>${input.footnotes.map((note, index) => `<w:footnote w:id="${index + 1}">${wordParagraph(p(note))}</w:footnote>`).join("")}</w:footnotes>`,
        }
      : {}),
    "docProps/core.xml": core(input.title),
    ...(input.macros ? { "word/vbaProject.bin": new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) } : {}),
    ...(input.extra ?? {}),
  })
}

// --- PowerPoint -------------------------------------------------------------------------------------------------------

export type Slide = {
  readonly title?: string
  readonly bullets?: readonly (string | { readonly text: string; readonly level: number })[]
  readonly text?: readonly string[]
  readonly table?: readonly (readonly string[])[]
  readonly notes?: string
  readonly hidden?: boolean
  readonly footer?: string
}

const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

function shape(placeholder: string | undefined, paragraphs: readonly string[]) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${placeholder === undefined ? "" : `<p:ph type="${placeholder}"/>`}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs.join("")}</p:txBody></p:sp>`
}

function drawing(text: string, level = 0, bullet?: "none") {
  return `<a:p><a:pPr lvl="${level}">${bullet === "none" ? "<a:buNone/>" : ""}</a:pPr><a:r><a:t>${escape(text)}</a:t></a:r></a:p>`
}

/**
 * A .pptx. Slides are stored under file names in reverse order, so a reader that takes the order from
 * presentation.xml, not from the names, reads them as given.
 */
export function pptx(slides: readonly Slide[], options: { readonly title?: string } = {}) {
  const files: Record<string, string> = {
    "[Content_Types].xml": TYPES,
    "_rels/.rels": rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]),
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rS${index}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(
      slides.map((_, index) => ({
        id: `rS${index}`,
        type: "slide",
        target: `slides/slide${slides.length - index}.xml`,
      })),
    ),
    "docProps/core.xml": core(options.title),
  }
  for (const [index, slide] of slides.entries()) {
    const file = slides.length - index
    const body = [
      ...(slide.title ? [shape("title", [drawing(slide.title)])] : []),
      ...(slide.bullets
        ? [
            shape(
              "body",
              slide.bullets.map((bullet) =>
                typeof bullet === "string" ? drawing(bullet) : drawing(bullet.text, bullet.level),
              ),
            ),
          ]
        : []),
      ...(slide.text
        ? [
            shape(
              undefined,
              slide.text.map((text) => drawing(text, 0, "none")),
            ),
          ]
        : []),
      ...(slide.footer ? [shape("ftr", [drawing(slide.footer)])] : []),
      ...(slide.table
        ? [
            `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${slide.table.map((row) => `<a:tr>${row.map((cell) => `<a:tc><a:txBody>${drawing(cell)}</a:txBody></a:tc>`).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
          ]
        : []),
    ].join("")
    files[`ppt/slides/slide${file}.xml`] =
      `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
    files[`ppt/slides/_rels/slide${file}.xml.rels`] = rels(
      slide.notes ? [{ id: "rN", type: "notesSlide", target: `../notesSlides/notesSlide${file}.xml` }] : [],
    )
    if (slide.notes)
      files[`ppt/notesSlides/notesSlide${file}.xml`] =
        `<?xml version="1.0" encoding="UTF-8"?><p:notes ${P}><p:cSld><p:spTree>${shape("sldImg", [])}${shape("body", [drawing(slide.notes, 0, "none")])}${shape("sldNum", [drawing(String(file))])}</p:spTree></p:cSld></p:notes>`
  }
  return zip(files)
}

// --- Excel ------------------------------------------------------------------------------------------------------------

export type Sheet = {
  readonly name: string
  readonly rows: readonly (readonly (
    | string
    | number
    | boolean
    | { readonly formula: string; readonly value: number }
  )[])[]
  readonly hidden?: boolean
  readonly hiddenRows?: readonly number[]
}

/** A .xlsx: strings shared, numbers as values, booleans typed, formulas with their cached value. */
export function xlsx(sheets: readonly Sheet[]) {
  const strings: string[] = []
  const shared = (text: string) => {
    if (!strings.includes(text)) strings.push(text)
    return strings.indexOf(text)
  }
  const files: Record<string, string> = {
    "[Content_Types].xml": TYPES,
    "_rels/.rels": rels([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]),
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rW${index}"${sheet.hidden ? ' state="hidden"' : ""}/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels(
      sheets.map((_, index) => ({ id: `rW${index}`, type: "worksheet", target: `worksheets/sheet${index + 1}.xml` })),
    ),
  }
  for (const [index, sheet] of sheets.entries()) {
    const rows = sheet.rows
      .map((row, at) => {
        const cells = row
          .map((cell, column) => {
            const ref = `${letters(column)}${at + 1}`
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
            if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`
            if (typeof cell === "object") return `<c r="${ref}"><f>${escape(cell.formula)}</f><v>${cell.value}</v></c>`
            return `<c r="${ref}" t="s"><v>${shared(cell)}</v></c>`
          })
          .join("")
        return `<row r="${at + 1}"${sheet.hiddenRows?.includes(at + 1) ? ' hidden="1"' : ""}>${cells}</row>`
      })
      .join("")
    files[`xl/worksheets/sheet${index + 1}.xml`] =
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  }
  files["xl/sharedStrings.xml"] =
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}">${strings.map((text) => `<si><t>${escape(text)}</t></si>`).join("")}</sst>`
  return zip(files)
}

function letters(column: number): string {
  return column < 26
    ? String.fromCharCode(65 + column)
    : `${letters(Math.floor(column / 26) - 1)}${String.fromCharCode(65 + (column % 26))}`
}

// --- Raw zip ----------------------------------------------------------------------------------------------------------

export type Entry = {
  readonly name: string
  /** Stored as given: already deflated for method 8. */
  readonly data: Uint8Array
  readonly method: 0 | 8
  /** What the headers claim the entry inflates to; a bomb lies about it. */
  readonly size: number
  readonly flags?: number
}

/** A zip written byte by byte, so its headers can say anything. */
export function archive(entries: readonly Entry[]) {
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  const offsets = entries.reduce<number[]>(
    (all, entry, index) => [
      ...all,
      index === 0 ? 0 : all[index - 1]! + 30 + entries[index - 1]!.name.length + entries[index - 1]!.data.length,
    ],
    [],
  )
  for (const [index, entry] of entries.entries()) {
    const name = strToU8(entry.name)
    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, entry.flags ?? 0, true)
    header.setUint16(8, entry.method, true)
    header.setUint32(18, entry.data.length, true)
    header.setUint32(22, entry.size, true)
    header.setUint16(26, name.length, true)
    local.push(new Uint8Array(header.buffer), name, entry.data)
    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 20, true)
    record.setUint16(6, 20, true)
    record.setUint16(8, entry.flags ?? 0, true)
    record.setUint16(10, entry.method, true)
    record.setUint32(20, entry.data.length, true)
    record.setUint32(24, entry.size, true)
    record.setUint16(28, name.length, true)
    record.setUint32(42, offsets[index]!, true)
    central.push(new Uint8Array(record.buffer), name)
  }
  const start = local.reduce((sum, part) => sum + part.length, 0)
  const size = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Math.min(entries.length, 0xffff), true)
  end.setUint16(10, Math.min(entries.length, 0xffff), true)
  end.setUint32(12, size, true)
  end.setUint32(16, start, true)
  return concat([...local, ...central, new Uint8Array(end.buffer)])
}

/**
 * A raw DEFLATE stream of `megabytes` of zeros (about 1,000:1), built without holding them: three megabytes compressed
 * with a byte-aligned flush after each, then the third block repeated. It inflates to another megabyte every time,
 * because the window it refers back to is zeros whichever block came before.
 */
export function zeros(megabytes: number) {
  const chunk = new Uint8Array(1024 * 1024)
  const blocks: Uint8Array[][] = [[]]
  const deflate = new Deflate({ level: 9 }, (data) => blocks.at(-1)!.push(data))
  for (let block = 0; block < 3; block++) {
    deflate.push(chunk)
    deflate.flush(true)
    blocks.push([])
  }
  deflate.push(new Uint8Array(0), true)
  const [first, second, third, end] = blocks.map(concat)
  return concat([
    first!,
    ...(megabytes > 1 ? [second!] : []),
    ...Array.from({ length: Math.max(0, megabytes - 2) }, () => third!),
    end!,
  ])
}

/** An Office-shaped zip bomb: a document part that claims 1 KB and inflates to `megabytes` of zeros. */
export function bomb(megabytes: number) {
  return archive([
    { name: "[Content_Types].xml", data: strToU8(TYPES), method: 0, size: TYPES.length },
    { name: "word/document.xml", data: zeros(megabytes), method: 8, size: 1024 },
  ])
}

export function concat(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.length
  }, 0)
  return out
}

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
