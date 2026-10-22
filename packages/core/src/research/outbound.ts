export * as ResearchOutbound from "./outbound"

import { isIP } from "node:net"
import { parse } from "tldts"
import { BrainScan } from "../brain/scan"
import { ResearchCanonical } from "./canonical"
import { ResearchWords } from "./words"

// The check on every search query and address research sends out. The research lead holds private context, and a
// hostile page can try to steer it into putting some of that in a query. The context comes in two kinds:
// - private facts: personal fact lines, MEMORY.md, private document passages, pages read signed in, and decision and
//   lesson lines, which often carry private details ("we drop Acme in Q3", section 6.4a);
// - the work: repository files read, how-you-work preferences and RULES.md. They name tools and libraries all the
//   time, so a capitalised word in them says nothing about anyone.
// A query is refused when it holds:
// - a secret;
// - a run of 6 or more words from either kind, unless the user typed it or a public source in this run holds it;
// - a run of 3 words from a line of private-fact prose (not code) with a name or a number in it, on the same terms,
//   since "Acme's Q3 churn" is private in fewer than 6 words;
// - a rare token from either kind: an identifier, a path, an email address, a host name (intranet names such as
//   jira.acme.internal included), an IP address, or a number of 5 or more digits however its digits are grouped
//   ("4,417,203", "415-555-0134"); or a name from private-fact prose. An identifier, a host name or an email address
//   of 3 or more parts still counts when the query splits it into words ("reconcile ledger entries"). Only the user's
//   typing makes one of these safe to send. A public source does not, since a hostile page could list every host
//   name or number of a company to clear them all. The domains the user prefers or avoids are the one exception for
//   host names: they exist to become site: filters.
//
// A name is a word of private-fact prose that the prose never writes in lower case and that is not a common word: a
// capitalised word inside a sentence ("Acme", "Fremont"); a sentence's or a heading's word when it is not a common
// English word ("Falcon is the codename", but not "Heat pumps are loud"); and a word in capitals that is not a common
// acronym ("GLOBEX", but not "NASA" or "API"). Names cost some fair queries: a private line about Germany keeps
// "Germany" out of queries until the user types it.
//
// Text is compared after NFKC folding with invisible characters (soft hyphens, zero-width spaces) taken out, so they
// cannot split a token. It catches literal overlap only: a model can still paraphrase. The queries go to the search
// service the user set up and are shown in the Sources tab, so a paraphrase is at least visible.

export const REFUSAL = "That search would send text from your private files. Rephrase it with public terms."

export const RUN_WORDS = 6
/** The run of words from a line of prose that is enough when it holds a name or a number. */
export const NAMED_RUN_WORDS = 3

export type Context = {
  /**
   * Private facts loaded in this run: personal fact lines, MEMORY.md, private document passages, pages read signed
   * in, entries marked private, and decision and lesson lines. Text whose kind is not known belongs here.
   */
  readonly private: readonly string[]
  /**
   * The rest of the private text: repository files read, how-you-work preferences and RULES.md. Only its rare tokens
   * and its runs of 6 words are kept out of queries.
   */
  readonly work?: readonly string[]
  /** What the user typed in this run's root session. A launching agent's text (a sub-question, a task) is not typed. */
  readonly typed: readonly string[]
  /** Public text seen in this run: search results and the pages read. */
  readonly public: readonly string[]
  /**
   * Domains the user chose to prefer or avoid: the sources facet's, and the plan's once the user approved it. A
   * public host name equal to one of them or under it may be sent, as a site: filter or a word; they clear nothing
   * else.
   */
  readonly domains?: readonly string[]
}

export type Reason = "secret" | "words" | "token"

export type Result =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason; readonly match: string; readonly message: string }

// Words of mixed case that are names everyone uses, not identifiers from someone's code.
const COMMON = new Set([
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
  "solidjs",
  "solidstart",
  "vuejs",
  "nestjs",
  "nuxtjs",
  "threejs",
  "sveltekit",
  "vitepress",
  "tailwindcss",
  "openrouter",
  "digitalocean",
  "openapi",
  "openssl",
  "openssh",
  "openbsd",
  "freebsd",
  "openjdk",
  "intellij",
  "jetbrains",
  "lastpass",
  "testflight",
  "appstore",
  "clickhouse",
  "planetscale",
  "cockroachdb",
  "opensearch",
  "rabbitmq",
  "cloudformation",
  "bigquery",
  "pyspark",
  "jupyterlab",
  "deepmind",
  "huggingface",
  "llamaindex",
  "langchain",
  "webdriver",
  "webkit",
  "webview",
  "javafx",
  "swiftui",
  "appkit",
  "coreml",
  "airpods",
  "macos",
  "ipados",
  "watchos",
  "visionos",
  "tvos",
  "snake_case",
  "screaming_snake_case",
])

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

// Words a line of prose capitalises at the start of a sentence, and months and days, which are not names.
const COMMON_WORDS = new Set(
  `a about above across after afterwards again against all almost already also although always am among an and
  another any anyone anything are around as ask asked asks at avoid avoids be because been before being below best
  better between both but by can cannot check could daily decided did do does doing done during each early either else
  even ever every everyone everything few find first for from get give go good great had has have he her here hers him
  his how however i if in instead into is it its just keep last later least less let like likes made make many may
  maybe me might mine more most much must my never new next no none nor not note notes now of off often old on once only
  or other others our ours out over per perhaps please prefer preferred prefers rather really same see set several she
  should since so some sometimes soon still such take than thanks that the their theirs them then there these they
  this those though through to today together tomorrow too try twice under unless until up us use used uses using
  usually very via want wants was we weekly were what when where whether which while who whom whose why will with
  within without would yes yesterday yet you your yours
  january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday`
    .split(/\s+/)
    .filter(Boolean),
)

// The last labels of names that are not on the public internet: an intranet's or a home network's.
const INTRANET = new Set([
  "internal",
  "intranet",
  "corp",
  "lan",
  "local",
  "localdomain",
  "home",
  "private",
  "test",
  "example",
  "invalid",
  "localhost",
])

// Addresses everyone writes, which say nothing about anyone's network.
const LOOPBACK = new Set(["127.0.0.1", "0.0.0.0", "::1", "::"])

// Acronyms everyone writes, which are not names: a word in capitals is a name ("GLOBEX", "ZEPHYR") unless it is one
// of these or a common word written in capitals ("NOT", "IMPORTANT").
const ACRONYMS = new Set(
  `api apis sdk cli gui url uri http https html css json xml yaml toml csv tsv pdf sql nosql orm jwt oauth sso saml
  mfa otp tls ssl ssh ftp sftp smtp imap pop dns tcp udp vpn lan wan cpu gpu tpu ram rom ssd hdd usb nfc gps ios
  llm llms nlp rag gpt aws gcp ibm amd nasa fbi cia nsa usa uae nato imf oecd wto fda epa sec irs hmrc nhs cdc
  nih ieee iso ansi rfc ietf gdpr hipaa ccpa soc pci dss kyc aml ceo cto cfo coo cio ciso cmo svp evp faq faqs asap
  eta fyi tbd tba todo okr okrs kpi kpis roi arr mrr nrr grr ltv cac arpu saas paas iaas crm erp cms cdn seo sem ppc
  cta mvp poc rfp rfq sla slas sow nda ndas mou llc inc ltd plc gmbh ipo gdp cpi vat gst usd eur gbp jpy cny inr
  aud cad chf btc eth nft utc gmt pst pdt est edt cet cest ist jst ids pin atm sms mms voip dvd lcd led oled hdr
  lte wifi iot evs hvac cop scop seer hspf kwh mwh gwh iea irena ipcc neep ashrae bsi din npm pnpm git svn sre vms
  iam rbac acl acls cors csrf xss ssrf rce dos ddos cve cves owasp nist pii phi ocr tts stt asr icu phd mba bsc msc
  etc aka diy rsvp eli5 tldr imo imho btw wip lgtm ack nack eod eow cob ooo pto qbr mcp tui wsl sha pwd dir ide
  lts eol cicd ascii utf unicode rgb hsl svg png jpg jpeg gif webp mp3 mp4 wasm jsx tsx`
    .split(/\s+/)
    .filter(Boolean),
)

// Words too common to make a 6-word run telling on their own: a run needs at least two longer words.
const LONG_WORD = /^[\p{L}\p{N}]{4,}$/u
// A run of 3 needs one word of 4 or more letters, so "to 7 4" does not count.
const LETTER_WORD = /^\p{L}{4,}$/u
// A capitalised word with a lower-case letter in it, of letters only: "Acme", "McDonald", not "Q3" or "NASA".
const CAPITALISED = /^\p{Lu}\p{L}*\p{Ll}\p{L}*$/u
// A word in capitals, of 3 or more letters ("GLOBEX"), or 2 or more and a plural "s" ("SLAs").
const CAPITALS = /^\p{Lu}{3,}$|^\p{Lu}{2,}s$/u
// A line of code, a comment in code or markup: a line with braces, an arrow, a call or an assignment, or one that
// imports, exports or declares a type ("export * as Foo from", "import os", "type Foo<T> ="). Markdown headings and
// lists stay prose, and so does a semicolon inside a sentence.
const CODE = new RegExp(
  [
    /[{}]|;\s*$|=>|\w\(|\s=\s/.source,
    /^\s*(?:\/\/|\/\*)|^\s+\*(?:\s|\/|$)|<\/?[A-Za-z!]/.source,
    /^\s*(?:import|export)\s+(?:[*"'`]|(?:type|default|const|let|var|function|class|async|abstract)\b|[\w$]+\s+from\s)/
      .source,
    /^\s*(?:export\s+)?(?:declare|interface|type|enum|namespace)\s+[\w$.]+|^\s*from\s+[\w.]+\s+import\s|^\s*import\s+[\w.]+\s*$/
      .source,
  ].join("|"),
)
// A heading or a table row, whose capitals say nothing.
const HEADING = /^(?:#{1,6}\s|\|)/
// Where a sentence ends: after its stop and any closing marks ("Undo.**", "(see above).\"").
const SENTENCE = /(?<=[.!?:;][)\]"'\u201D\u2019*_]*)\s+/
// Rare tokens are found inside runs of the characters they are made of, each cut to this length, so the patterns do
// a bounded amount of work at each place and the check stays linear in the size of the private context.
const MAX_RUN = 128
const TOKEN_RUN = /[\w.+\-/@~:]+/g
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu
// Digits in groups, joined by a space, a comma, a dot, a dash, a slash or brackets: "4,417,203", "(415) 555-0134",
// "4242 4242 4242 4242". Each alternative has a fixed length, so the match stays linear.
const GROUPED = /\d+(?:(?:[ ,.\-/]| ?\( ?|\) ?)\d+)+/g
// A round number (10000, 250000) says nothing about anyone's files.
const ROUND = /^\d{1,2}0+$/
// The shortest number counted, and the shortest that matches inside a longer one ("555 0134" of "415 555 0134").
const NUMBER_DIGITS = 5
const PART_DIGITS = 7
// A token split into words: it needs 3 to 8 parts and 12 or more letters and digits, and the query has to write one
// word for each part. So "reconcile ledger entries" and "reconcile_ledger_entries" are reconcileLedgerEntries, while
// "status code" is not statusCode and "openai responses" is not OpenAIResponses.
const SPLIT_CHARS = 12
const SPLIT_PARTS = 3
const SPLIT_WORDS = 8

/** Whether a search query may leave, given the run's private context. */
export function check(query: string, context: Context): Result {
  if (BrainScan.credential(query) || BrainScan.redact(query).redacted)
    return refused("secret", "a password, key or token")
  const known = prepare(context)
  const words = wordsOf(query)
  const run = grams(words, RUN_WORDS)
    .filter((gram) => gram.filter((word) => LONG_WORD.test(word)).length >= 2)
    .map((gram) => ` ${gram.join(" ")} `)
    .find((gram) => known.words.includes(gram) && !known.allowedWords.includes(gram))
  if (run) return refused("words", run.trim())
  const named = grams(words, NAMED_RUN_WORDS)
    .map((gram) => gram.join(" "))
    .find((gram) => known.named.has(gram) && !known.allowedWords.includes(` ${gram} `))
  if (named) return refused("words", named)
  const lower = fold(query).toLowerCase()
  // Both ways round: a rare token of the query that the private text holds, and a rare token of the private text that
  // the query holds, which catches one the query wrote in lower case or ran into other letters.
  const token =
    rare(query).find((item) => {
      const value = item.toLowerCase()
      return (
        !/^\d+$/.test(value) &&
        known.raw.includes(value) &&
        !known.typedRaw.includes(value) &&
        !exempt(value, known.domains)
      )
    }) ?? known.tokens.find((item) => lower.includes(item))
  if (token) return refused("token", token)
  // A private number however the query groups its digits, run together across its words ("4 417 203", "4,417,203"),
  // or a long enough part of one. The user's own digits are theirs to send.
  const number = digitsOf(query)
    .filter((digits) => digits.length >= NUMBER_DIGITS && !known.typedDigits.includes(digits))
    .flatMap((digits) =>
      known.digits.filter((item) => digits.includes(item) || (digits.length >= PART_DIGITS && item.includes(digits))),
    )[0]
  if (number) return refused("token", number)
  // An identifier, a host name or an email address with its parts written as words.
  const split = Array.from({ length: SPLIT_WORDS - SPLIT_PARTS + 1 }, (_, index) =>
    grams(words, index + SPLIT_PARTS).map((gram) => known.split.get(`${gram.length}:${gram.join("")}`)),
  )
    .flat()
    .find(Boolean)
  if (split) return refused("token", split)
  // A name as a word of the query, or, from 6 letters, run into other letters ("acmerobotics").
  const name = known.names.find((item) => words.includes(item) || (item.length >= 6 && lower.includes(item)))
  if (name) return refused("token", name)
  return { ok: true }
}

/**
 * Whether an address may be read, by the same check on its path, query and fragment, and on the labels of its host
 * before its site: the site came from provenance, but a name such as acme-q3-churn.attacker.example carries text the
 * way a path does.
 */
export function address(url: string, context: Context): Result {
  if (!URL.canParse(url)) return refused("token", url)
  const parsed = new URL(url)
  const text = [
    ...(parse(parsed.hostname, { allowPrivateDomains: true }).subdomain ?? "").split("."),
    ...parsed.pathname.split("/"),
    ...[...parsed.searchParams].flatMap(([key, value]) => [key, value]),
    parsed.hash.slice(1),
  ]
    .map(ResearchCanonical.decoded)
    .join(" ")
  // As written, for identifiers and paths, and with a slug's dashes read as spaces, for runs of words.
  const written = check(text, context)
  if (!written.ok) return written
  return check(text.replace(/[-+_]+(?=\p{L})/gu, " "), context)
}

/**
 * The rare tokens in a text: identifiers, paths, email addresses, host names, IP addresses and numbers of 5 or more
 * digits. A number written in groups ("4,417,203", "415-555-0134") is given by its digits alone ("4417203").
 */
export function rare(text: string) {
  const folded = fold(text)
  const found = (folded.match(TOKEN_RUN) ?? [])
    .flatMap((run) =>
      Array.from({ length: Math.ceil(run.length / MAX_RUN) }, (_, index) =>
        run.slice(index * MAX_RUN, (index + 1) * MAX_RUN),
      ),
    )
    .flatMap((value) => [
      ...(value.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []),
      ...(value.match(/(?:~|\.{1,2})?\/?[\w.-]+(?:\/[\w.-]+)+/g) ?? []).filter(path),
      ...(value.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []).filter(host),
      ...(value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []).filter((ip) => isIP(ip) === 4 && !LOOPBACK.has(ip)),
      ...(value.match(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi) ?? []).filter(
        (ip) => isIP(ip) === 6 && !LOOPBACK.has(ip),
      ),
      ...(value.match(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g) ?? []).filter((token) => token.length >= 5),
      ...(value.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g) ?? []).filter((token) => token.length >= 6),
      ...(value.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []).filter((token) => token.length >= 6),
      ...(value.match(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{8,}\b/g) ?? []),
      ...(value.match(/\b\d{5,}\b/g) ?? []).filter((number) => !ROUND.test(number)),
    ])
  return [...new Set([...found, ...grouped(folded)])].filter((token) => !COMMON.has(token.toLowerCase()))
}

/**
 * The names in the prose of some texts: words the prose never writes in lower case, and no common word or acronym. A
 * word inside a sentence counts when it is capitalised. A sentence's first word, and a heading's words, are
 * capitalised anyway, so they count only when they are not a common English word, or when they are possessive
 * ("Target's"). A word in capitals counts when it is not an acronym or a common word.
 */
export function names(texts: readonly string[]) {
  const blocks = prose(texts)
  // Only a word written on its own shows the prose uses it in lower case: "acme" in jira.acme.internal or
  // acme-billing is part of a name, not the word.
  const lower = new Set(
    blocks
      .flatMap((block) => block.text.split(/\s+/))
      .map((chunk) => chunk.replace(/^[("'\u201C\u2018[]+|[)"'\u201D\u2019\].,;:!?]+$/gu, ""))
      .filter((chunk) => /^\p{Ll}+(?:['\u2019]\p{Ll}+)?$/u.test(chunk))
      .map((chunk) => chunk.replace(/['\u2019]\p{Ll}+$/u, "")),
  )
  const found = blocks.flatMap((block) =>
    block.text.split(SENTENCE).flatMap((sentence) =>
      [...sentence.matchAll(/([\p{L}\p{N}]+)(['\u2019]s(?![\p{L}\p{N}]))?/gu)].flatMap((match, index) => {
        const word = match[1]!
        const key = (
          CAPITALS.test(word) && word.endsWith("s") && !/^\p{Lu}+$/u.test(word) ? word.slice(0, -1) : word
        ).toLowerCase()
        if (key.length < 3 || lower.has(key) || COMMON_WORDS.has(key) || COMMON.has(key) || ACRONYMS.has(key)) return []
        if (CAPITALS.test(word)) return ResearchWords.common(key) ? [] : [key]
        if (!CAPITALISED.test(word)) return []
        const placed = block.titled || index === 0
        return placed && !match[2] && ResearchWords.common(key) ? [] : [key]
      }),
    ),
  )
  return [...new Set(found)]
}

// A path names a file or a place on disk: it starts at a root or home, has three or more parts, or ends in a file
// name. "and/or" and "TCP/IP" are words.
function path(token: string) {
  const parts = token
    .replace(/^~?\.{0,2}\//, "")
    .split("/")
    .filter(Boolean)
  return /^[~/.]/.test(token) || parts.length >= 3 || /\.[A-Za-z0-9]{1,6}$/.test(parts.at(-1) ?? "")
}

// A host name on a public suffix ("node.js" is a library, "example.co.uk" a site) or on an intranet's
// (jira.acme.internal, build01.corp.lan), and not one everyone names.
function host(token: string) {
  const parsed = parse(token, { allowPrivateDomains: true })
  if (!parsed.domain) return false
  if (!parsed.isIcann && !parsed.isPrivate && !INTRANET.has(parsed.publicSuffix?.toLowerCase() ?? "")) return false
  return !PUBLIC_SITES.has(parsed.domain.toLowerCase())
}

// The numbers written in groups in a text, by their digits alone: thousands ("4,417,203", "4.417.203", "4 417 203"),
// or digits grouped by spaces, dashes, slashes or brackets (a phone, a card, an account or an ID number). Not values in
// a list ("2024,2025"), a version or an IP address ("1.99.110", "10.20.30.40"; an IP address is a token of its own),
// a span of years ("2024-2026") or a round number.
function grouped(text: string) {
  return (text.match(GROUPED) ?? [])
    .filter((run) => {
      const later = run.split(/\D+/).slice(1)
      if (/^[\d,]+$/.test(run)) return later.every((group) => group.length === 3)
      if (/^[\d.]+$/.test(run))
        return later.every((group) => group.length === 3) || (later.length >= 2 && /\d{4}/.test(run))
      return !/^(?:19|20)\d\d[-/](?:19|20)\d\d$/.test(run)
    })
    .map((run) => run.replace(/\D/g, ""))
    .filter((digits) => digits.length >= NUMBER_DIGITS && !ROUND.test(digits))
}

// The digits of a query run together across everything that is not a letter, so "4 417 203", "4,417,203" and
// "415 / 555 / 0134" each give one number.
function digitsOf(text: string) {
  return (
    fold(text)
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .match(/\d+/g) ?? []
  )
}

// A token without its separators and case, and the number of parts it has: "reconcileLedgerEntries" is
// "reconcileledgerentries" in 3 parts, "jane.doe@acme.example" is "janedoeacmeexample" in 4.
function squash(token: string) {
  return fold(token)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

function parts(token: string) {
  return fold(token)
    .split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)
    .filter(Boolean).length
}

// A public host name the user chose as a domain to prefer or avoid, or one under it.
function exempt(token: string, domains: readonly string[]) {
  if (domains.length === 0 || !parse(token).isIcann) return false
  return domains.some((domain) => token === domain || token.endsWith(`.${domain}`))
}

function refused(reason: Reason, match: string): Result {
  return { ok: false, reason, match, message: REFUSAL }
}

function fold(text: string) {
  return text.replace(IGNORABLE, "").normalize("NFKC").replace(IGNORABLE, "")
}

function wordsOf(text: string) {
  return fold(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function grams(words: readonly string[], size: number) {
  return words.slice(0, Math.max(0, words.length - size + 1)).map((_, index) => words.slice(index, index + size))
}

function joined(texts: readonly string[]) {
  return ` ${texts.map((text) => wordsOf(text).join(" ")).join(" \n ")} `
}

// The prose of the texts a block at a time, folded: a paragraph with its wrapped lines joined again, so a sentence
// or a run of words is read whole, and each list item, quote, heading, table row and title line on its own. A line of
// code ends a block, and so does a fenced code block. A code span ("`Bun.file()`") is left out of its line, since its
// words are code too. A heading, table row or title line is `titled`. The blocks are built in place, so a long text
// costs one pass.
//
// A text that is mostly code outside fences, such as a source file, has no prose at all: the lines CODE misses in it
// (an object's keys, a union's members) are code as well, and their capitalised words name types and functions.
function prose(texts: readonly string[]) {
  return texts.flatMap((text) => {
    const lines = fold(text).split("\n")
    const marked = lines.reduce<{ fenced: boolean; lines: { text: string; fenced: boolean; code: boolean }[] }>(
      (state, line) => {
        const fence = /^\s*(?:```|~~~)/.test(line)
        const spans = line.replace(/`[^`]*`/g, " ")
        state.lines.push({ text: spans.trim(), fenced: fence || state.fenced, code: CODE.test(spans) })
        return { fenced: fence ? !state.fenced : state.fenced, lines: state.lines }
      },
      { fenced: false, lines: [] },
    ).lines
    const open = marked.filter((line) => !line.fenced && line.text)
    if (open.length >= 5 && open.filter((line) => line.code).length * 10 >= open.length * 3) return []
    return marked
      .reduce<{ text: string; titled: boolean }[]>((blocks, item) => {
        const line = item.fenced || item.code ? "" : item.text
        const last = blocks.at(-1)
        if (!line) {
          if (last?.text) blocks.push({ text: "", titled: false })
          return blocks
        }
        const titled = titledLine(line)
        if (last?.text && !titled && !last.titled && !/^(?:[-*+>]|\d+[.)])\s/.test(line)) {
          last.text = `${last.text} ${line}`
          return blocks
        }
        if (last && !last.text) blocks.pop()
        blocks.push({ text: line, titled })
        return blocks
      }, [])
      .filter((block) => block.text)
  })
}

// A heading, a table row, or a line whose words of 4 or more letters, 2 or more of them, are all capitalised and
// that does not end a sentence: "Getting Started", "Quarterly Revenue Review".
function titledLine(line: string) {
  if (HEADING.test(line)) return true
  if (/[.!?]$/.test(line)) return false
  const long = line
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))
    .filter((word) => word.length >= 4)
  return long.length >= 2 && long.every((word) => /^\p{Lu}/u.test(word))
}

// The context as the check reads it, worked out once per context object: its words joined for the 6-word runs, the
// 3-word runs of its private-fact prose with a name or a number in them, its text in lower case, and the rare tokens,
// numbers, split tokens and names that the user did not type. Tokens match without case, so lowercasing an
// identifier or a host name does not get it past the check.
const PREPARED = new WeakMap<Context, ReturnType<typeof build>>()

function prepare(context: Context) {
  const known = PREPARED.get(context)
  if (known) return known
  const built = build(context)
  PREPARED.set(context, built)
  return built
}

function build(context: Context) {
  const all = [...context.private, ...(context.work ?? [])]
  const typedRaw = context.typed.map(fold).join("\n").toLowerCase()
  const typedWords = new Set(context.typed.flatMap(wordsOf))
  const typedDigits = context.typed.flatMap(digitsOf).join(" ")
  const typedSplit = context.typed.map((text) => wordsOf(text).join("")).join(" ")
  const domains = (context.domains ?? []).map((domain) =>
    fold(domain)
      .trim()
      .toLowerCase()
      .replace(/^\*?\.|\.$/g, "")
      .replace(/^www\./, ""),
  )
  const found = names(context.private)
  const named = new Set(found)
  const tokens = [...new Set(all.flatMap(rare))].filter((token) => !exempt(token.toLowerCase(), domains))
  const open = (token: string) => !typedRaw.includes(token.toLowerCase()) && !typedSplit.includes(squash(token))
  return {
    words: joined(all),
    allowedWords: joined([...context.typed, ...context.public]),
    named: new Set(
      prose(context.private).flatMap((block) =>
        grams(wordsOf(block.text), NAMED_RUN_WORDS)
          .filter(
            (gram) =>
              gram.some((word) => named.has(word) || /\d/.test(word)) && gram.some((word) => LETTER_WORD.test(word)),
          )
          .map((gram) => gram.join(" ")),
      ),
    ),
    raw: all.map(fold).join("\n").toLowerCase(),
    typedRaw,
    typedDigits,
    domains,
    tokens: [...new Set(tokens.filter((token) => !/^\d+$/.test(token)).map((token) => token.toLowerCase()))].filter(
      (token) => token.length >= 5 && !typedRaw.includes(token),
    ),
    digits: tokens.filter((token) => /^\d+$/.test(token) && !typedDigits.includes(token)),
    split: new Map(
      tokens
        .filter((token) => !/^\d+$/.test(token) && open(token))
        .map((token) => [parts(token), squash(token), token] as const)
        .filter(([count, squashed]) => count >= SPLIT_PARTS && count <= SPLIT_WORDS && squashed.length >= SPLIT_CHARS)
        .map(([count, squashed, token]) => [`${count}:${squashed}`, token] as const),
    ),
    names: found.filter((name) => !typedWords.has(name)),
  }
}
