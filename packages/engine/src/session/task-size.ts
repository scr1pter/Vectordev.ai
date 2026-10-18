export * as SessionTaskSize from "./task-size"

import { TaskSize } from "@vectordevai/core/task-size"
import { SessionV1 } from "@vectordevai/core/v1/session"

// Sizes the request a run is answering from the projected history alone, on every step. Nothing is decided at
// admission: a prompt stores only what the sender chose (`size`, `judge`), and a completed escalate call is the durable
// record of a raise, so the size survives a restart and every step of a request agrees on it.

/** The hidden instruction the app sent with every prompt while LLM-as-a-judge was on, before Vector ran the judge. */
export const LEGACY_JUDGE_POLICY = "<vector_verified_completion>"

export type Request = {
  /** The user's own messages in this request, oldest first: the one that opened it and any that joined it. */
  readonly users: readonly SessionV1.WithParts[]
  /** Every message of the request from the one that opened it, oldest first. */
  readonly messages: readonly SessionV1.WithParts[]
  /** What the rules said. */
  readonly result: TaskSize.Result
  /** The request's size: the rules' size, raised once if the agent called escalate. */
  readonly tier: TaskSize.Tier
  readonly escalated: boolean
  /** The size, and cues, whose tools and policies the request is sent with; see `offered` in `size`. */
  readonly offered: { readonly tier: TaskSize.Tier; readonly cloud: boolean; readonly browser: boolean }
  readonly judge: TaskSize.JudgeMode
}

export type Input = {
  readonly messages: readonly SessionV1.WithParts[]
  /**
   * Whether the provider caches prompt prefixes. Then the tools and policies keep the highest size the session has
   * used while its cache is warm, so a light follow-up reuses the cached prefix instead of writing a new one. A model
   * without caching (the shared free models) follows each request's own size at once.
   */
  readonly caching: boolean
  /** How long the provider keeps a cached prefix, in milliseconds. */
  readonly lifetime: number
  /** Config `sizing.auto`. */
  readonly auto?: boolean
  /** Config `sizing.judge`, used when a prompt carries no judge setting of its own. */
  readonly judge?: TaskSize.JudgeMode
}

/** Every request in the history, oldest first; the last is the one being answered. Empty when no user has spoken. */
export function size(input: Input): Request[] {
  const used = {
    cloud: input.messages.some((message) => usedTool(message, "vector_cloud")),
    browser: input.messages.some((message) => usedTool(message, "browser")),
  }
  const sized: Request[] = []
  // On a caching provider the tools offered only grow while the cache is warm; a cold cache or a compaction (which
  // starts the visible history again) resets them to the request's own size.
  let sticky: Request["offered"] | undefined
  let end = 0
  for (const group of groups(input.messages)) {
    const previous = sized.at(-1)
    // What a "continue" or a "yes" continues: the last request that was more than a greeting, since a "thanks" and its
    // reply in between are not the work.
    const prior = sized.findLast((request) => request.tier !== "chat")
    const asked = previous ? TaskSize.asks(closingText(previous.messages)) : false
    const result = group.users.reduce<TaskSize.Result | undefined>((current, user) => {
      const next = TaskSize.classify({
        ...describe(user),
        previous: current?.tier ?? prior?.tier,
        asked: current ? false : asked,
        auto: input.auto,
      })
      if (!current) return next
      // A message that joined the run raises it; it never shrinks what the request already is.
      return TaskSize.rank(next.tier) > TaskSize.rank(current.tier)
        ? { ...next, judge: next.judge && current.judge }
        : current
    }, undefined)!
    const raised = escalation(group.messages)
    const tier = raised ? TaskSize.max(result.tier, raised) : result.tier
    const inherited = result.source === "inherited" && prior !== undefined
    const cloud = result.cloud || used.cloud || (inherited && prior.offered.cloud)
    const browser = result.browser || used.browser || (inherited && prior.offered.browser)
    const start = group.users[0].info.time.created
    const cold = !input.caching || sticky === undefined || start - end > input.lifetime
    const offered =
      tier === "chat"
        ? { tier, cloud, browser }
        : cold || sticky === undefined
          ? { tier, cloud, browser }
          : { tier: TaskSize.max(sticky.tier, tier), cloud: sticky.cloud || cloud, browser: sticky.browser || browser }
    // A greeting goes out on its own small request shape, so it neither reads nor refreshes the main cached prefix.
    if (tier !== "chat") {
      sticky = offered
      end = Math.max(start, ...group.messages.map(finishedAt))
    }
    sized.push({
      users: group.users,
      messages: group.messages,
      result,
      tier,
      escalated: raised !== undefined,
      offered,
      judge: judgeMode(group.users, input.judge, result.judge),
    })
  }
  return sized
}

/** The text a request's user typed, for the judge's brief. */
export function requestText(request: Pick<Request, "users">) {
  return request.users.map((user) => typed(user)).join("\n\n")
}

/** Files the request changed after the given message: its recorded patches, and its completed edits and writes. */
export function changedFiles(request: Pick<Request, "messages">, after?: string) {
  return [
    ...new Set(
      request.messages
        .filter((message) => message.info.role === "assistant" && (after === undefined || message.info.id > after))
        .flatMap((message) => message.parts.flatMap(changed)),
    ),
  ]
}

function changed(part: SessionV1.Part): string[] {
  if (part.type === "patch") return part.files
  if (part.type !== "tool" || part.state.status !== "completed") return []
  if (part.tool === "edit" || part.tool === "write")
    return typeof part.state.input.filePath === "string" ? [part.state.input.filePath] : []
  if (part.tool === "apply_patch" && Array.isArray(part.state.metadata?.files))
    return part.state.metadata.files.flatMap((file: unknown) =>
      file && typeof file === "object" && "filePath" in file && typeof file.filePath === "string"
        ? [file.filePath]
        : [],
    )
  return []
}

/** The judge runs Vector started in this request, oldest first. */
export function judgeRuns(request: Pick<Request, "messages">) {
  return request.messages.flatMap((message) =>
    message.info.role === "assistant"
      ? message.parts.flatMap((part) =>
          part.type === "tool" && part.tool === "task" && part.metadata?.judge !== undefined
            ? [{ messageID: message.info.id, part }]
            : [],
        )
      : [],
  )
}

/** The agent's closing text in a request: what it told the user it did. */
export function closingText(messages: readonly SessionV1.WithParts[]) {
  const last = messages.findLast(
    (message) =>
      message.info.role === "assistant" &&
      message.parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim()),
  )
  return (
    last?.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
      .join("\n")
      .trim() ?? ""
  )
}

/** The user's own words in a message: not attached file contents, and not Vector's or a client's hidden instructions. */
export function typed(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
}

/** A message from the user, as opposed to a task notification, a judge's findings or a compaction marker. */
export function real(message: SessionV1.WithParts) {
  if (message.info.role !== "user") return false
  return message.parts.some(
    (part) =>
      (part.type === "text" && !part.synthetic && !part.ignored) || part.type === "file" || part.type === "agent",
  )
}

function groups(messages: readonly SessionV1.WithParts[]) {
  // The projected history can be reordered around a compaction; message IDs are monotonic.
  const sorted = messages.toSorted((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
  return sorted.reduce<{ users: SessionV1.WithParts[]; messages: SessionV1.WithParts[]; closed: boolean }[]>(
    (list, message) => {
      const current = list.at(-1)
      if (real(message)) {
        // A message sent while the run is going joins it; one sent after the run answered opens the next request.
        if (!current || current.closed) return [...list, { users: [message], messages: [message], closed: false }]
        current.users.push(message)
        current.messages.push(message)
        return list
      }
      if (!current) return list
      current.messages.push(message)
      if (message.info.role === "assistant" && terminal(message.info)) current.closed = true
      // Vector's own follow-ups (a judge's findings, a task notification, a compaction's continue) continue the run.
      if (message.info.role === "user") current.closed = false
      return list
    },
    [],
  )
}

function terminal(info: SessionV1.Assistant) {
  if (info.error) return true
  return info.finish !== undefined && !["tool-calls", "unknown"].includes(info.finish)
}

function finishedAt(message: SessionV1.WithParts) {
  return message.info.role === "assistant" ? (message.info.time.completed ?? message.info.time.created) : 0
}

function describe(message: SessionV1.WithParts) {
  const files = message.parts.filter((part) => part.type === "file")
  const info = message.info.role === "user" ? message.info : undefined
  return {
    text: typed(message),
    files: files.filter((part) => part.type === "file" && !part.mime.startsWith("image/")).length,
    images: files.filter((part) => part.type === "file" && part.mime.startsWith("image/")).length,
    agents: message.parts.flatMap((part) => (part.type === "agent" ? [part.name] : [])),
    choice: info?.size,
    structured: info?.format?.type === "json_schema",
  }
}

function escalation(messages: readonly SessionV1.WithParts[]) {
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "escalate" || part.state.status !== "completed") continue
      const to = part.state.metadata?.to
      if (to === "light" || to === "standard" || to === "thorough") return to as TaskSize.Tier
    }
  }
}

function judgeMode(
  users: readonly SessionV1.WithParts[],
  configured: TaskSize.JudgeMode | undefined,
  allowed: boolean,
): TaskSize.JudgeMode {
  if (!allowed) return "off"
  const chosen = users.findLast((user) => user.info.role === "user" && user.info.judge !== undefined)
  if (chosen?.info.role === "user" && chosen.info.judge) return chosen.info.judge
  // Older clients turned the judge on by sending its policy as a hidden instruction with each prompt.
  const legacy = users.some((user) =>
    user.parts.some((part) => part.type === "text" && part.synthetic && part.text.startsWith(LEGACY_JUDGE_POLICY)),
  )
  if (legacy) return "thorough"
  return configured ?? "off"
}

function usedTool(message: SessionV1.WithParts, tool: string) {
  return message.info.role === "assistant" && message.parts.some((part) => part.type === "tool" && part.tool === tool)
}
