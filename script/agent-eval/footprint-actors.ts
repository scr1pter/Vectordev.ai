// Script routing is independent of the order concurrent provider requests arrive in. Actor names are fixture
// labels, not model instructions; only the original user brief identifies a child, never another agent's report.
export type Work =
  | { kind: "bash"; command: string; description: string }
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string; from: string; to: string }
  | { kind: "search"; pattern: string }
  | { kind: "list"; pattern: string }
  | {
      kind: "delegate"
      agent: "explore" | "general"
      description: string
      prompt: string
      actor?: string
      background?: boolean
      dependsOn?: string[]
    }
  | { kind: "manage"; action: "wait" | "message" | "stop"; actor: string; text?: string }
  | { kind: "hold"; text: string }
  | { kind: "answer"; text: string; sub?: true }

export type ActorStep = Work & {
  after?: { actor: string; requests: number }
  releaseOn?: "message" | "stop"
  requires?: string
  verify?: boolean
}
export type ActorPlan = { steps: ActorStep[]; actors?: Record<string, ActorStep[]> }

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join("\n")
  if (typeof value !== "object" || value === null) return ""
  if ("text" in value) return textOf(value.text)
  if ("content" in value) return textOf(value.content)
  if ("output" in value) return textOf(value.output)
  return ""
}

export function firstUserText(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  return textOf(messages.find((item) => typeof item === "object" && item !== null && item.role === "user"))
}

export function resultItems(body: Record<string, unknown>): { id: string; text: string; failed: boolean }[] {
  const items = [
    ...(Array.isArray(body.input) ? body.input : []),
    ...(Array.isArray(body.messages)
      ? body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      : []),
  ]
  return items.flatMap((item) => {
    if (item.type === "tool_result")
      return [{ id: String(item.tool_use_id), text: textOf(item.content), failed: item.is_error === true }]
    if (item.type === "function_call_output")
      return [{ id: String(item.call_id), text: textOf(item.output), failed: false }]
    return []
  })
}

export function returnedTaskID(text: string) {
  return (
    text.match(/(?:task_id|agentId|agent_id|sessionId|sessionID)["']?\s*[:=]\s*["']?([\w-]+)/)?.[1] ??
    text.match(/<task-id>([\w-]+)<\/task-id>/)?.[1] ??
    text.match(/<task id="([\w-]+)"/)?.[1]
  )
}

export function actorScript(plan: ActorPlan, inline = false) {
  const parent: ActorStep[] = []
  const scripts = new Map<string, ActorStep[]>(Object.entries(plan.actors ?? {}))
  const briefs = new Map<string, string>()
  const positions = new Map<string, number>()
  const counts = new Map<string, number>()
  const ids = new Map<string, string>()
  const results = new Map<string, string>()
  const operations = new Map<string, ActorStep>()
  const controls = new Map<
    string,
    { actor: string; action: "launch" | "wait" | "message" | "stop"; needsID?: boolean }
  >()
  const acknowledged = new Set<string>()
  const seen = new Set<string>()
  const errors: string[] = []
  const waiters = new Set<() => void>()
  let child: string | undefined
  let serial = 0
  plan.steps.forEach((step) => {
    if (step.kind === "delegate") {
      const actor = step.actor ?? `worker-${serial++}`
      briefs.set(actor, step.prompt)
      if (!inline) parent.push({ ...step, actor })
      if (!plan.actors) {
        child = actor
        scripts.set(actor, [])
      }
      return
    }
    if (inline) {
      if (!(step.kind === "answer" && step.sub)) parent.push(step)
      return
    }
    if (child) {
      scripts.get(child)?.push(step)
      if (step.kind === "answer" && step.sub) child = undefined
      return
    }
    parent.push(step)
  })
  scripts.set("parent", parent)
  const signal = () => [...waiters].forEach((wake) => wake())
  const until = (ready: () => boolean) => {
    if (ready()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        if (!ready()) return
        waiters.delete(wake)
        resolve()
      }
      waiters.add(wake)
    })
  }
  const observe = (body: Record<string, unknown>) => {
    resultItems(body).forEach((item) => {
      if (seen.has(item.id)) return
      seen.add(item.id)
      const operation = operations.get(item.id)
      if (operation?.verify && (item.failed || !/\b0 fail\b/.test(item.text)))
        errors.push(`Scripted verification did not pass: ${item.text.slice(0, 500)}`)
      if (operation && !["bash", "delegate", "manage"].includes(operation.kind) && item.failed)
        errors.push(`${operation.kind} failed: ${item.text.slice(0, 500)}`)
      const control = controls.get(item.id)
      if (!control) return
      if (
        item.failed ||
        /(?:Unknown tool|Tool execution failed|Error executing tool|No task found|Unknown subagent|No subagent)/i.test(
          item.text,
        )
      ) {
        errors.push(`${control.action} ${control.actor}: ${item.text.slice(0, 500)}`)
      }
      if (control.action === "launch") {
        const id = returnedTaskID(item.text)
        if (id) ids.set(control.actor, id)
        if (!id && control.needsID)
          errors.push(`No task ID in ${control.actor} launch result: ${item.text.slice(0, 500)}`)
      }
      results.set(control.actor, item.text)
      acknowledged.add(`${control.action}:${control.actor}`)
    })
    signal()
  }
  return {
    errors,
    observe,
    identify(body: Record<string, unknown>, headers: Record<string, string>) {
      const first = firstUserText(body)
      const actor = [...briefs].find(([, brief]) => first.includes(brief))?.[0] ?? "parent"
      if (actor !== "parent" && headers["x-session-id"]) ids.set(actor, headers["x-session-id"])
      return actor
    },
    async next(actor: string, body: Record<string, unknown>) {
      const at = positions.get(actor) ?? 0
      const step = scripts.get(actor)?.[at]
      if (!step) return { kind: "answer", text: "Acknowledged; all scripted work is complete." } satisfies ActorStep
      positions.set(actor, at + 1)
      counts.set(actor, (counts.get(actor) ?? 0) + 1)
      signal()
      if (step.after) await until(() => (counts.get(step.after!.actor) ?? 0) >= step.after!.requests)
      if (step.requires && !JSON.stringify(body).includes(step.requires))
        errors.push(`${actor} did not receive required context: ${step.requires}`)
      return step
    },
    waitForControl(actor: string, action: "message" | "stop") {
      return until(() => acknowledged.has(`${action}:${actor}`))
    },
    track(id: string, step: ActorStep) {
      operations.set(id, step)
      if (step.kind === "delegate" && step.actor)
        controls.set(id, { actor: step.actor, action: "launch", needsID: step.background === true })
      if (step.kind === "manage") controls.set(id, { actor: step.actor, action: step.action })
    },
    result(actor: string) {
      return results.get(actor) ?? ""
    },
    id(actor: string) {
      const id = ids.get(actor)
      if (!id) throw new Error(`No task ID has been observed for ${actor}`)
      return id
    },
    remaining() {
      return [...scripts].reduce(
        (sum, [actor, steps]) => sum + Math.max(0, steps.length - (positions.get(actor) ?? 0)),
        0,
      )
    },
    counts() {
      return Object.fromEntries(counts)
    },
  }
}
