export * as ResearchOutbound from "./outbound"

import { isIP } from "node:net"
import { parse } from "tldts"
import { BrainScan } from "../brain/scan"
import { ResearchCanonical } from "./canonical"
import { ResearchEnglish } from "./english"
import { WebFence } from "./fence"

// The check on every search query and address research sends out. The research lead holds private context (recalled
// personal lines, private document passages, repository files it read), and a hostile page can try to steer it into
// putting some of that in a query. So a query is refused when it holds:
// - a secret;
// - a run of 6 or more words from the private context, unless the user typed it or a public source in this run holds
//   it;
// - a run of 3 words from a line of prose (a personal line or a document passage, not code) with a name or a number
//   in it, on the same terms, since "Acme's Q3 churn" is private in fewer than 6 words;
// - a rare token from the private context: an identifier, a path, an email address, a host name (intranet names such
//   as jira.acme.internal included), an IP address, a number of 5 or more digits, or a name from a line of prose. Only
//   the user's typing makes one of these safe to send. A public source does not, since a hostile page could list every
//   host name or number of a company to clear them all.
//
// A name is a capitalised word of prose that the private prose never writes in lower case and that is not a common
// word: "Acme", "Falcon" and "Fremont", and "Kestrel" or "Globex" opening a remembered fact ("Kestrel ships in May",
// "Employer: Globex"), but not "Heat" at the start of a sentence about heat pumps. Code is left out, since it is full
// of capitalised words ("Effect", "Schema") that say nothing about anyone. Names cost some fair queries: a private line
// about Germany keeps "Germany" out of queries until the user types it.
//
// Text is compared the way a reader sees it, on both sides: folded by NFKD, without accents and invisible characters
// (soft hyphens, zero-width spaces), with letters from other scripts that look like Latin ones read as Latin
// ("Аcme" with a Cyrillic "А" is "Acme"), and with numbers written in groups read whole (2,400,000, 2.400.000,
// 2 400 000 and 24,00,000 are all 2400000, and a card number written in fours is one number). It catches literal
// overlap only: a model can still paraphrase. The queries go to the search service the user set up and are shown in
// the Sources tab, so a paraphrase is at least visible.

export const REFUSAL = "That search would send text from your private files. Rephrase it with public terms."

export const RUN_WORDS = 6
/** The run of words from a line of prose that is enough when it holds a name or a number. */
export const NAMED_RUN_WORDS = 3

export type Context = {
  /** Private text loaded in this run: personal lines, private document passages, repository file contents. */
  readonly private: readonly string[]
  /** What the user typed in this run's root session. A launching agent's text (a sub-question, a task) is not typed. */
  readonly typed: readonly string[]
  /** Public text seen in this run: search results and the pages read. */
  readonly public: readonly string[]
  /**
   * The preferred and avoided domains of the sources facet (section 6.4a). They exist to become site: filters, so
   * they may go out as a host name or a site: value. Anywhere else in a query (an address, a path, a longer host) they
   * are checked like any other private text. Only public host names count, never a word or an intranet name.
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

// Words too common to make a 6-word run telling on their own: a run needs at least two longer words.
const LONG_WORD = /^[\p{L}\p{N}]{4,}$/u
// A run of 3 needs one word of 4 or more letters, so "to 7 4" does not count.
const LETTER_WORD = /^\p{L}{4,}$/u
// A capitalised word with a lower-case letter in it, of letters only: "Acme", "McDonald", not "Q3" or "NASA".
const CAPITALISED = /^\p{Lu}\p{L}*\p{Ll}\p{L}*$/u
// A line of code, a comment in code or markup. Markdown headings and lists stay prose, and so does a semicolon
// inside a sentence.
const CODE = /[{}]|;\s*$|=>|\w\(|\s=\s|^\s*(?:\/\/|\/\*)|^\s+\*(?:\s|\/|$)|<\/?[A-Za-z!]/
// Rare tokens are found inside runs of the characters they are made of, each cut to this length, so the patterns do
// a bounded amount of work at each place and the check stays linear in the size of the private context.
const MAX_RUN = 128
const TOKEN_RUN = /[\w.+\-/@~:]+/g
// What a reader reads past: accents and other combining marks once NFKD has split them off, and invisible characters.
const UNSEEN = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu
// A number with its digits in groups: of three, with one separator throughout (a comma, a dot, an apostrophe, an
// underscore or a space; NFKD has made no-break and thin spaces plain ones), or in lakhs and crores (24,00,000 and
// 1,23,45,678). A group does not start inside another number or a word.
const GROUPED =
  /(?<![\p{L}\p{N}_])(?<!\d[.,])(?:\d{1,3}([,.'\u2019_ ])\d{3}(?:\1\d{3})*|\d{1,2}(?:,\d{2})+,\d{3})(?!\p{N})/gu
// A card number written in groups: four of four (a last group may be shorter, and a fifth may follow), or 4-6-5 and
// 4-6-4. One separator throughout, a space or a hyphen.
const CARD = /(?<![\p{L}\p{N}_])\d{4}([ -])(?:\d{4}\1\d{4}\1\d{1,4}(?:\1\d{1,3})?|\d{6}\1\d{4,5})(?![\p{L}\p{N}_])/gu

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
  // Rare tokens and names are read with the sources facet's domains taken out where they stand as a host name or a
  // site: value. Runs of words were read whole above.
  const sent = known.exempt(fold(query))
  const lower = sent.toLowerCase()
  // Both ways round: a rare token of the query that the private text holds, and a rare token of the private text that
  // the query holds, which catches one the query wrote in lower case or ran into other letters.
  const token =
    rare(sent).find((item) => known.raw.includes(item.toLowerCase()) && !known.typedRaw.includes(item.toLowerCase())) ??
    known.tokens.find((item) => lower.includes(item))
  if (token) return refused("token", token)
  // A name as a word of the query, or, from 6 letters, run into other letters ("acmerobotics").
  const shown = wordsOf(sent)
  const name = known.names.find((item) => shown.includes(item) || (item.length >= 6 && lower.includes(item)))
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
 * digits.
 */
export function rare(text: string) {
  const found = (fold(text).match(TOKEN_RUN) ?? [])
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
      // A number of one significant figure (10000, 300000) says nothing about anyone's files. 2,400,000 does.
      ...(value.match(/\b\d{5,}\b/g) ?? []).filter((number) => !/^\d0+$/.test(number)),
    ])
  return [...new Set(found)].filter((token) => !COMMON.has(token.toLowerCase()))
}

/**
 * The names in the prose of some texts: capitalised words the prose never writes in lower case, and no common word. A
 * sentence's first word, or the first after a label's colon, is capitalised anyway, so it counts only when it reads as
 * a name: possessive ("Acme's"), followed by another capitalised word ("Acme Robotics"), or not a common English word
 * ("Kestrel ships in May", "Employer: Globex", but not "Heat pumps are loud").
 */
export function names(texts: readonly string[]) {
  const words = prose(texts)
    .flatMap((paragraph) => fold(paragraph).split(/(?<=[.!?:;])\s+/))
    .flatMap((sentence) => {
      const found = [...sentence.matchAll(/([\p{L}\p{N}]+)(['\u2019]s(?![\p{L}\p{N}]))?/gu)]
      return found.map((match, index) => ({
        word: match[1]!,
        named: index > 0 || !!match[2] || CAPITALISED.test(found[1]?.[1] ?? "") || !ResearchEnglish.common(match[1]!),
      }))
    })
  // Only a word written on its own shows the prose uses it in lower case: "acme" in jira.acme.internal or
  // acme-billing is part of a name, not the word.
  const lower = new Set(
    prose(texts)
      .flatMap((paragraph) => fold(paragraph).split(/\s+/))
      .map((chunk) => chunk.replace(/^[("'\u201C\u2018[]+|[)"'\u201D\u2019\].,;:!?]+$/gu, ""))
      .filter((chunk) => /^\p{Ll}+(?:['\u2019]\p{Ll}+)?$/u.test(chunk))
      .map((chunk) => chunk.replace(/['\u2019]\p{Ll}+$/u, "")),
  )
  return [
    ...new Set(
      words
        .filter((item) => item.named && item.word.length >= 3 && CAPITALISED.test(item.word))
        .map((item) => item.word.toLowerCase())
        .filter((word) => !lower.has(word) && !COMMON_WORDS.has(word) && !COMMON.has(word)),
    ),
  ]
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

function refused(reason: Reason, match: string): Result {
  return { ok: false, reason, match, message: REFUSAL }
}

function fold(text: string) {
  return WebFence.latin(text.normalize("NFKD").replace(UNSEEN, ""))
    .replace(CARD, (number) => number.replace(/\D/g, ""))
    .replace(GROUPED, (number: string, separator: string | undefined, at: number, whole: string) => {
      // An IPv4 address stays as written, and so does a chain that goes on with its separator and a digit (1.100.2,
      // 192.168.1.20): a version or an address, not a number. "2,400,000.00" is a number with its decimals.
      const after = whole.slice(at + number.length, at + number.length + 2)
      if (isIP(number) === 4 || (separator && separator !== " " && after[0] === separator && /\d/.test(after[1] ?? "")))
        return number
      return number.replace(/\D/g, "")
    })
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

// The prose of the texts a paragraph at a time: the lines that are not code, with wrapped lines joined again so a
// sentence or a run of words is read whole. A line of code ends a paragraph.
function prose(texts: readonly string[]) {
  return texts.flatMap((text) =>
    text
      .split("\n")
      .map((line) => (CODE.test(line) ? "" : line.trim()))
      .join("\n")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
      .filter(Boolean),
  )
}

// The context as the check reads it, worked out once per context object: its words joined for the 6-word runs, the
// 3-word runs of its prose with a name or a number in them, its text in lower case, and the rare tokens and names of
// the private text that the user did not type. Tokens match without case, so lowercasing an identifier or a host name
// does not get it past the check.
const PREPARED = new WeakMap<Context, ReturnType<typeof build>>()

function prepare(context: Context) {
  const known = PREPARED.get(context)
  if (known) return known
  const built = build(context)
  PREPARED.set(context, built)
  return built
}

function build(context: Context) {
  const typedRaw = context.typed.map(fold).join("\n").toLowerCase()
  const typedWords = new Set(context.typed.flatMap(wordsOf))
  const found = names(context.private)
  const named = new Set(found)
  return {
    words: joined(context.private),
    allowedWords: joined([...context.typed, ...context.public]),
    named: new Set(
      prose(context.private).flatMap((paragraph) =>
        grams(wordsOf(paragraph), NAMED_RUN_WORDS)
          .filter(
            (gram) =>
              gram.some((word) => named.has(word) || /\d/.test(word)) && gram.some((word) => LETTER_WORD.test(word)),
          )
          .map((gram) => gram.join(" ")),
      ),
    ),
    raw: context.private.map(fold).join("\n").toLowerCase(),
    typedRaw,
    tokens: [...new Set(context.private.flatMap(rare).map((token) => token.toLowerCase()))].filter(
      (token) => token.length >= 5 && !typedRaw.includes(token),
    ),
    names: found.filter((name) => !typedWords.has(name)),
    exempt: exempting(context.domains ?? []),
  }
}

// The text with each of the domains blanked where it stands alone as a host name or as a site: value ("nature.com",
// "site:nature.com", "-site:nature.com"), and nowhere else: not in "jane@nature.com", "nature.com/acme",
// "acme.nature.com" or "inurl:nature.com". Only host names on a public suffix count, so a word or an intranet name
// passed as a domain exempts nothing.
function exempting(domains: readonly string[]) {
  const hosts = domains
    .map((domain) => fold(domain).trim().toLowerCase())
    .filter((domain) => {
      const parsed = parse(domain, { allowPrivateDomains: true })
      return (
        /^[a-z0-9.-]+$/.test(domain) &&
        parsed.hostname === domain &&
        !!parsed.domain &&
        (!!parsed.isIcann || !!parsed.isPrivate)
      )
    })
    .map((domain) => domain.replaceAll(".", "\\."))
  if (hosts.length === 0) return (text: string) => text
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.@/:+~-])(?:-?site:)?(?:${hosts.join("|")})(?![\\p{L}\\p{N}_@/:-]|\\.[\\p{L}\\p{N}])`,
    "giu",
  )
  return (text: string) => text.replace(pattern, " ")
}
