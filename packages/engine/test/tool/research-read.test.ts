import { afterAll, expect } from "bun:test"
import { Effect } from "effect"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Permission } from "../../src/permission"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { ResearchRun } from "../../src/tool/research-run"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_read (section 5.4), end to end on the fake LLM server and the fake web: an address must come from a search
// result, a link a read offered or the user's own message; the run's first new page asks once, for that run only and
// never saved as Always; a saved source reads again with no network call.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const { it, cleanup } = runtime(web)
afterAll(async () => {
  await web.close()
  cleanup()
})

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
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* llm.tool("research_plan", plan())
      yield* llm.tool("research_read", { url: web.url("article", "/") })
      // An address a page might have asked for, with the agent's own text in its query.
      yield* llm.tool("research_read", { url: `${web.url("article", "/")}?ref=badge-4417` })
      yield* llm.text("Done.")
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
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const asked = yield* answer("always")
      const session = yield* sessions.create({ title: "Research" })
      const article = web.url("article", "/")
      const pdf = web.url("docs", "/report.pdf")
      yield* llm.tool("research_plan", plan())
      yield* llm.tool("research_read", { url: article })
      yield* llm.tool("research_read", { url: pdf })
      yield* llm.tool("research_read", { source: "S1", find: "412 homes" })
      yield* llm.text("Done.")
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
      yield* llm.tool("research_plan", plan({ question: "Which heat pumps work below minus 20 degrees?" }))
      yield* llm.tool("research_read", { url: web.url("docs", "/report.pdf") })
      yield* llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Now research which ones work in the coldest winters.",
      })
      expect(asked.filter((request) => request.permission === "research_read")).toHaveLength(2)

      // The pages are held, private web documents of the run, as the store keeps them.
      const store = yield* ResearchStore.Service
      const place = yield* (yield* Instruction.Service).place()
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
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      yield* answer("once")
      const session = yield* sessions.create({ title: "Research" })
      const hostile = web.url("hostile", "/")
      const article = web.url("article", "/")
      const data = web.url("article", "/data/heat-pump-study.csv")
      yield* llm.tool("research_plan", plan())
      yield* llm.tool("research_read", { url: hostile, links: true })
      yield* llm.tool("research_read", { url: article, links: true })
      yield* llm.tool("research_read", { url: data })
      yield* llm.text("Done.")
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
      const { llm } = yield* setup(web, { research: { limits: { focused: { pages: 1 } } } })
      const sessions = yield* Session.Service
      yield* answer("once")
      const session = yield* sessions.create({ title: "Research" })
      const article = web.url("article", "/")
      const pdf = web.url("docs", "/report.pdf")
      yield* llm.tool("research_plan", plan())
      yield* llm.tool("research_read", { url: article })
      yield* llm.tool("research_read", { url: pdf })
      yield* llm.text("Done.")
      const before = web.count("docs", "/report.pdf")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pump savings: ${article} ${pdf}` })
      const [first, second] = yield* calls(session.id, "research_read")
      expect(output(first)).toContain("S1 · ")
      expect(output(second)).toBe(ResearchStore.PAGES)
      expect(web.count("docs", "/report.pdf")).toBe(before)
    }),
  90_000,
)
