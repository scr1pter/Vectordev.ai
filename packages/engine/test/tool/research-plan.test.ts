import { afterAll, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Question } from "../../src/question"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { ResearchRun } from "../../src/tool/research-run"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_plan's plan card (sections 5.2 and 5.4), in the app, where someone can answer it: Start keeps the plan's
// depth, Start deep raises the run to Thorough with the user as its source, a typed reply is a steer that starts
// nothing, the card's own JSON answer carries the user's edits, Cancel stops, and a call that only moves sub-questions
// along never asks again.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web, { client: "app" })
afterAll(() => web.close())

// Answers each plan card with the next of `replies`, and keeps the questions asked.
const answer = (replies: string[]) =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const asked: string[] = []
    yield* Effect.gen(function* () {
      while (true) {
        for (const request of yield* question.list()) {
          asked.push(request.questions[0]?.question ?? "")
          yield* question.reply({ requestID: request.id, answers: [[replies.shift() ?? "Cancel"]] }).pipe(Effect.ignore)
        }
        yield* Effect.sleep(10)
      }
    }).pipe(Effect.forkScoped)
    return asked
  })

const metadataOf = (part: SessionV1.ToolPart | undefined): SessionV1.ToolStateCompleted["metadata"] =>
  part?.state.status === "completed" ? part.state.metadata : {}

it.instance(
  "Start deep raises the run to Thorough from the user's own answer, and a status-only call never asks again",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const asked = yield* answer(["Start deep"])
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_plan", { ...plan(), status: ["answered", "open"] })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })

      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain("Research: How much do heat pumps cut heating bills in cold climates?")
      expect(asked[0]).toContain("1. What did field studies measure?")
      expect(asked[0]).toContain("About 15 pages and 8 searches")
      const [first, second] = yield* calls(session.id, "research_plan")
      expect(metadataOf(first)).toMatchObject({
        approved: true,
        answer: "start-deep",
        to: "thorough",
        source: "user",
        plan: { depth: "deep" },
      })
      expect(metadataOf(second)).toMatchObject({ approved: true, answer: "status", runID: metadataOf(first).runID })
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      const detail = yield* store.get(place, metadataOf(first).runID)
      expect(detail?.run).toMatchObject({ depth: "deep", status: "running" })
      expect(detail?.run.plan?.status).toEqual(["answered", "open"])
    }),
  90_000,
)

it.instance(
  "a typed reply is a steer that starts nothing, the card's JSON answer carries edits, and Cancel stops",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const edited = `vector-plan:${JSON.stringify({
        action: "start",
        plan: { subquestions: ["Which homes did the study follow?"], avoid_domains: ["example.com"] },
        always: ["avoid_domains"],
      })}`
      yield* answer(["Look at Nordic studies first", edited, "Cancel"])
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      const before = (yield* store.list(place)).length
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_read", { url: web.url("article", "/") })
      yield* test.llm.tool("research_plan", plan({ question: "What did Nordic heat pump field studies find?" }))
      yield* test.llm.tool("research_plan", plan({ question: "Should I stop researching heat pumps?" }))
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: `Research heat pumps, ${web.url("article", "/")}` })

      const [steer, approved, cancelled] = yield* calls(session.id, "research_plan")
      expect(metadataOf(steer)).toMatchObject({ approved: false, answer: "steer" })
      expect(output(steer)).toContain("Look at Nordic studies first")
      // Nothing is read while no plan is approved.
      const [read] = yield* calls(session.id, "research_read")
      expect(output(read)).toBe(ResearchRun.NO_PLAN)
      expect(web.count("article")).toBe(0)
      expect(metadataOf(approved)).toMatchObject({
        approved: true,
        answer: "start",
        always: ["avoid_domains"],
        plan: { subquestions: ["Which homes did the study follow?"], avoid_domains: ["example.com"], depth: "focused" },
      })
      expect(metadataOf(approved).to).toBeUndefined()
      expect(metadataOf(cancelled)).toMatchObject({ approved: false, answer: "cancel" })
      expect(output(cancelled)).toContain("cancelled")
      // Only the approved plan started a run.
      expect((yield* store.list(place)).length - before).toBe(1)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

for (const size of [undefined, "thorough" as const])
  it.instance(
    `a headless run, which denies questions, has its plan approved within its ${size ?? "Work"} size and never asks`,
    () =>
      Effect.gen(function* () {
        const test = yield* setup(web)
        const asked = yield* answer([])
        const sessions = yield* Session.Service
        // What `vector run` gives a session that no one can answer.
        const session = yield* sessions.create({
          title: "Research",
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        })
        yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
        yield* test.llm.text("Done.")
        yield* send({
          sessionID: session.id,
          agent: "research",
          text: "Research how much heat pumps save.",
          ...(size ? { size } : {}),
        })
        expect(asked).toEqual([])
        const [planned] = yield* calls(session.id, "research_plan")
        // The model asked for deep; only a Thorough request lets a plan no one approved go deep, with its caps.
        expect(metadataOf(planned)).toMatchObject({
          approved: true,
          answer: "automatic",
          plan: { depth: size === "thorough" ? "deep" : "focused" },
        })
        // Only the user's own answer raises a run to Thorough.
        expect(metadataOf(planned).to).toBeUndefined()
        const store = yield* ResearchStore.Service
        const instruction = yield* Instruction.Service
        const detail = yield* store.get(yield* instruction.place(), metadataOf(planned).runID)
        expect(detail?.run.depth).toBe(size === "thorough" ? "deep" : "focused")
      }),
    60_000,
  )

it.instance(
  "a site the user approved on the plan card may be searched though the run read it in a file",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(test.dir, "notes", "hosts.md"),
        "# Hosts\n\nOur status page is status.acmecorp.com.\n",
      )
      yield* answer(["Start"])
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "private_network", pattern: "*", action: "allow" }],
      })
      yield* test.llm.tool("research_plan", { ...plan(), prefer_domains: ["acmecorp.com"] })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "hosts.md") })
      yield* test.llm.tool("research_search", { query: "outage history", site: "status.acmecorp.com" })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how often status pages report outages." })
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toContain("untrusted_web_page")
    }),
  90_000,
)
