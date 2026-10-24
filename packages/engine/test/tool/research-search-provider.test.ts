import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { ResearchRun } from "../../src/tool/research-run"
import { OPTIONS, options, searchProvider } from "../../src/tool/research-search"
import { FakeBridge } from "../lib/fake-bridge"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Where Deep research searches (section 5.7, owner decision 23 Oct 2026): in the calling agent's own research browser
// in the desktop app, the lead's or each researcher's, through the bridge's research.search. There is no search
// service and no key. Without the desktop's browser nothing is searched, and the tool says so. A search goes out only
// after the outbound check and Vector Local's Web access, and its results join the run's provenance.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web)
const bridge = FakeBridge.start(FakeBridge.searching(web))
afterAll(async () => {
  await bridge.close()
  await web.close()
})
const allow = [{ permission: "research_read", pattern: "*", action: "allow" as const }]
const researcher = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("research_assignment")
// The engine pointed at the fake desktop for one test, as the desktop app points it at its own.
const withDesktop = <A, E, R>(effect: Effect.Effect<A, E, R>) => FakeBridge.within(bridge, effect)

describe("research's search provider", () => {
  test("the research browser where the desktop has one, else nothing, and the command line's none searches nothing", () => {
    expect(searchProvider({ browser: true })).toEqual({ provider: "browser" })
    expect(searchProvider({ browser: false })).toEqual({ provider: "none", reason: ResearchSearch.NEEDS_DESKTOP })
    expect(searchProvider({ browser: true, chosen: "none" })).toEqual({ provider: "none", reason: ResearchSearch.NONE })
    // A search service an earlier version's command line named (its messages may still say so) changes nothing.
    for (const chosen of ["searxng", "exa", "parallel", "auto"])
      expect(searchProvider({ browser: true, chosen })).toEqual({ provider: "browser" })
  })

  test("the command line's choices are read from the newest message the user sent", () => {
    const user = (id: string, parts: SessionV1.Part[]): SessionV1.WithParts => ({
      info: { id, sessionID: "ses_options", role: "user", time: { created: 1 }, agent: "research" } as SessionV1.User,
      parts,
    })
    const text = (id: string, value: string, extra: Partial<SessionV1.TextPart> = {}) =>
      ({ id, sessionID: "ses_options", messageID: "msg", type: "text", text: value, ...extra }) as SessionV1.TextPart
    const sent = user("msg_1", [
      text("p1", "Research heat pumps"),
      text("p2", "Research settings", { synthetic: true, metadata: { [OPTIONS]: { search: "none", scope: "brain" } } }),
    ])
    // Vector's own follow-up (a judge's verdict) is not a message the user sent.
    const followup = user("msg_2", [text("p3", "<vector_research_verdict>", { synthetic: true })])
    expect(options([sent, followup])).toEqual({ search: "none", scope: "brain" })
    expect(options([sent, user("msg_3", [text("p4", "Now research the costs")])])).toEqual({})
    // An old command line's search name still leaves its scope standing.
    expect(
      options([user("msg_4", [text("p5", "x", { metadata: { [OPTIONS]: { search: "exa", scope: "web" } } })])]),
    ).toEqual({ search: "exa", scope: "web" })
    expect(options([user("msg_5", [text("p6", "y", { metadata: { [OPTIONS]: { scope: "everything" } } })])])).toEqual(
      {},
    )
  })
})

it.instance(
  "without the desktop's browser research searches nothing, counts nothing and says so on the card and in the run",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const before = FakeBridge.searches(bridge).length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump field study" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const [planned] = yield* calls(session.id, "research_plan")
      expect(output(planned)).toContain("Nothing is searched on the web here")
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toBe(ResearchSearch.NEEDS_DESKTOP)
      expect(search?.state.status === "completed" ? search.state.metadata.refused : undefined).toBe("desktop")
      expect(FakeBridge.searches(bridge).length).toBe(before)
      const runID = search?.state.status === "completed" ? (search.state.metadata.runID as string) : ""
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      expect((yield* store.get(place, runID))?.run.searches).toBe(0)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "the lead searches in its own research browser: the query and its filters go to the desktop, and the results may be read",
  () =>
    withDesktop(
      Effect.gen(function* () {
        const test = yield* setup()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        const before = FakeBridge.searches(bridge).length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", {
          query: "heat pump field study",
          site: "nature.com",
          recency: "year",
          limit: 5,
        })
        // A result's address, which the user never typed, is the run's to read.
        yield* test.llm.tool("research_read", { url: web.url("article", "/") })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
        const sent = FakeBridge.searches(bridge).slice(before)
        expect(sent).toHaveLength(1)
        const research = yield* ResearchRun.Service
        const limits = yield* research.limits("focused")
        expect(sent[0]?.body).toMatchObject({
          command: "research.search",
          sessionID: session.id,
          rootID: session.id,
          agent: "research",
          max: 1 + limits.researchers,
          query: "heat pump field study site:nature.com",
          recency: "year",
          limit: 5,
          engines: ["google", "duckduckgo"],
        })
        // Nothing but the run's own IDs and the query: no address, no page of the agent's choosing.
        expect(sent[0]?.body).not.toHaveProperty("url")
        const [search] = yield* calls(session.id, "research_search")
        expect(output(search)).toContain("3 results from Google")
        expect(output(search)).toContain("untrusted_web_page")
        expect(search?.state.status === "completed" ? search.state.metadata : {}).toMatchObject({
          provider: "browser",
          engine: "google",
        })
        const [read] = yield* calls(session.id, "research_read")
        expect(read?.state.status === "completed" ? read.state.metadata.refused : "error").toBeUndefined()
        expect(output(read)).toContain("S1")
        expect(guard.outside()).toEqual([])
      }),
    ),
  90_000,
)

it.instance(
  "each researcher searches in a research browser of its own, under the run's count of 1 + the researcher cap",
  () =>
    withDesktop(
      Effect.gen(function* () {
        const test = yield* setup()
        const sessions = yield* Session.Service
        const lead = yield* sessions.create({ title: "Research", permission: allow })
        const before = FakeBridge.searches(bridge).length
        yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
        yield* test.llm.tool("research_search", { query: "heat pump savings in cold climates" })
        for (const prompt of ["What did field studies measure?", "How large were the savings?"]) {
          yield* test.llm.tool("task", {
            description: "Heat pumps",
            prompt,
            subagent_type: "researcher",
            background: false,
          })
          yield* test.llm.toolMatch(researcher, "research_search", { query: "heat pump field study homes" })
          yield* test.llm.textMatch(researcher, "Found it.")
        }
        yield* test.llm.text("Done.")
        yield* send({ sessionID: lead.id, agent: "research", text: "Research how much heat pumps cut heating bills." })
        const children = yield* sessions.children(lead.id)
        expect(children).toHaveLength(2)
        // The run's depth as it was approved: a plan no one can answer stays within the request's size.
        const [planned] = yield* calls(lead.id, "research_plan")
        const depth = planned?.state.status === "completed" ? planned.state.metadata.plan.depth : "focused"
        const research = yield* ResearchRun.Service
        const limits = yield* research.limits(depth)
        const sent = FakeBridge.searches(bridge)
          .slice(before)
          .map((call) => call.body)
        // One search each, in the lead's browser and in each researcher's own, all of one run.
        expect(sent.map((body) => [body.sessionID, body.agent])).toEqual([
          [lead.id, "research"],
          ...children.map((child) => [child.id, "researcher"]),
        ])
        expect(new Set(sent.map((body) => body.runID)).size).toBe(1)
        expect(sent.map((body) => body.max)).toEqual(Array(3).fill(1 + limits.researchers))
        expect(sent.every((body) => body.rootID === lead.id)).toBe(true)
        for (const child of children) {
          const [search] = yield* calls(child.id, "research_search")
          expect(output(search)).toContain("results from Google")
        }
        expect(guard.outside()).toEqual([])
      }),
    ),
  120_000,
)

it.instance(
  "a check on Google is said, with DuckDuckGo's results; when both ask for one, search is unavailable and the run is told so",
  () =>
    withDesktop(
      Effect.gen(function* () {
        const test = yield* setup()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        const check = { engine: "google", reason: "Google asked for a check that it is not automated traffic." }
        const answers = [
          FakeBridge.searched(web, { engine: "duckduckgo", tried: [check] }),
          FakeBridge.research({
            ok: false,
            error: ResearchSearch.unavailable([{ engine: "google" }, { engine: "duckduckgo" }]),
            search: {
              results: [],
              tried: [
                check,
                { engine: "duckduckgo", reason: "DuckDuckGo asked for a check that it is not automated traffic." },
              ],
            },
          }),
          // Only DuckDuckGo's page was tried (Vector Local kept the search off Google), and it asked for a check.
          FakeBridge.research({
            ok: false,
            error: ResearchSearch.unavailable([{ engine: "duckduckgo" }]),
            search: {
              results: [],
              tried: [
                { engine: "duckduckgo", reason: "DuckDuckGo asked for a check that it is not automated traffic." },
              ],
            },
          }),
        ]
        bridge.answer((call) => {
          if (call.path !== "/research") return FakeBridge.visible()
          return call.body.command === "research.search" ? answers.shift() : FakeBridge.research()
        })
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump field study" })
        yield* test.llm.tool("research_search", { query: "heat pump savings" })
        yield* test.llm.tool("research_search", { query: "heat pump noise" })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." }).pipe(
          Effect.ensuring(Effect.sync(() => bridge.answer(FakeBridge.searching(web)))),
        )
        const [fallback, unavailable, alone] = yield* calls(session.id, "research_search")
        expect(output(fallback)).toContain("3 results from DuckDuckGo")
        expect(output(fallback)).toContain(`${check.reason} Vector searched DuckDuckGo instead.`)
        expect(fallback?.state.status === "completed" ? fallback.state.metadata.engine : undefined).toBe("duckduckgo")
        expect(output(unavailable)).toContain(
          ResearchSearch.unavailable([{ engine: "google" }, { engine: "duckduckgo" }]),
        )
        expect(unavailable?.state.status === "completed" ? unavailable.state.title : "").toBe("Search unavailable")
        expect(unavailable?.state.status === "completed" ? unavailable.state.metadata : {}).toMatchObject({
          unavailable: true,
        })
        expect(output(alone)).toContain(ResearchSearch.unavailable([{ engine: "duckduckgo" }]))
        expect(output(alone)).not.toContain("Google")
        expect(guard.outside()).toEqual([])
      }),
    ),
  90_000,
)

it.instance(
  "Vector Local's Web access decides each results page as research-browser traffic before the search leaves",
  () =>
    withDesktop(
      Effect.gen(function* () {
        const test = yield* setup()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        const before = FakeBridge.searches(bridge).length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump field study" })
        yield* test.llm.text("Done.")
        const file = path.join(Global.Path.config, "vector.json")
        const written = yield* Effect.promise(() => Bun.file(file).json())
        const local = (block?: object) =>
          Effect.promise(async () => {
            await Bun.write(file, JSON.stringify(block ? { ...written, local: block } : written))
            Config.refreshLocal()
            Config.confirmLocal()
          })
        // The user keeps Vector off Google: the search goes to DuckDuckGo's page alone.
        yield* local({
          enabled: true,
          web: "ask",
          web_domains: { deny: ["google.com"] },
          endpoints: [new URL(test.llm.url).origin],
        })
        yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." }).pipe(
          Effect.ensuring(local().pipe(Effect.orDie)),
        )
        expect(
          FakeBridge.searches(bridge)
            .slice(before)
            .map((call) => call.body.engines),
        ).toEqual([["duckduckgo"]])

        // Your network only, with neither engine on the company's list: nothing leaves, and nothing counts.
        const other = yield* sessions.create({ title: "Research", permission: allow })
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump field study" })
        yield* test.llm.text("Done.")
        yield* local({ enabled: true, web: "network", endpoints: [new URL(test.llm.url).origin] })
        yield* send({ sessionID: other.id, agent: "research", text: "Research how much heat pumps save." }).pipe(
          Effect.ensuring(local().pipe(Effect.orDie)),
        )
        const [refused] = yield* calls(other.id, "research_search")
        expect(output(refused)).toContain(
          "Vector Local's Web access keeps research's searches off Google and DuckDuckGo",
        )
        expect(refused?.state.status === "completed" ? refused.state.metadata.refused : undefined).toBe("local")
        expect(FakeBridge.searches(bridge).length - before).toBe(1)
        expect(Egress.policy().enabled).toBe(false)
        yield* Effect.promise(() => Egress.erase())
        expect(guard.outside()).toEqual([])
      }),
    ),
  90_000,
)
