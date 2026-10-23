import { afterAll, expect } from "bun:test"
import { Effect } from "effect"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { calls, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { ResearchScript } from "../../../core/test/lib/research-script"

// The scripted Focused research run (core's test/lib/research-script.ts) on the V1 runner, in the app, where the user
// answers the plan card. Its store rows are the recorded fixture the V2 runner's test compares its own run with, so a
// change to what V1 stores shows here first, and the fixture moves with it.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web, { client: "app" })
afterAll(() => web.close())

// Starts each plan card and allows each permission once.
const answer = Effect.gen(function* () {
  const question = yield* Question.Service
  const permission = yield* Permission.Service
  yield* Effect.gen(function* () {
    while (true) {
      for (const request of yield* question.list())
        yield* question.reply({ requestID: request.id, answers: [["Start"]] }).pipe(Effect.ignore)
      for (const request of yield* permission.list())
        yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore)
      yield* Effect.sleep(10)
    }
  }).pipe(Effect.forkScoped)
})

it.instance(
  "the scripted research run stores the rows the V2 runner's run must match",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      yield* answer
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      for (const call of ResearchScript.calls(web)) yield* test.llm.tool(call.tool, call.input)
      yield* test.llm.text(ResearchScript.CLOSING)
      yield* send({ sessionID: session.id, agent: "research", text: ResearchScript.PROMPT })

      const [planned] = yield* calls(session.id, "research_plan")
      const runID = planned?.state.status === "completed" ? planned.state.metadata.runID : undefined
      expect(typeof runID).toBe("string")
      const store = yield* ResearchStore.Service
      const instruction = yield* Instruction.Service
      const detail = yield* store.get(yield* instruction.place(), runID as string)
      expect(detail).toBeDefined()
      const rows = ResearchScript.rows(detail!, web)
      expect(rows).toEqual(yield* Effect.promise(() => Bun.file(ResearchScript.FIXTURE).json()))
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)
