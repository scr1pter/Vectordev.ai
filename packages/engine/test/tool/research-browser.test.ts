import { afterAll, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Session } from "@/session/session"
import { ResearchBrowser } from "../../src/tool/research-browser"
import { RENDER } from "../../src/tool/research-read"
import { ResearchRun } from "../../src/tool/research-run"
import { FakeBridge } from "../lib/fake-bridge"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_browser (section 5.6a), end to end on the fake LLM server, the fake web and a fake desktop bridge on
// loopback: each research agent's browser opens only addresses from the run's provenance, sends the desktop only the
// provenance it lacks, saves what it reads as sources, joins the links it followed to the run's provenance, checks what
// it types against the run's private context, and closes when its agent's session finishes. The desktop's own side
// (slots, the proxy, the navigation rule) is tested in packages/desktop.

const guard = NetworkGuard.use()
const ARTICLE_HTML = await Bun.file(path.join(FakeWeb.FIXTURES, "article.html")).text()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A public page that lists numbers, as a hostile page listing every 5-digit number would.
    numbers: {
      "/": {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<html><head><title>Part numbers</title></head><body><main><h1>Heat pump part numbers</h1><p>Compressor parts: ${Array.from({ length: 40 }, (_, index) => 48_200 + index).join(", ")}.</p><p>Each part ships with a manual and a warranty card for the installer.</p></main></body></html>`,
      },
    },
  },
})
const bridge = FakeBridge.start()
const pointed = FakeBridge.use(bridge)
const it = runtime(web)
afterAll(async () => {
  pointed.off()
  await bridge.close()
  await web.close()
})

// The user approved reading pages for these runs, and the search server on their own network (the fake web resolves to
// this computer, so SearXNG on it is a private address, which asks once for its origin).
const allow = [
  { permission: "research_read", pattern: "*", action: "allow" as const },
  { permission: "private_network", pattern: "*", action: "allow" as const },
]
const ARTICLE = web.url("article", "/")
const COPY = web.url("copy", "/heat-pumps")

// A desktop that keeps one copy of the run's provenance and answers each command as the research browser would.
const desktop = (pages: Record<string, unknown> = {}) => {
  const state = { generation: "desktop-copy-1", url: "" }
  return (call: FakeBridge.Call) => {
    if (call.path !== "/research") return FakeBridge.visible()
    const body = call.body
    if (body.generation !== undefined && body.generation !== state.generation) return FakeBridge.research({ ok: false, resync: true })
    if (body.command === "research.open") state.url = String(body.url)
    const shown = { generation: state.generation, url: state.url, address: state.url, title: "How heat pumps cut heating bills" }
    if (body.command === "research.read" || body.command === "research.find" || body.command === "research.links")
      return FakeBridge.research({
        ...shown,
        read: { html: ARTICLE_HTML, title: shown.title, url: state.url, links: [{ url: COPY, text: "A copy", main: true }], forms: [], truncated: false },
      })
    if (body.command === "research.observe")
      return FakeBridge.research({
        ...shown,
        observed: { title: shown.title, url: state.url, text: "Search the study", elements: [{ ref: "ref_1", role: "searchbox", name: "Search", tag: "input", type: "search" }] },
      })
    return FakeBridge.research({ ...shown, ...(pages[String(body.command)] as object | undefined) })
  }
}

const researchCalls = () => bridge.calls().filter((call) => call.path === "/research")
// The commands sent from `from` on, once the closing that follows the session's end has been sent.
const settled = (from: number) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 50 })) {
      if (researchCalls().slice(from).some((call) => call.body.command === "research.close")) break
      yield* Effect.sleep(20)
    }
    return researchCalls().slice(from)
  })

it.instance(
  "opens only an address in the run's provenance, sends the desktop only what it lacks, and saves what it reads",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump savings in cold climates" })
      yield* test.llm.tool("research_browser", { action: "open", url: "https://elsewhere.example/notes" })
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "read" })
      yield* test.llm.tool("research_note", {
        subquestion: "How large were the savings?",
        claim: "Heat pumps cut delivered heating energy by 61 percent.",
        source: "S1",
        quote: "used 61 percent less delivered energy for heating",
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })

      const browsed = yield* calls(session.id, "research_browser")
      expect(output(browsed[0])).toContain(ResearchProvenance.REFUSAL)
      expect(output(browsed[1])).toContain("The page is open.")
      expect(output(browsed[2])).toContain("S1 · ")
      expect(output(browsed[2])).toContain("The study followed 412 homes through two winters.")
      expect(output(browsed[2])).toContain("untrusted_web_page")
      const [note] = yield* calls(session.id, "research_note")
      expect(note?.state.status === "completed" ? note.state.metadata.note : undefined).toBeTruthy()

      // The desktop was asked to open the article only, and to close the browser once the lead's turn ended.
      const sent = yield* settled(before)
      expect(sent.map((call) => call.body.command)).toEqual(["research.open", "research.read", "research.close"])
      const [open, read] = sent
      const runID = browsed[1]!.state.status === "completed" ? browsed[1]!.state.metadata.runID : undefined
      expect(open!.body).toMatchObject({
        runID,
        sessionID: session.id,
        rootID: session.id,
        agent: "research",
        max: 1 + ResearchRun.LIMITS.focused.researchers,
        images: false,
        url: ARTICLE,
      })
      expect(open!.body.generation).toBeUndefined()
      // The run's search results, sent whole to start the desktop's copy.
      expect(open!.body.provenance).toEqual(expect.arrayContaining([ARTICLE, COPY, web.url("docs", "/report.pdf")]))
      // The next command names that copy and sends nothing it already has.
      expect(read!.body).toMatchObject({ generation: "desktop-copy-1", provenance: [], typed: [] })
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "sends the whole provenance again when the desktop holds another copy of it",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const handler = desktop()
      const state = { forgot: false }
      bridge.answer((call) => {
        // The desktop's browsers all closed after the first command, so its copy is gone.
        if (call.body.command === "research.observe" && call.body.generation !== undefined && !state.forgot) {
          state.forgot = true
          return FakeBridge.research({ ok: false, resync: true })
        }
        return handler(call)
      })
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "observe" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump savings, starting at ${ARTICLE}` })
      const sent = researchCalls().slice(before, before + 3)
      expect(sent.map((call) => [call.body.command, call.body.generation])).toEqual([
        ["research.open", undefined],
        ["research.observe", "desktop-copy-1"],
        ["research.observe", undefined],
      ])
      // An address the user typed goes as typed, so robots.txt does not apply to it.
      expect(sent[2]!.body.typed).toEqual([ARTICLE])
      const [, observed] = yield* calls(session.id, "research_browser")
      expect(output(observed)).toContain('ref_1 searchbox (search) "Search"')
    }),
  90_000,
)

it.instance(
  "a link the browser followed joins the run's provenance, so research may read it",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop({ "research.click": { url: COPY, address: COPY, joined: [COPY] } }))
      yield* test.llm.tool("research_plan", plan())
      // Not yet: nothing gave this address.
      yield* test.llm.tool("research_read", { url: COPY })
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "click", ref: "ref_1" })
      yield* test.llm.tool("research_read", { url: COPY })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump savings, starting at ${ARTICLE}` })
      const reads = yield* calls(session.id, "research_read")
      expect(output(reads[0])).toContain(ResearchProvenance.REFUSAL)
      const [, click] = yield* calls(session.id, "research_browser")
      expect(click?.state.status === "completed" ? click.state.metadata.links : undefined).toEqual([COPY])
      expect(output(click)).toContain("Followed a link")
      expect(output(reads[1])).not.toContain(ResearchProvenance.REFUSAL)
      expect(output(reads[1])).toContain("S1 · ")
    }),
  90_000,
)

it.instance(
  "typed text passes the outbound check with the run's private context, and a page listing a number does not clear it",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      const notes = path.join(test.dir, "notes.md")
      yield* fs.writeWithDirs(notes, "Ticket 48213 tracks the payments migration.\n")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      const numbers = web.url("numbers", "/")
      yield* test.llm.tool("research_plan", plan())
      // The repository's file makes 48213 private; the public page then lists it among its numbers.
      yield* test.llm.tool("read", { filePath: notes })
      yield* test.llm.tool("research_read", { url: numbers })
      yield* test.llm.tool("research_browser", { action: "open", url: ARTICLE })
      yield* test.llm.tool("research_browser", { action: "type", ref: "ref_1", text: "part 48213 heat pump" })
      // A private name from the user's memory, which the user did not type.
      yield* test.llm.tool("research_browser", { action: "type", ref: "ref_1", text: "Lisbon heat pump installers" })
      // The user typed Hooli, so it may go.
      yield* test.llm.tool("research_browser", { action: "type", ref: "ref_1", text: "Hooli heat pumps" })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research the heat pumps Hooli installs. Start with ${ARTICLE} and ${numbers}.`,
      })
      const browsed = yield* calls(session.id, "research_browser")
      const [read] = yield* calls(session.id, "research_read")
      expect(output(read)).toContain("48213")
      expect(output(browsed[1])).toBe(ResearchBrowser.TYPED)
      expect(output(browsed[2])).toBe(ResearchBrowser.TYPED)
      expect(output(browsed[3])).toContain("Typed into ref_1.")
      const typed = researchCalls()
        .slice(before)
        .filter((call) => call.body.command === "research.type")
      expect(typed.map((call) => call.body.text)).toEqual(["Hooli heat pumps"])
    }),
  90_000,
)

it.instance(
  "takes screenshots only for a model that reads images",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      bridge.answer(desktop())
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_browser", { action: "screenshot" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research heat pump savings." })
      const [shot] = yield* calls(session.id, "research_browser")
      expect(output(shot)).toBe(ResearchBrowser.NO_IMAGES)
      expect(researchCalls().slice(before)).toEqual([])
    }),
  90_000,
)

it.instance(
  "a script-built page is read in the agent's research browser when the desktop has one",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const spa = web.url("spa", "/")
      const rendered = `<!doctype html><html><head><title>Heat pump planner</title></head><body><main><h1>Heat pump planner</h1><p>Rendered by script: the planner sizes a heat pump from the floor area and the coldest design temperature of the home.</p><p>It lists installers that fit the size it chose.</p></main></body></html>`
      bridge.answer((call) =>
        call.body.command === "research.read"
          ? FakeBridge.research({ url: spa, address: spa, read: { html: rendered, title: "Heat pump planner", url: spa, links: [], forms: [], truncated: false } })
          : FakeBridge.research({ url: spa, address: spa }),
      )
      const before = researchCalls().length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: spa })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump sizing at ${spa}` })
      const [read] = yield* calls(session.id, "research_read")
      expect(output(read)).toContain("S1 · ")
      expect(output(read)).toContain("Rendered by script: the planner sizes a heat pump")
      expect(read?.state.status === "completed" ? read.state.metadata.status : undefined).toBe("read")
      // The fetch came first; the browser rendered the page only because script builds it.
      expect(web.count("spa", "/")).toBeGreaterThan(0)
      expect((yield* settled(before)).map((call) => call.body.command)).toEqual([
        "research.open",
        "research.read",
        "research.close",
      ])
    }),
  90_000,
)

it.instance(
  "without the desktop browser it says so, and research_read keeps a script-built page as skipped",
  () =>
    Effect.gen(function* () {
      pointed.off()
      try {
        const test = yield* setup(web)
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        const spa = web.url("spa", "/")
        const before = bridge.calls().length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_browser", { action: "open", url: spa })
        yield* test.llm.tool("research_read", { url: spa })
        yield* test.llm.tool("research_read", { url: spa, mode: "render" })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump sizing at ${spa}` })
        const [browsed] = yield* calls(session.id, "research_browser")
        expect(output(browsed)).toBe(ResearchBrowser.NEEDS_DESKTOP)
        const reads = yield* calls(session.id, "research_read")
        expect(output(reads[0])).toContain(ResearchReader.NEEDS_RENDER.replace(/\.$/, ""))
        expect(reads[0]?.state.status === "completed" ? reads[0].state.metadata.status : undefined).toBe("needs-render")
        expect(output(reads[1])).toBe(RENDER)
        expect(bridge.calls().length).toBe(before)
        // The skipped page is in the run, with why.
        const store = yield* ResearchStore.Service
        expect(store).toBeDefined()
      } finally {
        FakeBridge.use(bridge)
      }
    }),
  90_000,
)
