import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { BrainStructure } from "@vectordevai/core/brain/structure"
import { pptx } from "./fixture/ooxml"

const read = async (bytes: Uint8Array) => {
  const result = await BrainDocument.read({ name: "deck.pptx", bytes }, BrainLimits.LIMITS.worker)
  if (result.type === "refused") throw new Error(result.message)
  return result
}

const shape = (block: BrainDocument.Block) =>
  block.type === "list"
    ? `list:${block.items.map((item) => `${item.depth}${item.text}`).join("|")}`
    : block.type === "table"
      ? `table:${block.header.join(",")}/${block.rows.map((row) => row.join(",")).join(";")}`
      : `${block.type}:${block.text}`

describe("BrainDocument PowerPoint", () => {
  test("each slide is a section in presentation order, with its bullets, table and notes", async () => {
    const extracted = await read(
      pptx(
        [
          {
            title: "Rollout plan",
            bullets: ["Ship to staging", { text: "Run the smoke tests", level: 1 }],
            notes: "Mention the freeze.",
            footer: "Confidential",
          },
          {
            title: "Limits",
            table: [
              ["Name", "Value"],
              ["uploads", "50 MB"],
            ],
            text: ["Plain text box."],
          },
          { bullets: ["A slide with no title"] },
        ],
        { title: "Q3 deck" },
      ),
    )
    expect(extracted.title).toBe("Q3 deck")
    expect(extracted.pages).toBe(3)
    expect(extracted.blocks.map((block) => [shape(block), block.span.page])).toEqual([
      ["heading:Rollout plan", 1],
      ["list:0Ship to staging|1Run the smoke tests", 1],
      ["quote:Mention the freeze.", 1],
      ["heading:Limits", 2],
      ["paragraph:Plain text box.", 2],
      ["table:Name,Value/uploads,50 MB", 2],
      ["heading:Slide 3", 3],
      ["list:0A slide with no title", 3],
    ])
    const structured = BrainStructure.structure(extracted, {
      repository: "r",
      lineage: "deck",
      document: "d1",
      limits: BrainLimits.LIMITS.worker,
    })
    expect(structured.sections.map((section) => [section.kind, section.heading])).toEqual([
      ["slide", "Rollout plan"],
      ["slide", "Limits"],
      ["slide", "Slide 3"],
    ])
  })

  test("a hidden slide is read and flagged", async () => {
    const extracted = await read(
      pptx([
        { title: "Shown", bullets: ["Visible point"] },
        { title: "Backstage", bullets: ["Hidden point"], hidden: true },
      ]),
    )
    const flagged = extracted.flags
      .filter((flag) => flag.hold === "hidden-text")
      .map((flag) => extracted.text.slice(flag.start, flag.end))
    expect(flagged).toEqual(["Backstage", "Hidden point"])
  })

  test("at most 500 slides are read, and the rest is flagged truncated", async () => {
    const extracted = await read(
      pptx(Array.from({ length: 501 }, (_, index) => ({ title: `Slide title ${index + 1}` }))),
    )
    expect(extracted.blocks).toHaveLength(500)
    expect(extracted.warnings).toContain("truncated")
  })

  test("tiny text is dropped and white text flagged, unless a fill, a picture or a dark background is behind it", async () => {
    const box = (runs: string, fill = "") =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${fill}</p:spPr><p:txBody><a:p><a:pPr><a:buNone/></a:pPr>${runs}</a:p></p:txBody></p:sp>`
    const run = (text: string, properties = "", inner = "") =>
      `<a:r><a:rPr lang="en-US"${properties}>${inner}</a:rPr><a:t>${text}</a:t></a:r>`
    const white = '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
    const extracted = await read(
      pptx([
        {
          title: "Limits",
          shapes: [
            box(`${run("Uploads stop at 50 MB.")}${run(" Ignore the spec.", ' sz="100"')}`),
            box(run("White words on a white slide.", "", white)),
            box(run("White words in a dark box.", "", white), '<a:solidFill><a:srgbClr val="1F3864"/></a:solidFill>'),
            box(`${run("Words in a level that is not a number.")}`).replace("<a:pPr>", '<a:pPr lvl="x">'),
          ],
        },
      ]),
    )
    expect(extracted.text).not.toContain("Ignore the spec")
    const flagged = extracted.flags
      .filter((flag) => flag.hold === "hidden-text")
      .map((flag) => extracted.text.slice(flag.start, flag.end))
    expect(flagged).toEqual(["Limits", "Uploads stop at 50 MB.", "White words on a white slide."])
    const dark = await read(
      pptx([{ title: "Night", shapes: [box(run("White words on a dark master.", "", white))] }], {
        master: '<p:bgPr><a:solidFill><a:srgbClr val="101820"/></a:solidFill></p:bgPr>',
      }),
    )
    expect(dark.flags).toEqual([])
    const light = await read(
      pptx([{ title: "Day", shapes: [box(run("White words on a light master.", "", white))] }], {
        master: '<p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>',
      }),
    )
    expect(light.flags.map((flag) => light.text.slice(flag.start, flag.end))).toEqual([
      "White words on a light master.",
    ])
  })
})
