export * as TaskSize from "./task-size"

import type { Choice, Tier } from "@vectordevai/schema/task-size"

export { Tier, Choice, JudgeMode } from "@vectordevai/schema/task-size"

// Sizes a request from what the user typed, with no model call, so "hi" gets one direct reply and only genuinely large
// work brings in subagents and the judge. The engine, the app and desktop all use this one classifier.
//
// The rules are a heuristic, so the policy is built to fail safe. Sizing real work too small costs more than sizing a
// short request too large, so only two narrow kinds of message get less than Standard: a social message (Chat) and a
// short, single, clearly small action (Light). Everything else starts at Standard, at the provider's own effort, and the
// agent can raise it with escalate once it sees the work. A reply inside work that is still open keeps that work's size.

/** Reasoning effort for a request when the user left effort on its default. */
export type Effort = "off" | "low" | "default" | "high"

/** Where a size came from: Vector's rules, the sender's own choice, or the request it continues. */
export type Source = "auto" | "user" | "inherited"

export type Input = {
  /** What the user typed for this request, without attached file contents or Vector's own hidden instructions. */
  readonly text: string
  /** Attached files and images. */
  readonly files?: number
  readonly images?: number
  /** Subagents the user named with @. */
  readonly agents?: readonly string[]
  /** The sender's explicit size; "auto" or undefined lets the rules decide. */
  readonly choice?: Choice
  /** The size of the work before this message: the last request in the session that was more than a social reply. */
  readonly previous?: Tier
  /**
   * Whether the request right before this message is still open: its reply asked or offered something, or its run did
   * not finish (it was interrupted, failed or stopped). Then anything but a social message is a reply inside that work.
   */
  readonly open?: boolean
  /**
   * Whether the reply right before this message closed by offering more, optional work ("Want me to also update the
   * docs?"). A plain "no thanks" to it leaves nothing to do, so it is answered directly; a "no" to a real question
   * ("Should I keep the old API?") is an answer inside the work.
   */
  readonly offer?: boolean
  /** The request asks for structured output, which needs a tool call. */
  readonly structured?: boolean
  /** false turns automatic sizing off: every request gets the full harness unless the sender picks a size. */
  readonly auto?: boolean
  /**
   * The text is a command's template: a workflow its author wrote, not the user's words about this request. Force
   * words in it ("be thorough", "use subagents") are not instructions.
   */
  readonly template?: boolean
}

export type Result = {
  readonly tier: Tier
  readonly source: Source
  /** Stable reason codes, such as "greeting", "small-edit" or "files:40"; clients turn them into copy. */
  readonly reasons: readonly string[]
  /** The request mentions hosting or data work, so Vector Cloud's tool is offered. */
  readonly cloud: boolean
  /** The request mentions a page or the UI, so the browser tool is offered. */
  readonly browser: boolean
  /** false when the user said to skip the judge for this request. */
  readonly judge: boolean
  /** Subagents the user named; they may be launched below Thorough. */
  readonly agents: readonly string[]
}

const ORDER = { chat: 0, light: 1, standard: 2, thorough: 3 } as const satisfies Record<Tier, number>
const TIERS = ["chat", "light", "standard", "thorough"] as const satisfies readonly Tier[]

export function rank(tier: Tier) {
  return ORDER[tier]
}

export function max(a: Tier, b: Tier): Tier {
  return ORDER[a] >= ORDER[b] ? a : b
}

export function min(a: Tier, b: Tier): Tier {
  return ORDER[a] <= ORDER[b] ? a : b
}

/** One step up, as the escalate tool raises a request without a target. Thorough stays Thorough. */
export function raise(tier: Tier): Tier {
  return TIERS[Math.min(ORDER[tier] + 1, TIERS.length - 1)]
}

export function effort(tier: Tier): Effort {
  if (tier === "chat") return "off"
  if (tier === "light") return "low"
  if (tier === "thorough") return "high"
  return "default"
}

/** User-facing name of a size. */
export function label(tier: Tier) {
  return { chat: "Chat", light: "Light", standard: "Standard", thorough: "Thorough" }[tier]
}

/**
 * Built-in tools a request of this size is not offered. Chat is offered none at all. MCP, plugin and custom tools are
 * never removed: the user installed them.
 */
export function withheld(
  tier: Tier,
  cues: { readonly cloud: boolean; readonly browser: boolean; readonly agents?: number },
): ReadonlySet<string> {
  const delegation = (cues.agents ?? 0) > 0 ? [] : ["task", "task_manage"]
  if (tier === "thorough") return new Set()
  if (tier === "standard") return new Set([...delegation, ...(cues.cloud ? [] : ["vector_cloud"])])
  return new Set([
    ...delegation,
    "todowrite",
    "question",
    ...(cues.cloud ? [] : ["vector_cloud"]),
    ...(cues.browser ? [] : ["browser"]),
  ])
}

/**
 * The size guidance attached to a request's user message. It is worked out from that request alone, so a message renders
 * the same on every later request and the provider's prompt cache keeps it.
 */
export function note(tier: Tier, options: { readonly escalate: boolean; readonly judge: boolean }) {
  const escalate = options.escalate ? " If it turns out bigger, call escalate with your reason." : ""
  if (tier === "light")
    return `<task_size>Light request: do it directly in as few steps as possible, without a to-do list or subagents. If you changed code, run one focused check.${escalate}</task_size>`
  if (tier === "standard")
    return `<task_size>Standard request: do the work yourself and keep a short to-do list for multi-step work. Subagents are not offered.${options.escalate ? " If it turns out to span the whole system, or independent parts of roughly five or more files would be cheaper split up, call escalate with your reason." : ""}</task_size>`
  if (tier === "thorough")
    return `<task_size>Thorough request: plan with the to-do list, split independent substantial parts across subagents when that is cheaper, and verify with the strongest checks available.${options.judge ? " Vector runs the judge after you finish, so do not launch it yourself." : ""}</task_size>`
  // A greeting goes out on the quick lane, which carries no note.
  return undefined
}

export function classify(input: Input): Result {
  const text = prose(input.text)
  const lower = text.toLowerCase().replace(/[’‘]/g, "'")
  const cues = {
    cloud: CLOUD.test(lower),
    browser: BROWSER.test(lower) || (input.images ?? 0) > 0,
    agents: [...new Set(input.agents ?? [])],
  }
  // A greeting before this message is not work it could continue.
  const previous = input.previous === "chat" ? undefined : input.previous
  const result = (tier: Tier, source: Source, reasons: string[], judge = true): Result => {
    // A structured answer needs its tool, and a named subagent needs the task tool, so neither is ever a bare reply.
    const floor = (input.structured || cues.agents.length > 0) && tier === "chat" ? "light" : tier
    return { tier: floor, source, reasons, ...cues, judge }
  }

  if (input.choice && input.choice !== "auto") return result(input.choice, "user", ["user"])
  if (input.auto === false) return result("thorough", "auto", ["auto-off"])

  // Negated asks ("no subagents", "skip the judge", "don't be thorough") come out first, so they cannot read as the ask
  // itself. "Don't be thorough" asks for the opposite: it caps the request like "keep it simple".
  const noSubagents = NO_SUBAGENTS.test(lower)
  const noJudge = NO_JUDGE.test(lower)
  const notThorough = NOT_THOROUGH.test(lower)
  const asked = strip(strip(strip(lower, NO_SUBAGENTS), NO_JUDGE), NOT_THOROUGH)
  const capped = CAP_LIGHT.test(lower) || notThorough
  // A force word counts only as the user's instruction about this request: a clause that asks for it ("be thorough",
  // "use subagents", "run the judge"), never a mention ("fix the bug with subagents not starting") or a template's text.
  const forced = input.template ? [] : instructions(asked)
  if (forced.length > 0) {
    const tier = noSubagents ? "standard" : capped ? "light" : "thorough"
    return result(tier, "user", forced, !noJudge)
  }

  const plain = !input.files && !input.images && cues.agents.length === 0
  const raw = input.text
  const bare = plain && !PATH.test(raw) && !URL_PATTERN.test(raw) && !raw.includes("`") && text.length <= 80
  const phrase = bare ? chatPhrase(lower) : undefined
  // A greeting, thanks, a farewell, emoji or a question about Vector is a direct reply, whatever came before it.
  if (phrase && SOCIAL.has(phrase)) return result("chat", "auto", [phrase === "vector" ? "about-vector" : phrase])

  // A message that is only a cue ("keep it simple", "no subagents") applies to the request it follows.
  const rest = strip(strip(asked, CAP_LIGHT), FILLER).replace(/\s+/g, " ").trim()
  if ((capped || noSubagents || noJudge) && rest.split(" ").filter(Boolean).length <= 2) {
    const base = previous ?? "light"
    const tier = capped ? min(base, "light") : noSubagents ? min(base, "standard") : base
    return result(max(tier, "light"), previous ? "inherited" : "auto", ["cue"], !noJudge)
  }

  // What the message asks for on its own, read without a leading "yes," or "go ahead and".
  const signals = measure(text, unprefixed(lower), input)
  const own: Tier | undefined =
    signals.thorough.length > 0
      ? "thorough"
      : signals.standard.length > 0
        ? "standard"
        : signals.light.length > 0
          ? "light"
          : undefined
  const ownReasons =
    own === "thorough" ? signals.thorough : own === "standard" ? signals.standard : own ? signals.light : []
  // The user's own words cap it: "no subagents" at Standard, "quick question" at Light unless it is plainly large.
  const limit = (tier: Tier) =>
    noSubagents ? min(tier, "standard") : capped ? min(tier, signals.thorough.length > 0 ? "standard" : "light") : tier

  // A plain "no thanks" to an offer of more work closes that work: nothing is left to do, so it is a direct reply, and
  // the engine's judge still checks the work it closes.
  if (input.offer && phrase === "decline") return result("chat", "auto", ["decline"])
  // A reply inside the work before it keeps that work's size and never lowers it: anything sent while that work is
  // still open; a "yes", a "continue" or a "go ahead, ..." at any time; and a short message about that work, one that
  // points back at it ("build it", "implement the plan", "option 2") or names nothing of its own ("use postgres",
  // "approved"). A whole-message reply takes the size as it is; a longer one is raised by what it asks for itself.
  const replying =
    phrase === "accept" || phrase === "approve" || phrase === "directive" || input.open || continuing(lower)
  if (previous && (replying || (!phrase && refers(lower, own, signals.question)))) {
    // A message that is only near the work, saying nothing of its size, is still at least Standard: nothing in it says
    // it is small.
    const tier = phrase ? previous : max(previous, own ?? (replying ? previous : "standard"))
    const reasons = [input.open ? "answer" : "continue", ...(tier !== previous ? ownReasons : [])]
    return result(limit(tier), "inherited", reasons, !noJudge)
  }
  if (phrase) {
    // "yes" to a greeting's offer is work of unknown size; an "ok" or a "great" to finished work is just a reply.
    if (input.open) return result(limit("standard"), "auto", ["answer"], !noJudge)
    return result("chat", "auto", [phrase])
  }
  return result(limit(own ?? "standard"), "auto", own ? ownReasons : ["default"], !noJudge)
}

/** Whether an assistant's closing text asks the user for a decision or offers more work, so a short "ok" answers it. */
export function asks(text: string) {
  const tail = closing(text).join(" ").slice(-400)
  if (tail.endsWith("?")) return true
  return ASKS.test(tail)
}

/**
 * Whether a reply ends on a question the work waits on, such as "Should I also migrate the tests?". A closing
 * pleasantry ("Anything else?") is not one. Vector does not judge work while it waits on the user.
 */
export function waits(text: string) {
  const tail = text.trim().replace(/[\s*_`)\]]+$/, "")
  if (!tail.endsWith("?")) return false
  const start = Math.max(...[".", "!", "?", "\n"].map((mark) => tail.lastIndexOf(mark, tail.length - 2))) + 1
  return !pleasantry(tail.slice(start))
}

/**
 * Whether a reply closes by offering more, optional work: "Want me to also update the docs?", "I can also add tests if
 * you like." A plain "no thanks" declines such an offer and leaves nothing to do. A question the work itself turns on
 * ("Should I keep the old API?", "Which router?") is not an offer: a "no" to it is an answer.
 */
export function offers(text: string) {
  const last = closing(text).findLast((sentence) => sentence.endsWith("?") || ASKS.test(sentence))
  return last !== undefined && OFFER.test(last)
}

/** The sentences a reply closes with, lowercased, without the closing pleasantries that offer nothing to answer. */
function closing(text: string) {
  return sentences(text.trim().slice(-600))
    .filter((sentence) => !pleasantry(sentence))
    .map((sentence) => sentence.trim().toLowerCase().replace(/[’‘]/g, "'"))
}

// A closing courtesy that offers no particular work: the whole sentence is one, so "What would you like me to do
// first?" after a plan is still a question.
function pleasantry(sentence: string) {
  return PLEASANTRY.test(
    sentence
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[\s*_`)\]!?.:;,😊🙂👋]+$/u, "")
      .replace(/^[\s*_`(\[]+/, "")
      .trim(),
  )
}

/**
 * Whether a Chat result is social: a greeting, thanks, a farewell, emoji or a question about Vector. The rest of Chat
 * ("ok", "yes", "continue", "great") is a reply to the work before it, which only the engine can read against that
 * work, so a client must not treat it as a bare greeting.
 */
export function social(result: Pick<Result, "tier" | "reasons">) {
  return result.tier === "chat" && SOCIAL_REASONS.has(result.reasons[0] ?? "")
}

function measure(text: string, lower: string, input: Input) {
  const paths = new Set((text.match(PATH_GLOBAL) ?? []).map((item) => item.trim())).size + (input.files ?? 0)
  const items = text.split("\n").filter((line) => LIST_ITEM.test(line))
  const actionItems = items.filter((line) => ACTION.test(line.toLowerCase())).length
  const scale = SCALE.filter((pattern) => pattern.test(lower)).length
  const wide = WIDE.test(lower)
  const system = SYSTEM_SCOPE.test(lower)
  const target = SYSTEM_OBJECT.exec(lower)
  const counted = Math.max(
    0,
    ...[...lower.matchAll(COUNTED)].map((match) => Number(match[1])),
    ...[...lower.matchAll(ACROSS_COUNT)].map((match) => Number(match[1])),
  )
  const features = Object.entries(FEATURES).filter(([, pattern]) => pattern.test(lower)).length
  const building = BUILD.test(lower)
  const fixing = FIX.test(lower)
  const editing = EDIT.test(lower)
  // Reworking what exists (rewrite, port, switch, convert, replace ...) is an action, and over a whole system or every
  // part of one it is large work.
  const rework = REWORK.test(lower)
  const action = building || fixing || editing || rework || ACTION.test(lower)
  const small = SMALL_EDIT.test(lower)
  const trimmed = lower.trim()
  const question =
    (QUESTION.test(trimmed) || (AUX_QUESTION.test(trimmed) && trimmed.endsWith("?"))) && !REQUEST.test(trimmed)
  // A deadlock, a race, a leak or a crash takes real investigation, even asked as a question.
  const hard = [
    ...(HARD_FAILURE.test(lower) ? ["hard-failure"] : []),
    ...(WHY_FAIL.test(trimmed) ? ["why-fail"] : []),
  ]
  const length = text.replace(/\s+/g, " ").trim().length

  const thorough = [
    ...(scale >= 2 ? [`scale:${scale}`] : []),
    ...(scale >= 1 && wide && action && !small ? ["scale+scope"] : []),
    ...(rework && (system || wide) && !small ? ["rework+scope"] : []),
    // A rework of a whole system, or "make the app ..." with a scale term ("make the desktop app work offline").
    ...(target && (target[1] !== undefined || scale >= 1) ? ["whole-system"] : []),
    ...(system && (building || fixing || editing) && !small ? ["system-wide"] : []),
    ...(counted >= 10 ? [`files:${counted}`] : []),
    ...(paths >= 6 ? [`paths:${paths}`] : []),
    ...(actionItems >= 5 ? [`items:${actionItems}`] : []),
    ...(features >= 3 && building ? [`features:${features}`] : []),
    ...(length >= 1200 && action ? ["long"] : []),
  ]
  const standard = [
    ...(building && !small && !(OPERATION.test(lower) && !features) ? ["build"] : []),
    ...(fixing && !small ? ["fix"] : []),
    ...(/\b(?:with|add|write|and) (?:unit |integration |e2e )?tests\b/.test(lower) ? ["tests"] : []),
    ...(paths >= 2 ? [`paths:${paths}`] : []),
    ...(actionItems >= 2 ? [`items:${actionItems}`] : []),
    ...(scale >= 1 && action && !small ? ["scale"] : []),
    ...(target ? ["system"] : []),
    ...(wide && (building || editing || rework) && !small ? ["wide"] : []),
    ...hard,
    ...(question ? ["question"] : []),
    ...(length >= 300 && action ? ["long"] : []),
    ...(length >= 600 ? ["long"] : []),
    ...((input.images ?? 0) > 0 && action ? ["image+action"] : []),
  ]
  // A question about code is Standard, how-to questions included, and never Thorough on its own words: the agent
  // raises it with escalate when the answer turns out to need large work.
  if (question && !fixing) return { thorough: [], standard: [...thorough, ...standard], light: [], question }
  return { thorough, standard, light: standard.length > 0 ? [] : light(lower, input), question }
}

// A short, single, clearly small action: deploying or shipping, a git step, running the tests or a script, fixing a typo,
// renaming, formatting or installing a package. Every clause of the message has to be one of these, and nothing in it
// may widen the job (a scope word, a failure, an attachment). Anything else is Standard.
function light(lower: string, input: Input): string[] {
  if ((input.files ?? 0) > 0 || (input.images ?? 0) > 0) return []
  if (lower.split(/\s+/).filter(Boolean).length > 16 || SCOPE.test(lower) || FAILURE.test(lower)) return []
  const kinds = clauses(lower).reduce<string[] | undefined>((found, clause, index, list) => {
    if (!found) return undefined
    const kind = SMALL_ACTIONS.find(([, pattern]) => pattern.test(polite(clause)))?.[0]
    if (kind) return [...found, kind]
    // "install react and react-dom": a bare package name after "and" is another object of the install before it.
    const install = index > 0 && INSTALL.test(polite(list[index - 1]!)) && PACKAGE_ONLY.test(clause.trim())
    return install ? found : undefined
  }, [])
  return kinds && kinds.length > 0 ? [...new Set(kinds)] : []
}

// Force words are instructions about this request: a clause that starts with one ("be thorough", "use subagents", "run
// the judge"), or an imperative clause that says "thoroughly" or ends with "with subagents". The same words in a
// statement or a question ("the subagents are not starting", "how would you judge this?") are only mentions.
function instructions(lower: string) {
  return [
    ...new Set(
      clauses(lower).flatMap((clause) => {
        const asked = polite(clause)
        if (!asked) return []
        return FORCE.flatMap(([code, start, inside]) =>
          start.test(asked) || (inside !== undefined && imperative(asked) && inside.test(asked)) ? [code] : [],
        )
      }),
    ),
  ]
}

// A message that picks the work back up: "continue where you left off", "keep going until it passes", "do the rest of
// the migration", or one whose first or last clause is only a "yes" or a "go ahead".
function continuing(lower: string) {
  if (CONTINUING.test(polite(lower))) return true
  // A closing "please" is courtesy, not an acceptance.
  const parts = clauses(lower)
    .map((clause) => polite(clause))
    .filter((part) => !/^(?:please|pls|plz)$/.test(part))
  return [parts[0], parts.at(-1)].some((part) => {
    if (!part) return false
    const kinds = replyKinds(words(part))
    return kinds !== undefined && (kinds.has("accept") || kinds.has("approve") || kinds.has("directive"))
  })
}

// A short message about the work before it. One that points back at that work ("build it", "implement the plan", "go
// with option b", "the second one") continues it whatever it asks for itself; one that gives no size of its own ("use
// postgres", "approved", "start") is most likely about that work too, since nothing else is in view. A question about
// the work is still a question, and a longer message is a request of its own.
function refers(lower: string, own: Tier | undefined, question: boolean) {
  if (question) return false
  const count = lower.split(/\s+/).filter(Boolean).length
  if (count > 10) return false
  return own === undefined ? count <= 6 : BACK.test(lower)
}

// The message without a leading reply ("yes, ", "ok go ahead and "), so what it asks for is measured on its own.
function unprefixed(lower: string) {
  const parts = clauses(lower)
  const first = parts[0] ? replyKinds(words(polite(parts[0]))) : undefined
  if (parts.length < 2 || !first || first.size === 0) return lower
  return lower
    .slice(lower.indexOf(parts[0]!) + parts[0]!.length)
    .replace(/^[\s.!?;:,]+/, "")
    .replace(/^(?:and then|then|and|but|&)\s+/, "")
}

// Splits a message into clauses at sentence breaks, commas and "and" / "then". A dot inside a word ("utils.ts") is not
// a break.
function clauses(lower: string) {
  return lower
    .split(/[!?;\n]+\s*|[.:](?:\s+|$)|,\s*|\s+(?:and then|then|and|but|&)\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

// A clause without the politeness around the ask: "please", "can you", "just", a trailing "for me".
function polite(clause: string) {
  return clause
    .trim()
    .replace(POLITE_START, "")
    .replace(/\s+(?:please|pls|for me|now|thanks|thank you)$/, "")
    .replace(/[?.!\s]+$/, "")
    .trim()
}

// An imperative clause starts with its verb, not with a subject, a determiner or a question word.
function imperative(clause: string) {
  return !NOT_IMPERATIVE.has(clause.split(/\s+/)[0] ?? "")
}

function words(text: string) {
  return plainWords(text).map(collapse)
}

function plainWords(text: string) {
  return text
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function sentences(text: string) {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim())
}

type Phrase =
  | "greeting"
  | "thanks"
  | "farewell"
  | "reaction"
  | "ack"
  | "decline"
  | "accept"
  | "approve"
  | "directive"
  | "vector"
  | "emoji"

// A whole message that is only short replies and social phrases, clause by clause: "thanks, that worked!", "hey, you
// there?", "sounds good, go ahead". Any clause that is something else (a request, a question about the code) makes it
// not one. The strongest kind wins, so "thanks, go ahead" continues the work and "no, thanks" declines.
function chatPhrase(lower: string): Phrase | undefined {
  if (EMOJI_ONLY.test(lower)) return "emoji"
  const all = words(lower)
  // A question about Vector is read whole first, so the "vector" in "what is vector?" is not dropped as a vocative.
  if (VECTOR_QUESTIONS.has(all.join(" "))) return "vector"
  if (all.length > 0 && dropVocatives(all).length === 0) return "greeting"
  const kinds = clauses(lower).map(clauseKinds)
  if (kinds.length === 0 || kinds.some((kind) => kind === undefined)) return undefined
  const found = new Set(kinds.flatMap((kind) => [...(kind ?? [])]))
  return PHRASE_ORDER.find((kind) => found.has(kind))
}

function clauseKinds(clause: string): Set<Phrase> | undefined {
  const all = plainWords(clause)
  const trimmed = dropVocatives(all)
  // Only a vocative ("there", "vector"): nothing to add.
  if (trimmed.length === 0) return new Set()
  // Word sets hold collapsed spellings ("hiii" is "hi"); patterns read the words as typed.
  const typed = trimmed.join(" ")
  const phrase = collapse(typed)
  const whole = collapse(all.join(" "))
  if (VECTOR_QUESTIONS.has(whole) || VECTOR_QUESTIONS.has(phrase)) return new Set(["vector"])
  if (SMALL_TALK.has(whole) || SMALL_TALK.has(phrase)) return new Set(["greeting"])
  // "hi there, how are you", "hey vector what's up", "hello again": a greeting with an optional how-are-you.
  const greeting = [...GREETINGS].find((item) => phrase === item || phrase.startsWith(`${item} `))
  const after = greeting ? dropVocatives(phrase.slice(greeting.length).trim().split(" ").filter(Boolean)).join(" ") : ""
  if (greeting && (after === "" || after === "again" || SMALL_TALK.has(after))) return new Set(["greeting"])
  if (FAREWELLS.has(phrase)) return new Set(["farewell"])
  if (thanked(typed)) return new Set(["thanks"])
  // "sounds good, go ahead" or "yes please do": short replies, longest first, read as sent before vocatives are
  // dropped, so "all good" is not read as "good".
  const replies = replyKinds(whole.split(" ")) ?? replyKinds(phrase.split(" "))
  if (replies) return replies
  // "it works now", "that fixed it": the user reporting back, which answers the work like an "ok".
  if (SUCCESS.test(typed)) return new Set(["ack"])
  return undefined
}

// A thanks, with what it thanks for ("thanks for the help", "thank you for fixing that") or a courtesy after it
// ("thanks again"), but never a new ask hidden in it ("thanks for that, now add tests").
function thanked(typed: string) {
  const phrase = collapse(typed)
  if (THANKS.has(phrase) || THANKS.has(dropTrailing(phrase))) return true
  const match = /^(.+?) for (.+)$/.exec(typed)
  if (!match || !THANKS.has(collapse(match[1]!))) return false
  const rest = match[2]!
  return rest.split(" ").length <= 6 && ![ASKING, ACTION, BUILD, FIX, EDIT].some((pattern) => pattern.test(rest))
}

// Splits a short message into known short replies, longest first, or gives up when any word is left over.
function replyKinds(words: readonly string[]): Set<Phrase> | undefined {
  if (words.length === 0) return new Set()
  return [4, 3, 2, 1]
    .filter((size) => size <= words.length)
    .map((size) => {
      const kind = REPLIES.find(([, items]) => items.has(words.slice(0, size).join(" ")))?.[0]
      const rest = kind ? replyKinds(words.slice(size)) : undefined
      return kind && rest ? new Set<Phrase>([kind, ...rest]) : undefined
    })
    .find((kinds) => kinds !== undefined)
}

function strip(text: string, pattern: RegExp) {
  return text.replace(new RegExp(pattern.source, "g"), " ")
}

function dropVocatives(words: string[]) {
  const start = words.findIndex((word) => !VOCATIVES.has(collapse(word)))
  if (start === -1) return []
  const end = words.findLastIndex((word) => !VOCATIVES.has(collapse(word)))
  return words.slice(start, end + 1)
}

function dropTrailing(phrase: string) {
  return phrase.replace(/ (?:so much|a lot|a ton|again|in advance|man|dude|bro|mate)$/, "")
}

// Letters typed more than once in a row ("hiii", "heyyy", "thanksss") match their plain spelling. Both sides of every
// comparison go through it, so "good" and "god" never need telling apart.
function collapse(value: string) {
  return value.replace(/(\p{L})\1+/gu, "$1")
}

function set(items: readonly string[]) {
  return new Set(items.map(collapse))
}

// Pasted code and logs say what went wrong, not how big the job is, so length rules count prose only.
function prose(text: string) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !LOG_LINE.test(line))
    .join("\n")
    .trim()
}

const VOCATIVES = set(["vector", "there", "team", "everyone", "all", "buddy", "friend", "mate", "guys", "folks"])
const GREETINGS = set([
  "hi",
  "hey",
  "hello",
  "hiya",
  "howdy",
  "yo",
  "sup",
  "wassup",
  "whats up",
  "gm",
  "good morning",
  "good afternoon",
  "good evening",
  "morning",
  "evening",
  "hola",
  "bonjour",
  "hallo",
  "ciao",
  "namaste",
  "salut",
  "hej",
  "你好",
  "こんにちは",
  "안녕하세요",
  "hey hey",
  "hi hi",
  "oh hi",
])
const SMALL_TALK = set([
  "how are you",
  "how are you doing",
  "how r u",
  "how are u",
  "hows it going",
  "how is it going",
  "whats up",
  "how have you been",
  "hope you are well",
  "hope youre well",
  "you there",
  "are you there",
  "can you help me",
  "can you help",
  "could you help me",
])
const THANKS = set([
  "thanks",
  "thank you",
  "thx",
  "ty",
  "tysm",
  "cheers",
  "appreciate it",
  "much appreciated",
  "many thanks",
  "thanks a lot",
  "thank you so much",
  "thanks so much",
  "thanks again",
  "ok thanks",
  "okay thanks",
  "ok thank you",
  "great thanks",
  "perfect thanks",
  "awesome thanks",
  "cool thanks",
  "nice thanks",
])
const FAREWELLS = set(["bye", "goodbye", "bye bye", "see you", "see ya", "cya", "later", "good night", "gn", "ttyl"])
const REACTIONS = set([
  "nice",
  "cool",
  "great",
  "awesome",
  "perfect",
  "lol",
  "haha",
  "wow",
  "amazing",
  "sweet",
  "neat",
  "nice work",
  "great job",
  "good job",
  "well done",
  "love it",
  "nice one",
  "great work",
  "good work",
  "excellent",
])
// Acknowledgements: they answer the reply before them only when it asked or offered something.
const ACK = set([
  "ok",
  "okay",
  "k",
  "kk",
  "alright",
  "got it",
  "understood",
  "makes sense",
  "fine",
  "right",
  "ok cool",
  "noted",
])
// Declines: they answer a question inside the work ("Should I keep the old API?" "no"), or close an offer of more work
// ("Want me to also update the docs?" "no thanks"), which leaves nothing to do.
const DECLINES = set([
  "no",
  "nope",
  "nah",
  "no thanks",
  "no thank you",
  "not now",
  "not yet",
  "not needed",
  "maybe later",
  "thats all",
  "thats it",
  "thats enough",
  "all good",
  "im good",
  "were good",
  "nothing else",
  "no need",
  "never mind",
  "nevermind",
  "skip it",
  "skip that",
  "leave it",
  "stop here",
  "stop there",
  "stop for now",
  // The tail of a decline: "stop here for now".
  "for now",
])
// Acceptances: on their own they make no sense without something to accept, so they always continue the request
// before them.
const ACCEPT = set([
  "yes",
  "yep",
  "yeah",
  "yup",
  "ya",
  "yea",
  "sure",
  "sure thing",
  "yes please",
  "yes pls",
  "please",
  "ok sure",
  "okay sure",
  "absolutely",
  "definitely",
  "of course",
  "do that",
  "lets do it",
  "lets do that",
  "lets go",
  "that works",
  "works for me",
  "both",
  "all of them",
])
// Approvals of what the agent proposed: they continue it like an acceptance, but next to a thanks ("thanks, looks
// great") they close the work instead.
const APPROVALS = set(["sounds good", "looks good", "sounds great", "looks great", "lgtm", "approved", "agreed"])
const DIRECTIVES = set([
  "go",
  "go ahead",
  "do it",
  "continue",
  "keep going",
  "proceed",
  "carry on",
  "try again",
  "retry",
  "please do",
  "go for it",
  "ok go",
  "ok do it",
  "yes do it",
  "yes go ahead",
  "ok go ahead",
  "do the rest",
  "finish it",
  "same",
  "same thing",
  "next",
  "next one",
  "resume",
])
// Questions about Vector itself, read whole: "vector" in them is the subject, not a vocative.
const VECTOR_QUESTIONS = set([
  "who are you",
  "what are you",
  "what can you do",
  "what can you help with",
  "what can you help me with",
  "what model are you",
  "which model are you",
  "what model is this",
  "what model are you using",
  "whats your name",
  "what is your name",
  "who made you",
  "who built you",
  "what is vector",
  "whats vector",
  "who made vector",
  "who built vector",
  "who makes vector",
  "who created vector",
  "what does vector do",
  "what can vector do",
  "how does vector work",
  "how do i use vector",
  "how to use vector",
  "help",
  "are you an ai",
  "are you a bot",
  "are you human",
])
const REPLIES = [
  ["directive", DIRECTIVES],
  ["accept", ACCEPT],
  ["approve", APPROVALS],
  ["decline", DECLINES],
  ["ack", ACK],
  ["reaction", REACTIONS],
  ["thanks", THANKS],
] as const
// The strongest kind in a message of short replies wins: a "go ahead" or a "yes" anywhere continues the work, a "no"
// declines it, and a thanks or a greeting with only courtesy around it is social.
const PHRASE_ORDER = [
  "directive",
  "accept",
  "decline",
  "thanks",
  "farewell",
  "greeting",
  "vector",
  "emoji",
  "approve",
  "ack",
  "reaction",
] as const satisfies readonly Phrase[]
// The user reporting that it works, as typed: "it works now", "that fixed it", "thats what i wanted".
const SUCCESS =
  /^(?:(?:it|its|that|thats|this|everything|all|the (?:build|tests?|app|fix|deploy|site|page))(?: is| was| are| now)? )?(?:works?|worked|working|fixed|solved|resolved|passing|passes|passed|green|builds)(?: now| again| perfectly| great| fine| well| as expected| for me)*$|^(?:that|it|this) (?:did it|did the trick|fixed it|solved it|helped|was it)$|^thats (?:what i (?:wanted|needed)|perfect|exactly it|exactly what i wanted)$|^(?:problem solved|all set|all good now|looks good now)$/
// Words that make a thanks also a new ask: "thanks for that, can you now ...".
const ASKING = /\b(?:can|could|would|will|please|pls|now|also|next|then|but|need|want)\b/
const SOCIAL = new Set<Phrase>(["greeting", "thanks", "farewell", "emoji", "vector"])
const SOCIAL_REASONS = new Set(["greeting", "thanks", "farewell", "emoji", "about-vector"])
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\u200d|\ufe0f|[\u{1F3FB}-\u{1F3FF}]|\s)+$/u

const LOG_LINE =
  /^\s*(?:at\s+\S.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+)$|File ".+", line \d+|Traceback \(most recent call last\)|\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|npm (?:ERR!|WARN)|Caused by:|\s*\^+\s*$)/
const PATH =
  /(?:^|[\s"'(])(?:[\w@.-]+\/)+[\w@.-]+|\b[\w@-]+\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html|py|rb|go|rs|java|kt|swift|cc?|cpp|hpp?|cs|php|vue|svelte|astro|ya?ml|toml|sql|sh|txt|lock)\b/i
const PATH_GLOBAL = new RegExp(PATH.source, "gi")
const URL_PATTERN = /\bhttps?:\/\/\S+/i
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/

const NO_SUBAGENTS =
  /\b(?:no|don'?t|do not|without|never|skip(?: the)?)\s+(?:use\s+|using\s+|launch(?:ing)?\s+|spawn(?:ing)?\s+|any\s+|the\s+)*(?:sub-?agents?|parallel agents|agents)\b/
const NO_JUDGE =
  /\b(?:no|don'?t|do not|without|never|skip(?: the)?)\s+(?:use\s+|using\s+|run(?:ning)?\s+|the\s+|any\s+|an?\s+)*(?:llm[- ]as[- ]a[- ])?judge\b/
const SUBAGENTS = "(?:some |a few |multiple |several |parallel |many |the |\\d+ )?(?:sub-?agents?|parallel agents)"
const JUDGE = "(?:the |an? )?(?:llm[- ]as[- ]an?[- ])?judge"
// Each force word as an instruction: how a clause that asks for it starts, and what an imperative clause may say inside.
const FORCE: ReadonlyArray<readonly [code: string, start: RegExp, inside?: RegExp]> = [
  [
    "explicit:thorough",
    /^(?:be (?:very |extra |really |super |more |as |fully )?(?:thorough|exhaustive)|(?:do|give me|make it|run) (?:a |an )?(?:thorough|exhaustive|deep|in-depth|full) (?:job|pass|dive|review|audit|analysis|investigation|look)|(?:do a )?deep[- ]dive|go deep|dig deep|take your time)\b/,
    /\b(?:thoroughly|exhaustively)\b/,
  ],
  ["explicit:think", /^(?:ultrathink|think (?:hard|harder|deeply|very carefully|really hard))\b/],
  [
    "explicit:subagents",
    new RegExp(
      `^(?:use|using|launch|spin up|spawn|start|bring in|run|delegate to) ${SUBAGENTS}\\b|^split (?:it|this|the work) (?:across|between|among) ${SUBAGENTS}\\b`,
    ),
    new RegExp(`\\b(?:with|using|via|across) ${SUBAGENTS}$`),
  ],
  [
    "explicit:judge",
    new RegExp(
      `^(?:use|run|launch|bring in|have|get|call|start|ask|invoke|enable) ${JUDGE}\\b|^judge (?:it|this|that|the (?:work|result|results|change|changes|diff))$`,
    ),
    new RegExp(`\\b(?:with|using|via) ${JUDGE}$`),
  ],
]
// The words around an ask that are not the ask: "please", "can you", "just", "go ahead and".
const POLITE_START =
  /^(?:(?:please|pls|plz|kindly|now|then|also|just|ok|okay|so|alright|actually|quickly|go ahead and|can you|could you|would you|will you|can u|could u|i want you to|i'd like you to|id like you to|i need you to|make sure (?:to|you))\s+)+/
// Words a statement or a question starts with; an imperative clause starts with its verb instead.
const NOT_IMPERATIVE = new Set([
  "i",
  "i'm",
  "im",
  "i've",
  "i'd",
  "we",
  "we're",
  "you",
  "you're",
  "it",
  "it's",
  "its",
  "they",
  "they're",
  "he",
  "she",
  "this",
  "that",
  "these",
  "those",
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
  "their",
  "there",
  "here",
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "whose",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "should",
  "would",
  "could",
  "can",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "if",
  "because",
  "since",
  "although",
  "though",
  "as",
  "not",
  "no",
  "every",
  "all",
  "some",
  "any",
  "each",
])
// A pointer back at the work before: a pronoun, the agent's own plan or proposal, or one of the options it laid out.
const BACK =
  /\b(?:it|this|that|them|these|those|(?:the|your|that|this) (?:plan|above|proposal|suggestion|approach|recommendation|idea|version|design|draft|steps|phases|rest|same)|(?:option|phase|step|part|approach|choice|variant|alternative|stage) (?:\d+|[a-e]|one|two|three|four|five)|(?:the )?(?:first|second|third|fourth|fifth|last|other|former|latter|next) (?:one|option|approach|phase|step|choice|part))\b/
// Picking the work back up, at the start of a message.
const CONTINUING =
  /^(?:continue|proceed|resume|keep going|carry on|go on|finish|complete|do the rest|pick up where|pick it up|retry|try again)\b/
const CAP_LIGHT =
  /\b(?:quick question|briefly|just (?:answer|tell me|show me|run it)|tl;?dr|keep it (?:simple|short|light|quick)|in one line|one[- ]liner)\b/
// "Don't be thorough", "no need to go deep", "don't overthink it": the opposite of a force word.
const NOT_THOROUGH =
  /\b(?:no|don'?t|do not|no need to|needn'?t|without|stop)\s+(?:be(?:ing)?\s+|get(?:ting)?\s+|too\s+|so\s+|very\s+|overly\s+|super\s+|extra\s+|that\s+|a\s+)*(?:thorough(?:ly)?|exhaustive(?:ly)?|deep[- ]dive|go(?:ing)? (?:too )?deep|overthink(?:ing)?(?: it| this)?|over-?engineer(?:ing)?(?: it| this)?|think (?:too )?hard(?:er)?|take your time)\b/
const FILLER = /\b(?:please|pls|and|but|ok|okay|also|now|this|it|that|the|time|for|again|thanks|just|so)\b/

const SCALE = [
  /\b(?:re-?)?architect(?:ure|ing)?\b/,
  /\bmigrat(?:e|es|ing|ion)\b/,
  /\brefactor(?:s|ing)?\b/,
  /\brewrit(?:e|es|ing)\b/,
  /\bredesign(?:s|ing)?\b/,
  /\boverhaul(?:s|ing)?\b/,
  /\bport(?:ing)? (?:it|this|that|everything|(?:the|our|my) [\w-]+) (?:to|from|over)\b/,
  /\bre-?implement(?:s|ing|ation)?\b/,
  /\brestructur(?:e|es|ing)\b/,
  /\bmoderni[sz](?:e|es|ing|ation)\b/,
  /\bbreaking changes\b/,
  /\bupgrad(?:e|es|ing)\s+(?:\S+\s+){0,3}?to\s+(?:the\s+)?(?:[\w.@/-]+\s+)?(?:v(?:ersion)?\s*)?(?:\d|latest\b)/,
  /\b(?:works?|run|runs|usable|available) offline\b|\boffline[- ](?:first|support|mode)\b|\bmultiplayer\b|\breal[- ]?time (?:sync|collaboration)\b/,
  /\bmonorepo\b/,
  /\bmulti[- ]?file\b/,
  /\bend[- ]to[- ]end\b/,
  /\bproduction[- ]ready\b/,
  /\bfrom scratch\b/,
  /\bsecurity (?:audit|review)\b/,
  /\bperformance (?:audit|overhaul)\b/,
  /\bcodebase[- ]wide\b/,
]
// Every part of something: across it, all of a kind, every one of a kind, everywhere.
const WIDE =
  /\b(?:everywhere|across|throughout|(?:entire|whole)(?!\s+(?:function|method|file|class|component|line|paragraph|sentence|section|page|test|block|thing|message|string|word|comment|readme|doc|docstring|script|query|loop)\b)|every (?!(?:time|day|week|month|year|now|so|other|once|single time)\b)[\w-]+|all (?:the |of the |our |my )?(?:[\w-]+ )?(?:files|routes|pages|packages|components|endpoints|tests|modules|screens|services|apis|models|tables|views|controllers|handlers|hooks|classes|functions|imports|usages|calls|callers|queries|dependencies|deps|templates|commands|tools|plugins|providers|schemas|scripts|workflows|places|occurrences|instances|references|crates|libraries|apps|repos|repositories))\b/
// A whole system: the codebase, the repository or the entire app, as the place the work happens.
const SYSTEM =
  "app|apps|application|backend|back[- ]end|frontend|front[- ]end|codebase|code base|repo|repository|monorepo|project|site|website|ui|tui|cli|server|api|stack|system|product|platform|engine|extension"
const SYSTEM_SCOPE = new RegExp(
  `\\b(?:entire|whole|full|complete)\\s+(?:[\\w.-]+\\s+){0,2}?(?:${SYSTEM})\\b|\\b(?:across|throughout|all over|through|go through|sweep(?: through)?)\\s+(?:the |this |our |my )?(?:entire |whole )?(?:codebase|code base|repo|repository|monorepo|project|app|application)\\b|\\b(?:codebase|repo(?:sitory)?|project)[- ]wide\\b`,
)
// A rework verb, or "make" and "turn", aimed at a whole system: "port the TUI to ...", "rewrite the backend", "make the
// desktop app work offline". Not a part of one ("the app's icon", "the api key").
const SYSTEM_OBJECT = new RegExp(
  `\\b(?:(rewrit(?:e|ing)|redesign(?:ing)?|overhaul(?:ing)?|port(?:ing)?|switch(?:ing)?|convert(?:ing)?|rebuild(?:ing)?|re-?implement(?:ing)?|re-?architect(?:ing)?|restructur(?:e|ing)|moderni[sz](?:e|ing)|migrat(?:e|ing)|refactor(?:ing)?|upgrad(?:e|ing)|translat(?:e|ing))|make|turn)\\s+(?:the |this |our |my |your )?(?:entire |whole |full |complete )?(?:[\\w.-]+ ){0,2}?(?:${SYSTEM})\\b(?!['’]s\\b|\\s+(?:icon|logo|name|title|version|port|readme|config|description|badge|tagline|url|link|key|keys|token|client|call|calls|docs|route|endpoint|button|label|color|colour|font)\\b)`,
)
// Verbs that rework something that exists. "Port" and "switch" only as verbs: "port the app to ...", "switch the app".
const REWORK =
  /\b(?:rewrit(?:e|es|ing)|redesign(?:s|ing)?|overhaul(?:s|ing)?|convert(?:s|ing)?|rebuild(?:s|ing)?|re-?implement(?:s|ing)?|re-?architect(?:s|ing)?|restructur(?:e|es|ing)|moderni[sz](?:e|es|ing)|migrat(?:e|es|ing)|refactor(?:s|ing)?|upgrad(?:e|es|ing)|replac(?:e|es|ing)|translat(?:e|es|ing))\b|\bport(?:s|ing)? (?:it|this|that|the|our|my|all|everything)\b[^.?!\n]*\b(?:to|from|over|onto|into)\b|\bswitch(?:es|ing)? (?:the|our|my|this|that|all|every|everything|it|over)\b/
const COUNTED =
  /\b(\d{2,})\s+(?:\w+\s+)?(?:files|modules|routes|pages|components|tests|endpoints|packages|screens|services|tables|apis)\b/g
const ACROSS_COUNT = /\bacross\s+(\d{2,})\b/g
const FEATURES = {
  auth: /\b(?:auth|authentication|login|log in|sign[- ]?in|sign[- ]?up|oauth|sso|user accounts?)\b/,
  database: /\b(?:database|postgres|supabase|persistence|data model)\b/,
  payments: /\b(?:payments?|stripe|billing|checkout|subscriptions?)\b/,
  api: /\b(?:rest api|graphql|api endpoints?|backend)\b/,
  ui: /\b(?:dashboard|admin panel|admin page|landing page|frontend)\b/,
  tests: /\b(?:tests|test suite|ci pipeline|ci)\b/,
  deploy: /\b(?:deployment pipeline|hosting|vercel)\b/,
  notifications: /\b(?:notifications?|email alerts|emails)\b/,
  search: /\bsearch\b/,
  i18n: /\b(?:i18n|translations?|locali[sz]ation)\b/,
}
const BUILD =
  /\b(?:add|implement|build|create|write|integrate|support|set up|setup|wire up|develop|design|scaffold|introduce)\b/
const FIX = /\b(?:fix|debug|investigate|diagnose|repair|solve|resolve|troubleshoot)\b/
const EDIT =
  /\b(?:change|update|remove|delete|rename|replace|move|tweak|adjust|bump|edit|make|convert|clean up|format|lint)\b/
const ACTION =
  /\b(?:add|implement|build|create|write|integrate|fix|debug|refactor|update|change|remove|rename|replace|migrate|test|deploy|ship|make|move|convert|support|wire|set up|improve|optimi[sz]e)\b/
const SMALL_EDIT =
  /\b(?:typos?|spelling|misspell\w*|(?:fix|update|add|remove|delete|edit|change|reword|rewrite|tweak|clean up|correct|improve)\s+(?:the |a |an |this |that |these |those |my |some |its |their )?(?:[\w-]+ )?(?:comments?|docstrings?)|a comment|the comment|wording|copy text|readme|console\.log|log line|whitespace|indentation|version (?:number|bump)|bump (?:the )?version|lint (?:errors?|warnings?)|formatting|a label|the label|the title|the colou?r|padding|margin|font size)\b/
const OPERATION =
  /\b(?:deploy|ship|publish|preview|release|roll ?back|commit|push|pull|merge|rebase|stash|install|uninstall)\b|\b(?:npm|bun|pnpm|yarn) (?:add|remove|i)\b|\b(?:run|start|restart|stop|kick off|rerun|re-run) (?:the |all |my )?(?:tests?|test suite|build|dev server|server|app|linter|lint|typecheck|type check|migrations?|script|command)\b|\bbuild (?:it|this|the (?:app|project|repo|repository|site|package))\b|\b(?:open|create|make|raise) (?:a |the )?(?:pr|pull request)\b/
// A question about the code: a wh-word or a request to explain, or an auxiliary question that ends in "?". "Do the rest"
// and "find the bug" are instructions, not questions.
const QUESTION = /^(?:what|where|why|how|when|which|who|whose|explain|describe|tell me|walk me through|summari[sz]e)\b/
const AUX_QUESTION =
  /^(?:is|are|does|do|did|was|were|has|have|had|should|would|could|can|will|shall|may|might|isn'?t|aren'?t|doesn'?t|don'?t|didn'?t)\b/
const REQUEST = /^(?:can you|could you|would you|will you|please|pls|can u|could u)\b/
// What makes a small action more than one: a scope over many places, or a count of them.
const SCOPE =
  /\b(?:every(?:thing|where|one|body)?|entire(?:ly)?|whole|across|throughout|all over|codebase|code base|monorepo|(?:repo|repository|project)[- ]wide|all (?:the |of the |our |my |of our )?(?!(?:changes|tests?|specs?|of it|of them)\b)[\w-]+|\d+\s+(?:\w+\s+)?(?:files|modules|routes|pages|components|packages|repos|repositories|services|apps))\b/
// A failure, or a question about one, is never a small action: it needs looking into first.
const FAILURE =
  /\b(?:fail\w*|(?<!spelling )errors?|erroring|exceptions?|broken|broke|break\w*|regress\w*|bugs?|buggy|crash\w*|wrong|issues?|problems?|not work\w*|doesn'?t|won'?t|can'?t|isn'?t|aren'?t|didn'?t|why|how|[45]\d\d)\b/
// The small actions a Light request may be made of. Each one is its verb and its own object, matched against a whole
// clause: what it deploys and where, the package it installs, the branch or flag of a git step, the script it runs.
// Nothing may follow the object, so "build the app with next.js", "deploy a new microservice for billing", "git bisect
// to find the commit that broke login" and "run the migration that splits the users table" are not small actions.
// Words that join a second idea onto an action ("with ...", "for ...", "after ...", "to find ...", "that ..."): an
// object never contains one.
const LINK =
  "(?:a|an|and|or|but|with|without|for|after|before|while|when|once|until|unless|if|so|that|which|who|where|about|using|via|by|like|then|to|into|onto|in|on|of|from|than|because|instead)"
// One word of an object: a name, a path, a version or a ref.
const WORD = `(?!${LINK}\\b)[\\w@./:#~^+=-]+`
// Where an action goes: "to vercel", "to the app store", "onto main".
const TARGET = `(?:to|on|onto|into) (?:the )?${WORD}(?: ${WORD})?`
// What a deploy, a publish or a ship may name: what is already built, a version, or a named package or app.
const DEPLOYABLE = `(?:it|this|that|them|v?\\d[\\w.-]*|(?:the |my |our |this )?(?:app|site|website|backend|frontend|api|server|docs|build|changes|branch|fix|hotfix|release|latest(?: version| changes)?|preview|package|worker|functions?|project|code|update|new version|current branch)|[\\w@]+[./@-][\\w./@-]*)`
// What a git step may name: a flag, a ref or a branch, a remote, or what it commits or pushes.
const GIT_ARG = `(?:-{1,2}[\\w-]+(?:=\\S+)?|\\w*[\\d./_@#:~^-][\\w./_@#:~^-]*|main|master|origin|upstream|head|dev|develop|staging|prod|production|trunk|it|this|that|them|everything|the|my|all|last|latest|current|(?:changes|commits?|tags?|branch|branches|fix|work|files?|updates?|stash)|${WORD} branch|${TARGET}|(?:from|off|off of) (?:the )?${WORD})`
const RUNNABLE =
  "(?:tests?|test suite|suite|specs?|build|linter|lint|typecheck|type ?check|type-check|formatter|prettier|eslint|biome|dev server|server|app|migrations?|script|seed|codegen|benchmarks?|storybook)"
// A file or a path the action runs on: "packages/core", "utils.ts".
const PATHY = "[\\w@.-]*[/.][\\w@./-]+"
const ARG = `(?!${LINK}\\b)\\S+`
// A package name, never "the" or a linking word.
const PACKAGE = `(?!(?:the|${LINK})\\b)[@\\w][\\w@/.^~=:-]*`
const PACKAGE_ONLY = new RegExp(`^${PACKAGE}$`)
const INSTALL = new RegExp(
  `^(?:(?:npm|bun|pnpm|yarn) (?:install|i|add|remove|uninstall)|install|uninstall|reinstall)(?: (?:-{1,2}[\\w-]+|${PACKAGE})){0,6}$|^(?:add|remove) (?:the )?${PACKAGE} (?:package|dependency|dev ?dependency|dep|library)$`,
)
const SMALL_ACTIONS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["operation", INSTALL],
  ["operation", new RegExp(`^(?:re-?deploy|deploy|publish|ship)(?: ${DEPLOYABLE})?(?: ${TARGET})?$`)],
  [
    "operation",
    new RegExp(
      `^(?:git )?commit(?: ${GIT_ARG}){0,3}(?: (?:with|using) (?:a |an |the )?(?:${WORD} )?(?:commit )?message\\b.*| -m .+)?$`,
    ),
  ],
  [
    "operation",
    new RegExp(
      `^(?:git (?!${LINK}\\b)[\\w-]+(?: (?:pop|apply|drop|list|show|add|remove|set-url|start|reset|good|bad))?|push|force[- ]push|pull|fetch|rebase|amend|squash|tag|cherry[- ]pick|checkout|check out)(?: ${GIT_ARG}){0,4}$`,
    ),
  ],
  ["operation", new RegExp(`^stash(?: (?:pop|apply|drop|list|show|push|save|clear))?(?: ${GIT_ARG}){0,2}$`)],
  [
    "operation",
    /^merge(?: (?:main|master|dev|develop|origin\/\S+|upstream|it|this|the (?:pr|pull request|branch|changes)|(?:the |this )?\S+ branch|#?\d+))?(?: (?:into|in|to|with) \S+(?: branch)?)?$/,
  ],
  [
    "operation",
    new RegExp(
      `^(?:switch|change) to (?:the )?${WORD}(?: branch)?$|^(?:create|make|start|open) (?:a )?(?:new )?branch(?: (?:called|named) ${WORD}| ${WORD})?(?: (?:from|off|off of) ${WORD})?$`,
    ),
  ],
  [
    "operation",
    new RegExp(
      `^(?:open|create|make|raise|draft|submit|file) (?:a |the )?(?:draft |new )?(?:pr|pull request)(?: (?:for|to|against|into|on|from) (?:the |this |my )?${WORD}(?: branch)?)?$`,
    ),
  ],
  [
    "operation",
    new RegExp(
      `^(?:run|rerun|re-run|start|restart|stop|kick off|execute|launch) (?:the |all the |all |my |our )?(?:${WORD} )?${RUNNABLE}(?: (?:for|in|on|against|of) (?:the )?${WORD}(?: ${WORD})?| -{1,2}\\S+| ${PATHY}){0,2}$`,
    ),
  ],
  [
    "operation",
    new RegExp(
      `^(?:run|execute) (?:\`[^\`]+\`|(?:npm|bun|bunx|pnpm|yarn|npx|make|cargo|go|python3?|pytest|deno|node|just|turbo|uv|uvx|docker)(?: ${ARG}){0,6}|\\S+\\.(?:sh|py|ts|js|mjs|rb)(?: ${ARG}){0,4})$|^(?:npm|bun|bunx|pnpm|yarn|npx)(?: ${ARG}){1,5}$`,
    ),
  ],
  [
    "operation",
    /^build(?: (?:it|this|that|(?:the |my |our )(?:app|project|repo|repository|site|package|packages|docs|image|binary|container|frontend|backend|cli|extension)))?(?: for (?:prod|production|release|dev|development|debug|ios|android|web|windows|mac|macos|linux))?$/,
  ],
  [
    "small-edit",
    new RegExp(
      `^(?:fix|correct) (?:the |a |an |this |that |these |those |some |two |three |\\d+ |my |its )?(?:typos?|spelling(?: mistakes?| errors?)?|misspellings?|misspelled ${WORD})(?: (?:in|on) (?:the |this |my |our )?${WORD}(?: ${WORD})?)?$`,
    ),
  ],
  [
    "small-edit",
    // Renaming one thing, never the whole app or repository.
    new RegExp(
      `^rename (?:the )?(?:(?!(?:${SYSTEM})\\b)${WORD} )?(?!(?:${SYSTEM})\\b)${WORD} (?:to|as) ${WORD}(?: (?:in|on) (?:the )?${WORD})?$`,
    ),
  ],
  [
    "small-edit",
    new RegExp(
      `^(?:format|reformat|prettify|lint)(?: (?:it|this|that|everything|the (?:file|files|code|project|repo)|\\S+\\.\\w+))?(?: with \\S+)?$|^fix (?:the )?(?:formatting|indentation|whitespace)(?: (?:in|of|on) (?:the |this )?${WORD}(?: ${WORD})?)?$`,
    ),
  ],
  [
    "small-edit",
    new RegExp(
      `^(?:bump|increment|update|set) (?:the )?(?:package |app )?version(?: number)?(?: (?:to|of) (?:the )?${WORD}(?: ${WORD})?)?$`,
    ),
  ],
]
// A deadlock, a race, a leak, a hang or a crash, and "why does ... fail": problems that take real investigation.
const HARD_FAILURE =
  /\b(?:dead-?lock(?:s|ed|ing)?|live-?lock(?:s|ed|ing)?|race conditions?|racy|races?|memory leaks?|leak(?:s|ing|ed)?|hang(?:s|ing)?(?! on\b| tight\b)|hung|freez(?:e|es|ing)|frozen|crash(?:es|ing|ed)?|segfaults?|segmentation fault|flak(?:y|iness)|intermittent(?:ly)?|non-?deterministic|stall(?:s|ing|ed)?|stuck|corrupt(?:s|ed|ion)?|out of memory|oom|infinite loop)\b/
const WHY_FAIL =
  /^why (?:does|do|did|is|are|was|were|would|might)\b.*\b(?:fail\w*|break\w*|broken|errors?|erroring|throw\w*|time[sd]? ?out|timing out|slow\w*|wrong|stop\w*|exit\w*|not work\w*)\b|^why (?:doesn'?t|won'?t|isn'?t|aren'?t|can'?t|don'?t|didn'?t|wasn'?t)\b/
const ASKS =
  /\b(?:shall i|should i|shall we|should we|want me to|want me|would you like|would you prefer|do you want|let me know|if you(?:'d| would)? (?:like|want|prefer|wish)|if you want|ready to (?:proceed|go|publish|deploy)|confirm|approve|okay to|ok to|go ahead\?|i (?:can|could) also|we (?:can|could) also|next,? i(?:'d| would|'ll| will| can| could| plan to)|i(?:'d)? (?:recommend|suggest)|happy to|the next steps? (?:would|is|are|could)|i can (?:go ahead|take care of|do that|handle))\b/
// Closing courtesies that offer no particular work, a greeting reply's "How can I help?" included. Each is a whole
// sentence: one that names work ("What would you like me to do first?") asks something.
const PLEASANTRY =
  /^(?:(?:is there )?(?:anything|something) else(?: (?:i can (?:help(?: you)? with|do(?: for you)?)|you(?:'d| would)? like(?: me to (?:do|help with|look at))?|you need(?: help with)?|on your mind))?|(?:do you have )?any (?:other |more |further )?questions|(?:let me know|feel free to (?:ask|reach out|let me know)|just let me know) if (?:you (?:need|have|want) )?(?:anything else|any (?:other |more |further )?(?:questions|changes|help))(?: (?:i can help with|you need))?|if you need anything else(?:, (?:just )?let me know)?|(?:how can i|how may i) help(?: you)?(?: today| further)?|what can i (?:help(?: you)? with|do for you)(?: today)?|what (?:would you like|do you want)(?: me)? to (?:work on|do)(?: today)?|what are we working on(?: today)?|happy to help(?: further| with anything else)?|hope (?:this|that) helps)$/
// An offer of more, optional work in a reply's closing question or sentence.
const OFFER =
  /\b(?:want me to|would you like me to|do you want me to|should i also|shall i also|i (?:can|could) also|if you(?:'d| would)? like,? i (?:can|could)|if you want,? i (?:can|could)|let me know if you(?:'d| would)? like me to|happy to (?:also )?(?:add|update|write|do|make|look|take|help))\b/
const CLOUD =
  /\b(?:vercel|supabase|deploy\w*|ship (?:it|this|to)|publish\w*|preview|production|prod|rollback|roll back|env vars?|environment variables?|database|db|auth|login|log in|sign[- ]?in|sign[- ]?up|domain|hosting|hosted)\b/
const BROWSER =
  /\b(?:browser|page|screen|screenshot|ui|ux|layout|css|styles?|styling|localhost|click|button|form|looks?|visual(?:ly)?|render(?:s|ing)?|dark mode|responsive|mobile view)\b/
