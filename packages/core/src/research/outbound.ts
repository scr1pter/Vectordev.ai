export * as ResearchOutbound from "./outbound"

import { parse } from "tldts"
import { BrainScan } from "../brain/scan"

// The check on every search query and address research sends out. The research lead holds private context (recalled
// personal cards, private document passages, repository files it read), and a hostile page can try to steer it into
// putting some of that in a query. So a query is refused when it holds a secret, a run of 6 or more words from the
// private context, or a rare token from it (an identifier, a path, an email address, a host name, a number of 5 or
// more digits), unless the user typed those words or a public source in this run contains them.
//
// It catches literal overlap only: a model can still paraphrase. The queries go to the search service the user set up
// and are shown in the Sources tab, so a paraphrase is at least visible.

export const REFUSAL = "That search would send text from your private files. Rephrase it with public terms."

export const RUN_WORDS = 6

export type Context = {
  /** Private text loaded in this session: personal cards, private document passages, repository file contents. */
  readonly private: readonly string[]
  /** What the user typed in this session. */
  readonly typed: readonly string[]
  /** Public text seen in this run: search results and the pages read. */
  readonly public: readonly string[]
}

export type Reason = "secret" | "words" | "token"

export type Result = { readonly ok: true } | { readonly ok: false; readonly reason: Reason; readonly match: string; readonly message: string }

// Words of mixed case that are names everyone uses, not identifiers from someone's code.
const COMMON = new Set(
  [
    "javascript",
    "typescript",
    "coffeescript",
    "actionscript",
    "github",
    "gitlab",
    "bitbucket",
    "postgresql",
    "mysql",
    "mongodb",
    "sqlite",
    "mariadb",
    "dynamodb",
    "youtube",
    "linkedin",
    "wordpress",
    "powershell",
    "powerpoint",
    "iphone",
    "ipad",
    "macbook",
    "openai",
    "chatgpt",
    "deepseek",
    "paypal",
    "devops",
    "fastapi",
    "numpy",
    "pytorch",
    "tensorflow",
    "graphql",
    "webassembly",
    "websocket",
    "webgpu",
    "webrtc",
    "oauth",
    "playstation",
    "airbnb",
    "doordash",
    "hubspot",
    "salesforce",
    "netsuite",
    "quickbooks",
    "smartthings",
    "homekit",
    "openstreetmap",
    "nextjs",
    "nodejs",
    "eventbrite",
    "mailchimp",
    "dropbox",
    "onedrive",
    "sharepoint",
    "photoshop",
    "indesign",
    "autocad",
    "solidworks",
    "matlab",
  ],
)

// Hosts so common that naming one says nothing about anyone's files.
const PUBLIC_SITES = new Set([
  "github.com",
  "gitlab.com",
  "wikipedia.org",
  "stackoverflow.com",
  "npmjs.com",
  "pypi.org",
  "google.com",
  "youtube.com",
  "reddit.com",
  "arxiv.org",
  "medium.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "apple.com",
  "microsoft.com",
  "amazon.com",
  "mozilla.org",
  "w3.org",
  "nih.gov",
  "who.int",
  "europa.eu",
])

// Words too common to make a 6-word run telling on their own: a run needs at least two longer words.
const LONG_WORD = /^[\p{L}\p{N}]{4,}$/u

/** Whether a search query may leave, given the session's private context. */
export function check(query: string, context: Context): Result {
  if (BrainScan.credential(query) || BrainScan.redact(query).redacted)
    return refused("secret", "a password, key or token")
  const known = prepare(context)
  const words = wordsOf(query)
  const run = words
    .slice(0, Math.max(0, words.length - RUN_WORDS + 1))
    .map((_, index) => words.slice(index, index + RUN_WORDS))
    .filter((gram) => gram.filter((word) => LONG_WORD.test(word)).length >= 2)
    .map((gram) => ` ${gram.join(" ")} `)
    .find((gram) => known.words.includes(gram) && !known.allowedWords.includes(gram))
  if (run) return refused("words", run.trim())
  const lower = fold(query).toLowerCase()
  // Both ways round: a rare token of the query that the private text holds, and a rare token of the private text that
  // the query holds, which catches one the query wrote in lower case or ran into other letters.
  const token =
    rare(query).find((item) => known.raw.includes(item.toLowerCase()) && !known.allowedRaw.includes(item.toLowerCase())) ??
    known.tokens.find((item) => lower.includes(item))
  if (token) return refused("token", token)
  return { ok: true }
}

/** Whether an address may be read, by the same check on its path and query; the host came from provenance. */
export function address(url: string, context: Context): Result {
  if (!URL.canParse(url)) return refused("token", url)
  const parsed = new URL(url)
  const text = [
    ...parsed.pathname.split("/"),
    ...[...parsed.searchParams].flatMap(([key, value]) => [key, value]),
  ]
    .map((part) => part.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))))
    .join(" ")
  // As written, for identifiers and paths, and with a slug's dashes read as spaces, for runs of words.
  const written = check(text, context)
  if (!written.ok) return written
  return check(text.replace(/[-+_]+(?=\p{L})/gu, " "), context)
}

/** The rare tokens in a text: identifiers, paths, email addresses, host names and numbers of 5 or more digits. */
export function rare(text: string) {
  const value = fold(text)
  const found = [
    ...(value.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []),
    ...(value.match(/(?:~|\.{1,2})?\/?[\w.-]+(?:\/[\w.-]+)+/g) ?? []).filter(path),
    ...(value.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []).filter(host),
    ...(value.match(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g) ?? []).filter((token) => token.length >= 5),
    ...(value.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g) ?? []).filter((token) => token.length >= 6),
    ...(value.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []).filter((token) => token.length >= 6),
    ...(value.match(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{8,}\b/g) ?? []),
    // A round number (10000, 250000) says nothing about anyone's files.
    ...(value.match(/\b\d{5,}\b/g) ?? []).filter((number) => !/^\d{1,2}0+$/.test(number)),
  ]
  return [...new Set(found)].filter((token) => !COMMON.has(token.toLowerCase()))
}

// A path names a file or a place on disk: it starts at a root or home, has three or more parts, or ends in a file
// name. "and/or" and "TCP/IP" are words.
function path(token: string) {
  const parts = token.replace(/^~?\.{0,2}\//, "").split("/").filter(Boolean)
  return /^[~/.]/.test(token) || parts.length >= 3 || /\.[A-Za-z0-9]{1,6}$/.test(parts.at(-1) ?? "")
}

// A host name on a public suffix ("node.js" is a library, "example.co.uk" a site), and not one everyone names.
function host(token: string) {
  const parsed = parse(token, { allowPrivateDomains: true })
  if (!parsed.domain || !(parsed.isIcann || parsed.isPrivate)) return false
  return !PUBLIC_SITES.has(parsed.domain.toLowerCase())
}

function refused(reason: Reason, match: string): Result {
  return { ok: false, reason, match, message: REFUSAL }
}

function fold(text: string) {
  return text.normalize("NFKC")
}

function wordsOf(text: string) {
  return fold(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function joined(texts: readonly string[]) {
  return ` ${texts.map((text) => wordsOf(text).join(" ")).join(" \n ")} `
}

// The context as the check reads it, worked out once per context object: its words joined for the 6-word runs, its
// text in lower case, and the rare tokens of the private text that no typed or public text holds. Tokens match
// without case, so lowercasing an identifier or a host name does not get it past the check.
const PREPARED = new WeakMap<Context, ReturnType<typeof build>>()

function prepare(context: Context) {
  const known = PREPARED.get(context)
  if (known) return known
  const built = build(context)
  PREPARED.set(context, built)
  return built
}

function build(context: Context) {
  const allowed = [...context.typed, ...context.public]
  const allowedRaw = allowed.map(fold).join("\n").toLowerCase()
  return {
    words: joined(context.private),
    allowedWords: joined(allowed),
    raw: context.private.map(fold).join("\n").toLowerCase(),
    allowedRaw,
    tokens: [
      ...new Set(context.private.flatMap(rare).map((token) => token.toLowerCase())),
    ].filter((token) => token.length >= 5 && !allowedRaw.includes(token)),
  }
}
