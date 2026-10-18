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
  const bare = plain && !PATH.test(raw) && !URL_PATTERN.test(raw) && !raw.includes("`") && text.length <= 60
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

  // A reply inside the work before it keeps that work's size and never lowers it: anything sent while that work is
  // still open, and a "yes", a "continue" or a "go ahead, ..." at any time. A whole-message reply takes the size as it
  // is; a longer one is raised by what it asks for itself.
  if (previous && (phrase === "accept" || phrase === "directive" || input.open || continuing(lower))) {
    const tier = phrase ? previous : max(previous, own ?? previous)
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
  // A closing pleasantry ("Anything else?", "Let me know if you need anything else.") offers nothing to answer.
  const tail = sentences(text.trim().slice(-600))
    .filter((sentence) => !PLEASANTRY.test(sentence.toLowerCase()))
    .join(" ")
    .slice(-400)
    .toLowerCase()
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
  return !PLEASANTRY.test(tail.slice(start).toLowerCase())
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
  if (question && !fixing) return { thorough: [], standard: [...thorough, ...standard], light: [] }
  return { thorough, standard, light: standard.length > 0 ? [] : light(lower, input) }
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
    const install = index > 0 && INSTALL.test(polite(list[index - 1]!)) && PACKAGE.test(clause.trim())
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
    return kinds !== undefined && (kinds.has("accept") || kinds.has("directive"))
  })
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
  return text
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(collapse)
}

function sentences(text: string) {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim())
}

type Phrase = "greeting" | "thanks" | "farewell" | "reaction" | "ack" | "accept" | "directive" | "vector" | "emoji"

function chatPhrase(lower: string): Phrase | undefined {
  if (EMOJI_ONLY.test(lower)) return "emoji"
  const all = words(lower)
  const trimmed = dropVocatives(all)
  if (trimmed.length === 0) return all.length > 0 ? "greeting" : undefined
  const phrase = collapse(trimmed.join(" "))
  if (VECTOR_QUESTIONS.has(phrase)) return "vector"
  // "hi there, how are you" and "hey vector what's up": a greeting with an optional how-are-you.
  const greeting = [...GREETINGS].find((item) => phrase === item || phrase.startsWith(`${item} `))
  const after = greeting ? phrase.slice(greeting.length).trim() : undefined
  if (greeting && (after === "" || (after !== undefined && SMALL_TALK.has(dropVocatives(after.split(" ")).join(" ")))))
    return "greeting"
  if (SMALL_TALK.has(phrase)) return "greeting"
  if (THANKS.has(phrase)) return "thanks"
  if (FAREWELLS.has(phrase)) return "farewell"
  if (THANKS.has(dropTrailing(phrase))) return "thanks"
  // "sounds good, go ahead" or "yes please do": replies built only from short replies take the strongest of them.
  const kinds = replyKinds(phrase.split(" "))
  if (!kinds) return undefined
  return (["directive", "accept", "thanks", "ack", "reaction"] as const).find((kind) => kinds.has(kind))
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
  const start = words.findIndex((word) => !VOCATIVES.has(word))
  if (start === -1) return []
  const end = words.findLastIndex((word) => !VOCATIVES.has(word))
  return words.slice(start, end + 1)
}

function dropTrailing(phrase: string) {
  return phrase.replace(/ (?:so much|a lot|again|man|dude|bro|mate)$/, "")
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

const VOCATIVES = new Set(["vector", "there", "team", "everyone", "all", "buddy", "friend", "mate", "guys", "folks"])
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
  "lgtm",
  "sounds good",
  "looks good",
  "noted",
  "sounds great",
  "looks great",
  // Declines answer an offer the same way: "no thanks" to "Want me to also update the docs?".
  "no",
  "nope",
  "nah",
  "no thanks",
  "no thank you",
  "not now",
  "not yet",
  "maybe later",
  "thats all",
  "all good",
  "im good",
  "were good",
  "nothing else",
  "no need",
  "never mind",
  "nevermind",
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
  "help",
  "are you an ai",
  "are you a bot",
])
const REPLIES = [
  ["directive", DIRECTIVES],
  ["accept", ACCEPT],
  ["ack", ACK],
  ["reaction", REACTIONS],
  ["thanks", THANKS],
] as const
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
  /\b(?:deploy|ship|publish|preview|release|roll ?back|commit|push|pull|merge|rebase|stash|install|uninstall)\b|\b(?:run|start|restart|stop|kick off|rerun|re-run) (?:the |all |my )?(?:tests?|test suite|build|dev server|server|app|linter|lint|typecheck|type check|migrations?|script|command)\b|\bbuild (?:it|this|the (?:app|project|repo|repository|site|package))\b|\b(?:open|create|make|raise) (?:a |the )?(?:pr|pull request)\b/
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
  /\b(?:fail\w*|(?<!spelling )errors?|erroring|exceptions?|broken|break\w*|bugs?|buggy|crash\w*|wrong|issues?|problems?|not work\w*|doesn'?t|won'?t|can'?t|isn'?t|aren'?t|didn'?t|why|how|[45]\d\d)\b/
const INSTALL =
  /^(?:(?:npm|bun|pnpm|yarn) (?:install|i|add|remove|uninstall)|install|uninstall|reinstall)(?:\s+\S+){0,6}$|^(?:add|remove) (?:the )?\S+ (?:package|dependency|dev ?dependency|dep)(?:\s+\S+){0,4}$/
const PACKAGE = /^[@\w][\w@/.^~-]*$/
// The small actions a Light request may be made of. Each is matched against a whole clause, so "run the tests and fix
// what fails" or "merge the two config loaders" is not one.
const SMALL_ACTIONS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["operation", INSTALL],
  ["operation", /^(?:re-?)?deploy(?:\s+\S+){0,6}$|^publish(?:\s+\S+){0,6}$/],
  ["operation", /^ship (?:it|this|that|them|the (?:app|site|build|release|changes|branch|fix)|to \S+)(?:\s+\S+){0,4}$/],
  [
    "operation",
    /^(?:commit|push|force[- ]push|rebase|stash|amend|cherry[- ]pick|squash|tag|checkout|check out|git \S+)(?:\s+\S+){0,8}$/,
  ],
  [
    "operation",
    /^pull(?: (?:the )?(?:latest|changes|main|master|origin|upstream))?(?:\s+\S+){0,3}$|^fetch(?: (?:origin|upstream|all|--all|the latest|main|tags))?$/,
  ],
  [
    "operation",
    /^merge(?: (?:main|master|dev|develop|origin\/\S+|upstream|it|this|the (?:pr|pull request|branch|changes)|(?:the |this )?\S+ branch|#?\d+))?(?: (?:into|in|to|with) \S+(?: branch)?)?$/,
  ],
  [
    "operation",
    /^(?:switch|change) to (?:the )?\S+ branch$|^(?:create|make|start|open) (?:a )?(?:new )?branch(?:\s+\S+){0,4}$/,
  ],
  ["operation", /^(?:open|create|make|raise|draft|submit|file) (?:a |the )?(?:draft )?(?:pr|pull request)(?:\s+\S+){0,8}$/],
  [
    "operation",
    /^(?:run|rerun|re-run|start|restart|stop|kick off|execute|launch) (?:the |all the |all |my |our )?(?:unit |e2e |integration |focused )?(?:tests?|test suite|specs?|build|linter|lint|typecheck|type ?check|type-check|formatter|prettier|eslint|biome|dev server|server|app|migrations?|script|seed|codegen|benchmarks?|storybook)(?:\s+\S+){0,6}$/,
  ],
  [
    "operation",
    /^(?:run|execute) (?:`[^`]+`|(?:npm|bun|bunx|pnpm|yarn|npx|make|cargo|go|python3?|pytest|deno|node|just|turbo|uv|docker)\b|\S+\.(?:sh|py|ts|js|mjs|rb)\b)(?:\s+\S+){0,6}$|^(?:npm|bun|bunx|pnpm|yarn|npx) \S+(?:\s+\S+){0,5}$/,
  ],
  ["operation", /^build (?:it|this|the (?:app|project|repo|repository|site|package|docs|image|binary|container))(?:\s+\S+){0,4}$/],
  [
    "small-edit",
    /^(?:fix|correct) (?:the |a |an |this |that |these |those |some |two |three |\d+ |my |its )?(?:typos?|spelling(?: mistakes?| errors?)?|misspellings?|misspelled \S+)(?:\s+\S+){0,6}$/,
  ],
  ["small-edit", /^rename(?:\s+\S+){1,8}$/],
  [
    "small-edit",
    /^(?:format|reformat|prettify|lint)(?: (?:it|this|that|everything|the (?:file|files|code|project|repo)|\S+\.\w+))?(?: with \S+)?$|^fix (?:the )?(?:formatting|indentation|whitespace)(?:\s+\S+){0,6}$/,
  ],
  ["small-edit", /^(?:bump|increment|update|set) (?:the )?(?:package |app )?version(?: number)?(?:\s+\S+){0,4}$/],
]
// A deadlock, a race, a leak, a hang or a crash, and "why does ... fail": problems that take real investigation.
const HARD_FAILURE =
  /\b(?:dead-?lock(?:s|ed|ing)?|live-?lock(?:s|ed|ing)?|race conditions?|racy|races?|memory leaks?|leak(?:s|ing|ed)?|hang(?:s|ing)?(?! on\b| tight\b)|hung|freez(?:e|es|ing)|frozen|crash(?:es|ing|ed)?|segfaults?|segmentation fault|flak(?:y|iness)|intermittent(?:ly)?|non-?deterministic|stall(?:s|ing|ed)?|stuck|corrupt(?:s|ed|ion)?|out of memory|oom|infinite loop)\b/
const WHY_FAIL =
  /^why (?:does|do|did|is|are|was|were|would|might)\b.*\b(?:fail\w*|break\w*|broken|errors?|erroring|throw\w*|time[sd]? ?out|timing out|slow\w*|wrong|stop\w*|exit\w*|not work\w*)\b|^why (?:doesn'?t|won'?t|isn'?t|aren'?t|can'?t|don'?t|didn'?t|wasn'?t)\b/
const ASKS =
  /\b(?:shall i|should i|shall we|should we|want me to|want me|would you like|would you prefer|do you want|let me know|if you(?:'d| would)? (?:like|want|prefer|wish)|if you want|ready to (?:proceed|go|publish|deploy)|confirm|approve|okay to|ok to|go ahead\?|i (?:can|could) also|we (?:can|could) also|next,? i(?:'d| would|'ll| will| can| could| plan to)|i(?:'d)? (?:recommend|suggest)|happy to|the next steps? (?:would|is|are|could)|i can (?:go ahead|take care of|do that|handle))\b/
// Closing courtesies that offer no particular work, a greeting reply's "How can I help?" included.
const PLEASANTRY =
  /\b(?:anything else|something else|anything more|any other (?:changes|questions|tasks)|any questions|further (?:help|questions|changes)|help with anything|how can i help|what can i (?:help(?: you)? with|do for you)|what would you like(?: me)? to (?:work on|do)|what are we working on)\b/
const CLOUD =
  /\b(?:vercel|supabase|deploy\w*|ship (?:it|this|to)|publish\w*|preview|production|prod|rollback|roll back|env vars?|environment variables?|database|db|auth|login|log in|sign[- ]?in|sign[- ]?up|domain|hosting|hosted)\b/
const BROWSER =
  /\b(?:browser|page|screen|screenshot|ui|ux|layout|css|styles?|styling|localhost|click|button|form|looks?|visual(?:ly)?|render(?:s|ing)?|dark mode|responsive|mobile view)\b/
