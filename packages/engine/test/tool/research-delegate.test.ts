import { afterAll, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { SessionMemory } from "../../src/session/memory"
import { ResearchRun } from "../../src/tool/research-run"
import { SubagentLifecycle } from "../../src/tool/subagent-lifecycle"
import { TestLLMServer } from "../lib/llm-server"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The research lead hands sub-questions to researchers (sections 5.3, 5.6a and 6.4a). A researcher's request carries
// its sub-question, the run's public preferences, and of the owner's memory only screened preferences and the rules
// file: no fact, no MEMORY.md, no decision, nothing private. The lead's brief passes the outbound check against the
// run's private context before the researcher starts, what a researcher returns is capped, and the lead's task call
// records that its researcher read the web.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const { it, cleanup } = runtime(web)
afterAll(async () => {
  await web.close()
  cleanup()
})

const HABIT = "Run the payments tests with bun test before every commit"
const DECISION = "Review migrations before handlers in every pull request"
const PARTICULAR = "Drop the Initech integration from billing.initech.com next quarter"
const FACT = "My badge number at Hooli is 44172 and my manager is Dana Whitfield"
const PRIVATE = "Follow the Globex style guide for payments code"
const NOTES = "The Falcon migration moves the ledger to the reconcileLedgerEntries service before the March freeze."
const SUBQUESTION = "How do other teams run payments tests in continuous integration?"

const allow = [{ permission: "research_read", pattern: "*", action: "allow" as const }]
const researcher = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("research_assignment")

const remember = Effect.fn("test.remember")(function* () {
  const brain = yield* Brain.Service
  const place = yield* (yield* Instruction.Service).place()
  const own = (kind: "preference" | "decision" | "fact", text: string, extra: Partial<Brain.Proposal> = {}) =>
    brain.propose(place, { kind, text, scope: "personal", origin: "user", evidence: { type: "user" }, ...extra })
  yield* own("preference", HABIT)
  yield* own("decision", DECISION)
  yield* own("decision", PARTICULAR)
  yield* own("fact", FACT)
  yield* own("preference", PRIVATE, { private: true })
})

it.instance(
  "a researcher's request carries its sub-question and only the how-you-work lines it may hear, and returns capped",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      yield* remember()
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", { ...plan({ depth: "deep" }), prefer_domains: ["nature.com"] })
      yield* llm.tool("task", {
        description: "CI practice",
        prompt: SUBQUESTION,
        subagent_type: "researcher",
        background: false,
      })
      // The researcher answers at length; the lead gets 1,500 characters of it.
      yield* llm.textMatch(
        researcher,
        `Teams run them on every pull request. ${"More detail follows here. ".repeat(120)}`,
      )
      yield* llm.text("Done.")
      const bodies = yield* send({
        sessionID: lead.id,
        agent: "research",
        text: "Research how teams test payments code.",
      })

      const asked = (yield* (yield* TestLLMServer).hits)
        .map((hit) => JSON.stringify(hit.body))
        .filter((body) => body.includes("research_assignment"))
      expect(asked.length).toBeGreaterThan(0)
      const body = asked[0]!
      expect(body).toContain(`Your sub-question: ${SUBQUESTION}`)
      expect(body).toContain("Prefer sources on: nature.com")
      // How the owner works, screened, and the rules file; nothing about the owner.
      expect(body).toContain(HABIT)
      expect(body).toContain("Never force-push to main")
      expect(body).not.toContain("badge number")
      expect(body).not.toContain("Whitfield")
      expect(body).not.toContain("Hooli")
      expect(body).not.toContain("Globex")
      expect(body).not.toContain("Initech")
      expect(body).not.toContain(DECISION)
      // The researcher was offered its own tools and nothing else.
      const tools = (JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools?.map(
        (tool) => tool.function?.name,
      )
      expect(tools?.toSorted()).toEqual(["research_note", "research_read", "research_search"])
      // The lead's task list names its researchers and not the judge, which Vector launches itself.
      expect(bodies.some((item) => item.includes("- researcher:"))).toBe(true)
      expect(bodies.some((item) => item.includes("- research-judge:"))).toBe(false)

      const [task] = yield* calls(lead.id, "task")
      expect(task?.state.status).toBe("completed")
      const report = output(task).match(/<task_result>\n([\s\S]*?)\n<\/task_result>/)?.[1] ?? ""
      expect(report.length).toBeLessThanOrEqual(ResearchRun.RETURN_CHARS)
      expect(report.startsWith("Teams run them on every pull request.")).toBe(true)
      // The researcher read the web by design, and its hold passed up to the lead's task call.
      expect(task?.state.status === "completed" ? task.state.metadata[SessionMemory.HOLD] : undefined).toBe("web")
      const [child] = yield* sessions.children(lead.id)
      expect(SubagentLifecycle.read(child!)?.agent).toBe("researcher")
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a brief that carries a line of a file the lead read is refused before any researcher starts",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.tool("read", { filePath: path.join(dir, "notes", "plan.md") })
      yield* llm.tool("task", {
        description: "Ledger move",
        prompt: `Find out how hard this is: ${NOTES}`,
        subagent_type: "researcher",
        background: false,
      })
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research how hard a ledger migration is." })
      const [task] = yield* calls(lead.id, "task")
      expect(task?.state.status).toBe("error")
      expect(output(task)).toContain(ResearchRun.BRIEF_REFUSAL)
      expect(yield* sessions.children(lead.id)).toEqual([])
    }),
  90_000,
)

it.instance(
  "only the research lead launches researchers, and only Vector launches the research judge",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const build = yield* sessions.create({ title: "Build" })
      yield* llm.tool("task", {
        description: "Look it up",
        prompt: SUBQUESTION,
        subagent_type: "researcher",
        background: false,
      })
      yield* llm.text("Done.")
      yield* send({
        sessionID: build.id,
        agent: "build",
        text: "Research how teams test payments code, and be thorough.",
        size: "thorough",
      })
      const [fromBuild] = yield* calls(build.id, "task")
      expect(fromBuild?.state.status).toBe("error")
      expect(yield* sessions.children(build.id)).toEqual([])

      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.tool("task", {
        description: "Check it",
        prompt: "N1: check it",
        subagent_type: "research-judge",
        background: false,
      })
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research how teams test payments code." })
      const [judge] = yield* calls(lead.id, "task")
      expect(judge?.state.status).toBe("error")
      expect(output(judge)).toContain("runs only when Vector checks a report")
      expect(yield* sessions.children(lead.id)).toEqual([])
    }),
  90_000,
)
