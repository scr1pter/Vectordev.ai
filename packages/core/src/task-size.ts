export * as TaskSize from "./task-size"

import type { Choice, Tier } from "@vectordevai/schema/task-size"

export { Tier, Choice, JudgeMode } from "@vectordevai/schema/task-size"

// Sizes a request with no model call, so "hi" gets one direct reply and only work that the user or the agent calls large
// brings in subagents and the judge. The engine, the V2 runner, the app and desktop all use this one classifier.
//
// It is built so that a wrong guess costs little and never cripples work:
// - Chat (one direct reply, no tools) is only a social message, and never while work waits on the user.
// - Everything else is Work: every tool but subagents, at the provider's default effort. Light and Standard behave the
//   same, except that Light, a size only a sender picks, skips the to-do list.
// - Thorough (subagents, high effort, the judge) comes only from the user's own ask in the message, from the agent's
//   escalate call, or from a message that continues Thorough work. Never from words about the work's scope.

/** Reasoning effort for a request when the user left effort on its default. */
export type Effort = "off" | "default" | "high"

/** Where a size came from: Vector's rules, the sender's own choice, or the work the message continues. */
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
  /** The size of the work before this message: the last request in the session that was not Chat. */
  readonly previous?: Tier
  /**
   * Whether the request right before this message is still open: its reply asked or offered something, or its run did
   * not finish (it was interrupted, failed or stopped). Then the message answers or follows up that work, so it is
   * never a bare reply, and it continues that work at its size.
   */
  readonly open?: boolean
  /** The request asks for structured output, which needs a tool call. */
  readonly structured?: boolean
  /** false turns automatic sizing off: every request gets the full harness unless the sender picks a size. */
  readonly auto?: boolean
}

export type Result = {
  readonly tier: Tier
  readonly source: Source
  /** Stable reason codes, such as "greeting", "work" or "explicit:thorough"; clients turn them into copy. */
  readonly reasons: readonly string[]
  /** false when the user said to skip the judge for this request. */
  readonly judge: boolean
  /** Subagents the user named; they may be launched below Thorough. */
  readonly agents: readonly string[]
}

const ORDER = { chat: 0, light: 1, standard: 2, thorough: 3 } as const satisfies Record<Tier, number>

export function rank(tier: Tier) {
  return ORDER[tier]
}

export function max(a: Tier, b: Tier): Tier {
  return ORDER[a] >= ORDER[b] ? a : b
}

export function effort(tier: Tier): Effort {
  if (tier === "chat") return "off"
  if (tier === "thorough") return "high"
  return "default"
}

/** User-facing name of a size. */
export function label(tier: Tier) {
  return { chat: "Chat", light: "Light", standard: "Standard", thorough: "Thorough" }[tier]
}

/**
 * Built-in tools a request of this size is not offered. Chat is offered no tools at all and goes out on its own lane,
 * so this is for Work and Thorough. MCP, plugin and custom tools are never removed: the user installed them.
 */
export function withheld(tier: Tier, agents = 0): ReadonlySet<string> {
  if (tier === "thorough") return new Set()
  return new Set([
    // A subagent the user named keeps the task tool; only that subagent may run.
    ...(agents > 0 ? [] : ["task", "task_manage"]),
    // Light is a small action the sender picked: it skips the to-do list, and nothing else.
    ...(tier === "light" ? ["todowrite"] : []),
  ])
}

/**
 * The size guidance attached to a request's user message. It is worked out from that request alone, so a message renders
 * the same on every later request and the provider's prompt cache keeps it.
 */
export function note(tier: Tier, options: { readonly escalate: boolean; readonly judge: boolean }) {
  const escalate = options.escalate
    ? " If the work turns out large (the whole system, or independent parts of roughly five or more files that would be cheaper split up), call escalate with your reason."
    : ""
  if (tier === "light")
    return `<task_size>Light request: do it directly, without a to-do list. Subagents are not offered.${escalate}</task_size>`
  if (tier === "standard")
    return `<task_size>Standard request: do the work yourself and keep a short to-do list for multi-step work. Subagents are not offered.${escalate}</task_size>`
  if (tier === "thorough")
    return `<task_size>Thorough request: plan with the to-do list, split independent substantial parts across subagents when that is cheaper, and verify with the strongest checks available.${options.judge ? " Vector runs the judge after you finish, so do not launch it yourself." : ""}</task_size>`
  // A greeting goes out on the quick lane, which carries no note.
  return undefined
}

export function classify(input: Input): Result {
  const text = prose(input.text)
  const lower = text.toLowerCase().replace(/[’‘]/g, "'")
  const agents = [...new Set(input.agents ?? [])]
  // A greeting before this message is not work it could continue.
  const previous = input.previous === "chat" ? undefined : input.previous
  const result = (tier: Tier, source: Source, reasons: readonly string[], judge = true): Result => ({
    // A structured answer needs its tool and a named subagent needs the task tool, so neither is ever a bare reply.
    tier: tier === "chat" && (input.structured || agents.length > 0) ? "standard" : tier,
    source,
    reasons,
    judge,
    agents,
  })

  if (input.choice && input.choice !== "auto") return result(input.choice, "user", ["user"])
  if (input.auto === false) return result("thorough", "auto", ["auto-off"])

  // The user's own "no subagents", "skip the judge" and "don't be thorough" come out first, so they never read as the
  // ask itself. "No subagents" and "don't be thorough" keep the request at Work, Thorough work it continues included.
  const noJudge = NO_JUDGE.test(lower)
  const capped = NO_SUBAGENTS.test(lower) || NOT_THOROUGH.test(lower)
  // A force word counts only as the user's instruction about this request: a clause that asks for it ("be thorough",
  // "use subagents", "run the judge"), never a mention ("fix the bug with subagents not starting").
  const forced = instructions([NO_SUBAGENTS, NO_JUDGE, NOT_THOROUGH].reduce(strip, lower))
  if (forced.length > 0) return result(capped ? "standard" : "thorough", "user", forced, !noJudge)

  // A greeting, thanks, a farewell, emoji, small talk or a question about Vector is a direct reply, unless work is
  // waiting on the user: then it answers or follows up that work.
  const kind = socialKind(input, text, lower)
  if (kind && !input.open) return result("chat", "auto", [kind])

  // Everything else is Work. A message continues the work before it when that work is still open, or when it reads as
  // a follow-up: a short message, or one that starts by answering ("yes, ...", "no, use postgres instead ...", "looks
  // good, ..."). Continuing Thorough work keeps it Thorough, so a reply, an approval or "build the app" after a large
  // plan still has subagents and the judge. Nothing in a message lowers Work: "keep it simple" or "quick question"
  // shapes the answer, not the tools.
  const follows =
    input.open === true ||
    (previous !== undefined && (text.split(/\s+/).filter(Boolean).length <= FOLLOW_UP_WORDS || REPLY.test(lower)))
  const reasons = [follows ? (input.open ? "answer" : "continue") : "work", ...(kind ? [kind] : [])]
  const tier = previous === "thorough" && follows && !capped ? "thorough" : "standard"
  return result(tier, follows && previous ? "inherited" : "auto", reasons, !noJudge)
}

/** Whether an assistant's closing text asks the user for a decision or offers more work, so the next message answers it. */
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

type Kind = "greeting" | "thanks" | "farewell" | "reaction" | "success" | "about-vector" | "emoji"

// A short message of prose, every clause of it social: "thanks, that works", "hey, how are you doing today?", "ok
// thanks bye". Any clause that is something else ("thanks, now fix the other one", "thanks but it's still broken")
// makes it not social. The strongest kind names it.
function socialKind(input: Input, text: string, lower: string): Kind | undefined {
  if (input.files || input.images || (input.agents?.length ?? 0) > 0) return
  if (PATH.test(input.text) || URL_PATTERN.test(input.text) || input.text.includes("`") || text.length > 80) return
  if (EMOJI_ONLY.test(lower)) return "emoji"
  const all = words(lower)
  // A question about Vector is read whole first, so the "vector" in "what is vector?" is not dropped as a name.
  if (VECTOR_QUESTIONS.has(all.join(" "))) return "about-vector"
  // Only a name or two ("vector?", "hey there" without the hey): someone checking that Vector is there.
  if (all.length > 0 && dropVocatives(all).length === 0) return "greeting"
  const kinds = clauses(lower).map(clauseKinds)
  if (kinds.length === 0 || kinds.some((kind) => kind === undefined)) return
  const found = new Set(kinds.flatMap((kind) => [...(kind ?? [])]))
  return SOCIAL_ORDER.find((kind) => found.has(kind))
}

function clauseKinds(clause: string): ReadonlySet<Kind> | undefined {
  const typed = plainWords(clause)
  const all = typed.map(collapse)
  if (all.length === 0) return new Set()
  if (VECTOR_QUESTIONS.has(all.join(" "))) return new Set(["about-vector"])
  const trimmed = dropVocatives(typed).join(" ")
  // "it works now", "that fixed it": the user reporting back.
  if (SUCCESS.test(trimmed)) return new Set(["success"])
  if (thanked(trimmed)) return new Set(["thanks"])
  return sequence(all)
}

// A thanks with what it thanks for ("thanks for the fix", "thank you for fixing that"), but never a new ask hidden in
// it ("thanks for that, can you now add tests").
function thanked(typed: string) {
  const match = /^(.+?) for (.+)$/.exec(typed)
  if (!match) return false
  const lead = sequence(words(match[1]!))
  const rest = match[2]!
  return lead?.has("thanks") === true && rest.split(" ").length <= 6 && !ASKING.test(rest)
}

// Splits a clause into known social phrases, longest first, or gives up when any word is left over. A filler ("ok",
// "again", a name) may sit between them but is not social on its own.
function sequence(words: readonly string[]): ReadonlySet<Kind> | undefined {
  if (words.length === 0) return new Set()
  return [4, 3, 2, 1]
    .filter((size) => size <= words.length)
    .map((size) => {
      const kind = PHRASES.find(([, items]) => items.has(words.slice(0, size).join(" ")))?.[0]
      const rest = kind ? sequence(words.slice(size)) : undefined
      return kind && rest ? new Set<Kind>([...(kind === "filler" ? [] : [kind]), ...rest]) : undefined
    })
    .find((kinds) => kinds !== undefined)
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

function strip(text: string, pattern: RegExp) {
  return text.replace(new RegExp(pattern.source, "g"), " ")
}

function dropVocatives(words: readonly string[]) {
  const start = words.findIndex((word) => !VOCATIVES.has(collapse(word)))
  if (start === -1) return []
  const end = words.findLastIndex((word) => !VOCATIVES.has(collapse(word)))
  return words.slice(start, end + 1)
}

// Letters typed more than once in a row ("hiii", "heyyy", "thanksss") match their plain spelling. Both sides of every
// comparison go through it, so "good" and "god" never need telling apart.
function collapse(value: string) {
  return value.replace(/(\p{L})\1+/gu, "$1")
}

function set(items: readonly string[]) {
  return new Set(items.map(collapse))
}

// Pasted code and logs say what went wrong, not how much the user wrote, so only prose counts.
function prose(text: string) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !LOG_LINE.test(line))
    .join("\n")
    .trim()
}

// A follow-up to the work before it is at most this many words of prose, unless it starts by answering.
const FOLLOW_UP_WORDS = 12
// A message that starts by answering the work before it: "yes, ...", "no, use postgres instead ...", "looks good, ...".
const REPLY =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|no|nope|nah|not|go ahead|continue|proceed|keep going|looks good|sounds good|lgtm|approved|also|now|then|actually|instead|but)\b/

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
])
const SMALL_TALK = set([
  "how are you",
  "how are you doing",
  "how r u",
  "how are u",
  "hows it going",
  "how is it going",
  "how have you been",
  "hope you are well",
  "hope youre well",
  "you there",
  "are you there",
  "can you help me",
  "can you help",
  "could you help me",
  "nice to meet you",
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
])
const FAREWELLS = set([
  "bye",
  "goodbye",
  "bye bye",
  "see you",
  "see ya",
  "cya",
  "later",
  "good night",
  "gn",
  "ttyl",
  "talk soon",
  "talk later",
  "have a good one",
  "have a nice day",
  "have a good day",
])
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
// Words that may sit inside a social message without being one: "ok thanks", "thanks a lot", "hello again", "how are
// you doing today", a name.
const FILLERS = set([
  ...VOCATIVES,
  "ok",
  "okay",
  "alright",
  "oh",
  "ah",
  "again",
  "today",
  "tomorrow",
  "so much",
  "a lot",
  "a ton",
  "in advance",
  "very much",
  "man",
  "dude",
  "bro",
])
// Questions about Vector itself, read whole: "vector" in them is the subject, not a name.
const VECTOR_QUESTIONS = set([
  "who are you",
  "what are you",
  "what can you do",
  "what can you help with",
  "what can you help me with",
  "what model are you",
  "which model are you",
  "what model is this",
  "which model is this",
  "what model are you using",
  "which model are you using",
  "what llm are you",
  "are you claude",
  "is this claude",
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
const PHRASES = [
  ["greeting", GREETINGS],
  ["greeting", SMALL_TALK],
  ["thanks", THANKS],
  ["farewell", FAREWELLS],
  ["reaction", REACTIONS],
  ["filler", FILLERS],
] as const
// The kind that names a social message: a thanks or a report that it works settles the work before it, a greeting
// answers nothing.
const SOCIAL_ORDER = [
  "thanks",
  "success",
  "farewell",
  "reaction",
  "greeting",
  "about-vector",
] as const satisfies readonly Kind[]
// The user reporting that it works, as typed: "it works now", "that fixed it", "thats what i wanted".
const SUCCESS =
  /^(?:(?:it|its|that|thats|this|everything|all|the (?:build|tests?|app|fix|deploy|site|page))(?: is| was| are| now)? )?(?:works?|worked|working|fixed|solved|resolved|passing|passes|passed|green|builds)(?: now| again| perfectly| great| fine| well| as expected| for me)*$|^(?:that|it|this) (?:did it|did the trick|fixed it|solved it|helped|was it)$|^thats (?:what i (?:wanted|needed)|perfect|exactly it|exactly what i wanted)$|^(?:problem solved|all set|all good now|looks good now)$/
// Words that make a thanks also a new ask: "thanks for that, can you now ...".
const ASKING = /\b(?:can|could|would|will|please|pls|now|also|next|then|but|need|want)\b/
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|‍|️|[\u{1F3FB}-\u{1F3FF}]|\s)+$/u

const LOG_LINE =
  /^\s*(?:at\s+\S.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+)$|File ".+", line \d+|Traceback \(most recent call last\)|\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|npm (?:ERR!|WARN)|Caused by:|\s*\^+\s*$)/
const PATH =
  /(?:^|[\s"'(])(?:[\w@.-]+\/)+[\w@.-]+|\b[\w@-]+\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html|py|rb|go|rs|java|kt|swift|cc?|cpp|hpp?|cs|php|vue|svelte|astro|ya?ml|toml|sql|sh|txt|lock)\b/i
const URL_PATTERN = /\bhttps?:\/\/\S+/i

const NO_SUBAGENTS =
  /\b(?:no|don'?t|do not|without|never|skip(?: the)?)\s+(?:use\s+|using\s+|launch(?:ing)?\s+|spawn(?:ing)?\s+|any\s+|the\s+)*(?:sub-?agents?|parallel agents|agents)\b/
const NO_JUDGE =
  /\b(?:no|don'?t|do not|without|never|skip(?: the)?)\s+(?:use\s+|using\s+|run(?:ning)?\s+|the\s+|any\s+|an?\s+)*(?:llm[- ]as[- ]a[- ])?judge\b/
// "Don't be thorough", "no need to go deep", "don't think too hard": the user taking back a force word. Style words such
// as "keep it simple" or "don't overthink it" describe the answer they want, not the size of the job, so they are not
// here.
const NOT_THOROUGH =
  /\b(?:no|don'?t|do not|no need to|needn'?t|without|stop)\s+(?:be(?:ing)?\s+|get(?:ting)?\s+|too\s+|so\s+|very\s+|overly\s+|super\s+|extra\s+|that\s+|a\s+)*(?:thorough(?:ly)?|exhaustive(?:ly)?|deep[- ]dive|go(?:ing)? (?:too )?deep|think (?:too )?hard(?:er)?|take your time)\b/
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
const ASKS =
  /\b(?:shall i|should i|shall we|should we|want me to|want me|would you like|would you prefer|do you want|let me know|if you(?:'d| would)? (?:like|want|prefer|wish)|if you want|ready to (?:proceed|go|publish|deploy)|confirm|approve|okay to|ok to|go ahead\?|i (?:can|could) also|we (?:can|could) also|next,? i(?:'d| would|'ll| will| can| could| plan to)|i(?:'d)? (?:recommend|suggest)|happy to|the next steps? (?:would|is|are|could)|i can (?:go ahead|take care of|do that|handle))\b/
// Closing courtesies that offer no particular work, a greeting reply's "How can I help?" included. Each is a whole
// sentence: one that names work ("What would you like me to do first?") asks something.
const PLEASANTRY =
  /^(?:(?:is there )?(?:anything|something) else(?: (?:i can (?:help(?: you)? with|do(?: for you)?)|you(?:'d| would)? like(?: me to (?:do|help with|look at))?|you need(?: help with)?|on your mind))?|(?:do you have )?any (?:other |more |further )?questions|(?:let me know|feel free to (?:ask|reach out|let me know)|just let me know) if (?:you (?:need|have|want) )?(?:anything else|any (?:other |more |further )?(?:questions|changes|help))(?: (?:i can help with|you need))?|if you need anything else(?:, (?:just )?let me know)?|(?:how can i|how may i) help(?: you)?(?: today| further)?|what can i (?:help(?: you)? with|do for you)(?: today)?|what (?:would you like|do you want)(?: me)? to (?:work on|do)(?: today)?|what are we working on(?: today)?|happy to help(?: further| with anything else)?|hope (?:this|that) helps)$/
