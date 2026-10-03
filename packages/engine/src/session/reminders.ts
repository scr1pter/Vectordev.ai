import path from "path"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@vectordevai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

// Later messages of a planning stretch point back to the full reminder its first message carries, rather than repeating
// it on every message of the history.
export const PLAN_STILL_ACTIVE =
  "<system-reminder>Plan mode is still active: the read-only rules of the plan mode reminder above still apply.</system-reminder>"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    // Each user message gets the reminder for its own agent, worked out from the history before it, so every earlier
    // message renders the same on every request. Attaching it only to the latest one changed the previous message on
    // each turn and invalidated the provider's prompt cache from there on.
    input.messages.forEach((message, index) => {
      if (message.info.role !== "user") return
      const agent = message === userMessage ? input.agent.name : message.info.agent
      const previous = input.messages.slice(0, index).findLast((msg) => msg.info.role === "assistant")
      const afterPlan = previous?.info.role === "assistant" && previous.info.agent === "plan"
      const text =
        agent === "plan"
          ? afterPlan
            ? PLAN_STILL_ACTIVE
            : PROMPT_PLAN
          : agent === "build" && afterPlan
            ? BUILD_SWITCH
            : undefined
      if (!text) return
      message.parts.push({
        id: PartID.ascending(),
        messageID: message.info.id,
        sessionID: message.info.sessionID,
        type: "text",
        text,
        synthetic: true,
      })
    })
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
