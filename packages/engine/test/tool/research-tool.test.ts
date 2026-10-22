import { afterAll, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Instruction } from "../../src/session/instruction"
import { Session } from "@/session/session"
import { SessionMemory } from "../../src/session/memory"
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
      const place = yield* (yield* Instruction.Service).place()
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
