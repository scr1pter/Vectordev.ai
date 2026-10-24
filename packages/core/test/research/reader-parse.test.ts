import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { ResearchReader } from "../../src/research/reader"
import { lines, pdf } from "../brain/fixture/pdf"
import { FakeWeb } from "../lib/fake-web"

// ResearchReader.parse: what a research browser holds (the HTML of a page it rendered, or a PDF it fetched into memory)
// read the way `read` reads a site's answer. No network: the bytes are the test's.

const html = (body: string) => new TextEncoder().encode(body)
const parse = (input: Parameters<typeof ResearchReader.parse>[0]) => Effect.runPromise(ResearchReader.parse(input))

describe("ResearchReader.parse", () => {
  test("reads a page a browser rendered: its text in chunks, its metadata and links, fenced the same way", async () => {
    const page = await parse({
      url: "https://journal.example/study",
      contentType: "text/html; charset=utf-8",
      body: html(
        `<!doctype html><html><head><title>Heat pumps</title><meta name="author" content="Ana Silva"></head><body><main><h1>Field study</h1><p>The study followed 412 homes through two winters.</p><p>See <a href="https://other.example/paper">the paper</a>.</p></main></body></html>`,
      ),
    })
    expect(page.status).toBe("read")
    expect(page.title).toBe("Heat pumps")
    expect(page.text).toContain("The study followed 412 homes through two winters.")
    expect(page.meta.author).toBe("Ana Silva")
    expect(page.links.map((link) => link.url)).toEqual(["https://other.example/paper"])
    expect(page.chunks.length).toBeGreaterThan(0)
    expect(page.private).toBe(false)
  })

  test("a page that is still empty after rendering is not read, and a paywall keeps its excerpt", async () => {
    const empty = await parse({
      url: "https://app.example/",
      contentType: "text/html; charset=utf-8",
      body: await Bun.file(path.join(FakeWeb.FIXTURES, "spa.html")).bytes(),
    })
    expect(empty.status).toBe("needs-render")
    const walled = await parse({
      url: "https://news.example/supply-chain",
      contentType: "text/html; charset=utf-8",
      body: await Bun.file(path.join(FakeWeb.FIXTURES, "paywall.html")).bytes(),
    })
    expect(walled.status).toBe("paywalled")
    // The browser's own status for the page counts, as a site's answer does.
    const gone = await parse({
      url: "https://news.example/gone",
      contentType: "text/html",
      status: 410,
      body: html("<p>Gone</p>"),
    })
    expect(gone.status).toBe("failed")
  })

  test("a page the user's own browser showed after a handoff is read in full, whatever its paywall markers say", async () => {
    // Publishers keep isAccessibleForFree: false and their meter classes for subscribers who signed in too.
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `<p>Paragraph ${index} for subscribers: the compressor makers plan new prices for installers.</p>`,
    ).join("")
    const body = html(
      `<!doctype html><html><head><title>Members article</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Members article","isAccessibleForFree":false}</script></head><body><main class="article-locked"><h1>Members article</h1>${paragraphs}<p>The last paragraph is here.</p></main></body></html>`,
    )
    const url = "https://journal.example/members"
    const walled = await parse({ url, contentType: "text/html; charset=utf-8", body })
    expect(walled.status).toBe("paywalled")
    expect(walled.text).not.toContain("The last paragraph is here.")
    const signed = await parse({ url, contentType: "text/html; charset=utf-8", body, signedIn: true })
    expect(signed.status).toBe("read")
    expect(signed.paywall).toBeUndefined()
    expect(signed.text).toContain("Paragraph 39 for subscribers")
    expect(signed.text).toContain("The last paragraph is here.")
  })

  test("reads a PDF a browser fetched into memory, page by page", async () => {
    const page = await parse({
      url: "https://docs.example/report.pdf",
      contentType: "application/pdf",
      body: pdf({
        title: "Heat pump field study",
        pages: [
          { runs: lines(["Heat pump field study.", "The study followed 412 homes through two winters."]) },
          { runs: lines(["Results.", "Delivered heating energy fell by 61 percent."]) },
        ],
      }),
    })
    expect(page.status).toBe("read")
    expect(page.pages).toBe(2)
    expect(page.chunks.map((chunk) => chunk.page)).toEqual([1, 2])
  })
})
