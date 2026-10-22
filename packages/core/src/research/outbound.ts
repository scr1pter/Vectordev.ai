export * as ResearchOutbound from "./outbound"

import { isIP } from "node:net"
import { domainToUnicode } from "node:url"
import { parse } from "tldts"
import { BrainScan } from "../brain/scan"
import { ResearchCanonical } from "./canonical"
import { WebFence } from "./fence"
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
// - a private number of 5 or more digits, read by its digits alone (below), unless the user typed it or a public
//   source in this run holds it;
// - a rare token from either kind: an identifier, a path, an email address, a host name (intranet names such as
//   jira.acme.internal included) or an IP address; or a name from private-fact prose. An identifier, a host name or
//   an email address of 3 or more parts still counts when the query splits it into words ("reconcile ledger
//   entries"). Only the user's typing makes one of these safe to send. A public source does not, since a hostile page
//   could list every host name of a company to clear them all. The domains the user prefers or avoids are the one
//   exception for host names: they exist to become site: filters, so they may go out as a host name or a site: value,
//   and nowhere else.
//
// A name is a word of private-fact prose that the prose never writes in lower case and that is not a common word: a
// capitalised word inside a sentence ("Acme", "Fremont"); a sentence's, a heading's or a label's first word when it is
// not a common English word ("Falcon is the codename", "Employer: Globex", but not "Heat pumps are loud"); a word in
// capitals that is not a common acronym ("GLOBEX", but not "NASA" or "API"); and, in a line written all in lower case
// as memory-of-you lines sometimes are ("my employer is initech"), every word that is not a common English word.
// Public tools a README names ("Docker builds the image") are not names. Names cost some fair queries: a private line
// about Germany keeps "Germany" out of queries until the user types it. A name still missed: a company named with a
// common word in a lower-case line ("i work at umbrella corp").
//
// Text is compared the way a reader sees it, on both sides:
// - folded by NFKD, without accents and invisible characters (soft hyphens, zero-width spaces);
// - with letters that look like Latin ones read as Latin, through Unicode's confusables data (WebFence.latin):
//   "\u0410cme" with a Cyrillic "\u0410", Cherokee "\u13AAcme", Lisu "\uA4EEcme" and "Ac\u2C98e" with a Coptic
//   "\u2C98" are all "Acme";
// - for names and rare tokens, with ASCII's own look-alikes read alike (I, l and 1; 0 and O; rn and m; vv and w), so
//   "GIobex", "Gl0bex" and "Acrne" are Globex and Acme, and a name of 6 or more letters with its letters split apart
//   ("G l o b e x", "glo-bex") is still that name.
//
// Numbers are compared by their digits only, every other character ignored, so no separator can hide one. A digit of
// any script is its ASCII digit (Arabic-Indic \u0662 and Devanagari \u0968 are 2).
// - The private side: each private number of 5 or more digits, and each stretch of whole groups in it of 5 or more
//   (a phone number without its country code): digit groups with one to three characters that are not letters or
//   digits between them make one number ("2,400,000", "+1 415-555-0132", "0044 0532 0130", a card in fours), and a
//   group glued to a letter joins the next only as a group of three, so "Q3 2026" is two numbers. A version or an IPv4
//   address (1.100.2, 192.168.1.20) is not a number; an IP address is a rare token of its own, as written.
// - The query side: all its digits in order, read across everything between them: inside a word whatever stands
//   between them ("4a417b203"), and across words with no letters ("4 - 417 / 203") and at most one word of letters
//   ("4417 and 203").
// - A query is refused when its digits hold a private number, or 7 or more digits in a row of a longer one. The user's
//   typing clears a number its digits hold. A public source clears a number it holds as one of its own numbers, unless
//   it holds more than 100 numbers of 5 or more digits: a page of every 5-digit number would otherwise clear them all.
// The cost: two unrelated numbers written side by side read as one, so on rare occasions a fair query is refused
// because its digits run into a private number ("iso 9001 2015" holds "12015"). A number spelled in words, or with
// letters for digits ("24OOOOO"), is not read.
//
// It catches literal overlap only: a model can still paraphrase. The queries go to the search service the user set up
// and are shown in the Sources tab, so a paraphrase is at least visible.

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
   * The rest of the private text: repository files read, how-you-work preferences and RULES.md. Only its rare tokens,
   * its numbers and its runs of 6 words are kept out of queries.
   */
  readonly work?: readonly string[]
  /** What the user typed in this run's root session. A launching agent's text (a sub-question, a task) is not typed. */
  readonly typed: readonly string[]
  /** Public text seen in this run: search results and the pages read. */
  readonly public: readonly string[]
  /**
   * Domains the user chose to prefer or avoid: the sources facet's (section 6.4a), and the plan's once the user
   * approved it. They exist to become site: filters, so a search query may send one as a host name or a site: value
   * (with or without "www."). Anywhere else in a query (a path, a longer host, an email address), and anywhere in an
   * address `address` checks, they are checked like any other private text. Only public host names count, never a
   * word or an intranet name.
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
  "android",
  "ansible",
  "babel",
  "chromium",
  "clang",
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
  "jupyter",
  "kafka",
  "kotlin",
  "kubectl",
  "kubernetes",
  "laravel",
  "linux",
  "llvm",
  "matplotlib",
  "minikube",
  "neovim",
  "netlify",
  "nginx",
  "npm",
  "nuxt",
  "ollama",
  "pnpm",
  "podman",
  "postgres",
  "protobuf",
  "pydantic",
  "pytest",
  "python",
  "redis",
  "redux",
  "scala",
  "sqlalchemy",
  "supabase",
  "terraform",
  "twilio",
  "ubuntu",
  "vercel",
  "vite",
  "vitest",
  "vscode",
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
  lts eol cicd ascii utf unicode rgb hsl svg png jpg jpeg gif webp mp3 mp4 wasm jsx tsx www`
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
// Where a sentence ends: after its stop and any closing marks ("Undo.**", "(see above).\""), or a label's colon.
const SENTENCE = /(?<=[.!?:;][)\]"'\u201D\u2019*_]*)\s+/
// A whitespace-delimited chunk of prose without the punctuation around it, and one that is a word in lower case.
const AROUND = /^[("'\u201C\u2018[]+|[)"'\u201D\u2019\].,;:!?]+$/gu
const LOWER_WORD = /^\p{Ll}+(?:['\u2019]\p{Ll}+)?$/u
// Rare tokens are found inside runs of the characters they are made of, each cut to this length, so the patterns do
// a bounded amount of work at each place and the check stays linear in the size of the private context.
const MAX_RUN = 128
const TOKEN_RUN = /[\w.+\-/@~:]+/g
// What a reader reads past: accents and other combining marks once NFKD has split them off, and invisible characters.
const UNSEEN = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu
// A decimal digit of any script. NFKD has made full-width, superscript and mathematical digits ASCII ones already.
const DIGIT = /\p{Nd}/gu
const ONE_DIGIT = /^\p{Nd}$/u
// A group of digits, and what may stand between two groups of one private number: one to three characters that are
// not letters, digits or marks (",", ".", " ", "-", ", ", ") ", a tab, a line break, "\u066C" in Arabic).
const GROUP = /\d+/g
const BETWEEN = /^[^\p{L}\p{N}\p{M}]{1,3}$/u
const LETTER_BEFORE = /\p{L}$/u
const LETTER_AFTER = /^\p{L}/u
const DIGITS = /^\d+$/
// The most groups one private number is read from, so a long list of numbers costs a bounded amount per group.
const MAX_GROUPS = 8
// The shortest private number, and the run of a longer one's digits that is enough on its own ("8802 5671" of a card
// written 4417880256719113).
const NUMBER_DIGITS = 5
const PART_DIGITS = 7
// The words of letters a query's digits are read across: "4417 and 203" is 4417203, "top 10 heat pumps 2025" is 10 and
// 2025.
const GAP_WORDS = 1
// A public text with more numbers of 5 or more digits than this clears none of them.
const PUBLIC_NUMBERS = 100
// A token split into words: it needs 3 to 8 parts and 12 or more letters and digits, and the query has to write one
// word for each part. So "reconcile ledger entries" and "reconcile_ledger_entries" are reconcileLedgerEntries, while
// "status code" is not statusCode and "openai responses" is not OpenAIResponses.
const SPLIT_CHARS = 12
const SPLIT_PARTS = 3
const SPLIT_WORDS = 8
// The words that stand for a separator when an address is spelled out.
const SPOKEN = new Set(["at", "dot", "dash", "hyphen", "underscore", "slash"])
// A name this long is still found with its letters split apart or run into other words ("G l o b e x",
// "acmerobotics" for a 6-letter name), and not a shorter one, which other words hold by chance.
const SPLIT_NAME = 6

/** Whether a search query may leave, given the run's private context. */
export function check(query: string, context: Context): Result {
  return inspect(query, context, true)
}

/**
 * Whether an address may be read, by the same check on its user name and password, its path, query and fragment, and
 * on the part of its host before its site, whole and label by label: the site came from provenance, but a name such
 * as acme-q3-churn.attacker.example or jira.initech.internal.attacker.example carries text the way a path does. The
 * sources facet's domains are not exempt here, since they are site: filters, not words of a path or a host's labels.
 */
export function address(url: string, context: Context): Result {
  if (!URL.canParse(url)) return refused("token", url)
  const parsed = new URL(url)
  const subdomain = subdomainOf(parsed.hostname)
  const text = [
    subdomain,
    ...subdomain.split("."),
    parsed.username,
    parsed.password,
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

// The check, with the user's domains exempt where they stand as a host name or a site: value when `sites` holds: in a
// search query, where they become site: filters, and not in an address. Runs of words and names are read in the
// query as written, so a domain clears no name it holds.
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
  // An identifier, a host name or an email address with its parts written as words, and "at" and "dot" read past
  // ("jane doe at globex dot com").
  const parted = wordsOf(sent).filter((word) => !SPOKEN.has(word))
  const split = Array.from({ length: SPLIT_WORDS - SPLIT_PARTS + 1 }, (_, index) =>
    grams(parted, index + SPLIT_PARTS).map((gram) => known.split.get(`${gram.length}:${alike(gram.join(""))}`)),
  )
    .flat()
    .find(Boolean)
  if (split) return refused("token", split)
  // A name as a word of the query, as a plural too ("Acmes"), or, from 6 letters, run into other letters or with its
  // letters split apart ("acmerobotics", "G l o b e x").
  const shown = new Set(words.map(alike))
  const squashed = alike(words.join(""))
  const name = known.names.find(
    (item) =>
      shown.has(item.key) ||
      shown.has(`${item.key}s`) ||
      shown.has(`${item.key}es`) ||
      (item.key.length >= SPLIT_NAME && squashed.includes(item.key)),
  )
  if (name) return refused("token", name.name)
  return { ok: true }
}

// A private number the query's digits hold, or 7 digits in a row of a longer one (see the comment at the top).
function numberIn(text: string, known: ReturnType<typeof build>) {
  const streams = digitStreams(text)
  return (
    known.numbers.find((number) => streams.some((stream) => stream.includes(number))) ??
    streams.flatMap((stream) => pieces(stream)).find((piece) => known.parts.has(piece))
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
 * The names in the prose of some texts: words the prose never writes in lower case, and no common word or acronym. A
 * word inside a sentence counts when it is capitalised. A sentence's first word, the first after a label's colon, and
 * a heading's words are capitalised anyway, so they count only when they are not a common English word, or when they
 * are possessive ("Target's"). A word in capitals counts when it is not an acronym or a common word. In a block written
 * all in lower case, every word that is not a common English word counts.
 */
export function names(texts: readonly string[]) {
  const blocks = prose(texts)
  // Only a word written on its own shows the prose uses it in lower case: "acme" in jira.acme.internal or
  // acme-billing is part of a name, not the word.
  const chunks = (text: string) => text.split(/\s+/).map((chunk) => chunk.replace(AROUND, ""))
  const lower = new Set(
    blocks
      .filter((block) => /\p{Lu}/u.test(block.text))
      .flatMap((block) => chunks(block.text))
      .filter((chunk) => LOWER_WORD.test(chunk))
      .map((chunk) => chunk.replace(/['\u2019]\p{Ll}+$/u, "")),
  )
  const plain = (key: string) =>
    key.length < 3 || COMMON_WORDS.has(key) || COMMON.has(key) || ACRONYMS.has(key) || ResearchWords.common(key)
  const found = blocks.flatMap((block) => {
    // A line in lower case, such as a memory-of-you line typed that way ("my employer is initech"), says nothing with
    // its capitals, so its words that are not common English words are its names.
    if (!/\p{Lu}/u.test(block.text))
      return chunks(block.text)
        .filter((chunk) => LOWER_WORD.test(chunk))
        .map((chunk) => chunk.replace(/['\u2019]\p{Ll}+$/u, ""))
        .filter((chunk) => !plain(chunk))
    return block.text.split(SENTENCE).flatMap((sentence) =>
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
    )
  })
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

// A rare token, and for a host name with a subdomain also its labels without the public suffix, which name the same
// host: billing.acme-internal.io is billing.acme-internal too, and jira.initech.internal jira.initech.
function unsuffixed(token: string) {
  if (/[@/]/.test(token) || !host(token)) return [token]
  const parsed = parse(token, { allowPrivateDomains: true })
  if (!parsed.subdomain || !parsed.domainWithoutSuffix) return [token]
  return [token, `${parsed.subdomain}.${parsed.domainWithoutSuffix}`]
}

// The part of a host before its site, as a reader sees it: each label's punycode decoded, and a label that does not
// decode kept as written. tldts finds no site in a host with a label it rejects (an underscore, a dash at either end,
// a label too long, punycode that does not decode), so then the site is the shortest end of the host that tldts takes
// for one, and everything before it is read; with no such end, the whole host is.
function subdomainOf(hostname: string) {
  const name = hostname.replace(/\.$/, "")
  if (isIP(name.replace(/^\[|\]$/g, ""))) return ""
  const parsed = parse(name, { allowPrivateDomains: true })
  const labels = name.split(".")
  const site = labels.findLastIndex((_, index) => {
    const end = labels.slice(index).join(".")
    return parse(end, { allowPrivateDomains: true }).domain === end
  })
  const subdomain = parsed.domain ? (parsed.subdomain ?? "") : site < 0 ? name : labels.slice(0, site).join(".")
  return subdomain
    .split(".")
    .map((label) => (label.startsWith("xn--") ? domainToUnicode(label) || label : label))
    .join(".")
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

// The digits a query or an address sends, run together the way the comment at the top says: each word's digits with
// everything else in it taken out, joined with the next word's across words that have neither letters nor digits and
// at most GAP_WORDS words of letters.
function digitStreams(text: string) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .reduce<{ streams: string[]; gap: number }>(
      (state, word) => {
        const digits = word.replace(/\D+/g, "")
        if (!digits) return { streams: state.streams, gap: /\p{L}/u.test(word) ? state.gap + 1 : state.gap }
        if (state.streams.length > 0 && state.gap <= GAP_WORDS) state.streams[state.streams.length - 1] += digits
        else state.streams.push(digits)
        return { streams: state.streams, gap: 0 }
      },
      { streams: [], gap: Number.POSITIVE_INFINITY },
    ).streams
}

// Every run of PART_DIGITS digits in a string of digits.
function pieces(digits: string) {
  return Array.from({ length: Math.max(0, digits.length - PART_DIGITS + 1) }, (_, index) =>
    digits.slice(index, index + PART_DIGITS),
  )
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
  const parts = cuts
    .slice(0, -1)
    .map((from, index) => ({ from, to: cuts[index + 1]!, dotted: dotted(part(run, from, cuts[index + 1]!)) }))
  if (!parts.some((piece) => piece.dotted)) return [run]
  return parts
    .reduce<typeof parts>((all, piece) => {
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

// The private numbers a run holds: each stretch of whole groups in it, at most MAX_GROUPS groups long, so
// +1 415-555-0132 holds 415-555-0132 and 555-0132 as well as the whole, and 45,210.50 holds 45,210.
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
  return digits.length >= NUMBER_DIGITS && !/^\d0+$/.test(digits)
}

// The numbers a public text holds as its own, or none when it holds more than PUBLIC_NUMBERS of them.
function publicNumbers(text: string) {
  const found = new Set(
    runs(fold(text))
      .filter((run) => !dotted(run))
      .flatMap(figures),
  )
  return found.size > PUBLIC_NUMBERS ? [] : [...found]
}

function wordsOf(text: string) {
  return fold(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
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
// 3-word runs of its private-fact prose with a name or a number in them, its text as look-alikes read, its numbers,
// and the rare tokens, split tokens and names that the user did not type. Tokens match without case, so lowercasing
// an identifier or a host name does not get it past the check.
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
  const typedRaw = alike(context.typed.map(fold).join("\n"))
  const typedWords = new Set(context.typed.flatMap(wordsOf).map(alike))
  const typedSplit = context.typed.map((text) => alike(wordsOf(text).join(""))).join(" ")
  // The numbers the user typed, read as a query's are, and the ones a public source holds as its own.
  const typedStreams = context.typed.flatMap((text) => digitStreams(fold(text)))
  const shown = new Set(context.public.flatMap(publicNumbers))
  const cleared = (digits: string) => shown.has(digits) || typedStreams.some((stream) => stream.includes(digits))
  const counted = all.flatMap((text) => runs(fold(text))).filter((run) => !dotted(run))
  const found = names(context.private)
  const named = new Set(found)
  const tokens = [
    ...new Set(
      all
        .flatMap(rare)
        .flatMap(unsuffixed)
        .filter((token) => !DIGITS.test(token)),
    ),
  ]
  const open = (token: string) => !typedRaw.includes(alike(token)) && !typedSplit.includes(alike(squash(token)))
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
    raw: alike(all.map(fold).join("\n")),
    typedRaw,
    tokens: tokens
      .map((token) => ({ token: token.toLowerCase(), key: alike(token) }))
      .filter((item) => item.token.length >= 5 && !typedRaw.includes(item.key)),
    // The private numbers nobody cleared, and every run of PART_DIGITS digits of the longer ones.
    numbers: [...new Set(counted.flatMap(figures))].filter((number) => !cleared(number)),
    parts: new Set(
      counted
        .map((run) => run.groups.join(""))
        .filter((digits) => digits.length > PART_DIGITS && !cleared(digits))
        .flatMap(pieces)
        .filter((piece) => !cleared(piece)),
    ),
    split: new Map(
      tokens
        .filter(open)
        .map((token) => [parts(token), alike(squash(token)), token] as const)
        .filter(([count, squashed]) => count >= SPLIT_PARTS && count <= SPLIT_WORDS && squashed.length >= SPLIT_CHARS)
        .map(([count, squashed, token]) => [`${count}:${squashed}`, token] as const),
    ),
    names: found.map((name) => ({ name, key: alike(name) })).filter((item) => !typedWords.has(item.key)),
    exempt: exempting(context.domains ?? []),
  }
}

// The text with each of the domains blanked where it stands alone as a host name, with or without "www.", or as a
// site: value ("nature.com", "www.nature.com", "site:nature.com", "-site:nature.com"), and nowhere else: not in
// "jane@nature.com", "nature.com/acme", "acme.nature.com" or "inurl:nature.com". Only host names on a public suffix
// count, so a word or an intranet name passed as a domain exempts nothing.
function exempting(domains: readonly string[]) {
  const hosts = domains
    .map((domain) =>
      fold(domain)
        .trim()
        .toLowerCase()
        .replace(/^\*?\.|\.$/g, "")
        .replace(/^www\./, ""),
    )
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
    `(?<![\\p{L}\\p{N}_.@/:+~-])(?:-?site:)?(?:www\\.)?(?:${hosts.join("|")})(?![\\p{L}\\p{N}_@/:-]|\\.[\\p{L}\\p{N}])`,
    "giu",
  )
  return (text: string) => text.replace(pattern, " ")
}
