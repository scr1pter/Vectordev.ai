import { afterAll, expect } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Session } from "@/session/session"
import { MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ResearchRun } from "../../src/tool/research-run"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_read (section 5.4), end to end on the fake LLM server and the fake web: an address must come from a search
// result, a link a read offered or the user's own message; the run's first new page asks once, for that run only and
// never saved as Always; a saved source reads again with no network call.

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A search server whose results point at a cloud metadata address, the user's own network and this computer.
    lansearch: {
      "/search": (_request, at) =>
        Response.json({
          query: "heat pump",
          number_of_results: 4,
          results: [
            { url: "http://169.254.169.254/latest/meta-data/", title: "Meta", content: "Heat pumps", engine: "fake" },
            { url: "http://10.1.2.3/wiki", title: "Wiki", content: "Heat pumps", engine: "fake" },
            { url: at.direct("article", "/"), title: "Loopback", content: "Heat pumps", engine: "fake" },
            {
              url: "http://metadata.google.internal/computeMetadata/v1/",
              title: "Metadata",
              content: "Heat pumps",
              engine: "fake",
            },
          ],
        }),
    },
  },
})
const it = runtime(web)
afterAll(() => web.close())

// Answers each permission the run asks, and keeps what was asked.
const answer = (reply: PermissionV1.ReplyBody["reply"]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const asked: PermissionV1.Request[] = []
    yield* Effect.gen(function* () {
      while (true) {
        for (const request of yield* permission.list()) {
          asked.push(request)
          yield* permission.reply({ requestID: request.id, reply }).pipe(Effect.ignore)
        }
        yield* Effect.sleep(10)
      }
    }).pipe(Effect.forkScoped)
    return asked
  })

it.instance(
  "an address no search result, page link or typed message gave is refused, and nothing is fetched",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: web.url("article", "/") })
      // An address a page might have asked for, with the agent's own text in its query.
      yield* test.llm.tool("research_read", { url: `${web.url("article", "/")}?ref=badge-4417` })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const reads = yield* calls(session.id, "research_read")
      expect(reads).toHaveLength(2)
      for (const read of reads) expect(output(read)).toContain(ResearchProvenance.REFUSAL)
      expect(web.count("article")).toBe(0)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "the run's first page asks once, the approval is not saved, and a saved source reads again offline",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const asked = yield* answer("always")
      const session = yield* sessions.create({ title: "Research" })
      const article = web.url("article", "/")
      const pdf = web.url("docs", "/report.pdf")
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: article })
      yield* test.llm.tool("research_read", { url: pdf })
      yield* test.llm.tool("research_read", { source: "S1", find: "412 homes" })
      yield* test.llm.text("Done.")
      const before = web.count("article")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings. Start with ${article} and ${pdf}.`,
      })
      const reads = yield* calls(session.id, "research_read")
      expect(reads.map((read) => read.state.status)).toEqual(["completed", "completed", "completed"])
      expect(output(reads[0])).toContain("S1 · ")
      expect(output(reads[0])).toContain("untrusted_web_page")
      expect(output(reads[0])).toContain("The study followed 412 homes through two winters.")
      expect(output(reads[1])).toContain("S2 · ")
      // The saved source came from the run, with no new request to the site.
      expect(output(reads[2])).toContain("412 homes")
      expect(output(reads[2])).toContain("saved")
      expect(web.count("article", "/") - before).toBe(1)
      // One approval for the run, for its own id, and Always saves nothing.
      const approvals = asked.filter((request) => request.permission === "research_read")
      expect(approvals).toHaveLength(1)
      const runID = reads[0]!.state.status === "completed" ? reads[0]!.state.metadata.runID : undefined
      expect(approvals[0]!.patterns).toEqual([runID])
      expect(approvals[0]!.always).toEqual([])
      expect(approvals[0]!.metadata.description).toBe(ResearchRun.READ_APPROVAL)
      expect(asked.filter((request) => request.permission === "private_network")).toEqual([])

      // A new run asks again: the answer was for that run only.
      yield* test.llm.tool("research_plan", plan({ question: "Which heat pumps work below minus 20 degrees?" }))
      yield* test.llm.tool("research_read", { url: web.url("docs", "/report.pdf") })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Now research which ones work in the coldest winters.",
      })
      expect(asked.filter((request) => request.permission === "research_read")).toHaveLength(2)

      // The pages are held, private web documents of the run, as the store keeps them.
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      const detail = yield* store.get(place, runID as string)
      expect(detail?.sources.map((source) => [source.id, source.status])).toEqual([
        ["S1", "read"],
        ["S2", "read"],
      ])
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "a link a read offered may be read next; one that looks built to carry data is not offered",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      yield* answer("once")
      const session = yield* sessions.create({ title: "Research" })
      const hostile = web.url("hostile", "/")
      const article = web.url("article", "/")
      const data = web.url("article", "/data/heat-pump-study.csv")
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: hostile, links: true })
      yield* test.llm.tool("research_read", { url: article, links: true })
      yield* test.llm.tool("research_read", { url: data })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research what these pages link to: ${hostile} ${article}`,
      })
      const [first, second, third] = yield* calls(session.id, "research_read")
      const linksOf = (part: typeof first) =>
        part?.state.status === "completed" ? ((part.state.metadata.links as string[] | undefined) ?? []) : []
      // The hostile page's exfiltration link, whose query reads as encoded data, is not offered.
      expect(linksOf(first).some((link) => link.includes("evil.web.test"))).toBe(false)
      expect(output(first)).toContain("untrusted_web_page")
      // What Vector noticed, in its own words beside the fence.
      expect(output(first)).toMatch(/Signals: .*Contains text addressed to AI assistants/)
      // A link the article offered is read next, as a source of its own.
      expect(linksOf(second)).toContain(data)
      expect(third?.state.status).toBe("completed")
      expect(output(third)).toContain("before_kwh")
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "past the run's page budget a read is refused before the site is asked, so the run ends with a report",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web, { research: { limits: { focused: { pages: 1 } } } })
      const sessions = yield* Session.Service
      yield* answer("once")
      const session = yield* sessions.create({ title: "Research" })
      const article = web.url("article", "/")
      const pdf = web.url("docs", "/report.pdf")
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: article })
      yield* test.llm.tool("research_read", { url: pdf })
      yield* test.llm.text("Done.")
      const before = web.count("docs", "/report.pdf")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump savings: ${article} ${pdf}` })
      const [first, second] = yield* calls(session.id, "research_read")
      expect(output(first)).toContain("S1 · ")
      expect(output(second)).toBe(ResearchStore.PAGES)
      expect(web.count("docs", "/report.pdf")).toBe(before)
    }),
  90_000,
)

it.instance(
  "after a compaction drops the plan from what the model sees, the run and what it may read are still found",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      yield* answer("once")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump field study" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const research = yield* ResearchRun.Service
      // What a step after a compaction gets: none of the messages before the summary.
      const ctx = {
        sessionID: session.id,
        messageID: MessageID.make("msg_after_compaction"),
        agent: "research",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const found = yield* research.current(ctx)
      expect("refused" in found).toBe(false)
      if ("refused" in found) return
      const check = ResearchProvenance.check(yield* research.provenance(ctx, found), web.url("article", "/"))
      expect(check.ok).toBe(true)
    }),
  90_000,
)

it.instance(
  "a search result at a metadata, private or loopback address is refused without asking and never fetched",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web, {
        research: { search: { provider: "searxng", url: web.url("lansearch", "/") } },
      })
      const asked = yield* answer("once")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      const found = [
        "http://169.254.169.254/latest/meta-data/",
        "http://10.1.2.3/wiki",
        web.direct("article", "/"),
        "http://metadata.google.internal/computeMetadata/v1/",
      ]
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump field study" })
      for (const url of found) yield* test.llm.tool("research_read", { url })
      yield* test.llm.text("Done.")
      const before = web.count("article")
      yield* send({ sessionID: session.id, agent: "research", text: "Research heat pumps." })
      const reads = yield* calls(session.id, "research_read")
      expect(reads).toHaveLength(found.length)
      for (const read of reads) {
        expect(read.state.status === "completed" ? read.state.metadata.status : undefined).toBe("failed")
        expect(output(read)).toContain("was not read: ")
        expect(output(read)).not.toContain("..")
        expect(output(read)).not.toContain("untrusted_web_page")
      }
      expect(output(reads[0])).toContain("cloud metadata")
      expect(output(reads[1])).toContain("only from an address you typed")
      expect(output(reads[2])).toContain("only from an address you typed")
      expect(output(reads[3])).toContain("cloud metadata")
      // Research found these addresses, so none of them asks to reach the user's network: each is refused.
      expect(
        asked.filter(
          (request) => request.permission === "private_network" && request.metadata.tool === "research_read",
        ),
      ).toEqual([])
      expect(web.count("article") - before).toBe(0)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "only a site the user chose reads as trusted, never one a plan approved on its own named",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web, { research: { domains: { prefer: [`docs.${FakeWeb.DOMAIN}`] } } })
      yield* answer("once")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      const article = web.url("article", "/")
      const pdf = web.url("docs", "/report.pdf")
      // The lead names the article's site itself, and no one approves its plan.
      yield* test.llm.tool("research_plan", { ...plan(), prefer_domains: [`article.${FakeWeb.DOMAIN}`] })
      yield* test.llm.tool("research_read", { url: article })
      yield* test.llm.tool("research_read", { url: pdf })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research heat pump savings: ${article} and ${pdf}.`,
      })
      const [planned] = yield* calls(session.id, "research_plan")
      expect(planned?.state.status === "completed" ? planned.state.metadata.answer : undefined).toBe("automatic")
      const [fromArticle, fromDocs] = yield* calls(session.id, "research_read")
      expect(output(fromArticle)).toContain("412 homes")
      expect(output(fromArticle)).not.toContain("You trust this site")
      expect(output(fromDocs)).toContain("You trust this site")
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const runID = planned?.state.status === "completed" ? planned.state.metadata.runID : ""
      const detail = yield* store.get(yield* instruction.place(), runID)
      expect(detail?.sources.map((source) => source.signals?.preference)).toEqual([undefined, "trusted"])
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "with Vector Local on, research's searches and reads are decided as its own, and Web access None refuses a read as it is sent",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      yield* answer("once")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      const article = web.url("article", "/")
      const site = new URL(article).origin
      // Vector Local as the owner sets it in their own config, beside the research settings setup wrote there: the
      // fake LLM server is the one model server on the list, and the search server is not on it.
      const file = path.join(Global.Path.config, "vector.json")
      const written = JSON.parse(readFileSync(file, "utf8"))
      const local = (access?: "ask" | "none") => {
        // With no access given the file is as setup wrote it again: JSON leaves an undefined block out.
        const block = access && { enabled: true, endpoints: [new URL(test.llm.url).origin], web: access }
        writeFileSync(file, JSON.stringify({ ...written, local: block || undefined }))
        Config.refreshLocal()
        Config.confirmLocal()
      }
      const decided = (since: number) =>
        Egress.events({ since })
          .filter((event) => event.source === "research-reader" || event.source === "websearch-searxng")
          .map((event) => [event.source, event.origin, event.decision, event.rule])
      yield* Effect.gen(function* () {
        local("ask")
        const asked = Date.now()
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump field study" })
        yield* test.llm.tool("research_read", { url: article })
        yield* test.llm.text("Done.")
        const searched = web.count("searxng")
        yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump savings: ${article}` })
        const [search] = yield* calls(session.id, "research_search")
        const [read] = yield* calls(session.id, "research_read")
        // A search server off the list gets no query; Web access Ask reads the page the user typed.
        expect(output(search)).toBe("Vector could not reach the search server.")
        expect(web.count("searxng")).toBe(searched)
        expect(output(read)).toContain("The study followed 412 homes through two winters.")
        const first = decided(asked)
        expect(first[0]).toEqual(["websearch-searxng", new URL(web.url("searxng", "/")).origin, "block", "not-listed"])
        // Each hop of the page is research-reader's (an address the user typed skips robots.txt).
        expect(first.length).toBeGreaterThan(1)
        expect(first.slice(1)).toEqual(first.slice(1).map(() => ["research-reader", site, "allow", "web-ask"]))

        local("none")
        const offline = Date.now()
        const before = web.count("article")
        yield* test.llm.tool("research_plan", plan({ question: "Which heat pumps work below minus 20 degrees?" }))
        yield* test.llm.tool("research_read", { url: article })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: `Now research the coldest winters: ${article}` })
        const reads = yield* calls(session.id, "research_read")
        expect(output(reads[1])).toContain("was not read: ")
        expect(web.count("article")).toBe(before)
        expect(decided(offline)).toContainEqual(["research-reader", site, "block", "web-none"])
        expect(guard.outside()).toEqual([])
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            local()
            rmSync(Config.localConfirmedFile(), { force: true })
            await Egress.erase()
          }),
        ),
      )
    }),
  90_000,
)
