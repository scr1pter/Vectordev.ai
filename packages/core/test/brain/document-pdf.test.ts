import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { deflated, lines, pdf, stream, type Extra, type Run } from "./fixture/pdf"

const read = async (bytes: Uint8Array, limits = BrainLimits.LIMITS.worker) => {
  const result = await BrainDocument.read({ name: "spec.pdf", bytes }, limits)
  if (result.type === "refused") throw new Error(result.message)
  return result
}

const blocks = (extracted: BrainDocument.Extracted) =>
  extracted.blocks.map((block) =>
    block.type === "list"
      ? `${block.type}:${block.items.map((item) => `${item.depth}${item.text}`).join("|")}`
      : block.type === "table"
        ? `table:${block.header.join(",")}/${block.rows.map((row) => row.join(",")).join(";")}`
        : `${block.type}${block.type === "heading" ? block.level : ""}:${block.text}`,
  )

describe("BrainDocument PDF", () => {
  test("unpdf loads under bun test and reads text with pages, metadata title and the body", async () => {
    const extracted = await read(
      pdf({
        title: "Upload guide",
        pages: [{ runs: lines(["Uploads are limited to 50 MB per file.", "Larger files are refused."]) }],
      }),
    )
    expect(extracted).toMatchObject({ type: "extracted", format: "pdf", title: "Upload guide", pages: 1, unread: [] })
    expect(blocks(extracted)).toEqual(["paragraph:Uploads are limited to 50 MB per file. Larger files are refused."])
    expect(extracted.blocks[0]!.span.page).toBe(1)
  })

  test("headings come from the outline, size, weight and numbering", async () => {
    const extracted = await read(
      pdf({
        outline: [{ title: "Appendix", page: 2 }],
        pages: [
          {
            runs: [
              { text: "1 Overview", x: 72, y: 720, size: 16, font: "bold" },
              ...lines(["The service issues tokens to signed-in users."], { top: 690 }),
              { text: "1.1 Scope", x: 72, y: 660, size: 13, font: "bold" },
              ...lines(["Only web clients are covered here."], { top: 640 }),
              { text: "Notes", x: 72, y: 610, size: 11, font: "bold" },
              ...lines(["Nothing else is in scope."], { top: 590 }),
            ],
          },
          { runs: [...lines(["Appendix"], { top: 720 }), ...lines(["Extra material lives here."], { top: 690 })] },
        ],
      }),
    )
    expect(blocks(extracted)).toEqual([
      "heading1:1 Overview",
      "paragraph:The service issues tokens to signed-in users.",
      "heading2:1.1 Scope",
      "paragraph:Only web clients are covered here.",
      "heading3:Notes",
      "paragraph:Nothing else is in scope.",
      "heading1:Appendix",
      "paragraph:Extra material lives here.",
    ])
  })

  test("an outline entry with no matching line still opens its section", async () => {
    const extracted = await read(
      pdf({ outline: [{ title: "Limits", page: 1 }], pages: [{ runs: lines(["Uploads stop at 50 MB per file."]) }] }),
    )
    expect(blocks(extracted)).toEqual(["heading1:Limits", "paragraph:Uploads stop at 50 MB per file."])
  })

  test("hyphenated line breaks join; running headers, footers and page numbers are dropped", async () => {
    const page = (number: number): { runs: Run[] } => ({
      runs: [
        { text: "Auth spec - draft", x: 72, y: 770 },
        ...lines([`Page ${number} says the retry budget is recal-`, "culated every minute by the worker."]),
        { text: `${number}`, x: 300, y: 30 },
      ],
    })
    const extracted = await read(pdf({ pages: [page(1), page(2), page(3)] }))
    expect(blocks(extracted)).toEqual(
      [1, 2, 3].map(
        (number) => `paragraph:Page ${number} says the retry budget is recalculated every minute by the worker.`,
      ),
    )
  })

  test("two columns are read left column first", async () => {
    const left = [
      "Left column line one of the",
      "text that runs down the left",
      "side of the page in order.",
      "It keeps going a little more.",
    ]
    const right = [
      "Right column line one of the",
      "text that runs down the right",
      "side of the page after it.",
      "And it ends right about here.",
    ]
    const runs = [...lines(left, { x: 72, size: 10 }), ...lines(right, { x: 330, size: 10 })]
    const extracted = await read(
      pdf({ pages: [{ runs: [{ text: "Two columns", x: 72, y: 750, size: 16, font: "bold" }, ...runs] }] }),
    )
    expect(blocks(extracted)).toEqual([
      "heading1:Two columns",
      `paragraph:${left.join(" ")}`,
      `paragraph:${right.join(" ")}`,
    ])
  })

  test("bulleted and numbered lists, aligned tables, and monospace code", async () => {
    const extracted = await read(
      pdf({
        pages: [
          {
            runs: [
              ...lines(["• Build the image", "• Push it to the registry"], { top: 740 }),
              { text: "• Tag the release", x: 90, y: 714 },
              ...[
                ["Name", "Default", "Description"],
                ["timeout", "30 s", "Request timeout"],
                ["retries", "3", "Retry count"],
              ].flatMap((row, index) =>
                row.map(
                  (cell, column): Run => ({
                    text: cell,
                    x: [72, 200, 330][column]!,
                    y: 660 - index * 16,
                    font: index === 0 ? "bold" : "regular",
                  }),
                ),
              ),
              ...lines(["bun run build", "  --production"], { top: 580, font: "mono" }),
              ...lines(["Plain text after the code."], { top: 530 }),
              { text: "Call", x: 72, y: 500 },
              { text: "refresh()", x: 98, y: 500, font: "mono" },
              { text: "before the request.", x: 160, y: 500 },
            ],
          },
        ],
      }),
    )
    expect(blocks(extracted)).toEqual([
      "list:0Build the image|0Push it to the registry|1Tag the release",
      "table:Name,Default,Description/timeout,30 s,Request timeout;retries,3,Retry count",
      "code:bun run build\n  --production",
      "paragraph:Plain text after the code.",
      "paragraph:Call refresh() before the request.",
    ])
    const paragraph = extracted.blocks.at(-1)!
    expect(paragraph.type === "paragraph" ? paragraph.code : []).toEqual(["refresh()"])
    expect(extracted.warnings).toContain("tables-approximate")
  })

  test("a page with no text layer (under 25 characters) is listed as unread; recognised (invisible) text on a scan is kept", async () => {
    const extracted = await read(
      pdf({
        pages: [
          { runs: lines(["The first page has its own text on it."]) },
          { image: true },
          { ocr: lines(["Recognised text from a scanned page."]) },
        ],
      }),
    )
    expect(extracted.unread).toEqual([2])
    expect(extracted.warnings).toContain("scanned")
    expect(blocks(extracted)).toEqual([
      "paragraph:The first page has its own text on it.",
      "paragraph:Recognised text from a scanned page.",
    ])
    expect(extracted.blocks[1]!.span.page).toBe(3)
  })

  test("only the first 1,000 pages are read (300 on the main thread), and the rest is flagged truncated", async () => {
    const bytes = pdf({
      pages: Array.from({ length: 1_001 }, (_, index) => ({
        runs: lines([`Page ${index + 1} holds one sentence of body text.`]),
      })),
    })
    const extracted = await read(bytes)
    expect(extracted.pages).toBe(1_001)
    expect(extracted.blocks).toHaveLength(1_000)
    expect(extracted.warnings).toContain("truncated")
    const inline = await read(bytes, BrainLimits.LIMITS.inline)
    expect(inline.blocks).toHaveLength(300)
  }, 60_000)

  test("a password-protected PDF is refused without asking for the password", async () => {
    const result = await BrainDocument.read(
      { name: "locked.pdf", bytes: pdf({ encrypted: true, pages: [{ runs: lines(["Secret text"]) }] }) },
      BrainLimits.LIMITS.worker,
    )
    expect(result).toMatchObject({ type: "refused", reason: "encrypted" })
  })

  test("a damaged PDF is refused, not thrown", async () => {
    const result = await BrainDocument.read(
      { name: "broken.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nthis is not a pdf at all") },
      BrainLimits.LIMITS.worker,
    )
    expect(result.type).toBe("refused")
  })
})

describe("BrainDocument PDF from a hostile file", () => {
  const body = lines([
    "Uploads are limited to 50 MB per file in every region.",
    "Larger files are refused by the service.",
    "Retries back off for a minute before trying again.",
    "The worker resumes the upload where it stopped.",
  ])
  const timed = async (bytes: Uint8Array, limits = BrainLimits.LIMITS.inline) => {
    const started = performance.now()
    const result = await BrainDocument.read({ name: "hostile.pdf", bytes }, limits)
    return { result, elapsed: performance.now() - started }
  }

  test("a page a billion points wide or a run stretched far past its page reads at once", async () => {
    const wide = await timed(
      pdf({ pages: [{ media: [0, 0, 1e9, 792], runs: [...body, { text: "Far right of the page", x: 9e8, y: 700 }] }] }),
    )
    expect(wide.elapsed).toBeLessThan(5_000)
    expect(wide.result.type).toBe("extracted")
    for (const stretch of [8e7, 1e12]) {
      const stretched = await timed(
        pdf({ pages: [{ runs: [...body, { text: "Stretched words", x: 72, y: 600, stretch }] }] }),
      )
      expect(stretched.elapsed).toBeLessThan(5_000)
      expect(stretched.result.type).toBe("extracted")
      if (stretched.result.type === "extracted") expect(stretched.result.text).toContain("Uploads are limited")
    }
  }, 30_000)

  test("a page tree that lists itself leaves the pages it cannot reach unread instead of failing", async () => {
    const result = await BrainDocument.read(
      { name: "loop.pdf", bytes: pdf({ loop: true, pages: [{ runs: body }] }) },
      BrainLimits.LIMITS.worker,
    )
    expect(result).toMatchObject({ type: "extracted", unread: [2] })
    if (result.type === "extracted") expect(result.text).toContain("Uploads are limited")
  })

  test("streams that inflate past the cap are refused, and ones under it are read", async () => {
    const limits = { ...BrainLimits.LIMITS.inline, streams: 1024 * 1024 }
    expect((await timed(pdf({ pages: [{ runs: body, padding: 2 * 1024 * 1024 }] }), limits)).result).toMatchObject({
      type: "refused",
      reason: "too-large",
    })
    expect((await timed(pdf({ pages: [{ runs: body, padding: 512 * 1024 }] }), limits)).result.type).toBe("extracted")
  })

  // pdf.js reads a filter by its short name, decodes a content stream whatever its other entries say, takes any line
  // break after `stream` and parses a dictionary of any length, so none of these may get past the count.
  test.each([
    ["/Filter /FlateDecode", {}],
    ["/Filter [/FlateDecode]", { filter: "/Filter [/FlateDecode]" }],
    ["/Filter /Fl", { filter: "/Filter /Fl" }],
    ["/Subtype /Image", { filter: "/Subtype /Image /Filter /FlateDecode" }],
    ["a carriage return after `stream`", { breaks: "\r" }],
    ["a space after `stream`", { breaks: " \n" }],
    ["5,000 characters before /Length", { filter: `/Filter /FlateDecode /Junk (${"a".repeat(5_000)})` }],
    ["the text in the same, only content stream", { packed: true }],
  ] as const)(
    "200 MB of padding with %s is refused at the cap",
    async (_, page) => {
      const bytes = pdf({ pages: [{ runs: body, padding: 200 * 1024 * 1024, ...page }] })
      expect(bytes.length).toBeLessThan(1024 * 1024)
      const read = await timed(bytes)
      expect(read.result).toMatchObject({ type: "refused", reason: "too-large" })
      expect(read.elapsed).toBeLessThan(10_000)
    },
    60_000,
  )

  test("a content stream in a picture's or Brotli's compression is read as empty, since neither is counted", async () => {
    const { brotliCompressSync } = await import("node:zlib")
    const hidden = "BT /F1 11 Tf 1 0 0 1 72 400 Tm (Words packed with Brotli are shown only once decoded) Tj ET"
    const file = new TextDecoder("latin1").decode(pdf({ pages: [{ runs: body }] }))
    const brotli = Array.from(brotliCompressSync(hidden), (byte) => String.fromCharCode(byte)).join("")
    // The page's first content stream, which holds its text, is swapped for the Brotli one; the cross-reference table
    // is then off by the difference, which pdf.js repairs by scanning the file.
    const swapped = file.replace(
      /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/,
      () => `<< /Filter /BrotliDecode /Length ${brotli.length} >>\nstream\n${brotli}\nendstream`,
    )
    const result = await BrainDocument.read(
      { name: "brotli.pdf", bytes: Uint8Array.from(swapped, (char) => char.charCodeAt(0)) },
      BrainLimits.LIMITS.inline,
    )
    expect(result.type).toBe("extracted")
    if (result.type === "extracted") expect(result.text).not.toContain("Brotli")
  })

  // A sampled function's table, the functions a stitching function lists and a mesh's points are as large as the file
  // says, not as large as anything decoded. Here each keeps its data in a stream that inflates past the cap, so the
  // file is refused if any of them is built at all, and none is: only drawing needs them.
  const MB = 1024 * 1024
  const sampled = stream(
    "<< /FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2097152] /BitsPerSample 8 /Filter /FlateDecode",
    deflated("", 2 * MB),
  )
  const mesh = stream(
    "<< /ShadingType 5 /ColorSpace /DeviceGray /BitsPerCoordinate 8 /BitsPerComponent 8 /VerticesPerRow 2 /Decode [0 1 0 1 0 1] /Filter /FlateDecode",
    deflated("", 2 * MB),
  )
  test.each<[string, (first: number) => Extra]>([
    [
      "a colour's tint transform",
      (first) => ({
        resources: `/ColorSpace << /Cs1 [/Separation /Spot /DeviceGray ${first} 0 R] >>`,
        content: "/Cs1 cs 0.5 sc",
        objects: [sampled],
      }),
    ],
    [
      "a transfer curve",
      (first) => ({
        resources: `/ExtGState << /Gs1 << /TR ${first} 0 R >> >>`,
        content: "/Gs1 gs",
        objects: [sampled],
      }),
    ],
    [
      "a stitching function's parts",
      (first) => ({
        resources: `/ColorSpace << /Cs1 [/Separation /Spot /DeviceGray ${first} 0 R] >>`,
        content: "/Cs1 cs 0.5 sc",
        objects: [
          `<< /FunctionType 3 /Domain [0 1] /Functions [${first + 1} 0 R ${first + 1} 0 R] /Bounds [0.5] /Encode [0 1 0 1] >>`,
          sampled,
        ],
      }),
    ],
    [
      "a gradient's colours",
      (first) => ({
        resources: `/Shading << /Sh1 ${first} 0 R >>`,
        content: "/Sh1 sh",
        objects: [
          `<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 100 0] /Function ${first + 1} 0 R >>`,
          sampled,
        ],
      }),
    ],
    [
      "a mesh's points",
      (first) => ({ resources: `/Shading << /Sh1 ${first} 0 R >>`, content: "/Sh1 sh", objects: [mesh] }),
    ],
    [
      "a mesh filling a shape as its pattern",
      (first) => ({
        resources: `/Pattern << /P1 << /PatternType 2 /Shading ${first} 0 R >> >>`,
        content: "/Pattern cs /P1 scn 0 0 100 100 re f",
        objects: [mesh],
      }),
    ],
  ])("the reader never builds %s", async (_, extra) => {
    const read = await timed(pdf({ pages: [{ runs: body }], extra }), { ...BrainLimits.LIMITS.inline, streams: MB })
    expect(read.result.type).toBe("extracted")
    if (read.result.type === "extracted") expect(read.result.text).toContain("Uploads are limited")
  })
})
