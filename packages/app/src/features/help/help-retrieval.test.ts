import { describe, expect, test } from "bun:test"
import { findRelevantDocs, helpContextFor, helpDocs, renderDocsContext } from "./help-retrieval"

describe("help corpus", () => {
  test("is built from the shipped guide and is non-trivial", () => {
    expect(helpDocs.length).toBeGreaterThan(10)
    expect(helpDocs.every((doc) => doc.title && doc.where && doc.body)).toBe(true)
  })

  test("ids are unique so retrieval cannot double-count an entry", () => {
    expect(new Set(helpDocs.map((doc) => doc.id)).size).toBe(helpDocs.length)
  })
})

describe("findRelevantDocs", () => {
  test("finds the code editor entry by name", () => {
    const titles = findRelevantDocs("how do I open the code editor").map((doc) => doc.title.toLowerCase())
    expect(titles.some((title) => title.includes("code"))).toBe(true)
  })

  test("returns nothing for an off-topic question so the assistant must decline", () => {
    expect(findRelevantDocs("write me a poem about the ocean")).toEqual([])
    expect(helpContextFor("write me a poem about the ocean")).toBe("")
  })

  test("ignores stop words and short tokens rather than matching everything", () => {
    expect(findRelevantDocs("how do I")).toEqual([])
    expect(findRelevantDocs("the a an of")).toEqual([])
  })

  test("respects the limit", () => {
    expect(findRelevantDocs("project session agent editor browser", 2).length).toBeLessThanOrEqual(2)
  })

  test("ranks a title match above an incidental prose mention", () => {
    const docs = findRelevantDocs("browser")
    expect(docs.length).toBeGreaterThan(0)
    expect(docs[0]!.title.toLowerCase()).toContain("browser")
  })
})

describe("renderDocsContext", () => {
  test("includes the locator line so answers can name real controls", () => {
    const context = renderDocsContext(findRelevantDocs("code editor", 1))
    expect(context).toContain("Where:")
    expect(context.startsWith("## ")).toBe(true)
  })

  test("is empty for no docs", () => {
    expect(renderDocsContext([])).toBe("")
  })
})
