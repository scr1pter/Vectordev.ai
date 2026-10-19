import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"

const shapes = async (text: string, name = "notes.txt") => {
  const result = await BrainDocument.read({ name, bytes: new TextEncoder().encode(text) }, BrainLimits.LIMITS.worker)
  if (result.type === "refused") throw new Error(result.message)
  return result.blocks.map((block) =>
    block.type === "list"
      ? `list${block.ordered ? "#" : "-"}:${block.items.map((item) => `${item.depth}${item.text}`).join("|")}`
      : block.type === "table"
        ? "table"
        : `${block.type}${block.type === "heading" ? block.level : ""}:${block.text}`,
  )
}

describe("BrainDocument text, reStructuredText and AsciiDoc", () => {
  test("reStructuredText: underline styles take levels in order of first use; '::' introduces a literal block", async () => {
    expect(
      await shapes(
        "========\nAuth spec\n========\n\nLimits\n======\n\nUploads stop at\n50 MB. Use this::\n\n    bun run upload\n\nRetries\n-------\n\nThree at most.\n",
        "spec.rst",
      ),
    ).toEqual([
      "heading1:Auth spec",
      "heading2:Limits",
      "paragraph:Uploads stop at 50 MB. Use this:",
      "code:bun run upload",
      "heading3:Retries",
      "paragraph:Three at most.",
    ])
  })

  test("AsciiDoc: '=' headings and '----' listing blocks", async () => {
    expect(await shapes("= Guide\n\n== Install\n\n----\nbun install\n----\n\nDone.\n", "guide.adoc")).toEqual([
      "heading1:Guide",
      "heading2:Install",
      "code:bun install",
      "paragraph:Done.",
    ])
  })

  test("plain text: ALL CAPS and numbered headings, lists, quotes, indented code and hyphenated line breaks", async () => {
    expect(
      await shapes(
        "INTRODUCTION\n\nThe retry budget is recal-\nculated every minute.\n\n3.2 Retry limits\n\n- first point\n  continued here\n- second point\n1. ordered\n\n> a quoted line\n\n    indented code\n\n----\n\nAfter a lone rule.\n",
      ),
    ).toEqual([
      "heading1:INTRODUCTION",
      "paragraph:The retry budget is recalculated every minute.",
      "heading2:3.2 Retry limits",
      "list-:0first point continued here|0second point",
      "list#:0ordered",
      "quote:a quoted line",
      "code:indented code",
      "paragraph:After a lone rule.",
    ])
  })

  test("a numbered list item is not a heading", async () => {
    expect(await shapes("1. Install the package.\n2. Run it.\n")).toEqual(["list#:0Install the package.|0Run it."])
  })
})
