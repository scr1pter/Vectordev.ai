export * as WorkspaceTrust from "./workspace-trust"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"

const version = 1 as const
const filename = "workspace-trust.json"
const ignoredDirectories = new Set([".git", "node_modules"])
const ignoredFiles = new Set([".DS_Store", ".gitignore"])
const configNames = new Set(["vector.json", "vector.jsonc", "tui.json", "tui.jsonc"])

type StoredTrust = {
  path: string
  fingerprint: string
}

type Store = {
  version: typeof version
  workspaces: Record<string, StoredTrust>
}

export type Snapshot = {
  workspace: string
  fingerprint: string
}

export type Status = Snapshot & {
  trusted: boolean
}

export async function snapshot(workspace: string, inputs: readonly string[]): Promise<Snapshot> {
  const canonical = await canonicalize(workspace)
  const names = Array.from(configNames)
  const expanded = [
    ...inputs,
    ...names.map((name) => path.join(canonical, name)),
    path.join(canonical, ".vector"),
    ...inputs.flatMap((input) =>
      configNames.has(path.basename(input))
        ? [...names.map((name) => path.join(path.dirname(input), name)), path.join(path.dirname(input), ".vector")]
        : [],
    ),
  ]
  const discovered = (
    await Promise.all(Array.from(new Set(expanded.map((input) => path.resolve(input)))).map((input) => collect(input)))
  ).flat()
  const referenced = (
    await Promise.all(
      discovered
        .filter((file) => configNames.has(path.basename(file)))
        .map(async (file) =>
          Promise.all(
            executableInputs(await readConfig(file), { source: file, workspace: canonical }).map((input) =>
              collect(input),
            ),
          ),
        ),
    )
  ).flat(2)
  const files = Array.from(new Set([...discovered, ...referenced])).sort((left, right) => left.localeCompare(right))
  const hash = createHash("sha256").update(`workspace\0${canonical}\0`)

  for (const file of files) {
    hash.update(`path\0${file}\0`)
    hash.update(await fs.readFile(file).catch(() => Buffer.from("<unreadable>")))
    hash.update("\0")
  }
  return { workspace: canonical, fingerprint: hash.digest("hex") }
}

export async function status(stateDirectory: string, current: Snapshot): Promise<Status> {
  const store = await readStore(stateDirectory)
  const trusted = store.workspaces[key(current.workspace)]
  return {
    ...current,
    trusted: trusted?.path === current.workspace && trusted.fingerprint === current.fingerprint,
  }
}

export async function approve(stateDirectory: string, current: Snapshot) {
  const store = await readStore(stateDirectory)
  store.workspaces[key(current.workspace)] = {
    path: current.workspace,
    fingerprint: current.fingerprint,
  }
  await fs.mkdir(stateDirectory, { recursive: true })
  const target = path.join(stateDirectory, filename)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 })
  await fs.rename(temporary, target)
}

export function remoteUrlAllowed(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password) return false
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
}

export function executableInputs(config: unknown, context: { source: string; workspace: string }) {
  if (!isRecord(config)) return []
  const source = path.dirname(context.source)
  const plugins = [
    ...(Array.isArray(config.plugin) ? config.plugin : []).map((entry) => (Array.isArray(entry) ? entry[0] : entry)),
    ...(Array.isArray(config.plugins) ? config.plugins : []).map((entry) => (isRecord(entry) ? entry.package : entry)),
  ]
  const mcp = isRecord(config.mcp) ? config.mcp : {}
  const servers = isRecord(mcp.servers) ? mcp.servers : mcp
  return Array.from(
    new Set([
      ...plugins.flatMap((spec) => localPath(spec, source)),
      ...localPath(config.shell, source),
      ...commandInputs(config.formatter, context.workspace),
      ...commandInputs(config.lsp, context.workspace),
      ...Object.values(servers).flatMap((server) => {
        if (!isRecord(server) || !Array.isArray(server.command)) return []
        const cwd = typeof server.cwd === "string" ? path.resolve(context.workspace, server.cwd) : context.workspace
        return server.command.flatMap((value) => localPath(value, cwd))
      }),
    ]),
  )
}

async function canonicalize(workspace: string) {
  const resolved = await fs.realpath(workspace).catch(() => path.resolve(workspace))
  const normalized = path.normalize(resolved)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

async function collect(input: string, seen = new Set<string>()): Promise<string[]> {
  const stat = await fs.lstat(input).catch(() => undefined)
  if (!stat || ignoredFiles.has(path.basename(input))) return []
  if (stat.isSymbolicLink()) {
    const target = await fs.realpath(input).catch(() => undefined)
    return target ? collect(target, seen) : []
  }
  const resolved = path.resolve(input)
  if (seen.has(resolved)) return []
  seen.add(resolved)
  if (stat.isFile()) return [resolved]
  if (!stat.isDirectory()) return []

  const entries = await fs.readdir(input, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries
        .filter((entry) => !ignoredDirectories.has(entry.name))
        .map((entry) => collect(path.join(input, entry.name), seen)),
    )
  ).flat()
}

async function readConfig(file: string) {
  return fs
    .readFile(file, "utf8")
    .then((value) => parse(value) as unknown)
    .catch(() => undefined)
}

function commandInputs(config: unknown, base: string) {
  if (!isRecord(config)) return []
  return Object.values(config).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.command)) return []
    return entry.command.flatMap((value) => localPath(value, base))
  })
}

function localPath(value: unknown, base: string) {
  if (typeof value !== "string") return []
  if (value.startsWith("file:")) {
    try {
      return [fileURLToPath(value)]
    } catch {
      return []
    }
  }
  if (URL.canParse(value)) return []
  if (path.isAbsolute(value)) return [value]
  if (value.includes("/") || value.includes("\\")) return [path.resolve(base, value)]
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function key(workspace: string) {
  return createHash("sha256").update(workspace).digest("hex")
}

async function readStore(stateDirectory: string): Promise<Store> {
  const parsed = await fs
    .readFile(path.join(stateDirectory, filename), "utf8")
    .then((value) => JSON.parse(value) as unknown)
    .catch(() => undefined)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version, workspaces: {} }
  if (!("version" in parsed) || parsed.version !== version) return { version, workspaces: {} }
  if (!("workspaces" in parsed) || !parsed.workspaces || typeof parsed.workspaces !== "object") {
    return { version, workspaces: {} }
  }
  return parsed as Store
}
