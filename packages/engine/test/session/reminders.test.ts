import { describe, expect } from "bun:test"
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
})
