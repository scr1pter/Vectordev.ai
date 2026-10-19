export * as BrainAnchor from "./anchor"

import { BrainDrift } from "./drift"
import { BrainExtract } from "./extract"
import { BrainLexical } from "./lexical"
import type { BrainSchema } from "./schema"

// Links from what a document says to the code that does it, found with Ripgrep in the working tree, with no code index
// of its own. A document names code by identifiers (`refreshTokenTtl`, MAX_UPLOAD_BYTES), paths, endpoint routes and
// environment variables. Each is looked for, and a line that defines a name outweighs one that only uses it. Plain words
// are never linked unless the document set them as code, and a name that half the repository uses links nothing: it
// says nothing about where anything is.

export type Method = BrainSchema.Anchor["method"]
export type Status = BrainSchema.Anchor["status"]

/** How strongly each way of linking ties a passage or record to a file. */
export const WEIGHT: Readonly<Record<Method, number>> = {
  definition: 1,
  path: 0.9,
  route: 0.8,
  constant: 0.8,
  env: 0.7,
  use: 0.4,
  user: 1,
  outcome: 0.5,
}

export const LIMIT = {
  /** Names looked for in one pass. */
  identifiers: 400,
  /** Bytes of one Ripgrep pattern. */
  pattern: 8 * 1024,
  /** Matching lines read in one pass. A pass that reaches it is looked at again without its common names, or in halves. */
  hits: 4_000,
  /** Ripgrep passes one lookup makes; names still not looked at in full after them keep their links. */
  passes: 24,
  /** Anchors one name makes. */
  perName: 5,
  /** A name found in more files than this is too common to say where anything is. */
  common: 50,
  /** Anchors one record or passage keeps, and names it waits for. */
  perOwner: 20,
  pending: 50,
  /** Characters of a line a link can point at: a longer one (minified or generated code) is never looked at. */
  line: BrainDrift.LINE,
} as const

/** A name a document gives: `text` is an identifier, a repository path, a route shape (`/v1/users/*`) or an env name. */
export type Name = {
  readonly kind: "symbol" | "path" | "route" | "env"
  readonly text: string
  /** A route's method, when the document gives one. */
  readonly method?: string
}

// Product and format names with an internal capital, which read like identifiers and name no code of the repository.
const NOT_CODE =
  /^(?:JavaScript|TypeScript|CoffeeScript|ActionScript|GitHub|GitLab|BitBucket|PostgreSQL|PostGIS|MySQL|SQLite|MongoDB|MariaDB|DynamoDB|CouchDB|InfluxDB|ClickHouse|OpenAPI|GraphQL|OAuth|OpenID|WebSocket|WebSockets|WebAssembly|WebRTC|WebGL|WebGPU|JavaDoc|JSDoc|NodeJS|NextJS|NuxtJS|ReactJS|VueJS|VSCode|IntelliJ|PyCharm|WebStorm|XCode|PowerShell|PowerPoint|OneDrive|SharePoint|DevOps|MacBook|iPhone|iPad|iCloud|iOS|macOS|watchOS|tvOS|iPadOS|YouTube|LinkedIn|PayPal|WordPress|BigQuery|CloudFront|CloudWatch|CloudFlare|ChatGPT|OpenAI|DeepSeek|HuggingFace|FastAPI|NestJS|SvelteKit|TailwindCSS|ESLint|PostCSS|LaTeX|BibTeX|McDonald|eBay|FedEx|DocuSign)$/

const IDENTIFIER = /(?<![\w$./\\-])[A-Za-z_][A-Za-z0-9_]{3,63}(?![\w$])/g
const SHAPED = /[a-z0-9][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/
const PATH = /(?<![\w:/.\\-])(?:\.{1,2}\/)?(?:[\w@-][\w@.-]*\/)+[\w-][\w.-]*\.[A-Za-z0-9]{1,8}(?![\w/])/g
const ROUTE_IN_TEXT = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'`),;<>]*)/g
const DOC_FILE = /\.(?:md|mdx|markdown|rst|adoc|txt|pdf|docx?|pptx?|xlsx?|csv|html?)$/i
const LOCK_FILE =
  /(?:^|\/)(?:package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$/

/**
 * The names a passage or record gives that code could have: identifiers with an internal capital or an underscore,
 * SCREAMING_SNAKE names, repository paths, routes and env names its record read, and any of the document's code spans
 * it holds. A plain word (`upload`) counts only as a code span.
 */
export function names(input: {
  readonly text: string
  /** The document's code spans: what it set as code (backticks, a monospace font, a Code style). */
  readonly code?: readonly string[]
  /** The record's fields, which name its route, env variable or function. */
  readonly fields?: Readonly<Record<string, unknown>>
}): Name[] {
  const found = new Map<string, Name>()
  const add = (name: Name) => {
    const key = `${name.kind}\0${name.method ?? ""}\0${name.text}`
    if (!found.has(key) && found.size < LIMIT.perOwner * 2) found.set(key, name)
  }
  const symbol = (text: string, plain: boolean) => {
    if (text.length < 3 || text.length > 64 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return
    if (NOT_CODE.test(text) || BrainLexical.STOP_TERMS.has(text.toLowerCase())) return
    if (!plain && !SHAPED.test(text)) return
    add({ kind: "symbol", text })
  }
  const fields = input.fields ?? {}
  const form = typeof fields.form === "string" ? fields.form : undefined
  const named = typeof fields.name === "string" ? fields.name : undefined
  if (form === "endpoint" && typeof fields.route === "string")
    add({
      kind: "route",
      text: fields.route,
      ...(typeof fields.method === "string" ? { method: fields.method.toUpperCase() } : {}),
    })
  if (form === "env" && named && /^[A-Za-z_][A-Za-z0-9_]*$/.test(named)) add({ kind: "env", text: named })
  if ((form === "function" || form === "config" || form === "error") && named)
    symbol(named.replace(/\(.*$/, "").split(".").at(-1) ?? named, true)
  for (const span of input.code ?? []) {
    const code = span.trim()
    if (!code || !input.text.includes(code)) continue
    const path = code.replace(/^\.\//, "")
    if (/^(?:[\w@-][\w@.-]*\/)+[\w-][\w.-]*\.[A-Za-z0-9]{1,8}$/.test(path)) {
      add({ kind: "path", text: path })
      continue
    }
    const route = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/[^\s]*)$/.exec(code)
    if (route) {
      add({ kind: "route", text: BrainExtract.route(route[2]!), ...(route[1] ? { method: route[1] } : {}) })
      continue
    }
    // `createSession()`, `session.refresh`: the name the code would define.
    const call = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(.*\))?$/.exec(code)
    if (call) symbol(call[1]!, true)
  }
  for (const match of input.text.matchAll(IDENTIFIER)) symbol(match[0], false)
  for (const match of input.text.matchAll(PATH)) add({ kind: "path", text: match[0].replace(/^\.\//, "") })
  // An endpoint record is about its own route; another one its sentence names is a record of its own.
  if (form !== "endpoint")
    for (const match of input.text.matchAll(ROUTE_IN_TEXT))
      add({ kind: "route", text: BrainExtract.route(match[2]!.replace(/[.:]+$/, "")), method: match[1]! })
  return [...found.values()]
}

/** Identifiers in groups whose Ripgrep `pattern` is at most `LIMIT.pattern` bytes. */
export function groups(identifiers: readonly string[]) {
  return identifiers.reduce<string[][]>((chunks, name) => {
    const last = chunks.at(-1)
    if (last && [...last, name].join("|").length + 12 <= LIMIT.pattern) last.push(name)
    else chunks.push([name])
    return chunks
  }, [])
}

/** A Ripgrep pattern that finds any of these identifiers as a whole word. */
export function pattern(identifiers: readonly string[]) {
  return `\\b(?:${identifiers.join("|")})\\b`
}

/** Files whose lines never anchor a document: other documents, and lock files. */
export function skipped(file: string) {
  return DOC_FILE.test(file) || LOCK_FILE.test(file)
}

/**
 * What a line does with a name: defines it (a declaration, or a function or object bound to it), reads it as an
 * environment variable, or only uses it.
 */
export function classify(line: string, name: string, file = ""): "definition" | "env" | "use" {
  if (!line.includes(name)) return "use"
  const word = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // `\s+(?:\*\s*)?` and not `\s+\*?\s*`: two runs of spaces next to each other backtrack with the square of a line's length.
  if (
    new RegExp(
      `\\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|func|impl|module|object|record|protocol|typedef)\\s+(?:\\*\\s*)?${word}\\b|\\bfunc\\s+\\([^)]*\\)\\s*${word}\\b|\\b${word}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|\\{)`,
    ).test(line)
  )
    return "definition"
  // `MAX_UPLOAD_BYTES = 64 * 1024 * 1024` at the top of a Python or Ruby module is its definition.
  if (
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name) &&
    new RegExp(`^\\s*(?:export\\s+)?${word}\\s*(?::\\s*[\\w.\\[\\]]+\\s*)?=(?![=>])`).test(line)
  )
    return /(?:^|\/)\.env(?:\.[\w-]+)?$/.test(file) ? "env" : "definition"
  if (
    new RegExp(
      `(?:process\\.env|Bun\\.env|import\\.meta\\.env|Deno\\.env)(?:\\.${word}\\b|\\[\\s*["'\`]${word}["'\`]\\s*\\])|Deno\\.env\\.get\\(\\s*["'\`]${word}["'\`]|os\\.environ(?:\\.get)?\\s*[\\[(]\\s*["']${word}["']|os\\.getenv\\(\\s*["']${word}["']|env::var\\(\\s*["']${word}["']|System\\.getenv\\(\\s*["']${word}["']|getenv\\(\\s*["']${word}["']`,
    ).test(line)
  )
    return "env"
  return "use"
}

const REGISTRATION = [
  // Express, Hono, Elysia, Fastify, Koa routers, chi and gin in Go: `.get("/x", …)`, `r.Get("/x", …)`.
  /\.(get|post|put|patch|delete|head|options|all)\s*\(\s*["'`]/i,
  // NestJS: `@Get("/x")`.
  /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(/,
  // Spring: `@GetMapping("/x")`, `@RequestMapping("/x")`.
  /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(/,
  // FastAPI and Flask: `@app.get("/x")`, `@router.post("/x")`, `@app.route("/x")`.
  /@\w+\.(get|post|put|patch|delete|head|options|route)\s*\(/,
  // Effect: `HttpApiEndpoint.get("name", "/x")`.
  /HttpApiEndpoint\.(get|post|put|patch|delete|head|options)\s*\(/,
  // Go's net/http: `mux.HandleFunc("GET /x", …)`, `http.Handle("/x", …)`.
  /\b(HandleFunc|Handle)\s*\(/,
] as const

/** The routes a line registers, with their method when the line gives one. */
export function routes(line: string) {
  const registration = REGISTRATION.map((pattern) => pattern.exec(line)).find((match) => match !== null)
  if (!registration) return []
  const verb = registration[1]!.toUpperCase()
  const method = ["REQUEST", "ROUTE", "ALL", "HANDLEFUNC", "HANDLE"].includes(verb) ? undefined : verb
  return [...line.matchAll(/["'`](?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?(\/[^"'`\s]*)["'`]/g)].map((match) => ({
    route: BrainExtract.route(match[2]!),
    ...((match[1] ?? method) ? { method: match[1] ?? method } : {}),
  }))
}

/** Whether a line registers the route a document names (with the same method, when both give one). */
export function registers(line: string, name: Name) {
  return routes(line).some(
    (found) => found.route === name.text && (!name.method || !found.method || found.method === name.method),
  )
}

/**
 * A constant's value as its definition line gives it, when the expression is plain arithmetic and a unit can be told
 * from the name or a trailing comment: `MAX_UPLOAD_BYTES = 64 * 1024 * 1024` is 67108864 bytes.
 */
export function value(line: string, name: string) {
  const word = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const at = new RegExp(`\\b${word}\\b\\s*(?::\\s*[\\w.\\[\\]<>]+\\s*)?[:=](?![=>])\\s*`).exec(line)
  if (!at) return undefined
  const rest = line.slice(at.index + at[0].length)
  const comment = /\s(?:\/\/|#|--|\/\*)\s*(.*)$/.exec(rest)
  const raw = (comment ? rest.slice(0, comment.index) : rest)
    .replace(/[;,]\s*$/, "")
    .replace(/\s+as\s+const\s*$/, "")
    .trim()
  const evaluated = BrainDrift.evaluate(raw)
  if (evaluated === undefined) return undefined
  const unit = BrainDrift.unit(name, comment?.[1])
  if (!unit) return undefined
  return { raw, value: evaluated, unit }
}

/** A path as the repository has it: the file itself, or the one tracked file that ends with it. */
export function resolvePath(name: string, files: readonly string[], tracked: ReadonlySet<string>) {
  if (tracked.has(name)) return name
  const matches = files.filter((file) => file.endsWith(`/${name}`))
  return matches.length === 1 ? matches[0] : undefined
}
