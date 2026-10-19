import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"

const table = async (text: string, name = "data.csv", limits = BrainLimits.LIMITS.worker) => {
  const result = await BrainDocument.read({ name, bytes: new TextEncoder().encode(text) }, limits)
  if (result.type === "refused") throw new Error(result.message)
  const block = result.blocks[0]!
  if (block.type !== "table") throw new Error("not a table")
  return { header: block.header, rows: block.rows, refs: block.refs, warnings: result.warnings }
}

describe("BrainDocument CSV", () => {
  test("RFC 4180: quoted fields, doubled quotes and line breaks inside quotes", async () => {
    expect(await table('name,note\r\n"Smith, Jo","said ""hi""\nthen left"\r\nLee,plain\r\n')).toMatchObject({
      header: ["name", "note"],
      rows: [
        ["Smith, Jo", 'said "hi" then left'],
        ["Lee", "plain"],
      ],
      refs: ["row 2", "row 3"],
    })
  })

  test("the delimiter is sniffed (semicolon, tab, pipe) or taken from .tsv", async () => {
    expect((await table("a;b;c\n1;2;3\n")).rows).toEqual([["1", "2", "3"]])
    expect((await table("a|b\nx|y\n")).rows).toEqual([["x", "y"]])
    expect((await table("a\tb\nx\ty\n", "data.tsv")).rows).toEqual([["x", "y"]])
  })

  test("a numeric first row is data, not a header", async () => {
    expect(await table("1,2\n3,4\n")).toMatchObject({
      header: [],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    })
  })

  test("rows past the read cap stop reading, rows past the index cap are left out, both flagged truncated", async () => {
    const limits = { ...BrainLimits.LIMITS.worker, rows: 10, csvRows: 50 }
    const text = `id,value\n${Array.from({ length: 100 }, (_, index) => `${index},v${index}`).join("\n")}\n`
    const result = await table(text, "data.csv", limits)
    expect(result.rows).toHaveLength(10)
    expect(result.warnings).toContain("truncated")
  })

  test("a CSV past 32 MB is refused as too large", async () => {
    const result = await BrainDocument.read(
      { name: "big.csv", bytes: new Uint8Array(32 * 1024 * 1024 + 1).fill(0x61) },
      BrainLimits.LIMITS.worker,
    )
    expect(result).toMatchObject({ type: "refused", reason: "too-large" })
  })
})
