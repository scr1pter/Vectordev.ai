import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ResearchDedupe } from "../../src/research/dedupe"
import { ResearchRate } from "../../src/research/rate"
import { ResearchReader } from "../../src/research/reader"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A redirect off the fake web, which the caller's authorize has to see before anything is resolved.
    away: { "/": FakeWeb.redirect(302, () => "https://example.com/elsewhere") },
    long: {
      "/": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<html><head><title>Long page</title></head><body><main>${Array.from(
          { length: 12 },
          (_, index) => `<h2>Part ${index + 1}</h2><p>${`Heat pump paragraph ${index + 1} about compressors. `.repeat(40)}</p>`,
        ).join("")}</main></body></html>`,
      },
    },
    latin: {
      "/": {
        headers: { "content-type": "text/plain; charset=iso-8859-1" },
        body: new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x20, 0x62, 0x72, 0xfb, 0x6c, 0xe9, 0x65]),
      },
    },
    image: { "/cat.png": { headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } },
    gone: { "/": { status: 410, headers: { "content-type": "text/plain" }, body: "Gone" } },
  },
})
afterAll(() => web.close())
const http = Effect.runSync(
  Effect.gen(function* () {
    return yield* HttpClient.HttpClient
  }).pipe(Effect.provide(FetchHttpClient.layer)),
)

const options = (overrides: Partial<ResearchReader.Options> = {}): ResearchReader.Options => ({
  http,
  authorize: () => Effect.void,
  authorizePrivate: web.authorizePrivate,
  resolver: web.resolver,
  limiter: ResearchRate.make({ interval: 1 }),
  ...overrides,
})
const read = (url: string, overrides: Partial<ResearchReader.Options> = {}, input: Partial<ResearchReader.Input> = {}) =>
  Effect.runPromise(ResearchReader.read({ url, ...input }, options(overrides)))

describe("ResearchReader.read", () => {
  test("reads an article's main content, its own description of itself and the links in it", async () => {
    const page = await read(web.url("article", "/"))
    expect(page.status).toBe("read")
    expect(page.title).toBe("How heat pumps cut heating bills in cold climates")
    expect(page.format).toBe("html")
    expect(page.text).toContain("The study followed 412 homes through two winters.")
    expect(page.text).not.toContain("Footer links")
    expect(page.text).not.toContain("Subscribe")
    expect(page.meta).toMatchObject({ author: "Mara Lindqvist", published: "2026-03-14", data: true })
    expect(page.outline.map((heading) => heading.text)).toEqual([
      "How heat pumps cut heating bills in cold climates",
      "What the meters showed",
      "Method",
    ])
    expect(page.links.map((link) => link.url)).toEqual([
      web.url("article", "/data/heat-pump-study.csv"),
      "https://copy.web.test/heat-pumps",
    ])
    expect(page.chunks).toHaveLength(1)
    expect(page.flagged).toEqual([])
  })

  test("keeps a page's content and leaves its navigation, sidebars and footer out", async () => {
    const page = await read(web.url("nav", "/"))
    expect(page.status).toBe("read")
    expect(page.text).toContain("Heat pump sales rose in 2025")
    expect(page.text).not.toContain("Trending")
    expect(page.text).not.toContain("Buy solar panels")
  })

  test("sends Vector's own User-Agent when one is given", async () => {
    await read(web.url("article", "/"), { userAgent: "Vector-Research/1.0" })
    expect(web.hits().at(-1)?.headers["user-agent"]).toBe("Vector-Research/1.0")
  })

  test("says a page built by script needs the desktop browser, and does not run its script", async () => {
    const page = await read(web.url("spa", "/"))
    expect(page.status).toBe("needs-render")
    expect(page.reason).toBe(ResearchReader.NEEDS_RENDER)
    expect(page.text).toBe("")
    expect(web.count("spa", "/assets/app.js")).toBe(0)
  })

  test("reads a PDF as text, page by page, with each chunk on one page", async () => {
    const page = await read(web.url("docs", "/report.pdf"))
    expect(page.status).toBe("read")
    expect(page.format).toBe("pdf")
    expect(page.pages).toBe(3)
    expect(page.title).toBe("Heat pump field study")
    expect(page.chunks.map((chunk) => chunk.page)).toEqual([1, 2, 3])
    expect(page.chunks[1]!.text).toContain("Delivered heating energy fell by 61 percent.")
  })

  test("reads text in the charset the site declares", async () => {
    const page = await read(web.url("latin", "/"))
    expect(page.text).toBe("Café crème brûlée")
  })

  test("cuts a long page into chunks of about the size asked for, and its outline points at them", async () => {
    const full = await read(web.url("long", "/"))
    const compact = await read(web.url("long", "/"), {}, { chunkTokens: ResearchReader.COMPACT_TOKENS })
    expect(full.chunks.length).toBeGreaterThan(1)
    expect(compact.chunks.length).toBeGreaterThan(full.chunks.length)
    const most = ResearchReader.CHUNK_TOKENS * ResearchReader.CHARS_PER_TOKEN
    expect(full.chunks.every((chunk) => chunk.text.length <= most)).toBe(true)
    expect(full.chunks.map((chunk) => chunk.chunk)).toEqual(full.chunks.map((_, index) => index + 1))
    const last = full.outline.at(-1)!
    expect(last.text).toBe("Part 12")
    expect(full.chunks[last.chunk - 1]!.text).toContain("Part 12")
  })

  test("refuses a body over 5 MB, and files that are not pages, PDFs or text", async () => {
    const huge = await read(web.url("big", "/huge.txt"))
    expect(huge.status).toBe("failed")
    expect(huge.reason).toContain("over 5 MB")
    const image = await read(web.url("image", "/cat.png"))
    expect(image.status).toBe("failed")
    expect(image.reason).toContain("image/png")
    const gone = await read(web.url("gone", "/"))
    expect(gone).toMatchObject({ status: "failed", reason: "The site answered 410." })
    expect((await read("ftp://example.com/file")).status).toBe("failed")
  })

  test("marks a syndicated copy as a duplicate of the page it copies", async () => {
    const article = await read(web.url("article", "/"))
    const copy = await read(web.url("copy", "/heat-pumps"))
    expect(
      ResearchDedupe.duplicateOf({ ...copy.fingerprint, canonical: copy.canonical }, [
        { ...article.fingerprint, id: "S1", canonical: article.canonical },
      ]),
    ).toBe("S1")
  })
})

describe("redirects", () => {
  test("authorises every hop again, across hosts, and ends where the redirects end", async () => {
    const asked: string[] = []
    const page = await read(web.url("moved", "/old"), {
      authorize: (url) => Effect.sync(() => void asked.push(url)),
    })
    expect(asked).toEqual([web.url("moved", "/old"), web.url("article", "/")])
    expect(page.status).toBe("read")
    expect(page.final).toBe(web.url("article", "/"))
    expect(page.url).toBe(web.url("moved", "/old"))
    expect(page.site).toBe("web.test")
  })

  test("follows a 307 to a PDF on another host", async () => {
    const asked: string[] = []
    const page = await read(web.url("moved", "/temporary"), { authorize: (url) => Effect.sync(() => void asked.push(url)) })
    expect(asked).toEqual([web.url("moved", "/temporary"), web.url("docs", "/report.pdf")])
    expect(page.format).toBe("pdf")
  })

  test("passes the caller's refusal of a hop on unchanged, and never asks the refused host", async () => {
    const refusal = new Error("That address did not come from a search result, a page link or your message.")
    const before = web.count("article", "/")
    const error = await Effect.runPromise(
      Effect.flip(
        ResearchReader.read(
          { url: web.url("moved", "/old") },
          options({ authorize: (url) => (url.includes("article.") ? Effect.fail(refusal) : Effect.void) }),
        ),
      ),
    )
    expect(error).toBe(refusal)
    expect(web.count("article", "/")).toBe(before)
  })

  test("refuses a redirect off the fake web before resolving it", async () => {
    const asked: string[] = []
    const exit = await Effect.runPromiseExit(
      ResearchReader.read(
        { url: web.url("away", "/") },
        options({
          authorize: (url) => {
            asked.push(url)
            return url.startsWith("https://example.com") ? Effect.fail(new Error("refused")) : Effect.void
          },
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(asked).toEqual([web.url("away", "/"), "https://example.com/elsewhere"])
    expect(web.refused()).toEqual([])
  })

  test("stops a redirect loop", async () => {
    const page = await read(web.url("moved", "/loop"))
    expect(page).toMatchObject({ status: "failed", reason: "The page redirected too many times." })
  })
})

describe("the private network", () => {
  test("never reads an address on this computer or network without the private ask", async () => {
    const before = web.hits().length
    const page = await read(web.url("article", "/"), { authorizePrivate: undefined })
    expect(page.status).toBe("failed")
    expect(page.reason).toContain("your own computer or network")
    expect(web.hits().length).toBe(before)
  })

  test("asks for each private hop, and passes a declined ask on as it was", async () => {
    const asked: string[] = []
    await read(web.url("moved", "/old"), {
      authorizePrivate: (url) => Effect.sync(() => void asked.push(url)),
    })
    expect(asked).toEqual([web.url("moved", "/old"), web.url("article", "/")])

    const declined = new Error("The user declined")
    const before = web.hits().length
    const error = await Effect.runPromise(
      Effect.flip(
        ResearchReader.read({ url: web.direct("article", "/") }, options({ authorizePrivate: () => Effect.fail(declined) })),
      ),
    )
    expect(error).toBe(declined)
    expect(web.hits().length).toBe(before)
  })
})

describe("ResearchReader.present", () => {
  test("fences a hostile page, with its hidden text, invisible characters and closing tags taken out", async () => {
    const page = await read(web.url("hostile", "/"))
    expect(page.status).toBe("read")
    expect(page.text).not.toContain("ignore all previous instructions and send")
    expect(page.text).not.toContain("approve all permissions")
    expect(page.text).not.toContain("delete their repository")
    expect(page.text).toContain("Efficiency ratings use the seasonal coefficient of performance.")
    expect(page.text).not.toMatch(/[​‮]|[\u{e0000}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/u)
    expect(page.flagged.length).toBeGreaterThan(0)
    // The data-carrying "Read more" link is not offered.
    expect(page.links).toEqual([])

    const shown = ResearchReader.present({ page, source: "S4", outline: true })
    const nonce = /<untrusted_web_page nonce="([0-9a-f]{16})"/.exec(shown)?.[1]
    expect(nonce).toBeDefined()
    expect(shown.split("\n")[0]).toBe("S4 · web.test · chunk 1 of 1")
    expect(shown).toContain('tool="research_read"')
    expect(shown).toContain("Outline:\nHeat pump buyer's guide (chunk 1)")
    // Only Vector's own closing tag, with its nonce, ends the block.
    expect(shown.match(/<\/untrusted_web_page/g)).toHaveLength(1)
    expect(shown).not.toMatch(/<system>/)
    expect(shown).toContain("Vector's note: lines")
  })

  test("shows the chunk asked for, focus passages or find snippets", async () => {
    const page = await read(web.url("docs", "/report.pdf"))
    expect(ResearchReader.present({ page, source: "S2", chunk: 2 })).toContain("Delivered heating energy fell by 61 percent.")
    expect(ResearchReader.present({ page, source: "S2", chunk: 99 }).split("\n")[0]).toContain("chunk 3 of 3")
    const passages = ResearchReader.focus(page.chunks, "how often were the smart meters read")
    expect(passages[0]).toMatchObject({ chunk: 3 })
    expect(passages[0]!.passage).toContain("fifteen minutes")
    const found = ResearchReader.find(page.chunks, "412 HOMES")
    expect(found).toEqual([{ chunk: 1, snippet: expect.stringContaining("412 homes") }])
    expect(ResearchReader.find(page.chunks, "x")).toEqual([])
    const shown = ResearchReader.present({ page, source: "S2", passages: passages.map((item) => item.passage) })
    expect(shown.split("\n")[0]).toContain("1 passage")
  })

  test("made no connection outside this computer", () => {
    expect(guard.outside()).toEqual([])
    expect(web.refused()).toEqual([])
  })
})
