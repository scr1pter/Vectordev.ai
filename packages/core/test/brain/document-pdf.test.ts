import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { lines, pdf, type Run } from "./fixture/pdf"

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
