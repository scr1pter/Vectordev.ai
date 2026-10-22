import { afterAll, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Instruction } from "../../src/session/instruction"
import { Session } from "@/session/session"
import { SessionMemory } from "../../src/session/memory"
import { MessageID } from "../../src/session/schema"
import { ResearchRun } from "../../src/tool/research-run"
import { SubagentLifecycle } from "../../src/tool/subagent-lifecycle"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The build agent's research tool (on Work and Thorough requests, besides the Deep research mode): its question passes
// the outbound check before the research lead starts, the lead runs with the research agents' permissions and holds,
// research's default caps apply when the user has none, and the lead stays at the request's size, so its plan cannot
// raise a Work request to deep. The tool is offered to build alone, and not when the user turned it off.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const { it, cleanup } = runtime(web)
afterAll(async () => {
  await web.close()
  cleanup()
})

const NOTES = "The Falcon migration moves the ledger to the reconcileLedgerEntries service before the March freeze."
const HABIT = "Prefer migration guides that show a rollback plan"
const FACT = "My badge number at Hooli is 44172 and my manager is Dana Whitfield"
const lead = (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes("Plan the run with research_plan")
const names = (body: string) =>
  ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((tool) => tool.function?.name)

it.instance(
  "a Work request researches through the lead, at Focused, under research's caps, and is held as web",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      for (const [kind, text] of [
        ["preference", HABIT],
        ["fact", FACT],
      ] as const)
        yield* brain.propose(place, { kind, text, scope: "personal", origin: "user", evidence: { type: "user" } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* llm.tool("read", { filePath: path.join(dir, "notes", "plan.md") })
      // A question that copies what build read is refused before any lead starts.
      yield* llm.tool("research", { question: `How risky is this? ${NOTES}`, background: false })
      yield* llm.tool("research", {
        question: "How do teams migrate a ledger service without downtime?",
        depth: "deep",
        background: false,
      })
      // The lead plans deep; its launcher is a Work request, so the run is Focused.
      yield* llm.toolMatch(
        lead,
        "research_plan",
        plan({ question: "How do teams migrate a ledger service without downtime?", depth: "deep" }),
      )
      yield* llm.textMatch(lead, "Teams run both ledgers side by side, then switch reads.")
      yield* llm.text("Done.")
      const bodies = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Plan the ledger migration and look up how others do it.",
        size: "standard",
      })
      expect(names(bodies[0]!)).toContain("research")
      expect(names(bodies[0]!)).not.toContain("research_plan")

      const [refused, started] = yield* calls(build.id, "research")
      expect(refused?.state.status).toBe("error")
      expect(output(refused)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect(started?.state.status).toBe("completed")
      expect(output(started)).toContain("Teams run both ledgers side by side")
      expect(started?.state.status === "completed" ? started.state.metadata[SessionMemory.HOLD] : undefined).toBe("web")

      const children = yield* sessions.children(build.id)
      expect(children).toHaveLength(1)
      const record = SubagentLifecycle.read(children[0]!)
      expect(record?.agent).toBe("research")
      expect(record?.budget).toEqual({ usd: ResearchRun.LIMITS.focused.usd, steps: ResearchRun.LIMITS.focused.steps })
      const [planned] = yield* calls(children[0]!.id, "research_plan")
      const metadata = planned?.state.status === "completed" ? planned.state.metadata : {}
      expect(metadata.answer).toBe("automatic")
      expect(metadata.plan.depth).toBe("focused")
      expect(metadata.to).toBeUndefined()
      // The lead got the question alone, never the file build read.
      const leadBodies = bodies.filter((body) => body.includes("Plan the run with research_plan"))
      expect(leadBodies.length).toBeGreaterThan(0)
      // Of the owner's memory it hears how they work, screened, and nothing about them: no fact, no MEMORY.md.
      expect(leadBodies[0]).toContain(HABIT)
      expect(leadBodies[0]).toContain("Never force-push to main")
      for (const body of leadBodies) {
        expect(body).not.toContain("reconcileLedgerEntries")
        expect(body).not.toContain("badge number")
        expect(body).not.toContain("Hooli")
      }
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "research as a tool is not offered when the user turned it off",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web, { research: { tool: "off", search: { provider: "none" } } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* llm.text("Done.")
      const [body] = yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Plan the ledger migration.",
        size: "standard",
      })
      expect(names(body!)).not.toContain("research")
    }),
  60_000,
)

it.instance(
  "what build ran with a shell, or heard from an explore subagent, stays out of its research requests",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const explorer = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")

      const shell = yield* sessions.create({ title: "Build" })
      yield* llm.tool("bash", { command: "cat notes/plan.md", description: "Read the plan" })
      yield* llm.tool("research", { question: `How risky is this? ${NOTES}`, background: false })
      yield* llm.text("Done.")
      yield* send({ sessionID: shell.id, agent: "build", text: "Plan the ledger migration.", size: "standard" })
      const [bash] = yield* calls(shell.id, "bash")
      expect(output(bash)).toContain("reconcileLedgerEntries")
      const [fromShell] = yield* calls(shell.id, "research")
      expect(fromShell?.state.status).toBe("error")
      expect(output(fromShell)).toContain(ResearchRun.REQUEST_REFUSAL)

      const reported = yield* sessions.create({ title: "Build" })
      yield* llm.tool("task", {
        description: "Read the plan",
        prompt: "Read notes/plan.md and report its first sentence.",
        subagent_type: "explore",
        success_criteria: ["Quote the plan's first sentence"],
        background: false,
      })
      yield* llm.textMatch(explorer, `The plan says: ${NOTES}`)
      yield* llm.tool("research", { question: `How do teams do this? ${NOTES}`, background: false })
      yield* llm.text("Done.")
      // Subagents run on Thorough requests.
      yield* send({ sessionID: reported.id, agent: "build", text: "Plan the ledger migration.", size: "thorough" })
      const [task] = yield* calls(reported.id, "task")
      expect(output(task)).toContain("reconcileLedgerEntries")
      const [fromReport] = yield* calls(reported.id, "research")
      expect(fromReport?.state.status).toBe("error")
      expect(output(fromReport)).toContain(ResearchRun.REQUEST_REFUSAL)

      // No research lead started for either.
      const children = [...(yield* sessions.children(shell.id)), ...(yield* sessions.children(reported.id))]
      expect(children.map((child) => SubagentLifecycle.read(child)?.agent)).toEqual(["explore"])
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a file build read before a compaction still counts against its research request",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* llm.tool("read", { filePath: path.join(dir, "notes", "plan.md") })
      yield* llm.text("Read it.")
      yield* send({ sessionID: build.id, agent: "build", text: "Read the ledger plan.", size: "standard" })
      const research = yield* ResearchRun.Service
      // What a step after a compaction gets: none of the messages before the summary.
      const brief = (prompt: string) =>
        research
          .brief({
            agent: ResearchRun.LEAD,
            ctx: {
              sessionID: build.id,
              messageID: MessageID.make("msg_after_compaction"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
            prompt,
            extra: [],
          })
          .pipe(Effect.scoped)
      const refused = yield* brief(`How risky is this? ${NOTES}`)
      expect(refused.type).toBe("refused")
      expect(refused.type === "refused" ? refused.message : "").toContain(ResearchRun.REQUEST_REFUSAL)
      expect((yield* brief("How do teams migrate a ledger service without downtime?")).type).toBe("ok")
    }),
  90_000,
)

it.instance(
  "a budget the model writes for a research lead only lowers research's default caps",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const lead = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("How do heat pumps age")
      yield* llm.tool("task", {
        description: "Research ageing",
        prompt: "How do heat pumps age in cold climates?",
        subagent_type: "research",
        budget: { usd: 100, steps: 5_000 },
        background: false,
      })
      yield* llm.textMatch(lead, "They lose a little efficiency each year.")
      yield* llm.tool("task", {
        description: "Research costs",
        prompt: "What do heat pumps cost to run in cold climates?",
        subagent_type: "research",
        budget: { usd: 0.5 },
        background: false,
      })
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("What do heat pumps cost to run"),
        "About the same as gas.",
      )
      yield* llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Research heat pumps, thoroughly.", size: "thorough" })
      const budgets = (yield* sessions.children(build.id))
        .map((child) => SubagentLifecycle.read(child))
        .toSorted((left, right) => (left?.startedAt ?? 0) - (right?.startedAt ?? 0))
        .map((record) => record?.budget)
      expect(budgets).toEqual([
        { usd: ResearchRun.LIMITS.deep.usd, steps: ResearchRun.LIMITS.deep.steps },
        { usd: 0.5, steps: ResearchRun.LIMITS.deep.steps },
      ])
    }),
  120_000,
)

it.instance(
  "the user's task rules apply to research started through the tool",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web, { permission: { task: { research: "deny" } } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* llm.tool("research", { question: "How do heat pumps perform in cold climates?", background: false })
      yield* llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Look up heat pumps.", size: "standard" })
      const [research] = yield* calls(build.id, "research")
      expect(research?.state.status).toBe("error")
      expect(yield* sessions.children(build.id)).toEqual([])
    }),
  60_000,
)

it.instance(
  "a research lead cannot take another task's report with its brief",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const explorer = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      yield* llm.tool("task", {
        description: "Read the plan",
        prompt: "Read notes/plan.md and report its first sentence.",
        subagent_type: "explore",
        success_criteria: ["Quote the plan's first sentence"],
        background: false,
      })
      yield* llm.textMatch(explorer, `The plan says: ${NOTES}`)
      yield* llm.text("Read it.")
      yield* send({ sessionID: build.id, agent: "build", text: "Read the ledger plan.", size: "thorough" })
      const [explore] = yield* sessions.children(build.id)
      // The report would reach the lead with a brief that says nothing private.
      yield* llm.tool("task", {
        description: "Research it",
        prompt: "How do teams migrate a ledger service without downtime?",
        subagent_type: "research",
        depends_on: [explore!.id],
        background: false,
      })
      yield* llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Now look up how others do it.", size: "thorough" })
      const [, research] = yield* calls(build.id, "task")
      expect(research?.state.status).toBe("error")
      expect(output(research)).toContain("cannot depend on another task")
      expect(yield* sessions.children(build.id)).toHaveLength(1)
    }),
  120_000,
)
