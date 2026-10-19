export * as BrainData from "./data"

import { Option, Schema } from "effect"
import { parseAllDocuments } from "yaml"
import { refuse, type BrainLimits } from "./limits"
import type { Draft, Read, ReadRefusal } from "./read"

// Structured files: JSON, YAML (core schema, aliases capped, no custom tags), OpenAPI and Swagger, JSON Schema, and
// CSV or TSV. An API description becomes one heading per operation with its parameter and response tables, which the
// record rules read as contracts; a schema becomes a heading and a property table; anything else becomes key paths.

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const

type Value = unknown
type Fields = { readonly [key: string]: Value }

export function read(text: string, format: "json" | "yaml", limits: BrainLimits.Limits): Read | ReadRefusal {
  const parsed = format === "json" ? json(text, limits) : yaml(text, limits)
  if (parsed.type === "refused") return parsed
  if (depth(parsed.value, limits.data.depth) > limits.data.depth)
    return refuse("invalid", `This file nests deeper than ${limits.data.depth} levels, more than Vector reads.`)
  const value = parsed.value
  const budget = { left: limits.data.keys, cell: limits.cell }
  if (
    object(value) &&
    object(value.paths) &&
    (typeof value.openapi === "string" || typeof value.swagger === "string")
  ) {
    const drafts = api(value, budget)
    return {
      type: "read",
      format: "openapi",
      ...titled(value),
      drafts,
      links: servers(value),
      warnings: budget.left < 0 ? ["truncated"] : [],
    }
  }
  if (object(value) && (typeof value.$schema === "string" || object(value.definitions) || object(value.$defs))) {
    const name = typeof value.title === "string" ? value.title : "Schema"
    const drafts: Draft[] = [
      { type: "heading", level: 1, text: name },
      ...(object(value.properties) ? schema(name, value, value, budget) : []),
      ...Object.entries({
        ...(object(value.definitions) ? value.definitions : {}),
        ...(object(value.$defs) ? value.$defs : {}),
      }).flatMap(([key, definition]) => (object(definition) ? schema(key, definition, value, budget) : [])),
    ]
    return { type: "read", format, title: name, drafts, warnings: budget.left < 0 ? ["truncated"] : [] }
  }
  return { type: "read", format, drafts: paths(value, budget), warnings: budget.left < 0 ? ["truncated"] : [] }
}

/** JSON, refused when it nests past the cap: the depth is counted on the text, before anything is built. */
export function json(
  text: string,
  limits: BrainLimits.Limits,
): { readonly type: "value"; readonly value: Value } | ReadRefusal {
  if (nesting(text) > limits.data.depth)
    return refuse("invalid", `This file nests deeper than ${limits.data.depth} levels, more than Vector reads.`)
  const value = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  return Option.isSome(value)
    ? { type: "value", value: value.value }
    : refuse("invalid", "This JSON file is not valid JSON.")
}

/**
 * YAML in the core schema: no custom tags, so no type a file names is ever constructed, and at most `aliases` alias
 * expansions, so a "billion laughs" file is refused instead of growing without end. A file of several documents reads
 * as a list of them.
 */
export function yaml(
  text: string,
  limits: BrainLimits.Limits,
): { readonly type: "value"; readonly value: Value } | ReadRefusal {
  // The yaml package reports a resource-exhaustion attack (and a stack too deep to parse) by throwing; nothing else
  // about the file can throw.
  try {
    const documents = parseAllDocuments(text, {
      schema: "core",
      customTags: [],
      uniqueKeys: false,
      prettyErrors: false,
    })
    const list = Array.isArray(documents) ? documents.slice(0, 100) : []
    if (list.some((document) => document.errors.length > 0))
      return refuse("invalid", "This YAML file is not valid YAML.")
    const values = list.map((document) => document.toJS({ maxAliasCount: limits.data.aliases }) as Value)
    return { type: "value", value: values.length === 1 ? values[0] : values }
  } catch {
    return refuse("invalid", "This YAML file expands too far (aliases or nesting) to read safely.")
  }
}

/**
 * CSV and TSV per RFC 4180: quoted fields, doubled quotes and line breaks inside quotes. The delimiter is sniffed from
 * the first lines unless the file's extension gave one.
 */
export function csv(text: string, delimiter: string | undefined, limits: BrainLimits.Limits): Read | ReadRefusal {
  const separator = delimiter ?? sniff(text)
  const rows = parse(text, separator, limits)
  const filled = rows.rows.filter((row) => row.some((cell) => cell.trim()))
  if (filled.length === 0) return refuse("empty", "This file has no rows.")
  const header =
    filled.length > 1 && filled[0]!.every((cell) => cell.trim() && !/^[-+]?[\d.,]+%?$/.test(cell.trim()))
      ? filled[0]!
      : undefined
  const body = filled.slice(header ? 1 : 0)
  const indexed = body.slice(0, limits.rows)
  return {
    type: "read",
    format: "csv",
    drafts: [
      {
        type: "table",
        header: header ?? [],
        rows: indexed,
        confidence: 1,
        refs: indexed.map((_, index) => `row ${index + (header ? 2 : 1)}`),
      },
    ],
    warnings: rows.truncated || body.length > indexed.length ? ["truncated"] : [],
  }
}

function sniff(text: string) {
  const lines = text.split(/\r?\n/, 20).filter((line) => line.trim())
  const scored = [",", "\t", ";", "|"].map((candidate) => {
    const counts = lines.map((line) => line.replace(/"[^"]*"/g, "").split(candidate).length - 1)
    return { candidate, score: counts.length > 0 ? Math.min(...counts) : 0 }
  })
  return scored.toSorted((a, b) => b.score - a.score)[0]!.score > 0
    ? scored.toSorted((a, b) => b.score - a.score)[0]!.candidate
    : ","
}

function parse(text: string, separator: string, limits: BrainLimits.Limits) {
  const rows: string[][] = []
  const state = { row: [] as string[], field: "", quoted: false, truncated: false }
  const end = () => {
    state.row.push(state.field.slice(0, limits.cell))
    state.field = ""
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (state.quoted) {
      if (char === '"' && text[index + 1] === '"') {
        state.field += '"'
        index++
        continue
      }
      if (char === '"') state.quoted = false
      else state.field += char
      continue
    }
    if (char === '"' && state.field === "") {
      state.quoted = true
      continue
    }
    if (char === separator) {
      end()
      continue
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++
      end()
      rows.push(state.row.slice(0, limits.columns))
      state.row = []
      if (rows.length >= limits.csvRows) {
        state.truncated = index < text.length - 1
        return { rows, truncated: state.truncated }
      }
      continue
    }
    state.field += char
  }
  if (state.field || state.row.length > 0) {
    end()
    rows.push(state.row.slice(0, limits.columns))
  }
  return { rows, truncated: false }
}

function api(spec: Fields, budget: { left: number; cell: number }): Draft[] {
  const info = object(spec.info) ? spec.info : {}
  const intro: Draft[] = [
    { type: "heading", level: 1, text: string(info.title) || "API" },
    ...(string(info.version) ? [{ type: "paragraph" as const, text: `Version ${string(info.version)}.` }] : []),
    ...(string(info.description)
      ? [{ type: "paragraph" as const, text: string(info.description).slice(0, 4_000) }]
      : []),
  ]
  const operations = Object.entries(object(spec.paths) ? spec.paths : {}).flatMap(([path, item]) => {
    if (!path.startsWith("/") || !object(item)) return []
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    return METHODS.flatMap((method): Draft[] => {
      const operation = item[method]
      if (!object(operation) || --budget.left < 0) return []
      const parameters = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .map((parameter) => resolve(spec, parameter))
        .filter(object)
      const body = object(operation.requestBody) ? resolve(spec, operation.requestBody) : undefined
      const media = object(body) && object(body.content) ? Object.entries(body.content) : []
      const responses = object(operation.responses) ? Object.entries(operation.responses) : []
      return [
        { type: "heading", level: 2, text: `${method.toUpperCase()} ${path}` },
        ...(string(operation.summary)
          ? [{ type: "paragraph" as const, text: sentence(string(operation.summary)) }]
          : []),
        ...(string(operation.description)
          ? [{ type: "paragraph" as const, text: string(operation.description).slice(0, 2_000) }]
          : []),
        ...(string(operation.operationId)
          ? [
              {
                type: "paragraph" as const,
                text: `Operation ID: ${string(operation.operationId)}.`,
                code: [string(operation.operationId)],
              },
            ]
          : []),
        ...(parameters.length > 0
          ? [
              {
                type: "table" as const,
                header: ["Name", "In", "Type", "Required", "Description"],
                rows: parameters.map((parameter) => [
                  string(parameter.name),
                  string(parameter.in),
                  type(spec, parameter.schema ?? parameter),
                  parameter.required === true ? "yes" : "no",
                  string(parameter.description).slice(0, budget.cell),
                ]),
                confidence: 1,
              },
            ]
          : []),
        ...(media.length > 0
          ? [
              {
                type: "paragraph" as const,
                text: `Request body: ${media.map(([kind, content]) => `${kind}${object(content) && content.schema ? ` (${type(spec, content.schema)})` : ""}`).join(", ")}.`,
              },
            ]
          : []),
        ...(responses.length > 0
          ? [
              {
                type: "table" as const,
                header: ["Status", "Description"],
                rows: responses.map(([status, response]) => {
                  const resolved = resolve(spec, response)
                  return [status, object(resolved) ? string(resolved.description).slice(0, budget.cell) : ""]
                }),
                confidence: 1,
              },
            ]
          : []),
      ]
    })
  })
  const components =
    object(spec.components) && object(spec.components.schemas)
      ? spec.components.schemas
      : object(spec.definitions)
        ? spec.definitions
        : {}
  const schemas = Object.entries(components).flatMap(([name, definition]) =>
    object(definition) ? schema(name, definition, spec, budget) : [],
  )
  return [...intro, ...operations, ...schemas]
}

function schema(name: string, definition: Fields, root: Fields, budget: { left: number; cell: number }): Draft[] {
  if (--budget.left < 0) return []
  const properties = (object(definition.properties) ? Object.entries(definition.properties) : []).slice(
    0,
    Math.max(0, budget.left),
  )
  budget.left -= properties.length
  const required = Array.isArray(definition.required)
    ? definition.required.filter((item) => typeof item === "string")
    : []
  return [
    { type: "heading", level: 2, text: `Schema ${name}` },
    ...(string(definition.description)
      ? [{ type: "paragraph" as const, text: string(definition.description).slice(0, 2_000) }]
      : []),
    ...(properties.length > 0
      ? [
          {
            type: "table" as const,
            header: ["Property", "Type", "Required", "Description"],
            rows: properties.map(([key, property]) => [
              key,
              type(root, property),
              required.includes(key) ? "yes" : "no",
              object(property) ? string(property.description).slice(0, budget.cell) : "",
            ]),
            confidence: 1,
          },
        ]
      : []),
  ]
}

/** Any other value as key paths ("server.port: 8080"), one table per top-level key, at most `keys` of them. */
function paths(value: Value, budget: { left: number; cell: number }): Draft[] {
  const rows: [string, string][] = []
  const visit = (node: Value, path: string) => {
    if (budget.left <= 0) {
      budget.left = -1
      return
    }
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${path}[${index}]`))
    if (object(node)) return Object.entries(node).forEach(([key, item]) => visit(item, path ? `${path}.${key}` : key))
    budget.left--
    rows.push([path || "value", (node === null ? "null" : String(node)).slice(0, budget.cell)])
  }
  visit(value, "")
  const groups = Map.groupBy(rows, (row) => row[0].match(/^\[\d+\]|^[^.[]+/)?.[0] ?? row[0])
  return [...groups].flatMap(([key, group]): Draft[] => [
    { type: "heading", level: 1, text: key },
    { type: "table", header: ["Key", "Value"], rows: group, confidence: 1 },
  ])
}

function titled(spec: Fields) {
  return object(spec.info) && string(spec.info.title) ? { title: string(spec.info.title) } : {}
}

function servers(spec: Fields) {
  const listed = Array.isArray(spec.servers) ? spec.servers.filter(object).map((server) => string(server.url)) : []
  const host = string(spec.host) ? [`https://${string(spec.host)}${string(spec.basePath)}`] : []
  return [...listed, ...host].filter(Boolean)
}

// A local `$ref` ("#/components/parameters/Limit"), followed at most a few times so a cycle cannot loop.
function resolve(root: Fields, value: Value, hops = 0): Value {
  if (!object(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/") || hops > 8) return value
  const target = value.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<Value>((node, key) => (object(node) ? node[key] : undefined), root)
  return resolve(root, target, hops + 1)
}

function type(root: Fields, value: Value): string {
  if (!object(value)) return ""
  if (typeof value.$ref === "string") return value.$ref.split("/").pop() ?? ""
  if (value.type === "array") return `${type(root, value.items)}[]`
  return string(value.type) || string(value.format)
}

function object(value: Value): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function string(value: Value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : ""
}

function sentence(text: string) {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

// The deepest nesting of brackets outside strings, counted on the text.
function nesting(text: string) {
  const state = { depth: 0, deepest: 0, string: false, escaped: false }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (state.string) {
      if (state.escaped) state.escaped = false
      else if (code === 92) state.escaped = true
      else if (code === 34) state.string = false
      continue
    }
    if (code === 34) state.string = true
    else if (code === 91 || code === 123) state.deepest = Math.max(state.deepest, ++state.depth)
    else if (code === 93 || code === 125) state.depth--
  }
  return state.deepest
}

function depth(value: Value, cap: number, level = 0): number {
  if (level > cap) return level
  const children = Array.isArray(value) ? value : object(value) ? Object.values(value) : []
  return children.reduce<number>((deepest, item) => Math.max(deepest, depth(item, cap, level + 1)), level)
}
