import { describe, expect, test } from "bun:test"
import { strToU8 } from "fflate"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { archive, bomb, concat, docx, p, zeros } from "./fixture/ooxml"
import { lines, pdf } from "./fixture/pdf"

const read = (name: string, bytes: Uint8Array, limits = BrainLimits.LIMITS.worker) =>
  BrainDocument.read({ name, bytes }, limits)
const TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'

describe("BrainDocument limits", () => {
  test("a zip bomb (1,000:1, 1 GB of zeros, its header claiming 1 KB) is refused within a few megabytes", async () => {
    const bytes = bomb(1_024)
    expect(bytes.length).toBeLessThan(1.2 * 1024 * 1024)
    const started = performance.now()
    expect(await read("bomb.docx", bytes)).toMatchObject({ type: "refused", reason: "too-large" })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  test("each inflate cap stops reading: per part, per file and per ratio", async () => {
    const small = {
      ...BrainLimits.LIMITS.worker,
      zip: { ...BrainLimits.LIMITS.worker.zip, part: 2 * 1024 * 1024, total: 3 * 1024 * 1024, grace: 64 * 1024 },
    }
    expect(await read("part.docx", bomb(3), { ...small, zip: { ...small.zip, ratio: 100_000 } })).toMatchObject({
      type: "refused",
      reason: "too-large",
    })
    const parts = archive([
      { name: "[Content_Types].xml", data: strToU8(TYPES), method: 0, size: TYPES.length },
      { name: "word/document.xml", data: zeros(2), method: 8, size: 10 },
      { name: "word/styles.xml", data: zeros(2), method: 8, size: 10 },
    ])
    expect(await read("total.docx", parts, { ...small, zip: { ...small.zip, ratio: 100_000 } })).toMatchObject({
      type: "refused",
      reason: "too-large",
    })
    expect(await read("ratio.docx", bomb(1), small)).toMatchObject({ type: "refused", reason: "too-large" })
  })

  test("more than 5,000 zip entries is refused before any part is read", async () => {
    const entries = Array.from({ length: 5_001 }, (_, index) => ({
      name: `word/media/${index}.bin`,
      data: new Uint8Array([index % 256]),
      method: 0 as const,
      size: 1,
    }))
    const bytes = archive([
      { name: "[Content_Types].xml", data: strToU8(TYPES), method: 0, size: TYPES.length },
      ...entries,
    ])
    expect(await read("many.docx", bytes)).toMatchObject({ type: "refused", reason: "invalid" })
  })

  test("XML nested deeper than 256 levels, or past the node cap, is refused", async () => {
    const deep = `${"<w:sdt>".repeat(300)}${"</w:sdt>".repeat(300)}`
    expect(await read("deep.docx", docx({ body: [deep] }))).toMatchObject({ type: "refused", reason: "too-large" })
    const wide = docx({ body: Array.from({ length: 200 }, (_, index) => p(`Paragraph ${index}`)) })
    expect((await read("wide.docx", wide)).type).toBe("extracted")
    expect(
      await read("wide.docx", wide, { ...BrainLimits.LIMITS.worker, xml: { depth: 256, nodes: 300 } }),
    ).toMatchObject({ type: "refused", reason: "too-large" })
  })

  test("entities are never expanded: a DTD entity bomb reads as its literal text", async () => {
    const lol = `<!DOCTYPE w:document [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY xxe SYSTEM "file:///etc/passwd">]>`
    const document = `<?xml version="1.0"?>${lol}<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Before &lol2; and &xxe; after &amp; done</w:t></w:r></w:p></w:body></w:document>`
    const result = await read("dtd.docx", docx({ body: [], extra: { "word/document.xml": document } }))
    expect(result.type === "extracted" && result.text).toBe("Before &lol2; and &xxe; after & done")
  })

  test("a password-protected PDF or Office file, and a zip with encrypted entries, are refused", async () => {
    expect(await read("locked.pdf", pdf({ encrypted: true, pages: [{ runs: lines(["Secret"]) }] }))).toMatchObject({
      reason: "encrypted",
    })
    const ole = concat([
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      new Uint8Array(512),
      new Uint8Array(Buffer.from("EncryptedPackage", "utf16le")),
    ])
    expect(await read("locked.xlsx", ole)).toMatchObject({ reason: "encrypted" })
    const zipped = archive([
      { name: "[Content_Types].xml", data: strToU8(TYPES), method: 0, size: TYPES.length },
      { name: "word/document.xml", data: new Uint8Array(10), method: 0, size: 10, flags: 1 },
    ])
    expect(await read("locked.docx", zipped)).toMatchObject({ reason: "encrypted" })
  })

  test("a PDF past 1,000 pages reads the first 1,000 and says it was truncated", async () => {
    const result = await read(
      "long.pdf",
      pdf({
        pages: Array.from({ length: 1_001 }, (_, index) => ({
          runs: lines([`Page ${index + 1} of the long document body.`]),
        })),
      }),
    )
    expect(result.type === "extracted" && [result.blocks.length, result.warnings.includes("truncated")]).toEqual([
      1_000,
      true,
    ])
  }, 60_000)

  test("a YAML alias bomb and JSON nested past 64 levels are refused", async () => {
    const aliases = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      ...Array.from(
        { length: 9 },
        (_, index) =>
          `${String.fromCharCode(98 + index)}: &${String.fromCharCode(98 + index)} [${Array(9)
            .fill(`*${String.fromCharCode(97 + index)}`)
            .join(", ")}]`,
      ),
    ].join("\n")
    expect(await read("bomb.yaml", strToU8(aliases))).toMatchObject({ type: "refused", reason: "invalid" })
    expect(await read("deep.json", strToU8(`${"[".repeat(65)}${"]".repeat(65)}`))).toMatchObject({
      type: "refused",
      reason: "invalid",
    })
    expect((await read("ok.json", strToU8(`${"[".repeat(64)}1${"]".repeat(64)}`))).type).toBe("extracted")
  })

  test("a 65 MB file is refused as too large; the main-thread reader takes less", async () => {
    expect(await read("huge.pdf", new Uint8Array(65 * 1024 * 1024))).toMatchObject({
      type: "refused",
      reason: "too-large",
    })
    expect(await read("notes.md", new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61))).toMatchObject({
      reason: "too-large",
    })
    const large = concat([strToU8("%PDF-1.7\n"), new Uint8Array(21 * 1024 * 1024)])
    expect(await read("large.pdf", large, BrainLimits.LIMITS.inline)).toMatchObject({ reason: "too-large" })
  })

  test("hostile nesting in HTML and Markdown is cut short, never overflows the stack or runs away", async () => {
    const started = performance.now()
    for (const html of [
      `<p>Top text here.</p>${"<div>".repeat(200_000)}x`,
      `<p>Top text here.</p>${"<ul><li>".repeat(100_000)}x`,
      `<h1>Title</h1><table>${"<tr><td><table>".repeat(50_000)}x</table>`,
    ]) {
      const result = await read("deep.html", strToU8(html))
      expect(result.type === "extracted" && result.warnings).toContain("truncated")
    }
    for (const markdown of [
      `Top.\n\n${"> ".repeat(5_000)}deep quote\n`,
      `${"*".repeat(20_000)}x${"*".repeat(20_000)}\n`,
      `${"[".repeat(50_000)}x${"]".repeat(50_000)}\n`,
    ])
      expect((await read("deep.md", strToU8(markdown))).type).toBe("extracted")
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  test("per-document text stops at the character cap with a warning", async () => {
    const result = await read(
      "long.md",
      strToU8(Array.from({ length: 50 }, (_, index) => `Paragraph ${index} has some words in it.`).join("\n\n")),
      { ...BrainLimits.LIMITS.worker, chars: 400 },
    )
    expect(result.type === "extracted" && result.text.length).toBeLessThanOrEqual(400)
    expect(result.type === "extracted" && result.warnings).toContain("truncated")
  })

  test("on the main thread a long read gives the event loop turns, and stops when it is told to", async () => {
    const markdown = new TextEncoder().encode(
      Array.from({ length: 3_000 }, (_, index) => `Paragraph ${index}: the service MUST log request ${index}.`).join("\n\n"),
    )
    const ticks = { count: 0 }
    const timer = setInterval(() => ticks.count++, 0)
    const result = await BrainDocument.read({ name: "long.md", bytes: markdown }, BrainLimits.LIMITS.inline)
    clearInterval(timer)
    expect(result.type).toBe("extracted")
    expect(ticks.count).toBeGreaterThan(0)
    const stopped = new AbortController()
    stopped.abort()
    const cut = await BrainDocument.read({ name: "long.md", bytes: markdown }, BrainLimits.LIMITS.inline, stopped.signal)
    expect(cut.type === "extracted" ? cut.blocks.length : 0).toBeLessThan(3_000)
  })
})
