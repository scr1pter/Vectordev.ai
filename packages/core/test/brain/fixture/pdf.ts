// A small PDF writer for the reader's tests: text runs at given positions, sizes and fonts, an outline, image-only
// pages, metadata, a JavaScript open action and an encryption dictionary. Every fixture is generated here, so no binary
// document is committed.

export type Font = "regular" | "bold" | "mono"

export type Run = {
  readonly text: string
  readonly x: number
  /** Baseline, from the bottom of a 612 × 792 page. */
  readonly y: number
  readonly size?: number
  readonly font?: Font
}

export type Page = {
  readonly runs?: readonly Run[]
  /** Draws a picture and no text, as a scanned page does. */
  readonly image?: boolean
  /** Prints the page as a scanner with text recognition does: an image under invisible (render mode 3) text. */
  readonly ocr?: readonly Run[]
  /** A crop box narrower than the 612 × 792 page, so text between the two is printed but never shown. */
  readonly crop?: readonly [number, number, number, number]
}

export type Options = {
  readonly pages: readonly Page[]
  readonly outline?: readonly { readonly title: string; readonly page: number }[]
  readonly title?: string
  /** An open action that runs this script in a viewer that runs scripts. */
  readonly javascript?: string
  /** A standard security handler whose user password is not empty, so a reader without the password cannot open it. */
  readonly encrypted?: boolean
}

const FONTS = { regular: "F1", bold: "F2", mono: "F3" } as const

export function pdf(options: Options) {
  const objects: string[] = []
  const add = (body: string) => objects.push(body)
  const pageCount = options.pages.length
  // 1 catalog, 2 pages, 3-5 fonts, 6 image, then each page and its content, then outline items, then info.
  const firstPage = 7
  const outlineRoot = firstPage + pageCount * 2
  const outlineItems = options.outline ?? []
  const info = outlineRoot + (outlineItems.length > 0 ? 1 + outlineItems.length : 0)
  const encrypt = info + 1
  const catalog = [
    "/Type /Catalog /Pages 2 0 R",
    outlineItems.length > 0 ? `/Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` : "",
    options.javascript ? `/OpenAction << /S /JavaScript /JS (${escape(options.javascript)}) >>` : "",
    options.javascript
      ? `/Names << /JavaScript << /Names [(run) << /S /JavaScript /JS (${escape(options.javascript)}) >>] >> >>`
      : "",
  ]
  add(`<< ${catalog.filter(Boolean).join(" ")} >>`)
  add(
    `<< /Type /Pages /Count ${pageCount} /Kids [${options.pages.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ")}] >>`,
  )
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")
  add(
    stream(
      "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8",
      "\x00\xff\xff\x00",
    ),
  )
  for (const [index, page] of options.pages.entries()) {
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${page.crop ? ` /CropBox [${page.crop.join(" ")}]` : ""} /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents ${firstPage + index * 2 + 1} 0 R >>`,
    )
    const image = page.image || page.ocr ? ["q 500 0 0 700 56 46 cm /Im1 Do Q"] : []
    const runs = (page.runs ?? []).map(
      (run) =>
        `BT /${FONTS[run.font ?? "regular"]} ${run.size ?? 11} Tf 1 0 0 1 ${run.x} ${run.y} Tm (${escape(run.text)}) Tj ET`,
    )
    const ocr = (page.ocr ?? []).map(
      (run) =>
        `BT 3 Tr /${FONTS[run.font ?? "regular"]} ${run.size ?? 11} Tf 1 0 0 1 ${run.x} ${run.y} Tm (${escape(run.text)}) Tj ET`,
    )
    add(stream("<<", [...image, ...runs, ...ocr].join("\n")))
  }
  if (outlineItems.length > 0) {
    add(
      `<< /Type /Outlines /First ${outlineRoot + 1} 0 R /Last ${outlineRoot + outlineItems.length} 0 R /Count ${outlineItems.length} >>`,
    )
    for (const [index, item] of outlineItems.entries()) {
      const links = [
        index > 0 ? `/Prev ${outlineRoot + index} 0 R` : "",
        index < outlineItems.length - 1 ? `/Next ${outlineRoot + index + 2} 0 R` : "",
      ]
      add(
        `<< /Title (${escape(item.title)}) /Parent ${outlineRoot} 0 R /Dest [${firstPage + (item.page - 1) * 2} 0 R /XYZ 0 792 0] ${links.filter(Boolean).join(" ")} >>`,
      )
    }
  }
  add(`<< /Title (${escape(options.title ?? "")}) /Producer (Vector test fixture) >>`)
  if (options.encrypted)
    add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"7a".repeat(32)}> /U <${"3c".repeat(32)}> >>`)
  const header = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
  const offsets: number[] = []
  const body = objects.reduce((out, object, index) => {
    offsets.push(header.length + out.length)
    return `${out}${index + 1} 0 obj\n${object}\nendobj\n`
  }, "")
  const xref = header.length + body.length
  const table = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
  ]
  const trailer = [
    `/Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R`,
    options.encrypted ? `/Encrypt ${encrypt} 0 R /ID [<${"ab".repeat(16)}> <${"ab".repeat(16)}>]` : "",
  ]
  const file = `${header}${body}${table.join("\n")}\ntrailer\n<< ${trailer.filter(Boolean).join(" ")} >>\nstartxref\n${xref}\n%%EOF\n`
  return Uint8Array.from(file, (char) => char.charCodeAt(0) & 0xff)
}

function stream(dictionary: string, data: string) {
  return `${dictionary} /Length ${data.length} >>\nstream\n${data}\nendstream`
}

// PDF string escaping, plus the WinAnsi codes for the few typographic characters the fixtures use.
const WIN_ANSI: Record<string, string> = {
  "•": "\\225",
  "–": "\\226",
  "—": "\\227",
  "’": "\\222",
  "“": "\\223",
  "”": "\\224",
}

function escape(text: string) {
  return text.replace(/[\\()]/g, (char) => `\\${char}`).replace(/[•–—’“”]/g, (char) => WIN_ANSI[char]!)
}

/** Lines of body text from the top of a page down, 14 pt apart, as a simple one-column page sets them. */
export function lines(
  texts: readonly string[],
  options: { readonly top?: number; readonly x?: number; readonly size?: number; readonly font?: Font } = {},
) {
  return texts.map((text, index) => ({
    text,
    x: options.x ?? 72,
    y: (options.top ?? 720) - index * Math.round((options.size ?? 11) * 1.3),
    size: options.size ?? 11,
    font: options.font ?? "regular",
  }))
}
