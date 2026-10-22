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
import { reply, TestLLMServer } from "../lib/llm-server"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
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
  const instruction = yield* Instruction.Service
  const place = yield* instruction.place()
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

      const server = yield* TestLLMServer
      const asked = (yield* server.hits)
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

it.instance(
  "a run starts no more researchers than its depth allows",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web, { research: { limits: { deep: { researchers: 1 } } } })
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.tool("task", {
        description: "First",
        prompt: SUBQUESTION,
        subagent_type: "researcher",
        background: false,
      })
      yield* llm.textMatch(researcher, "Found it.")
      yield* llm.tool("task", {
        description: "Second",
        prompt: "How long do heat pumps last in cold climates?",
        subagent_type: "researcher",
        background: false,
      })
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research how teams test payments code." })
      const [first, second] = yield* calls(lead.id, "task")
      expect(first?.state.status).toBe("completed")
      expect(second?.state.status).toBe("error")
      expect(output(second)).toContain("has its 1 researcher")
      expect(yield* sessions.children(lead.id)).toHaveLength(1)
    }),
  90_000,
)

it.instance(
  "one batch of researchers cannot start past the run's cap",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web, { research: { limits: { deep: { researchers: 2 } } } })
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      const brief = (description: string, prompt: string) => ({ description, prompt, subagent_type: "researcher" })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      // Three in one batch: the third is past the cap, so the batch starts none of them.
      yield* llm.tool("task", {
        background: false,
        tasks: [
          brief("A", SUBQUESTION),
          brief("B", "How long do heat pumps last in cold climates?"),
          brief("C", "What do heat pumps cost in Europe?"),
        ],
      })
      yield* llm.tool("task", {
        background: false,
        tasks: [brief("A", SUBQUESTION), brief("B", "How long do heat pumps last in cold climates?")],
      })
      yield* llm.textMatch(researcher, "Found A.")
      yield* llm.textMatch(researcher, "Found B.")
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research heat pumps." })
      const [over, within] = yield* calls(lead.id, "task")
      expect(over?.state.status).toBe("error")
      expect(output(over)).toContain("has its 2 researchers")
      expect(within?.state.status).toBe("completed")
      expect(yield* sessions.children(lead.id)).toHaveLength(2)
    }),
  120_000,
)

it.instance(
  "task calls made in one step cannot start researchers past the run's cap together",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web, { research: { limits: { deep: { researchers: 1 } } } })
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.push(
        reply()
          .tool("task", { description: "A", prompt: SUBQUESTION, subagent_type: "researcher", background: false })
          .tool("task", {
            description: "B",
            prompt: "How long do heat pumps last in cold climates?",
            subagent_type: "researcher",
            background: false,
          }),
      )
      yield* llm.textMatch(researcher, "Found it.")
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research heat pumps." })
      const tasks = yield* calls(lead.id, "task")
      expect(tasks.map((task) => task.state.status).toSorted()).toEqual(["completed", "error"])
      expect(tasks.map(output).find((text) => text.includes("has its 1 researcher"))).toBeDefined()
      expect(yield* sessions.children(lead.id)).toHaveLength(1)
    }),
  120_000,
)

it.instance(
  "a session rule that allows task does not hand the lead a subagent its own rules deny",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({
        title: "Research",
        permission: [...allow, { permission: "task", pattern: "*", action: "allow" as const }],
      })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.tool("task", {
        description: "Shell",
        prompt: "List the files in the home folder.",
        subagent_type: "general",
        background: false,
      })
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research heat pumps." })
      const [task] = yield* calls(lead.id, "task")
      expect(task?.state.status).toBe("error")
      expect(output(task)).toContain("may not launch the general subagent")
      expect(yield* sessions.children(lead.id)).toEqual([])
    }),
  90_000,
)

it.instance(
  "a file the lead names in a sub-question is not attached to the researcher",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.tool("task", {
        description: "Ledger",
        prompt: "How do teams do what @notes/plan.md describes?",
        subagent_type: "researcher",
        background: false,
      })
      yield* llm.textMatch(researcher, "Found it.")
      yield* llm.text("Done.")
      yield* send({ sessionID: lead.id, agent: "research", text: "Research ledger migrations." })
      const server = yield* TestLLMServer
      const asked = (yield* server.hits)
        .map((hit) => JSON.stringify(hit.body))
        .filter((body) => body.includes("research_assignment"))
      expect(asked.length).toBeGreaterThan(0)
      for (const body of asked) expect(body).not.toContain("reconcileLedgerEntries")
      const [child] = yield* sessions.children(lead.id)
      const parts = (yield* sessions.messages({ sessionID: child!.id })).flatMap((message) => message.parts)
      expect(parts.filter((part) => part.type === "file")).toEqual([])
    }),
  // In a git repository, where a brief's @name finds the file.
  { git: true },
  90_000,
)

it.instance(
  "a researcher's request carries no instruction file of the repository, and its searches cannot name the working tree",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(dir, "AGENTS.md"),
        "# Rules\n\nDeploy to build07.acme-internal.corp with the zephyrDeploy script.\n",
      )
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      yield* llm.tool("task", {
        description: "CI",
        prompt: SUBQUESTION,
        subagent_type: "researcher",
        background: false,
      })
      yield* llm.toolMatch(researcher, "research_search", { query: `payments tests ${dir}` })
      yield* llm.textMatch(researcher, "Found it.")
      yield* llm.text("Done.")
      const bodies = yield* send({ sessionID: lead.id, agent: "research", text: "Research how teams test payments." })
      const server = yield* TestLLMServer
      const asked = (yield* server.hits)
        .map((hit) => JSON.stringify(hit.body))
        .filter((body) => body.includes("research_assignment"))
      expect(asked.length).toBeGreaterThan(0)
      for (const body of asked) {
        expect(body).not.toContain("zephyrDeploy")
        expect(body).not.toContain("acme-internal")
      }
      // The lead, which reads the repository, keeps its instructions.
      expect(bodies[0]).toContain("zephyrDeploy")
      const [child] = yield* sessions.children(lead.id)
      const [search] = yield* calls(child!.id, "research_search")
      expect(output(search)).toBe(ResearchOutbound.REFUSAL)
    }),
  { git: true },
  90_000,
)
