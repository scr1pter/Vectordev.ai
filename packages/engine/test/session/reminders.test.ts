import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import type { Agent } from "../../src/agent/agent"
import { Session } from "@/session/session"
import { SessionReminders } from "../../src/session/reminders"
import { MessageID, SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import PROMPT_PLAN from "../../src/session/prompt/plan.txt"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      FSUtil.node,
      RuntimeFlags.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalPlanMode: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const sessionID = SessionID.make("ses_reminders")
const user = (agent: string): SessionV1.WithParts => ({
  info: { id: MessageID.ascending(), role: "user", sessionID, agent, time: { created: 0 } } as SessionV1.Info,
  parts: [],
})
const assistant = (agent: string): SessionV1.WithParts => ({
  info: { id: MessageID.ascending(), role: "assistant", sessionID, agent } as SessionV1.Info,
  parts: [],
})
const texts = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
// The loop reloads history from storage every step, so each request starts from parts without reminders.
const fresh = (messages: SessionV1.WithParts[]) => messages.map((message) => ({ ...message, parts: [] }))

describe("session reminders", () => {
  it.instance("every earlier user message keeps the same reminder on every later request", () =>
    Effect.gen(function* () {
      const history = [user("plan"), assistant("plan"), user("build")]
      const apply = (messages: SessionV1.WithParts[], agent: string) =>
        SessionReminders.apply({
          messages: fresh(messages),
          agent: { name: agent } as Agent.Info,
          session: { id: sessionID } as Session.Info,
        })

      const first = yield* apply(history, "build")
      expect(texts(first[0])).toEqual([PROMPT_PLAN])
      expect(texts(first[2])).toEqual([BUILD_SWITCH])

      // The next turn renders the earlier messages exactly as before; only the new message is new.
      const second = yield* apply([...history, assistant("build"), user("build")], "build")
      expect(texts(second[0])).toEqual([PROMPT_PLAN])
      expect(texts(second[2])).toEqual([BUILD_SWITCH])
      expect(texts(second[4])).toEqual([])
    }),
  )

  it.instance("a planning stretch carries the full plan reminder once, then a short pointer", () =>
    Effect.gen(function* () {
      const history = [user("plan"), assistant("plan"), user("plan"), assistant("plan"), user("plan")]
      const applied = yield* SessionReminders.apply({
        messages: fresh(history),
        agent: { name: "plan" } as Agent.Info,
        session: { id: sessionID } as Session.Info,
      })
      expect(texts(applied[0])).toEqual([PROMPT_PLAN])
      expect(texts(applied[2])).toEqual([SessionReminders.PLAN_STILL_ACTIVE])
      expect(texts(applied[4])).toEqual([SessionReminders.PLAN_STILL_ACTIVE])
    }),
  )

  // Settings can turn explore off, and Plan mode cannot launch general, so a plan reminder that still named explore
  // would send the first task call to an agent that is not there.
  it.instance("the plan reminder suggests explore only where the plan agent may launch it", () =>
    Effect.gen(function* () {
      const apply = (explore?: boolean) =>
        SessionReminders.apply({
          messages: fresh([user("plan")]),
          agent: { name: "plan" } as Agent.Info,
          session: { id: sessionID } as Session.Info,
          explore,
        })
      expect(texts((yield* apply())[0])).toEqual([PROMPT_PLAN])
      expect(texts((yield* apply(true))[0])).toEqual([PROMPT_PLAN])
      const [off] = texts((yield* apply(false))[0])
      expect(PROMPT_PLAN).toContain("delegate explore agents")
      expect(off).not.toContain("explore")
      expect(off).toContain("delegate to specialists from the task tool's list")
    }),
  )
})

describe("session date notes", () => {
  const DAY = 24 * 60 * 60 * 1000
  const start = new Date(2026, 9, 10, 23, 30).getTime()
  const at = (created: number): SessionV1.WithParts => ({
    info: { id: MessageID.ascending(), role: "user", sessionID, agent: "build", time: { created } } as SessionV1.Info,
    parts: [],
  })

  test("messages on the day the history starts carry no note", () => {
    const notes = SessionReminders.dates(fresh([at(start), assistant("build"), at(start + 60_000)])).map(texts)
    expect(notes).toEqual([[], [], []])
  })

  test("the first message on a later day carries the new date, and every earlier message renders the same", () => {
    const history = [at(start), assistant("build"), at(start + 2 * 60 * 60 * 1000)]
    const first = SessionReminders.dates(fresh(history)).map(texts)
    const note = `<system-reminder>The date is now ${new Date(start + 2 * 60 * 60 * 1000).toDateString()}.</system-reminder>`
    expect(first).toEqual([[], [], [note]])

    // The next request, later the same day and again two days on: earlier messages keep exactly what they had.
    const second = SessionReminders.dates(
      fresh([...history, assistant("build"), at(start + 3 * 60 * 60 * 1000), assistant("build"), at(start + 2 * DAY)]),
    ).map(texts)
    expect(second.slice(0, 3)).toEqual(first)
    expect(second[4]).toEqual([])
    expect(second[6]).toEqual([`<system-reminder>The date is now ${new Date(start + 2 * DAY).toDateString()}.</system-reminder>`])
  })
})
