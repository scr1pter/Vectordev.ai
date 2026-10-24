export * as ResearchOutbound from "./outbound"

import { isIP } from "node:net"
import { domainToUnicode } from "node:url"
import { parse } from "tldts"
import { BrainScan } from "../brain/scan"
import { ResearchCanonical } from "./canonical"
import { WebFence } from "./fence"
import { ResearchWords } from "./words"

// The check on every search query and address research sends out (section 5.4). It checks for private text copied
// into a query by accident, and refuses a query only on a high-confidence signal, so ordinary research queries go out.
// A query or an address is refused when it holds:
// 1. a secret: a password, key or token, as BrainScan finds them;
// 2. a run of RUN_WORDS words that the private context holds, not all of them common words;
// 3. an email address, or a phone, card or account number (9 or more digits), from the private facts;
// 4. a private host from the private context: an intranet name (jira.acme.internal, build01.corp.lan), a private or
//    link-local IP address, or a host whose labels look internal (billing.acme-internal.io, db01.acme.io, and
//    jira.acme.com when the private context has an email address at acme.com);
// 5. a local path in the home folder of a user the private context names (/Users/<name>/, C:\Users\<name>\).
// The private context is the private facts and the work (see Context). The user's typing clears any of 2 to 5, and a
// public source of this run clears 2 and 3 (`strict` keeps a public source from clearing a number). Nothing else is
// refused: names of people and companies, identifiers, public host names, and numbers other than those of 3 (dates,
// versions, years, quarters, ports, amounts) all go out.
//
// It does not chase private text an agent encodes on purpose (digits spread over words, respellings) or paraphrases.
// Deliberate leaks are limited by how a run is built instead: an address must come from a search result, a page link
// or the user's text, researchers in Deep carry no private context, and memory writes are held after web content. The
// queries go to the search service the user set up and are shown in the Sources tab.
//
// Both sides are compared folded: NFKD without accents and invisible characters, any script's digits as ASCII, letters
// that look like Latin ones as Latin (WebFence.latin), and in lower case.

export const REFUSAL = "That search would send text from your private files. Rephrase it with public terms."

/** The run of consecutive words from the private context that is refused on its own. */
export const RUN_WORDS = 8

export type Context = {
  /**
   * Private facts loaded in this run: personal fact lines, MEMORY.md, private document passages, pages read signed
   * in, entries marked private, and decision and lesson lines. Text whose kind is not known belongs here.
   */
  readonly private: readonly string[]
  /**
   * The rest of the private text: repository files read, how-you-work preferences and RULES.md. Its runs of words,
   * private hosts and home folders are checked, and its email addresses and numbers are not.
   */
  readonly work?: readonly string[]
  /** What the user typed in this run's root session. A launching agent's text (a sub-question, a task) is not typed. */
  readonly typed: readonly string[]
  /** Public text seen in this run: search results and the pages read. */
  readonly public: readonly string[]
  /**
   * Domains the user chose to prefer or avoid: the sources facet's (section 6.4a), and the plan's once the user
   * approved it. They become site: filters, so a search query may send one as a host name even when it looks internal.
   * Only host names on a public suffix count, and `address` exempts none.
   */
  readonly domains?: readonly string[]
}

export type Reason = "secret" | "words" | "token"

export type Result =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason; readonly match: string; readonly message: string }

const list = (text: string) => new Set(text.split(/\s+/).filter(Boolean))
// Function words, which ResearchWords.common leaves out. A run made only of these and common words is not telling.
const STOP = list(`a about above after again against all also an and any are as at be because been before being below
  between both but by can could did do does doing done down during each few for from had has have having he her here
  hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our ours out
  over own same she should so some such than that the their theirs them then there these they this those through to
  too under until up us very was we were what when where which while who whom whose why will with would you your yours`)
// The last labels of names only an intranet or a home network resolves (with home.arpa).
const INTRANET = list("internal intranet corp lan local localdomain localhost")
// Words that make a label of a public host name internal ("billing.acme-internal.io", "vpn.acme.com").
const INTERNAL = list("internal intranet intra corp private vpn staging preprod uat")
// Labels that name an internal service under an organisation's own domain ("jira.acme.com" beside jane@acme.com).
const SERVICES = list(
  "jira confluence wiki git gitlab jenkins ci build grafana kibana sentry vault sso ldap admin dev qa",
)
// Mail domains that are nobody's organisation.
const MAIL = list(`gmail.com googlemail.com outlook.com hotmail.com live.com yahoo.com icloud.com me.com proton.me
  protonmail.com aol.com gmx.com github.com example.com`)
// Private and link-local IP addresses (and IPv4's shared range), and the ones everyone writes: routers' defaults and the
// cloud metadata endpoint.
const PRIVATE_IP =
  /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][0-9a-f]*:|fe[89ab][0-9a-f]*:)/
const WELL_KNOWN = list("192.168.0.1 192.168.1.1 192.168.1.254 10.0.0.1 172.16.0.1 169.254.169.254")
// Home folder names that are nobody's user name.
const GENERIC_USERS = list(`shared public default all guest admin administrator root user username user1 name me you
  yourname yourusername runner runneradmin ubuntu ec2-user vagrant pi node app www-data circleci travis jenkins git
  docker vscode codespace codespaces developer dev test $user %username% linuxbrew`)

// What stands between two words.
const WORD = /[^\p{L}\p{N}]+/u
// Locators are found inside runs of the characters they are made of, each cut to MAX_RUN, so the patterns do a bounded
// amount of work at each place and the check stays linear in the size of the private context.
const MAX_RUN = 128
const TOKEN_RUN = /[\w.+\-@:]+/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
// Not after a dot, so a file such as .env.local is not a host.
const HOST = /(?<![\w.-])[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/g
const IPV6 = /(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/g
// A machine's name: letters and a number ("build01", "db-02", "billing07").
const MACHINE = /^[a-z]{2,}-?\d{2,}$/
// A home folder, and the user name in it ("/Users/krishna/", "/home/kb/", "C:\Users\kbharadwaj\"), and a path that
// starts at a root, a drive or home ("/srv/x", "D:\finance", "~/notes").
const HOME = /(?:^|[^\w.-])(?:[a-z]:)?[\\/](?:users|home)[\\/]([^\\/\s"'`<>|:*?,;()[\]{}]+)/g
const LOCAL = /^(?:[a-z]:|~)?[\\/]/
// What a reader reads past: accents and other combining marks once NFKD has split them off, and invisible characters.
const UNSEEN = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu
// A decimal digit of any script. NFKD has made full-width, superscript and mathematical digits ASCII ones already.
const DIGIT = /\p{Nd}/gu

// A number is groups of digits with one usual separator between each two: a space (NFKD makes a no-break or thin space
// one), a hyphen or dash, a dot, a slash, an underscore, or the parentheses around an area code. Commas and apostrophes
// group amounts, which are not contacts, so they separate numbers. A year joins only a group of 3 or 4 digits
// ("555 2019"), so "2024 2025", "FY2024-25", "ISO 27001 2022" and "CVE-2024-12345" are numbers apart. Dotted groups
// are a version or an IPv4 address when a group has one digit or they read as an address (22.04.4, 130.0.6723.91,
// 10.0.19045), a decimal or an arXiv ID when there are two (2410.12345), and a number otherwise (415.555.0177). DOIs
// and ISBNs are public identifiers. A run of more than MAX_GROUPS groups is a list, each group a number of its own.
const DOTTED = /(?<![\d.])\d+(?:\.\d+)+/g
const PUBLIC_ID = /\b10\.\d{4,9}\/\S+|\bisbn(?:-1[03])?[\s:]*\d[\d -]{8,16}[\dx]?/gi
const SEPARATOR = /^(?:[ ./_\u2010-\u2015\u2212-]|\)? ?\(?)$/u
const YEAR = /^(?:19|20)\d\d$/
const MAX_GROUPS = 8
// A contact number has this many digits or more, and a query holds one when it shares this many in a row with it. A
// run of more than MAX_DIGITS is data, not a contact. A public text with more than PUBLIC_NUMBERS clears none.
const CONTACT_DIGITS = 9
const MAX_DIGITS = 40
const PUBLIC_NUMBERS = 100

/** Whether a search query may leave, given the run's private context. */
export function check(query: string, context: Context): Result {
  return inspect(query, context, true)
}

/**
 * Whether an address may be read, by the same check on its user name and password, path, query and fragment, and on
 * the part of its host before its site: the site came from provenance, but a name such as
 * jira.initech.internal.attacker.example carries text the way a path does. Its path is read for a home folder, not for
 * a user name elsewhere in it (github.com/<name> is a public page).
 */
export function address(url: string, context: Context): Result {
  if (!URL.canParse(url)) return refused("token", url)
  const parsed = new URL(url)
  const path = ResearchCanonical.decoded(parsed.pathname)
  const user = usersOf(fold(path)).find((name) => prepare(context).users.has(name))
  if (user) return refused("token", user)
  const text = [
    subdomainOf(parsed.hostname),
    parsed.username,
    parsed.password,
    ...path.split("/"),
    ...[...parsed.searchParams].flat(),
    parsed.hash.slice(1),
  ]
  return inspect(text.map(ResearchCanonical.decoded).join(" "), context, false)
}

/**
 * The context as browsers apply it in research (research_browser's addresses and typing, and the lead's handoff): a
 * public source of the run clears no number, so a hostile page that lists numbers cannot make one of the user's
 * sendable. Runs of words a public source holds stay clear, as they do for searches.
 */
export function strict(context: Context): Context {
  return { ...context, public: context.public.map((text) => text.replace(/\p{Nd}/gu, " ")) }
}

/** The email addresses, host names and IP addresses in a text, in lower case. */
export function rare(text: string) {
  const lower = fold(text)
  const hosts = locators(lower).filter((host) =>
    isIP(host) ? !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host) : intranet(host) || publicHost(host),
  )
  return [...new Set([...found(lower, EMAIL), ...hosts])]
}

/** @deprecated The check reads no names, since a name of a person or a company is never refused. It returns none. */
export function names(_texts: readonly string[]): string[] {
  return []
}

// The check. In a search query (`query`) the user's domains may go as host names, and every local path is read for a
// user name; `address` reads its path for a home folder itself.
function inspect(text: string, context: Context, query: boolean): Result {
  if (BrainScan.credential(text) || BrainScan.redact(text).redacted)
    return refused("secret", "a password, key or token")
  const known = prepare(context)
  const lower = fold(text)
  const run = grams(lower.split(WORD).filter(Boolean), RUN_WORDS)
    .filter((gram) => gram.some((word) => !common(word)))
    .map((gram) => ` ${gram.join(" ")} `)
    .find((gram) => known.words.includes(gram) && !known.allowed.includes(gram))
  if (run) return refused("words", run.trim())
  const contact =
    known.emails.find((email) => lower.includes(email)) ??
    numbersOf(lower).find((digits) => windows(digits).some((window) => known.numbers.has(window))) ??
    locators(lower)
      .filter((token) => !query || !known.domains.has(token.replace(/^www\./, "")))
      .flatMap((token) => known.hosts.filter((host) => holds(token, host)))[0] ??
    [...usersOf(lower), ...(query ? segmentsOf(lower) : [])].find((name) => known.users.has(name))
  if (contact) return refused("token", contact)
  return { ok: true }
}

function refused(reason: Reason, match: string): Result {
  return { ok: false, reason, match, message: REFUSAL }
}

// The context as the check reads it, worked out once per context object.
const PREPARED = new WeakMap<Context, ReturnType<typeof build>>()

function prepare(context: Context) {
  const known = PREPARED.get(context) ?? build(context)
  PREPARED.set(context, known)
  return known
}

function build(context: Context) {
  const facts = context.private.map(fold)
  const all = [...facts, ...(context.work ?? []).map(fold)]
  const typed = context.typed.map(fold)
  const shown = context.public.map(fold)
  const typedNumbers = typed.flatMap(numbersOf)
  const shownNumbers = shown.map(numbersOf).flatMap((numbers) => (numbers.length > PUBLIC_NUMBERS ? [] : numbers))
  const orgs = new Set(
    all
      .flatMap((text) => found(text, EMAIL))
      .map((email) => parse(email.slice(email.indexOf("@") + 1), { allowPrivateDomains: true }).domain ?? "")
      .filter((domain) => domain && !MAIL.has(domain)),
  )
  const typedHosts = typed.flatMap(locators)
  const typedUsers = new Set(typed.flatMap((text) => [...usersOf(text), ...segmentsOf(text)]))
  return {
    words: joined(all),
    allowed: joined([...typed, ...shown]),
    emails: [...new Set(facts.flatMap((text) => found(text, EMAIL)))].filter(
      (email) => ![...typed, ...shown].some((text) => text.includes(email)),
    ),
    // Every run of CONTACT_DIGITS digits of the contact numbers that the user did not type and no public source holds.
    numbers: new Set(
      [...new Set(facts.flatMap(numbersOf))]
        .filter((digits) => digits.length <= MAX_DIGITS && !shownNumbers.some((item) => item.includes(digits)))
        .filter((digits) => !typedNumbers.some((item) => windows(digits).some((window) => item.includes(window))))
        .flatMap(windows),
    ),
    hosts: [...new Set(all.flatMap(locators))].filter(
      (host) => internal(host, orgs) && !typedHosts.some((token) => holds(token, host)),
    ),
    users: new Set(
      all.flatMap(usersOf).filter((name) => name.length >= 2 && !GENERIC_USERS.has(name) && !typedUsers.has(name)),
    ),
    domains: new Set(
      (context.domains ?? [])
        .map((domain) => fold(domain).replace(/^\s*(?:\*?\.|www\.)?|\.?\s*$/g, ""))
        .filter(publicHost),
    ),
  }
}

// Whether a host name or an IP address from the private context is private (rule 4). A site's own label counts only
// as a part ("acme-internal"), so a file such as internal.md is not one.
function internal(host: string, orgs: ReadonlySet<string>) {
  // A network's or a broadcast address names no machine.
  if (isIP(host)) return PRIVATE_IP.test(host) && !WELL_KNOWN.has(host) && !/\.(?:0|255)$/.test(host)
  if (intranet(host)) return true
  const parsed = parse(host, { allowPrivateDomains: true })
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) return false
  const site = parsed.domainWithoutSuffix ?? ""
  const worded = (label: string) => label.split("-").some((piece) => INTERNAL.has(piece))
  return (
    (site.includes("-") && worded(site)) ||
    (parsed.subdomain ?? "")
      .split(".")
      .some((label) => worded(label) || MACHINE.test(label) || (orgs.has(parsed.domain!) && SERVICES.has(label)))
  )
}

// A name on an intranet's or a home network's suffix (jira.acme.internal, nas.home.arpa, api.acme.localhost).
function intranet(host: string) {
  return INTRANET.has(host.slice(host.lastIndexOf(".") + 1)) || host.endsWith(".home.arpa")
}

function publicHost(host: string) {
  const parsed = parse(host, { allowPrivateDomains: true })
  return parsed.hostname === host && !!parsed.domain && (!!parsed.isIcann || !!parsed.isPrivate)
}

// Whether a host-like token holds a private host or IP address whole, label for label: jira.acme.internal is in
// jira.acme.internal.attacker.example, and not in xjira.acme.internal.
function holds(token: string, host: string) {
  return `.${token}.`.includes(`.${host}.`)
}

// The contact-length numbers of a folded text as strings of digits, read as the comment on DOTTED says.
function numbersOf(text: string) {
  const plain = text.replace(PUBLIC_ID, " ; ").replace(DOTTED, (run) => {
    const groups = run.split(".")
    if (isIP(run) === 4 || groups.some((group) => group.length === 1)) return " ; "
    return groups.length === 2 ? groups.join(" ; ") : run
  })
  return [...plain.matchAll(/\d+/g)]
    .reduce<{ groups: string[]; end: number }[]>((runs, match) => {
      const last = runs.at(-1)
      const end = match.index + match[0].length
      if (last && joins(plain.slice(last.end, match.index), last.groups.at(-1)!, match[0])) {
        last.groups.push(match[0])
        last.end = end
        return runs
      }
      runs.push({ groups: [match[0]], end })
      return runs
    }, [])
    .flatMap((run) => (run.groups.length > MAX_GROUPS ? run.groups : [run.groups.join("")]))
    .filter((digits) => digits.length >= CONTACT_DIGITS)
}

// Whether two groups of digits with `separator` between them are one number.
function joins(separator: string, before: string, group: string) {
  if (!SEPARATOR.test(separator)) return false
  const years = [before, group].filter((item) => YEAR.test(item)).length
  return years === 0 || (years === 1 && [before, group].every((item) => YEAR.test(item) || /^\d{3,4}$/.test(item)))
}

// Every run of CONTACT_DIGITS digits in a string of digits.
function windows(digits: string) {
  return Array.from({ length: Math.max(0, digits.length - CONTACT_DIGITS + 1) }, (_, index) =>
    digits.slice(index, index + CONTACT_DIGITS),
  )
}

// What a pattern finds in the runs of a folded text, each run cut to MAX_RUN.
function found(lower: string, pattern: RegExp) {
  return (lower.match(TOKEN_RUN) ?? []).flatMap((run) =>
    Array.from({ length: Math.ceil(run.length / MAX_RUN) }, (_, index) =>
      run.slice(index * MAX_RUN, (index + 1) * MAX_RUN),
    ).flatMap((chunk) => chunk.match(pattern) ?? []),
  )
}

// The host names, IPv4 addresses and IPv6 addresses of a folded text.
function locators(lower: string) {
  return [...found(lower, HOST), ...found(lower, IPV6).filter((ip) => isIP(ip) === 6)]
}

function usersOf(lower: string) {
  return [...lower.matchAll(HOME)].map((match) => match[1]!.replace(/\.+$/, ""))
}

// The parts of the local paths in a text, which hold a user name as often as a home folder does ("D:\kb\ledger.db").
function segmentsOf(lower: string) {
  return lower
    .split(/[\s"'`<>|()[\]{},;]+/)
    .filter((token) => LOCAL.test(token))
    .flatMap((token) => token.split(/[\\/]+/).map((part) => part.replace(/\.+$/, "")))
}

// The part of a host before its site, each label's punycode decoded. When tldts finds no site, as in a host with a
// label it rejects (an underscore, a dash at either end, punycode that does not decode), the whole host is read.
function subdomainOf(hostname: string) {
  const name = hostname.replace(/\.$/, "")
  if (isIP(name.replace(/^\[|\]$/g, ""))) return ""
  const parsed = parse(name, { allowPrivateDomains: true })
  return (parsed.domain ? (parsed.subdomain ?? "") : name)
    .split(".")
    .map((label) => (label.startsWith("xn--") ? domainToUnicode(label) || label : label))
    .join(".")
}

// Text as the check compares it (see the comment at the top), in lower case.
function fold(text: string) {
  return WebFence.latin(text.normalize("NFKD").replace(UNSEEN, "").replace(DIGIT, ascii)).toLowerCase()
}

// A decimal digit of any script as its ASCII digit. Unicode gives each script's digits 0 to 9 in order, in blocks of
// ten that may follow one another, so a digit's value is the count of digits straight before it, modulo ten.
function ascii(digit: string) {
  const code = digit.codePointAt(0)!
  if (code < 0x80) return digit
  const before = Array.from({ length: 60 }, (_, index) => code - index - 1).findIndex(
    (at) => !/^\p{Nd}$/u.test(String.fromCodePoint(at)),
  )
  return String(before % 10)
}

// A word that says nothing on its own: a function word, a common English word, or a number of up to 4 digits.
function common(word: string) {
  return STOP.has(word) || ResearchWords.common(word) || /^\d{1,4}$/.test(word)
}

function grams(words: readonly string[], size: number) {
  return words.slice(0, Math.max(0, words.length - size + 1)).map((_, index) => words.slice(index, index + size))
}

function joined(texts: readonly string[]) {
  return ` ${texts.map((text) => text.split(WORD).filter(Boolean).join(" ")).join(" \n ")} `
}
