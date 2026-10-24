import { afterAll, expect, test } from "bun:test"
import path from "path"
import { Effect, Fiber } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ResearchStore } from "@vectordevai/core/research/store"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Question } from "../../src/question"
import { Instruction } from "../../src/session/instruction"
import { SessionMemory } from "../../src/session/memory"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionTaskSize } from "../../src/session/task-size"
import { SessionCompaction } from "../../src/session/compaction"
import { ResearchRun } from "../../src/tool/research-run"
import { reply } from "../lib/llm-server"
import { calls, output, plan, ref, repositoryConfig, runtime, send, setup } from "../lib/research"
import { FakeBridge } from "../lib/fake-bridge"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Sizing Deep research (sections 5.2, 5.6a and 11.2). A greeting in the research mode goes out on the quick lane with
// no memory at all; a question is Work, where the lead may still hand independent sub-questions to up to 2
// researchers; only the user's own "Start deep" (or a Thorough request) makes it Deep, never a child's plan. Research's
// default caps are the run's budget only when the user set none, a page budget ends the run with a report, a
// repository's config cannot pick where research searches, the lead recalls how the owner works and no fact about
// them, and a compaction keeps the run's digest.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web)
// Where someone can answer the plan card.
const app = runtime(web, { client: "app" })
// A desktop whose research browsers answer each search with the fake web's pages, for the tests that search.
const bridge = FakeBridge.start(FakeBridge.searching(web))
afterAll(async () => {
  await bridge.close()
  await web.close()
})

const allow = [{ permission: "research_read", pattern: "*", action: "allow" as const }]
const names = (body: string) =>
  ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((tool) => tool.function?.name)
const researcher = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("research_assignment")
const assistants = (messages: readonly SessionV1.WithParts[]) =>
  messages.flatMap((message) => (message.info.role === "assistant" ? [message.info] : []))

it.instance(
  "a greeting in the research mode goes to the quick lane with no memory and no recall",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      yield* brain.propose(yield* instruction.place(), {
        kind: "preference",
        text: "Say hi back in one short line",
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.text("Hello.")
      const [body] = yield* send({ sessionID: session.id, agent: "research", text: "hi" })
      expect(body).toBeDefined()
      // The quick lane: no research tools, no digest, no recall, no rules file.
      expect(names(body!)).not.toContain("research_plan")
      expect(body).not.toContain("vector_memory")
      expect(body).not.toContain("Never force-push to main")
      expect(body).not.toContain("Say hi back")
      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(assistants(messages).map((info) => info.agent)).toEqual(["quick"])
      expect(assistants(messages)[0]?.size).toBe("chat")
      const user = messages.find((message) => message.info.role === "user")!
      expect(SessionMemory.recalled(user)).toBe(false)
    }),
  60_000,
)

it.instance(
  "a question in the research mode is Work: the lead may start researchers, up to Focused's 2",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      const brief = (description: string, prompt: string) => ({ description, prompt, subagent_type: "researcher" })
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      // Three at once is past Focused's cap, so the batch starts none; two fit.
      yield* test.llm.tool("task", {
        background: false,
        tasks: [
          brief("A", "What did field studies measure?"),
          brief("B", "How long do heat pumps last in cold climates?"),
          brief("C", "What do heat pumps cost in Europe?"),
        ],
      })
      yield* test.llm.tool("task", {
        background: false,
        tasks: [brief("A", "What did field studies measure?"), brief("B", "How long do heat pumps last?")],
      })
      yield* test.llm.textMatch(researcher, "Found A.")
      yield* test.llm.textMatch(researcher, "Found B.")
      yield* test.llm.text("Done.")
      const bodies = yield* send({
        sessionID: lead.id,
        agent: "research",
        text: "Research how much heat pumps save in cold climates.",
      })
      const leads = bodies.filter((body) => !body.includes("research_assignment"))
      expect(names(leads[0]!)).toContain("task")
      expect(names(leads[0]!)).not.toContain("escalate")
      const [planned] = yield* calls(lead.id, "research_plan")
      // A Work request plans Focused whatever the model asked for, and records no raise.
      expect(planned?.state.status === "completed" ? planned.state.metadata.plan.depth : undefined).toBe("focused")
      const [over, within] = yield* calls(lead.id, "task")
      expect(over?.state.status).toBe("error")
      expect(output(over)).toContain("has its 2 researchers")
      expect(within?.state.status).toBe("completed")
      expect(yield* sessions.children(lead.id)).toHaveLength(2)
      // The request stayed Work.
      const messages = yield* sessions.messages({ sessionID: lead.id })
      expect(new Set(assistants(messages).map((info) => info.size))).toEqual(new Set(["standard"]))
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  '"no subagents" keeps the research lead on its own',
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.text("I will research it myself.")
      const [body] = yield* send({
        sessionID: lead.id,
        agent: "research",
        text: "Research how much heat pumps save, no subagents.",
      })
      expect(names(body!)).toContain("research_plan")
      expect(names(body!)).not.toContain("task")
      expect(names(body!)).not.toContain("task_manage")
    }),
  60_000,
)

app.instance(
  '"ok" on an open plan card starts the plan, with no new request and no recall',
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const question = yield* Question.Service
      const asked: string[] = []
      yield* Effect.gen(function* () {
        while (true) {
          for (const request of yield* question.list()) {
            asked.push(request.id)
            yield* question.reply({ requestID: request.id, answers: [["ok"]] }).pipe(Effect.ignore)
          }
          yield* Effect.sleep(10)
        }
      }).pipe(Effect.forkScoped)
      // Something the request recalls, so a second recall would show.
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const entry = yield* brain.propose(yield* instruction.place(), {
        kind: "preference",
        text: "For heat pump research prefer field studies over vendor claims",
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.text("Starting.")
      const bodies = yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Research how much heat pumps save.",
      })
      expect(asked).toHaveLength(1)
      const [planned] = yield* calls(session.id, "research_plan")
      expect(planned?.state.status === "completed" ? planned.state.metadata : {}).toMatchObject({
        approved: true,
        answer: "start",
      })
      const messages = yield* sessions.messages({ sessionID: session.id })
      const users = messages.filter((message) => message.info.role === "user")
      expect(users).toHaveLength(1)
      // The request recalled once, for the question; the "ok" was no request, so it recalled nothing.
      const recalls = messages.flatMap((message) => message.parts.flatMap((part) => SessionMemory.recall(part) ?? []))
      expect(recalls).toHaveLength(1)
      expect(SessionMemory.recalled(users[0]!)).toBe(true)
      expect(recalls[0]?.ids).toEqual([entry.type === "added" ? entry.entry.id : "missing"])
      // The step after the card sent the same recall the question's step did, and the "ok" as the card's answer only.
      expect(bodies).toHaveLength(2)
      expect(bodies.every((body) => body.includes("prefer field studies over vendor claims"))).toBe(true)
      const texts = (body: string) =>
        ((JSON.parse(body) as { messages?: { role?: string; content?: unknown }[] }).messages ?? [])
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
      expect(texts(bodies[1]!)).toEqual(texts(bodies[0]!))
    }),
  60_000,
)

it.instance(
  "a child's plan cannot raise a request: build's research tool at Work keeps the lead and build at Work",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build", permission: allow })
      const child = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("Plan the run with research_plan")
      yield* test.llm.tool("research", {
        question: "How much do heat pumps save in cold climates?",
        depth: "deep",
        background: false,
      })
      yield* test.llm.toolMatch(child, "research_plan", plan({ depth: "deep" }))
      yield* test.llm.textMatch(child, "Planned.")
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Find out how much heat pumps save before we price them.",
      })
      const [lead] = yield* sessions.children(build.id)
      expect(lead).toBeDefined()
      const [planned] = yield* calls(lead!.id, "research_plan")
      expect(planned?.state.status === "completed" ? planned.state.metadata : {}).toMatchObject({
        approved: true,
        answer: "automatic",
        plan: { depth: "focused" },
      })
      expect(planned?.state.status === "completed" ? planned.state.metadata.to : "missing").toBeUndefined()
      const requests = SessionTaskSize.size({
        messages: yield* sessions.messages({ sessionID: build.id }),
        caching: false,
        lifetime: 0,
      })
      expect(requests.at(-1)?.tier).toBe("standard")
      // A child is not sized at all: its assistant messages carry no size.
      expect(
        assistants(yield* sessions.messages({ sessionID: lead!.id })).every((info) => info.size === undefined),
      ).toBe(true)
    }),
  90_000,
)

app.instance(
  "\"Start deep\" on the root plan card raises the request to Thorough and research's caps to Deep's",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const question = yield* Question.Service
      yield* Effect.gen(function* () {
        while (true) {
          for (const request of yield* question.list())
            yield* question.reply({ requestID: request.id, answers: [["Start deep"]] }).pipe(Effect.ignore)
          yield* Effect.sleep(10)
        }
      }).pipe(Effect.forkScoped)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.text("Researching deeply.")
      const bodies = yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Research how much heat pumps save.",
      })
      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(assistants(messages).map((info) => info.size)).toEqual(["standard", "thorough"])
      expect(SessionTaskSize.size({ messages, caching: false, lifetime: 0 }).at(-1)?.tier).toBe("thorough")
      // The step after the raise is offered everything Thorough is.
      expect(names(bodies.at(-1)!)).toContain("task")
      const spend = yield* SpendGuard.Service
      const run = yield* spend.snapshot(session.id)
      expect(run?.budget).toEqual({ usd: ResearchRun.LIMITS.deep.usd, steps: ResearchRun.LIMITS.deep.steps })
      // The approved plan names the caps it runs under: Deep's, not the Focused defaults it started with.
      const [planned] = yield* calls(session.id, "research_plan")
      expect(output(planned)).toContain(`Step cap ${ResearchRun.LIMITS.deep.steps}`)
    }),
  60_000,
)

app.instance(
  "a request the user sized Focused is proposed Focused, whatever the model planned, and Start keeps it there",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const question = yield* Question.Service
      const offered: string[][] = []
      yield* Effect.gen(function* () {
        while (true) {
          for (const request of yield* question.list()) {
            offered.push(request.questions[0]?.options.map((option) => option.label) ?? [])
            yield* question.reply({ requestID: request.id, answers: [["Start"]] }).pipe(Effect.ignore)
          }
          yield* Effect.sleep(10)
        }
      }).pipe(Effect.forkScoped)
      const sessions = yield* Session.Service
      const spend = yield* SpendGuard.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      yield* test.llm.text("Researching.")
      // The Depth chip's Focused: the composer sends the size standard.
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Research how much heat pumps save.",
        size: "standard",
      })
      // "Start deep" is still offered, as the one way up.
      expect(offered).toEqual([["Start", "Start deep", "Cancel"]])
      const [planned] = yield* calls(session.id, "research_plan")
      const metadata = planned?.state.status === "completed" ? planned.state.metadata : {}
      expect(metadata.plan?.depth).toBe("focused")
      expect(metadata.to).toBeUndefined()
      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(new Set(assistants(messages).map((info) => info.size))).toEqual(new Set(["standard"]))
      expect((yield* spend.snapshot(session.id))?.budget).toEqual({
        usd: ResearchRun.LIMITS.focused.usd,
        steps: ResearchRun.LIMITS.focused.steps,
      })
    }),
  60_000,
)

it.instance(
  "research's default caps are the run's budget only when the user set none",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const prompt = yield* SessionPrompt.Service

      const focused = yield* sessions.create({ title: "Focused", permission: allow })
      yield* test.llm.text("Planning.")
      yield* send({ sessionID: focused.id, agent: "research", text: "Research how much heat pumps save." })
      expect((yield* guard.snapshot(focused.id))?.budget).toEqual({
        usd: ResearchRun.LIMITS.focused.usd,
        steps: ResearchRun.LIMITS.focused.steps,
      })

      const deep = yield* sessions.create({ title: "Deep", permission: allow })
      yield* test.llm.text("Planning.")
      yield* send({
        sessionID: deep.id,
        agent: "research",
        text: "Research how much heat pumps save.",
        size: "thorough",
      })
      expect((yield* guard.snapshot(deep.id))?.budget).toEqual({
        usd: ResearchRun.LIMITS.deep.usd,
        steps: ResearchRun.LIMITS.deep.steps,
      })

      // The user's own cap stands, higher or lower than research's.
      const capped = yield* sessions.create({ title: "Capped", permission: allow })
      yield* test.llm.text("Planning.")
      yield* prompt.prompt({
        sessionID: capped.id,
        agent: "research",
        model: ref,
        budget: { usd: 5 },
        parts: [{ type: "text", text: "Research how much heat pumps save." }],
      })
      expect((yield* guard.snapshot(capped.id))?.budget).toEqual({ usd: 5 })

      // The build agent gets none of research's.
      const build = yield* sessions.create({ title: "Build", permission: allow })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Rename the helper in utils." })
      expect((yield* guard.snapshot(build.id))?.budget).toEqual({})
    }),
  90_000,
)

// A test of the user's run budget in config: the user's config is read once, when the repository's instance first
// loads its config, so each test sets one.
const configured = Effect.fn("test.configured")(function* (run: Record<string, number>) {
  const test = yield* setup()
  const fs = yield* FSUtil.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const spend = yield* SpendGuard.Service
  // The user's own run limits: a repository's config cannot set them.
  yield* fs.writeWithDirs(path.join(Global.Path.config, "vector.json"), JSON.stringify({ budget: { run } }))
  yield* config.invalidate()
  const session = yield* sessions.create({ title: "Research", permission: allow })
  yield* test.llm.text("Planning.")
  yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
  return (yield* spend.snapshot(session.id))?.budget
})

it.instance(
  "a run's own cap in config stands for research too",
  () =>
    Effect.gen(function* () {
      expect(yield* configured({ steps: 30 })).toEqual({ steps: 30 })
    }),
  60_000,
)

it.instance(
  "a run budget in config that caps neither spend nor steps keeps research's caps beside it",
  () =>
    Effect.gen(function* () {
      // When to warn is not a cap: research's caps apply, and the user's warning share with them.
      expect(yield* configured({ warnAt: 0.5 })).toEqual({
        warnAt: 0.5,
        usd: ResearchRun.LIMITS.focused.usd,
        steps: ResearchRun.LIMITS.focused.steps,
      })
    }),
  60_000,
)

it.instance(
  "a cap sent while a run goes stays when the request is raised to Deep, and a guest's limit holds Deep's caps too",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const spend = yield* SpendGuard.Service
      // A research run on research's own caps, joined by a "be thorough" that brings a budget along.
      const joined = Effect.fn("test.joined")(function* (budget: { usd: number }, guest: boolean) {
        const session = yield* sessions.create({ title: "Research", permission: allow })
        const release = Promise.withResolvers<void>()
        yield* test.llm.push(reply().wait(release.promise).text("Thinking."))
        yield* test.llm.text("Researching deeper.")
        const before = (yield* test.llm.hits).length
        const running = yield* prompt
          .prompt({
            sessionID: session.id,
            agent: "research",
            model: ref,
            parts: [{ type: "text", text: "Research how much heat pumps save." }],
          })
          .pipe(Effect.forkScoped)
        while ((yield* test.llm.hits).length <= before) yield* Effect.sleep(10)
        expect((yield* spend.snapshot(session.id))?.budget).toEqual({
          usd: ResearchRun.LIMITS.focused.usd,
          steps: ResearchRun.LIMITS.focused.steps,
        })
        const steer = yield* prompt
          .prompt(
            {
              sessionID: session.id,
              agent: "research",
              model: ref,
              budget,
              parts: [{ type: "text", text: "be thorough" }],
            },
            guest ? { tightenBudget: true, refuseTrainingFreeModels: true, dropResearchOptions: true } : undefined,
          )
          .pipe(Effect.forkScoped)
        // The budget is armed before the message is saved.
        while (
          (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "user")
            .length < 2
        )
          yield* Effect.sleep(10)
        release.resolve()
        yield* Fiber.join(running)
        yield* Fiber.join(steer)
        // The steer raised the request to Thorough.
        expect(assistants(yield* sessions.messages({ sessionID: session.id })).map((info) => info.size)).toContain(
          "thorough",
        )
        expect(yield* test.llm.pending).toBe(0)
        expect(yield* test.llm.misses).toEqual([])
        return (yield* spend.snapshot(session.id))?.budget
      })
      // The owner's own cap replaces research's and stays through the raise.
      expect(yield* joined({ usd: 0.5 }, false)).toEqual({ usd: 0.5 })
      // A guest's limit only tightens: research's caps move to Deep's, and the guest's $2 still holds them.
      expect(yield* joined({ usd: 2 }, true)).toEqual({ usd: 2, steps: ResearchRun.LIMITS.deep.steps })
    }),
  90_000,
)

it.instance(
  "once the page budget is used the run ends with a report from what it read",
  () =>
    Effect.gen(function* () {
      const test = yield* setup({ research: { limits: { focused: { pages: 1 } } } })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: web.url("article", "/") })
      yield* test.llm.tool("research_read", { url: web.url("nav", "/") })
      yield* test.llm.tool("research_report", {
        title: "Heat pump savings",
        answer: "One field study was read before the page budget ran out.",
        sections: [],
        open_questions: ["What do other studies find?"],
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: `Research how much heat pumps save: ${web.url("article", "/")} and ${web.url("nav", "/")}`,
      })
      const [, second] = yield* calls(session.id, "research_read")
      expect(output(second)).toContain(ResearchStore.PAGES)
      expect(web.count("nav")).toBe(0)
      const [report] = yield* calls(session.id, "research_report")
      expect(report?.state.status === "completed" ? report.state.metadata.version : undefined).toBe(1)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "a repository's config cannot choose where research searches",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const fs = yield* FSUtil.Service
      const config = yield* Config.Service
      // The cloned repository names a SearXNG server of its author's, and is trusted: research searches in its own
      // research browsers all the same, and the server gets nothing.
      yield* fs.writeWithDirs(path.join(Global.Path.config, "vector.json"), JSON.stringify({}))
      yield* fs.writeWithDirs(
        path.join(test.dir, "vector.json"),
        JSON.stringify(
          repositoryConfig(test.llm.url, {
            research: { search: { provider: "searxng", url: web.url("searxng", "/") } },
          }),
        ),
      )
      const snapshot = yield* Effect.promise(() =>
        WorkspaceTrust.snapshot(test.dir, [path.join(test.dir, "vector.json")]),
      )
      yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
      yield* config.invalidate()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump field study savings" })
      yield* test.llm.text("Done.")
      const searched = FakeBridge.searches(bridge).length
      yield* FakeBridge.within(
        bridge,
        send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." }),
      )
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toContain("results from Google")
      expect(FakeBridge.searches(bridge).length - searched).toBe(1)
      expect(web.count("searxng")).toBe(0)
    }),
  60_000,
)

it.instance(
  "the research lead recalls how the owner works and no fact about them",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      const own = (kind: "preference" | "fact" | "decision", text: string) =>
        brain.propose(place, { kind, text, scope: "personal", origin: "user", evidence: { type: "user" } })
      yield* own("preference", "For heat pump research prefer field studies over vendor claims")
      yield* own("fact", "My heat pump at the Lisbon flat cost 9400 euros from Hooli Heating")
      yield* own("decision", "We price heat pump research against field studies, never vendor brochures")
      // Learned beside a private document: private whatever its kind.
      yield* brain.propose(place, {
        kind: "preference",
        text: "For heat pump research use the Globex heat pump tender figures first",
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
        private: true,
      })
      const sessions = yield* Session.Service
      const research = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.text("Planning.")
      const [asked] = yield* send({
        sessionID: research.id,
        agent: "research",
        text: "Research heat pump savings and what a heat pump costs.",
      })
      expect(asked).toContain("prefer field studies over vendor claims")
      expect(asked).toContain("never vendor brochures")
      expect(asked).not.toContain("9400 euros")
      expect(asked).not.toContain("Globex heat pump tender")
      // The build agent recalls both, as it always has.
      const build = yield* sessions.create({ title: "Build", permission: allow })
      yield* test.llm.text("Done.")
      const [built] = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Research heat pump savings and what a heat pump costs.",
      })
      expect(built).toContain("prefer field studies over vendor claims")
      expect(built).toContain("9400 euros")
      expect(built).toContain("Globex heat pump tender")
    }),
  60_000,
)

it.instance(
  "once Run Guard warns the lead starts no new researcher",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const spend = yield* SpendGuard.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      // The fake model server is on this computer, so its steps cost nothing: a priced step recorded while the first
      // step's answer is held stands in for spend that reaches Run Guard's warning (80% of the cap).
      const release = Promise.withResolvers<void>()
      yield* test.llm.push(reply().wait(release.promise).tool("research_plan", plan()))
      yield* test.llm.text("Done.")
      const before = (yield* test.llm.hits).length
      const running = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "research",
          model: ref,
          budget: { usd: 1 },
          parts: [{ type: "text", text: "Research how much heat pumps save." }],
        })
        .pipe(Effect.forkScoped)
      while (
        !(yield* test.llm.hits).slice(before).some((hit) => names(JSON.stringify(hit.body)).includes("research_plan"))
      )
        yield* Effect.sleep(10)
      yield* spend.record(session.id, {
        costKind: "priced",
        costUsd: 0.85,
        contextTokens: 0,
        cachedTokens: 0,
        continues: true,
        tools: [],
        patched: false,
      })
      release.resolve()
      yield* Fiber.join(running)
      const bodies = (yield* test.llm.hits)
        .slice(before)
        .map((hit) => JSON.stringify(hit.body))
        .filter((body) => names(body).includes("research_plan"))
      expect(names(bodies[0]!)).toContain("task")
      expect(names(bodies.at(-1)!)).not.toContain("task")
      expect(names(bodies.at(-1)!)).toContain("research_read")
    }),
  60_000,
)

it.instance(
  "once Run Guard warns, a research lead the build agent started starts no new researcher either",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const spend = yield* SpendGuard.Service
      const build = yield* sessions.create({ title: "Build", permission: allow })
      const child = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("Plan the run with research_plan") && !researcher(hit)
      const release = Promise.withResolvers<void>()
      yield* test.llm.tool("research", {
        question: "How much do heat pumps save in cold climates?",
        background: false,
      })
      yield* test.llm.toolMatch(child, "research_plan", plan())
      // The lead's next step is held while the build run's spend reaches Run Guard's warning (80% of its cap).
      yield* test.llm.pushMatch(
        child,
        reply().wait(release.promise).tool("task", {
          description: "Field studies",
          prompt: "What did field studies measure?",
          subagent_type: "researcher",
          background: false,
        }),
      )
      yield* test.llm.textMatch(child, "Researched it alone.")
      yield* test.llm.text("Done.")
      const running = yield* prompt
        .prompt({
          sessionID: build.id,
          agent: "build",
          model: ref,
          budget: { usd: 1 },
          parts: [{ type: "text", text: "Find out how much heat pumps save before we price them." }],
        })
        .pipe(Effect.forkScoped)
      while ((yield* calls((yield* sessions.children(build.id))[0]?.id ?? build.id, "research_plan")).length === 0)
        yield* Effect.sleep(10)
      yield* spend.record(build.id, {
        costKind: "priced",
        costUsd: 0.85,
        contextTokens: 0,
        cachedTokens: 0,
        continues: true,
        tools: [],
        patched: false,
      })
      expect((yield* spend.snapshot(build.id))?.warned).toBe(true)
      release.resolve()
      yield* Fiber.join(running)
      const [lead] = yield* sessions.children(build.id)
      const [task] = yield* calls(lead!.id, "task")
      expect(task?.state.status).toBe("error")
      expect(output(task)).toContain(ResearchRun.WARNED)
      expect(yield* sessions.children(lead!.id)).toEqual([])
    }),
  90_000,
)

it.instance(
  "a compaction of a research session keeps the run, where its sub-questions stand and its notes",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: web.url("article", "/") })
      yield* test.llm.tool("research_plan", { ...plan(), status: ["answered", "open"] })
      yield* test.llm.text("Read one study so far.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pumps: ${web.url("article", "/")}` })
      const [planned] = yield* calls(session.id, "research_plan")
      const runID = planned?.state.status === "completed" ? planned.state.metadata[ResearchRun.RUN] : undefined
      yield* compaction.create({ sessionID: session.id, agent: "research", model: ref, auto: false })
      yield* test.llm.text("## Goal\n- Research heat pumps")
      const before = (yield* test.llm.hits).length
      yield* prompt.loop({ sessionID: session.id })
      const summary = (yield* test.llm.hits).slice(before).map((hit) => JSON.stringify(hit.body))[0] ?? ""
      expect(summary).toContain("<research_run>")
      expect(summary).toContain(`Deep research run ${runID}`)
      expect(summary).toContain("1. [answered] What did field studies measure?")
      expect(summary).toContain("2. [open] How large were the savings?")
      // A source by its site alone: its title is the page's to write.
      expect(summary).toContain("Sources: S1 web.test.")
      expect(summary).not.toContain("Sources: S1 How heat pumps")
    }),
  90_000,
)

test("only a plan the user started deep on the root card raises a request", () => {
  {
    const user = (id: string, text: string): SessionV1.WithParts => ({
      info: {
        id,
        sessionID: "ses_size",
        role: "user",
        time: { created: 1 },
        agent: "research",
        model: { providerID: ref.providerID, modelID: ref.modelID },
      } as SessionV1.User,
      parts: [{ id: `${id}_p`, sessionID: "ses_size", messageID: id, type: "text", text } as SessionV1.TextPart],
    })
    const planned = (id: string, metadata: Record<string, unknown>): SessionV1.WithParts => ({
      info: {
        id,
        sessionID: "ses_size",
        role: "assistant",
        parentID: "msg_1",
        mode: "research",
        agent: "research",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 2 },
        finish: "tool-calls",
      } as SessionV1.Assistant,
      parts: [
        {
          id: `${id}_t`,
          sessionID: "ses_size",
          messageID: id,
          type: "tool",
          tool: "research_plan",
          callID: `${id}_c`,
          state: { status: "completed", input: {}, output: "", title: "", metadata, time: { start: 2, end: 3 } },
        } as SessionV1.ToolPart,
      ],
    })
    const tier = (metadata: Record<string, unknown>) =>
      SessionTaskSize.size({
        messages: [user("msg_1", "Research how much heat pumps save."), planned("msg_2", metadata)],
        caching: false,
        lifetime: 0,
      }).at(-1)?.tier
    expect(tier({ approved: true, answer: "start-deep", from: "standard", to: "thorough", source: "user" })).toBe(
      "thorough",
    )
    // A plan approved on its own records no source, and one that claims a raise without the user's does nothing.
    expect(tier({ approved: true, answer: "automatic", to: "thorough" })).toBe("standard")
    expect(tier({ approved: true, answer: "start" })).toBe("standard")
  }
})
