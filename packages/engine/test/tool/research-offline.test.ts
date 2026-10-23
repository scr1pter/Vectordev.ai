import { afterAll, expect } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "path"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "@vectordevai/core/global"
import type { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { ResearchBrowserTool } from "../../src/tool/research-browser"
import { ResearchReadTool } from "../../src/tool/research-read"
import { ResearchRun } from "../../src/tool/research-run"
import { ResearchSearchTool } from "../../src/tool/research-search"
import type { Tool } from "../../src/tool/tool"
import { MessageID } from "../../src/session/schema"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Deep research under Vector Local's Web access None (section 5.9): "Brain and files only", and the network tools are
// not offered at all. The plan's scope is the brain whatever was proposed and the run stays Focused, since Deep's
// researchers work on the web; a researcher is not started; and a run planned before Web access became None searches
// and reads no more pages. The fake LLM server is the one model server on the list.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web)
afterAll(() => web.close())

const NETWORK = ["research_read", "research_search", "research_browser"]
const toolNames = (body: string) =>
  ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).flatMap((tool) =>
    tool.function?.name ? [tool.function.name] : [],
  )

// The user's own config, as setup wrote it with research's settings, with Vector Local's block laid over it.
const userConfig = path.join(Global.Path.config, "vector.json")
const local = (block: ConfigLocalV1.Info | undefined) =>
  Effect.gen(function* () {
    const rest = Object.fromEntries(
      Object.entries(JSON.parse(readFileSync(userConfig, "utf8")) as Record<string, unknown>).filter(
        ([key]) => key !== "local",
      ),
    )
    writeFileSync(userConfig, JSON.stringify(block ? { ...rest, local: block } : rest))
    yield* (yield* Config.Service).invalidate()
    Config.refreshLocal()
    Config.confirmLocal()
  })
const off = Effect.fnUntraced(function* () {
  yield* local(undefined)
  rmSync(Config.localConfirmedFile(), { force: true })
})

it.instance(
  "with Web access None research is offered no network tool, and its plan is the brain's and Focused",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      yield* local({ enabled: true, web: "none", endpoints: [new URL(test.llm.url).origin] })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      // The model proposes the web, deep, as it might: the plan it gets is the brain's.
      yield* test.llm.tool("research_plan", plan({ scope: "web", depth: "deep" }))
      yield* test.llm.tool("task", {
        description: "Field studies",
        prompt: "What did field studies of heat pumps measure?",
        subagent_type: "researcher",
        background: false,
      })
      yield* test.llm.text("Done.")
      const bodies = yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Research how much heat pumps save.",
        size: "thorough",
      }).pipe(Effect.ensuring(off()))

      for (const body of bodies) {
        const tools = toolNames(body)
        expect(tools).toContain("research_plan")
        expect(tools).toContain("research_report")
        expect(tools.filter((name) => NETWORK.includes(name))).toEqual([])
      }
      const [planned] = yield* calls(session.id, "research_plan")
      expect(planned?.state.status === "completed" ? planned.state.metadata.plan : undefined).toMatchObject({
        scope: "brain",
        depth: "focused",
      })
      expect(output(planned)).toContain(ResearchRun.OFFLINE)
      expect(output(planned)).not.toContain("research_search")
      // No web worker: a researcher's work is the web.
      const [task] = yield* calls(session.id, "task")
      expect(output(task)).toContain(ResearchRun.OFFLINE_RESEARCHERS)
      expect(yield* sessions.children(session.id)).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "with Web access Ask the same research is offered its network tools",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      yield* local({ enabled: true, web: "ask", endpoints: [new URL(test.llm.url).origin] })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan({ scope: "web" }))
      yield* test.llm.text("Done.")
      const bodies = yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Research how much heat pumps save.",
      }).pipe(Effect.ensuring(off()))

      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) expect(toolNames(body)).toEqual(expect.arrayContaining(NETWORK))
      const [planned] = yield* calls(session.id, "research_plan")
      expect(planned?.state.status === "completed" ? planned.state.metadata.plan : undefined).toMatchObject({
        scope: "web",
      })
      expect(output(planned)).not.toContain(ResearchRun.OFFLINE)
    }),
  120_000,
)

it.instance(
  "a run planned before Web access became None searches and reads nothing more on the web",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan({ scope: "web" }))
      yield* test.llm.text("Planned.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })

      yield* local({ enabled: true, web: "none", endpoints: [new URL(test.llm.url).origin] })
      // The tools as a step that began before the change would still hold them.
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: MessageID.ascending(),
        agent: ResearchRun.LEAD,
        abort: AbortSignal.any([]),
        messages: yield* sessions.messages({ sessionID: session.id }),
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      // The fetch the tools would read the web with, which none of these calls reaches.
      const search = yield* (yield* ResearchSearchTool.pipe(Effect.provide(FetchHttpClient.layer))).init()
      const read = yield* (yield* ResearchReadTool.pipe(Effect.provide(FetchHttpClient.layer))).init()
      const browser = yield* (yield* ResearchBrowserTool).init()
      const [searched, page, opened] = yield* Effect.all([
        search.execute({ query: "heat pump field study savings" }, ctx),
        read.execute({ url: web.url("article", "/") }, ctx),
        browser.execute({ action: "open", url: web.url("article", "/") }, ctx),
      ]).pipe(Effect.ensuring(off()))

      expect([searched.output, searched.metadata.refused]).toEqual([ResearchRun.OFFLINE, "offline"])
      expect([page.output, page.metadata.refused]).toEqual([ResearchRun.OFFLINE, "offline"])
      expect([opened.output, opened.metadata.refused]).toEqual([ResearchRun.OFFLINE, "offline"])
      expect(web.hits().filter((hit) => hit.site === "searxng" || hit.site === "article")).toEqual([])
    }),
  120_000,
)
