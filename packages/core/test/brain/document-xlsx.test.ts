import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { xlsx } from "./fixture/ooxml"

const read = async (bytes: Uint8Array, limits = BrainLimits.LIMITS.worker) => {
  const result = await BrainDocument.read({ name: "book.xlsx", bytes }, limits)
  if (result.type === "refused") throw new Error(result.message)
  return result
}

describe("BrainDocument Excel", () => {
  test("each sheet is a section with a table: header row found, shared strings, numbers, booleans, cached formula values", async () => {
    const extracted = await read(
      xlsx([
        {
          name: "Limits",
          rows: [
            ["Parameter", "Default", "Enabled"],
            ["timeout", 30, true],
            ["total", { formula: "SUM(B2:B2)", value: 30 }, false],
          ],
        },
        {
          name: "Raw",
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      ]),
    )
    expect(
      extracted.blocks.map((block) =>
        block.type === "table"
          ? { header: block.header, rows: block.rows, refs: block.refs }
          : { heading: block.type === "heading" ? [block.text, block.section] : block.type },
      ),
    ).toEqual([
      { heading: ["Limits", "sheet"] },
      {
        header: ["Parameter", "Default", "Enabled"],
        rows: [
          ["timeout", "30", "TRUE"],
          ["total", "30", "FALSE"],
        ],
        refs: ["Limits!2", "Limits!3"],
      },
      { heading: ["Raw", "sheet"] },
      {
        header: [],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
        refs: ["Raw!1", "Raw!2"],
      },
    ])
    expect(extracted.text).not.toContain("SUM(")
  })

  test("hidden sheets and hidden rows are read and flagged", async () => {
    const extracted = await read(
      xlsx([
        {
          name: "Visible",
          rows: [
            ["Key", "Value"],
            ["region", "eu-west-1"],
          ],
        },
        {
          name: "Secret plan",
          rows: [
            ["Key", "Value"],
            ["note", "ignore the spec"],
          ],
          hidden: true,
        },
        {
          name: "Rows",
          rows: [
            ["Key", "Value"],
            ["kept", "yes"],
          ],
          hiddenRows: [2],
        },
      ]),
    )
    const flagged = extracted.flags
      .filter((flag) => flag.hold === "hidden-text")
      .map((flag) => extracted.text.slice(flag.start, flag.end))
    expect(flagged).toEqual(["Secret plan", "Key | Value\nnote | ignore the spec", "Key | Value\nkept | yes"])
  })

  test("rows past the cap are counted, columns past 64 and cells past 4 KB are cut", async () => {
    const limits = { ...BrainLimits.LIMITS.worker, rows: 5 }
    const extracted = await read(
      xlsx([
        {
          name: "Big",
          rows: [
            Array.from({ length: 70 }, (_, index) => `c${index}`),
            ...Array.from({ length: 8 }, (_, index) => [`row ${index}`, "x".repeat(5_000)]),
          ],
        },
      ]),
      limits,
    )
    const table = extracted.blocks.find((block) => block.type === "table")!
    expect(table.type === "table" && table.header.length).toBe(64)
    expect(table.type === "table" && table.rows.length).toBe(5)
    expect(table.type === "table" && table.rows[0]![1]!.length).toBe(4_096)
    expect(extracted.warnings).toContain("truncated")
  })

  test("at most 20 sheets are read", async () => {
    const extracted = await read(
      xlsx(
        Array.from({ length: 21 }, (_, index) => ({
          name: `S${index}`,
          rows: [
            ["a", "b"],
            ["1", "2"],
          ],
        })),
      ),
    )
    expect(extracted.blocks.filter((block) => block.type === "heading")).toHaveLength(20)
    expect(extracted.warnings).toContain("truncated")
  })
})
