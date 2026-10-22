export * as ResearchOutbound from "./outbound"

import { isIP } from "node:net"
import { domainToUnicode } from "node:url"
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
// "Employer: Globex"), but not "Heat" at the start of a sentence about heat pumps, nor a public tool a README names
// ("Docker builds the image"). Code is left out, since it is full of capitalised words ("Effect", "Schema") that say
// nothing about anyone. Names cost some fair queries: a private line about Germany keeps "Germany" out of queries
// until the user types it. And some names are missed: a company named with a common word ("Target pays about
// 2,400,000 USD a year" lets "Target vendor contract" through, since "Target" opening a sentence is the word) and a
// name written in capitals ("Uses ACME for invoicing", which reads as an acronym such as USD).
//
// Text is compared the way a reader sees it, on both sides:
// - folded by NFKD, without accents and invisible characters (soft hyphens, zero-width spaces);
// - with letters that look like Latin ones read as Latin, through Unicode's confusables data: "Аcme" with a Cyrillic
//   "А", Cherokee "\u13AAcme", Lisu "\uA4EEcme" and "Ac\u2C98e" with a Coptic "\u2C98" are all "Acme";
// - for names and rare tokens, with ASCII's own look-alikes read alike (I, l and 1; 0 and O; rn and m; vv and w), so
//   "GIobex", "Gl0bex" and "Acrne" are Globex and Acme;
// - with numbers read by their digits. A digit of any script is its ASCII digit (Arabic-Indic \u0662 and Devanagari
//   \u0968 are 2), and digit groups with one to three characters of space or punctuation between them are one number:
//   2,400,000, 2.400.000, 2 400 000, 2, 400, 000, USD2,400,000 and 24,00,000 are all 2400000, and 415-555-0132,
//   (415) 555-0132 and a card number in fours are one number each. A query is refused when one of its numbers holds
//   a number of 5 or more digits from the private text, or is one of 5 or more digits inside one, so a phone number
//   goes neither with its country code nor without it. Versions and IPv4 addresses (1.100.2, 192.168.1.20) are not
//   numbers, and a group glued to a letter joins the next only as a group of three, so "Q3 2026" is two numbers. The
//   cost is that two numbers written side by side are read as one: a private "2019, 2024" keeps "2019 2024" out.
// It catches literal overlap only: a model can still paraphrase. The queries go to the search service the user set up
// and are shown in the Sources tab, so a paraphrase is at least visible.

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
   * they may go out in a search query as a host name or a site: value. Anywhere else in a query (a path, a longer
   * host, an email address), and anywhere in an address `address` checks, they are checked like any other private
   * text. Only public host names count, never a word or an intranet name.
   */
  readonly domains?: readonly string[]
}

export type Reason = "secret" | "words" | "token"

export type Result =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason; readonly match: string; readonly message: string }

// Words of mixed case that are names everyone uses, not identifiers from someone's code, and the public tools a
// repository's README names ("Docker builds the image", "Postgres stores the sessions"), which say nothing about
// anyone. Tools named with an English word (Swift, Rust, Express) are left out, since a code name is often one.
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
  "android",
  "ansible",
  "babel",
  "bigquery",
  "chromium",
  "clang",
  "clickhouse",
  "cloudflare",
  "cmake",
  "datadog",
  "debian",
  "deno",
  "django",
  "docker",
  "elasticsearch",
  "emacs",
  "esbuild",
  "eslint",
  "fedora",
  "figma",
  "firebase",
  "firefox",
  "golang",
  "gradle",
  "grafana",
  "grpc",
  "heroku",
  "huggingface",
  "jupyter",
  "kafka",
  "kotlin",
  "kubectl",
  "kubernetes",
  "laravel",
  "linux",
  "llvm",
  "macos",
  "matplotlib",
  "minikube",
  "neovim",
  "netlify",
  "nginx",
  "npm",
  "nuxt",
  "ollama",
  "openapi",
  "pnpm",
  "podman",
  "postgres",
  "protobuf",
  "pydantic",
  "pytest",
  "python",
  "rabbitmq",
  "redis",
  "redux",
  "scala",
  "sqlalchemy",
  "supabase",
  "sveltekit",
  "tailwindcss",
  "terraform",
  "twilio",
  "ubuntu",
  "vercel",
  "vite",
  "vitest",
  "vscode",
  "vuejs",
  "webpack",
  "xcode",
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
// A decimal digit of any script. NFKD has made full-width and mathematical digits ASCII ones already.
const DIGIT = /\p{Nd}/gu
const ONE_DIGIT = /^\p{Nd}$/u
// A group of digits, and what may stand between two groups of one number: one to three characters that are not
// letters, digits, marks or line breaks (",", ".", " ", "-", ", ", ") ", a tab, "\u066C" in Arabic).
const GROUP = /\d+/g
const BETWEEN = /^[^\p{L}\p{N}\p{M}\n\r\u2028\u2029]{1,3}$/u
const LETTER_BEFORE = /\p{L}$/u
const LETTER_AFTER = /^\p{L}/u
const DIGITS = /^\d+$/
// The most groups one number is read from, so a long list of numbers costs a bounded amount per group.
const MAX_GROUPS = 8

/** Whether a search query may leave, given the run's private context. */
export function check(query: string, context: Context): Result {
  return inspect(query, context, true)
}

/**
 * Whether an address may be read, by the same check on its path, query and fragment, and on the part of its host
 * before its site, whole and label by label: the site came from provenance, but a name such as
 * acme-q3-churn.attacker.example or jira.initech.internal.attacker.example carries text the way a path does. The
 * sources facet's domains are not exempt here, since they are site: filters, not words of a path or a host's labels.
 */
export function address(url: string, context: Context): Result {
  if (!URL.canParse(url)) return refused("token", url)
  const parsed = new URL(url)
  // The host as a reader sees it, not its punycode, so look-alike letters in it are read.
  const subdomain = domainToUnicode(parse(parsed.hostname, { allowPrivateDomains: true }).subdomain ?? "")
  const text = [
    subdomain,
    ...subdomain.split("."),
    ...parsed.pathname.split("/"),
    ...[...parsed.searchParams].flatMap(([key, value]) => [key, value]),
    parsed.hash.slice(1),
  ]
    .map(ResearchCanonical.decoded)
    .join(" ")
  // As written, for identifiers and paths, and with a slug's dashes read as spaces, for runs of words.
  const written = inspect(text, context, false)
  if (!written.ok) return written
  return inspect(text.replace(/[-+_]+(?=\p{L})/gu, " "), context, false)
}

// The check, with the sources facet's domains exempt where they stand as a host name or a site: value when `sites`
// holds: in a search query, where they become site: filters, and not in an address.
function inspect(query: string, context: Context, sites: boolean): Result {
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
  // Numbers, rare tokens and names are read with the sources facet's domains taken out where they may stand. Runs of
  // words were read whole above.
  const sent = sites ? known.exempt(fold(query)) : fold(query)
  const number = numberIn(sent, known)
  if (number) return refused("token", number)
  const seen = alike(sent)
  // Both ways round: a rare token of the query that the private text holds, and a rare token of the private text that
  // the query holds, which catches one the query wrote in lower case or ran into other letters.
  const token =
    rare(sent).find(
      (item) => !DIGITS.test(item) && known.raw.includes(alike(item)) && !known.typedRaw.includes(alike(item)),
    ) ?? known.tokens.find((item) => seen.includes(item.key))?.token
  if (token) return refused("token", token)
  // A name as a word of the query, as a plural too ("Acmes"), or, from 6 letters, run into other letters
  // ("acmerobotics").
  const shown = new Set(wordsOf(sent).map(alike))
  const name = known.names.find(
    (item) =>
      shown.has(item.key) ||
      shown.has(`${item.key}s`) ||
      shown.has(`${item.key}es`) ||
      (item.name.length >= 6 && seen.includes(item.key)),
  )
  if (name) return refused("token", name.name)
  return { ok: true }
}

// A number of the private text inside one of the query's, or one of the query's of 5 or more digits inside one of the
// private text's, by their digits alone: "+1 415-555-0132" holds the private 415-555-0132, and "0532 0130" is part of
// the private 0044 0532 0130.
function numberIn(text: string, known: ReturnType<typeof build>) {
  const numbers = runs(text).map((run) => run.groups.join(""))
  return (
    known.numbers.find((number) => numbers.some((digits) => digits.includes(number))) ??
    numbers.find((digits) => figure(digits) && known.digits.includes(digits) && !known.typedDigits.includes(digits))
  )
}

/**
 * The rare tokens in a text: identifiers, paths, email addresses, host names, IP addresses and numbers of 5 or more
 * digits, by their digits, with each stretch of whole groups in them (415-555-0132 gives 4155550132 and 5550132).
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
    ])
  const numbers = runs(folded)
    .filter((run) => !dotted(run))
    .flatMap(figures)
  return [...new Set([...found, ...numbers])].filter((token) => !COMMON.has(token.toLowerCase()))
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
  return WebFence.latin(text.normalize("NFKD").replace(UNSEEN, "").replace(DIGIT, ascii))
}

// A decimal digit of any script as its ASCII digit. Unicode gives each script's digits 0 to 9 in order, in blocks of
// ten that may follow one another, so a digit's value is the count of digits straight before it, modulo ten.
function ascii(digit: string) {
  const code = digit.codePointAt(0)!
  if (code < 0x80) return digit
  const before = Array.from({ length: 60 }, (_, index) => code - index - 1).findIndex(
    (at) => !ONE_DIGIT.test(String.fromCodePoint(at)),
  )
  return String(before % 10)
}

// Text as ASCII's own look-alikes read, for names and rare tokens: in lower case, with I, l and 1 one letter, 0 and O
// one, rn read as m and vv as w (Unicode's prototypes for them).
function alike(text: string) {
  return text.toLowerCase().replace(/rn/g, "m").replace(/vv/g, "w").replace(/[i1]/g, "l").replace(/0/g, "o")
}

type Run = { readonly groups: readonly string[]; readonly separators: readonly string[] }

// The numbers of a folded text, as runs of digit groups. A group joins the one before it across what BETWEEN allows,
// unless one of the two is glued to a letter ("Q3", "3rd") and the later one is not a group of three: USD2,400,000 is
// one number, "Q3 2026" two.
function runs(text: string): Run[] {
  return [...text.matchAll(GROUP)]
    .reduce<{ groups: string[]; separators: string[]; start: number; end: number }[]>((all, match) => {
      const last = all.at(-1)
      const start = match.index
      const end = start + match[0].length
      const glued =
        (last?.groups.length === 1 && LETTER_BEFORE.test(text.slice(Math.max(0, last.start - 2), last.start))) ||
        LETTER_AFTER.test(text.slice(end, end + 2))
      if (last && BETWEEN.test(text.slice(last.end, start)) && (!glued || match[0].length === 3)) {
        last.groups.push(match[0])
        last.separators.push(text.slice(last.end, start))
        last.end = end
        return all
      }
      all.push({ groups: [match[0]], separators: [], start, end })
      return all
    }, [])
    .flatMap(apart)
}

// A version or an IPv4 address in a run stands on its own, so "1.2.3, 1.3.0" is two versions and not one number.
// The run is cut where a separator is not a dot, and the pieces that are not versions or addresses join again.
function apart(run: Run): Run[] {
  const cuts = [
    0,
    ...run.separators.flatMap((separator, index) => (separator === "." ? [] : [index + 1])),
    run.groups.length,
  ]
  const pieces = cuts
    .slice(0, -1)
    .map((from, index) => ({ from, to: cuts[index + 1]!, dotted: dotted(part(run, from, cuts[index + 1]!)) }))
  if (!pieces.some((piece) => piece.dotted)) return [run]
  return pieces
    .reduce<typeof pieces>((all, piece) => {
      const last = all.at(-1)
      if (last && !last.dotted && !piece.dotted) {
        last.to = piece.to
        return all
      }
      all.push({ ...piece })
      return all
    }, [])
    .map((piece) => part(run, piece.from, piece.to))
}

function part(run: Run, from: number, to: number): Run {
  return { groups: run.groups.slice(from, to), separators: run.separators.slice(from, to - 1) }
}

// A version or an IPv4 address, which the rare tokens read as written: an IPv4 address, or three or more groups of at
// most three digits joined by dots alone, unless every group after the first has three (2.345.678 is a number).
function dotted(run: Run) {
  if (run.separators.length < 2 || !run.separators.every((separator) => separator === ".")) return false
  if (run.groups.length === 4 && isIP(run.groups.join(".")) === 4) return true
  return run.groups.every((group) => group.length <= 3) && !run.groups.slice(1).every((group) => group.length === 3)
}

// The rare numbers a run holds: each stretch of whole groups that is a figure, so +1 415-555-0132 holds
// 415-555-0132 and 555-0132 as well as the whole.
function figures(run: Run) {
  return run.groups
    .flatMap((_, start) =>
      run.groups
        .slice(start, start + MAX_GROUPS)
        .map((_, index) => run.groups.slice(start, start + index + 1).join("")),
    )
    .filter(figure)
}

// A number of 5 or more digits, and more than one significant figure: 10000 and 300000 say nothing about anyone's
// files, 2,400,000 does.
function figure(digits: string) {
  return digits.length >= 5 && !/^\d0+$/.test(digits)
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
// 3-word runs of its prose with a name or a number in them, its text as look-alikes read, the numbers of its private
// text, and the rare tokens and names of the private text that the user did not type. Tokens match without case, so
// lowercasing an identifier or a host name does not get it past the check.
const PREPARED = new WeakMap<Context, ReturnType<typeof build>>()

function prepare(context: Context) {
  const known = PREPARED.get(context)
  if (known) return known
  const built = build(context)
  PREPARED.set(context, built)
  return built
}

function build(context: Context) {
  const typedRaw = alike(context.typed.map(fold).join("\n"))
  const typedWords = new Set(context.typed.flatMap(wordsOf).map(alike))
  const typedDigits = context.typed
    .flatMap((text) => runs(fold(text)))
    .map((run) => run.groups.join(""))
    .join("\n")
  const counted = context.private.flatMap((text) => runs(fold(text))).filter((run) => !dotted(run))
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
    raw: alike(context.private.map(fold).join("\n")),
    typedRaw,
    tokens: [...new Set(context.private.flatMap(rare).filter((token) => !DIGITS.test(token)))]
      .map((token) => ({ token: token.toLowerCase(), key: alike(token) }))
      .filter((item) => item.token.length >= 5 && !typedRaw.includes(item.key)),
    names: found.map((name) => ({ name, key: alike(name) })).filter((item) => !typedWords.has(item.key)),
    // The rare numbers of the private text the user did not type, and the digits of all its numbers.
    numbers: [...new Set(counted.flatMap(figures))].filter((number) => !typedDigits.includes(number)),
    digits: counted.map((run) => run.groups.join("")).join("\n"),
    typedDigits,
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
