export * as TaskSize from "./task-size"

import type { Choice, Tier } from "@vectordevai/schema/task-size"

export { Tier, Choice, JudgeMode } from "@vectordevai/schema/task-size"

// Sizes a request from what the user typed, with no model call, so "hi" gets one direct reply and only genuinely large
// work brings in subagents and the judge. The engine, the app and desktop all use this one classifier.

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
  /** The size the previous request in the session finished at. */
  readonly previous?: Tier
  /** Whether the previous reply asked the user something, so a "yes" or "ok" answers it. */
  readonly asked?: boolean
  /** The request asks for structured output, which needs a tool call. */
  readonly structured?: boolean
  /** false turns automatic sizing off: every request gets the full harness unless the sender picks a size. */
  readonly auto?: boolean
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

/** One step up, as the escalate tool raises a request. Thorough stays Thorough. */
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
  const escalate = options.escalate ? " If it turns out bigger, call escalate once with your reason." : ""
  if (tier === "light")
    return `<task_size>Light request: do it directly in as few steps as possible, without a to-do list or subagents. If you changed code, run one focused check.${escalate}</task_size>`
  if (tier === "standard")
    return `<task_size>Standard request: do the work yourself and keep a short to-do list for multi-step work. Subagents are not offered.${options.escalate ? " If independent parts of roughly five or more files would be cheaper split up, call escalate once with your reason." : ""}</task_size>`
  if (tier === "thorough")
    return `<task_size>Thorough request: plan with the to-do list, split independent substantial parts across subagents when that is cheaper, and verify with the strongest checks available.${options.judge ? " Vector runs the judge after you finish, so do not launch it yourself." : ""}</task_size>`
  // A greeting goes out on the quick lane, which carries no note.
  return undefined
}

export function classify(input: Input): Result {
  const text = prose(input.text)
  const lower = text.toLowerCase()
  const cues = {
    cloud: CLOUD.test(lower),
    browser: BROWSER.test(lower) || (input.images ?? 0) > 0,
    agents: [...new Set(input.agents ?? [])],
  }
  const result = (tier: Tier, source: Source, reasons: string[], judge = true): Result => {
    // A structured answer needs its tool, and a named subagent needs the task tool, so neither is ever a bare reply.
    const floor = (input.structured || cues.agents.length > 0) && tier === "chat" ? "light" : tier
    return { tier: floor, source, reasons, ...cues, judge }
  }

  if (input.choice && input.choice !== "auto") return result(input.choice, "user", ["user"])
  if (input.auto === false) return result("thorough", "auto", ["auto-off"])

  // Negated asks ("no subagents", "skip the judge") come out first, so they cannot read as the ask itself.
  const noSubagents = NO_SUBAGENTS.test(lower)
  const noJudge = NO_JUDGE.test(lower)
  const asked = strip(strip(lower, NO_SUBAGENTS), NO_JUDGE)
  const forced = FORCE.flatMap(([code, pattern]) => (pattern.test(asked) ? [code] : []))
  const capped = CAP_LIGHT.test(lower)
  const plain = !input.files && !input.images && cues.agents.length === 0
  const raw = input.text

  if (forced.length > 0) {
    const tier = noSubagents ? "standard" : capped ? "light" : "thorough"
    return result(tier, "user", forced, !noJudge)
  }

  const phrase = chatPhrase(lower)
  const bare = plain && !PATH.test(raw) && !URL_PATTERN.test(raw) && !raw.includes("`") && text.length <= 60
  if (bare && phrase) {
    // "great" or "yes" after a question answers it, so it continues that request with its history and tools.
    if ((phrase === "reaction" || phrase === "affirm") && input.asked && input.previous)
      return result(input.previous, "inherited", ["answer"], !noJudge)
    if (phrase === "directive" && input.previous) return result(input.previous, "inherited", ["continue"], !noJudge)
    return result("chat", "auto", [phrase === "vector" ? "about-vector" : phrase === "directive" ? "ack" : phrase])
  }

  // A message that is only a cue ("keep it simple", "no subagents") applies to the request it follows.
  const rest = strip(strip(asked, CAP_LIGHT), FILLER).replace(/\s+/g, " ").trim()
  if ((capped || noSubagents || noJudge) && rest.split(" ").filter(Boolean).length <= 2) {
    const base = input.previous ?? "light"
    const tier = capped ? min(base, "light") : noSubagents ? min(base, "standard") : base
    return result(max(tier, "light"), input.previous ? "inherited" : "auto", ["cue"], !noJudge)
  }

  const signals = measure(text, lower, input)
  const sized = signals.thorough.length > 0 ? "thorough" : signals.standard.length > 0 ? "standard" : "light"
  const reasons = sized === "thorough" ? signals.thorough : sized === "standard" ? signals.standard : signals.light
  // "Quick question" caps at Light unless the request is plainly large; "no subagents" caps at Standard.
  const tier = noSubagents
    ? min(sized, "standard")
    : capped
      ? min(sized, signals.thorough.length > 0 ? "standard" : "light")
      : sized
  return result(tier, "auto", reasons.length > 0 ? reasons : ["default"], !noJudge)
}

/** Whether an assistant's closing text asks the user for a decision, so a short "yes" or "ok" answers it. */
export function asks(text: string) {
  const tail = text.trim().slice(-400).toLowerCase()
  if (tail.endsWith("?")) return true
  return ASKS.test(tail)
}

function measure(text: string, lower: string, input: Input) {
  const paths = new Set((text.match(PATH_GLOBAL) ?? []).map((item) => item.trim())).size + (input.files ?? 0)
  const items = text.split("\n").filter((line) => LIST_ITEM.test(line))
  const actionItems = items.filter((line) => ACTION.test(line.toLowerCase())).length
  const scale = SCALE.filter((pattern) => pattern.test(lower)).length
  const scope = SCOPE.test(lower)
  const counted = Math.max(
    0,
    ...[...lower.matchAll(COUNTED)].map((match) => Number(match[1])),
    ...[...lower.matchAll(ACROSS_COUNT)].map((match) => Number(match[1])),
  )
  const features = Object.entries(FEATURES).filter(([, pattern]) => pattern.test(lower)).length
  const building = BUILD.test(lower)
  const fixing = FIX.test(lower)
  const editing = EDIT.test(lower)
  const action = building || fixing || editing || ACTION.test(lower)
  const small = SMALL_EDIT.test(lower)
  const operation = OPERATION.test(lower)
  const question = INFO_QUESTION.test(lower.trim()) && !REQUEST.test(lower.trim())
  const length = text.replace(/\s+/g, " ").trim().length

  const thorough = [
    ...(scale >= 2 ? [`scale:${scale}`] : []),
    ...(scale >= 1 && scope && action ? ["scale+scope"] : []),
    ...(counted >= 10 ? [`files:${counted}`] : []),
    ...(paths >= 6 ? [`paths:${paths}`] : []),
    ...(actionItems >= 5 ? [`items:${actionItems}`] : []),
    ...(features >= 3 && building ? [`features:${features}`] : []),
    ...(length >= 1200 && action ? ["long"] : []),
  ]
  const standard = [
    ...(building && !small && !(operation && !features) ? ["build"] : []),
    ...(fixing && !small ? ["fix"] : []),
    ...(/\b(?:with|add|write|and) (?:unit |integration |e2e )?tests\b/.test(lower) ? ["tests"] : []),
    ...(paths >= 2 ? [`paths:${paths}`] : []),
    ...(actionItems >= 2 ? [`items:${actionItems}`] : []),
    ...(scale >= 1 && action ? ["scale"] : []),
    ...(length >= 300 && action ? ["long"] : []),
    ...(length >= 600 ? ["long"] : []),
    ...((input.images ?? 0) > 0 && action ? ["image+action"] : []),
  ]
  const light = [
    ...(question ? ["question"] : []),
    ...(small ? ["small-edit"] : []),
    ...(operation ? ["operation"] : []),
  ]
  // A question about code stays Light, how-to questions included, unless it is plainly about a large area; then it is
  // at most Standard.
  if (question && !fixing) return { thorough: [], standard: thorough.length > 0 ? thorough : [], light }
  return { thorough, standard, light }
}

type Phrase = "greeting" | "thanks" | "farewell" | "reaction" | "affirm" | "directive" | "vector" | "emoji"

function chatPhrase(lower: string): Phrase | undefined {
  if (EMOJI_ONLY.test(lower)) return "emoji"
  const words = lower
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
  const trimmed = dropVocatives(words)
  if (trimmed.length === 0) return words.length > 0 ? "greeting" : undefined
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
  if (REACTIONS.has(phrase)) return "reaction"
  if (AFFIRM.has(phrase)) return "affirm"
  if (DIRECTIVES.has(phrase)) return "directive"
  if (THANKS.has(dropTrailing(phrase))) return "thanks"
  return undefined
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
const AFFIRM = set([
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "yup",
  "sure",
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
  "yes please",
  "sure thing",
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
const FORCE: ReadonlyArray<readonly [code: string, pattern: RegExp]> = [
  ["explicit:thorough", /\bbe (?:very |extra |really |super )?thorough\b|\bthoroughly\b|\bexhaustive(?:ly)?\b/],
  ["explicit:thorough", /\bdeep[- ]dive\b|\bgo deep\b|\btake your time\b/],
  ["explicit:think", /\bultrathink\b|\bthink (?:hard|harder|deeply|very carefully)\b/],
  [
    "explicit:subagents",
    /\b(?:use|using|launch|spin up|spawn|start|with|bring in)\s+(?:some |a few |multiple |several |parallel |many )?sub-?agents?\b/,
  ],
  [
    "explicit:judge",
    /\bllm[- ]as[- ]a[- ]judge\b|\b(?:have|let|ask|get) the judge\b|\buse the judge\b|\bjudge (?:it|this|the (?:work|result|change|changes))\b|\bwith the judge\b/,
  ],
]
const CAP_LIGHT =
  /\b(?:quick question|briefly|just (?:answer|tell me|show me|run it)|tl;?dr|keep it (?:simple|short|light|quick)|in one line|one[- ]liner)\b/
const FILLER = /\b(?:please|pls|and|but|ok|okay|also|now|this|it|that|the|time|for|again|thanks|just|so)\b/

const SCALE = [
  /\b(?:re-?)?architect(?:ure|ing)?\b/,
  /\bmigrat(?:e|es|ing|ion)\b/,
  /\brefactor(?:s|ing)?\b/,
  /\brewrit(?:e|es|ing)\b/,
  /\bredesign\b/,
  /\boverhaul\b/,
  /\bport(?:ing)? (?:it |this |the [\w-]+ )?(?:to|from|over)\b/,
  /\bmonorepo\b/,
  /\bmulti[- ]?file\b/,
  /\bend[- ]to[- ]end\b/,
  /\bproduction[- ]ready\b/,
  /\bfrom scratch\b/,
  /\bsecurity (?:audit|review)\b/,
  /\bperformance (?:audit|overhaul)\b/,
  /\bcodebase[- ]wide\b/,
]
const SCOPE =
  /\b(?:across|entire|whole|every (?:file|route|page|package|component|endpoint|test|module|screen)|all (?:the |of the )?(?:files|routes|pages|packages|components|endpoints|tests|modules|screens|services|apis|models|tables))\b/
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
  /\b(?:typos?|spelling|misspell\w*|comments?|wording|copy text|readme|docstrings?|console\.log|log line|whitespace|indentation|version (?:number|bump)|bump (?:the )?version|lint (?:errors?|warnings?)|formatting|a label|the label|the title|the colou?r|padding|margin|font size)\b/
const OPERATION =
  /\b(?:deploy|ship|publish|preview|release|roll ?back|commit|push|pull|merge|rebase|stash|install|uninstall)\b|\b(?:run|start|restart|stop|kick off|rerun|re-run) (?:the |all |my )?(?:tests?|test suite|build|dev server|server|app|linter|lint|typecheck|type check|migrations?|script|command)\b|\bbuild (?:it|this|the (?:app|project|repo|repository|site|package))\b|\b(?:open|create|make|raise) (?:a |the )?(?:pr|pull request)\b/
const INFO_QUESTION =
  /^(?:what|where|why|how|when|which|who|is|are|does|do|did|was|were|explain|describe|tell me|show me|list|find|summari[sz]e|walk me through)\b/
const REQUEST = /^(?:can you|could you|would you|will you|please|pls)\b/
const ASKS =
  /\b(?:shall i|should i|want me to|would you like|do you want|let me know|if you(?:'d| would) like|ready to (?:proceed|go|publish|deploy)|confirm|approve|okay to|ok to|go ahead\?)\b/
const CLOUD =
  /\b(?:vercel|supabase|deploy\w*|ship (?:it|this|to)|publish\w*|preview|production|prod|rollback|roll back|env vars?|environment variables?|database|db|auth|login|log in|sign[- ]?in|sign[- ]?up|domain|hosting|hosted)\b/
const BROWSER =
  /\b(?:browser|page|screen|screenshot|ui|ux|layout|css|styles?|styling|localhost|click|button|form|looks?|visual(?:ly)?|render(?:s|ing)?|dark mode|responsive|mobile view)\b/
