import { afterAll, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Instruction } from "../../src/session/instruction"
import { Session } from "@/session/session"
import { SessionMemory } from "../../src/session/memory"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ResearchRun } from "../../src/tool/research-run"
import { SubagentLifecycle } from "../../src/tool/subagent-lifecycle"
import { calls, output, plan, ref, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The build agent's research tool (on Work and Thorough requests, besides the Deep research mode): its question passes
// the outbound check before the research lead starts, the lead runs with the research agents' permissions and holds,
// research's default caps apply when the user has none, and the lead stays at the request's size, so its plan cannot
// raise a Work request to deep. The tool is offered to build alone, and not when the user turned it off. Everything in
// build's session tree counts against what it hands research: a page it fetched from the user's own network, and what
// a subagent took in, and the same check covers a message build sends a running research agent.

const guard = NetworkGuard.use()
const INTRANET = "Our Falcon merger with Initech closes on 4417203 at the reconcileLedgerEntries desk."
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    intranet: {
      "/": () =>
        new Response(`<html><body><p>${INTRANET}</p></body></html>`, { headers: { "content-type": "text/html" } }),
    },
  },
})
const it = runtime(web)
afterAll(() => web.close())

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
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
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
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      // A question that copies what build read is refused before any lead starts.
      yield* test.llm.tool("research", { question: `How risky is this? ${NOTES}`, background: false })
      yield* test.llm.tool("research", {
        question: "How do teams migrate a ledger service without downtime?",
        depth: "deep",
        background: false,
      })
      // The lead plans deep; its launcher is a Work request, so the run is Focused.
      yield* test.llm.toolMatch(
        lead,
        "research_plan",
        plan({ question: "How do teams migrate a ledger service without downtime?", depth: "deep" }),
      )
      yield* test.llm.textMatch(lead, "Teams run both ledgers side by side, then switch reads.")
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web, { research: { tool: "off", search: { provider: "none" } } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const explorer = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")

      const shell = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("bash", { command: "cat notes/plan.md", description: "Read the plan" })
      yield* test.llm.tool("research", { question: `How risky is this? ${NOTES}`, background: false })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: shell.id, agent: "build", text: "Plan the ledger migration.", size: "standard" })
      const [bash] = yield* calls(shell.id, "bash")
      expect(output(bash)).toContain("reconcileLedgerEntries")
      const [fromShell] = yield* calls(shell.id, "research")
      expect(fromShell?.state.status).toBe("error")
      expect(output(fromShell)).toContain(ResearchRun.REQUEST_REFUSAL)

      const reported = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("task", {
        description: "Read the plan",
        prompt: "Read notes/plan.md and report its first sentence.",
        subagent_type: "explore",
        success_criteria: ["Quote the plan's first sentence"],
        background: false,
      })
      yield* test.llm.textMatch(explorer, `The plan says: ${NOTES}`)
      yield* test.llm.tool("research", { question: `How do teams do this? ${NOTES}`, background: false })
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.text("Read it.")
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
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const lead = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("How do heat pumps age")
      yield* test.llm.tool("task", {
        description: "Research ageing",
        prompt: "How do heat pumps age in cold climates?",
        subagent_type: "research",
        budget: { usd: 100, steps: 5_000 },
        background: false,
      })
      yield* test.llm.textMatch(lead, "They lose a little efficiency each year.")
      yield* test.llm.tool("task", {
        description: "Research costs",
        prompt: "What do heat pumps cost to run in cold climates?",
        subagent_type: "research",
        budget: { usd: 0.5 },
        background: false,
      })
      yield* test.llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("What do heat pumps cost to run"),
        "About the same as gas.",
      )
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web, { permission: { task: { research: "deny" } } })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* test.llm.tool("research", { question: "How do heat pumps perform in cold climates?", background: false })
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const explorer = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      yield* test.llm.tool("task", {
        description: "Read the plan",
        prompt: "Read notes/plan.md and report its first sentence.",
        subagent_type: "explore",
        success_criteria: ["Quote the plan's first sentence"],
        background: false,
      })
      yield* test.llm.textMatch(explorer, `The plan says: ${NOTES}`)
      yield* test.llm.text("Read it.")
      yield* send({ sessionID: build.id, agent: "build", text: "Read the ledger plan.", size: "thorough" })
      const [explore] = yield* sessions.children(build.id)
      // The report would reach the lead with a brief that says nothing private.
      yield* test.llm.tool("task", {
        description: "Research it",
        prompt: "How do teams migrate a ledger service without downtime?",
        subagent_type: "research",
        depends_on: [explore!.id],
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Now look up how others do it.", size: "thorough" })
      const [, research] = yield* calls(build.id, "task")
      expect(research?.state.status).toBe("error")
      expect(output(research)).toContain("cannot depend on another task")
      expect(yield* sessions.children(build.id)).toHaveLength(1)
    }),
  120_000,
)

it.instance(
  "a page build fetched from the user's own network counts against its research request",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({
        title: "Build",
        permission: [
          { permission: "webfetch", pattern: "*", action: "allow" },
          { permission: "private_network", pattern: "*", action: "allow" },
        ],
      })
      yield* test.llm.tool("webfetch", { url: web.direct("intranet", "/"), format: "text" })
      yield* test.llm.tool("research", {
        question: "How do mergers like Falcon with Initech close, and what is reconcileLedgerEntries 4417203?",
        background: false,
      })
      yield* test.llm.tool("research", {
        question: "How do mergers like Falcon with Initech close?",
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Look at our intranet page and research it.",
        size: "standard",
      })
      const [fetched] = yield* calls(build.id, "webfetch")
      expect(output(fetched)).toContain("Initech")
      expect(fetched?.state.status === "completed" ? fetched.state.metadata.private : undefined).toBe(true)
      // The names alone are refused too: the page is the user's, not public text.
      for (const research of yield* calls(build.id, "research")) {
        expect(research.state.status).toBe("error")
        expect(output(research)).toContain(ResearchRun.REQUEST_REFUSAL)
      }
      expect(yield* sessions.children(build.id)).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "a private fact a subagent was briefed with and reported counts against build's research request, names included",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      yield* brain.propose(place, {
        kind: "fact",
        text: FACT,
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      const general = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("orchestration_assignment")
      // A Thorough request's subagent starts with a brief recalled with its task as the query: here, the fact.
      yield* test.llm.tool("task", {
        description: "Find the manager",
        prompt: "Find which manager signs off badge numbers and report the name.",
        subagent_type: "general",
        success_criteria: ["Name the manager"],
        background: false,
      })
      yield* test.llm.textMatch(general, "The manager is Dana Whitfield.")
      yield* test.llm.tool("research", {
        question: "How do engineering managers like Dana Whitfield run payments teams?",
        background: false,
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Look into how our team is run.", size: "thorough" })
      const [task] = yield* calls(build.id, "task")
      expect(output(task)).toContain("Dana Whitfield")
      const [research] = yield* calls(build.id, "research")
      expect(research?.state.status).toBe("error")
      expect(output(research)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect((yield* sessions.children(build.id)).map((child) => SubagentLifecycle.read(child)?.agent)).toEqual([
        "general",
      ])
    }),
  120_000,
)

it.instance(
  "build's message to a running research lead passes the check its request did, and a researcher hears from its lead alone",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      // A research lead build started, and a researcher that lead started, both still running.
      const delegated = (parentID: SessionID, agent: string) =>
        sessions.create({
          parentID,
          title: agent,
          metadata: {
            subagent: {
              kind: "subagent",
              custom: false,
              agent,
              title: agent,
              parentSessionID: parentID,
              parentMessageID: MessageID.ascending(),
              model: { providerID: ref.providerID, modelID: ref.modelID },
              background: true,
              status: "running",
              startedAt: Date.now(),
              runtimeID: SubagentLifecycle.RUNTIME_ID,
              attempt: 1,
            },
          },
        })
      const leader = yield* delegated(build.id, "research")
      const worker = yield* delegated(leader.id, "researcher")
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.tool("task_manage", {
        action: "message",
        task_id: leader.id,
        text: `Also look at this: ${NOTES}`,
      })
      yield* test.llm.tool("task_manage", {
        action: "message",
        task_id: worker.id,
        text: "Search for ledger migrations without downtime.",
      })
      yield* test.llm.tool("task_manage", {
        action: "message",
        task_id: leader.id,
        text: "Also look at ledger migrations without downtime.",
      })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: build.id, agent: "build", text: "Plan the ledger migration.", size: "thorough" })
      const [copied, toWorker, fair] = yield* calls(build.id, "task_manage")
      expect(copied?.state.status).toBe("error")
      expect(output(copied)).toContain(ResearchRun.REQUEST_REFUSAL)
      expect(toWorker?.state.status).toBe("error")
      expect(output(toWorker)).toContain(ResearchRun.LEAD_ONLY)
      // A message in public terms passes the check and goes on to the task, which here has no run to join.
      expect(output(fair)).not.toContain(ResearchRun.REQUEST_REFUSAL)
      expect(output(fair)).toContain("finished")
      // Nothing reached either mailbox.
      expect(SubagentLifecycle.read(yield* sessions.get(leader.id))?.mailbox ?? []).toEqual([])
      expect(SubagentLifecycle.read(yield* sessions.get(worker.id))?.mailbox ?? []).toEqual([])
    }),
  90_000,
)
