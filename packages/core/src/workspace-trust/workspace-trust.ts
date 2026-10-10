export * as WorkspaceTrust from "./workspace-trust"

import { constants } from "node:fs"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"

const version = 1 as const
const filename = "workspace-trust.json"
const cacheDirectory = "workspace-trust"
const ignoredDirectories = new Set([".git", "node_modules"])
const ignoredFiles = new Set([".DS_Store", ".gitignore"])
const configNames = new Set([
  "vector.json",
  "vector.jsonc",
  "vector.local.json",
  "vector.local.jsonc",
  "tui.json",
  "tui.jsonc",
])
const maxFiles = 10_000
const maxDirectories = 10_000
const maxBytes = 64 * 1024 * 1024
const maxFileBytes = 8 * 1024 * 1024
const maxDepth = 64
const maxDirectoryEntries = 10_000
const captured = Symbol("WorkspaceTrust.captured")
const capturedDirectories = Symbol("WorkspaceTrust.capturedDirectories")
const requestedWorkspace = Symbol("WorkspaceTrust.requestedWorkspace")

type StoredTrust = {
  path: string
  fingerprint: string
}

type Store = {
  version: typeof version
  workspaces: Record<string, StoredTrust>
}

type CapturedFile = {
  content: Buffer
  mode: number
}

export type Snapshot = {
  workspace: string
  fingerprint: string
  readonly [captured]: ReadonlyMap<string, CapturedFile>
  readonly [capturedDirectories]: ReadonlySet<string>
  readonly [requestedWorkspace]: string
}

export type TrustedSnapshot = Snapshot & {
  directory: string
}

export type Status = {
  workspace: string
  fingerprint: string
  trusted: boolean
}

export async function snapshot(workspace: string, inputs: readonly string[]): Promise<Snapshot> {
  const requested = path.resolve(workspace)
  const canonical = await canonicalize(workspace)
  const files = new Map<string, CapturedFile>()
  const directories = new Set<string>()
  const budget = { files: 0, bytes: 0 }
  const names = Array.from(configNames)
  const normalize = (input: string) => normalizeInput(input, requested, canonical)
  const normalizedInputs = inputs.map(normalize)
  const expanded = [
    ...normalizedInputs,
    ...names.map((name) => path.join(canonical, name)),
    path.join(canonical, ".vector"),
    ...normalizedInputs.flatMap((input) =>
      configNames.has(path.basename(input))
        ? [...names.map((name) => path.join(path.dirname(input), name)), path.join(path.dirname(input), ".vector")]
        : [],
    ),
  ]

  for (const input of new Set(expanded.map((item) => path.resolve(item)))) {
    await collect(input, files, directories, budget)
  }
  const configs = Array.from(files).filter(([file]) => configNames.has(path.basename(file)))
  for (const [file, value] of configs) {
    const config = readConfig(value.content)
    for (const input of [
      ...executableInputs(config, { source: file, workspace: canonical }),
      ...fileInputs(config, file),
    ]) {
      await collect(normalize(input), files, directories, budget)
    }
  }

  const hash = createHash("sha256").update(`workspace\0${canonical}\0`)
  for (const [file, value] of Array.from(files).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`path\0${file}\0mode\0${value.mode & 0o777}\0`)
    hash.update(value.content)
    hash.update("\0")
  }
  return {
    workspace: canonical,
    fingerprint: hash.digest("hex"),
    [captured]: files,
    [capturedDirectories]: directories,
    [requestedWorkspace]: requested,
  }
}

export async function status(stateDirectory: string, current: Snapshot): Promise<Status> {
  const store = await readStore(stateDirectory)
  const trusted = store.workspaces[key(current.workspace)]
  return {
    workspace: current.workspace,
    fingerprint: current.fingerprint,
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

export function readFileString(current: Snapshot, file: string) {
  return current[captured].get(snapshotPath(current, file))?.content.toString("utf8")
}

export async function materialize(stateDirectory: string, current: Snapshot): Promise<TrustedSnapshot> {
  const parent = path.join(stateDirectory, cacheDirectory)
  const target = path.join(parent, current.fingerprint)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const existing = await fs.lstat(target).catch(() => undefined)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Trusted workspace cache ${target} is not a private directory`)
    }
    await verifyMaterialized(target, current)
    return { ...current, directory: target }
  }

  const temporary = await fs.mkdtemp(path.join(parent, `.${current.fingerprint}.`))
  try {
    for (const directory of current[capturedDirectories]) {
      await fs.mkdir(path.join(temporary, materializedRelativePath(directory)), { recursive: true, mode: 0o700 })
    }
    for (const [file, value] of current[captured]) {
      const destination = path.join(temporary, materializedRelativePath(file))
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await fs.writeFile(destination, value.content, { flag: "wx", mode: value.mode & 0o111 ? 0o500 : 0o400 })
    }
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true })
    // Another process may have atomically published the same fingerprint first.
    // Accept its copy only after validating every approved file; unrelated runtime
    // artifacts beside those files do not change which captured paths are used.
    const winner = await fs.lstat(target).catch(() => undefined)
    if (!winner?.isDirectory() || winner.isSymbolicLink()) throw error
    await verifyMaterialized(target, current)
  }
  return { ...current, directory: target }
}

export function materializedPath(current: TrustedSnapshot, input: string) {
  const target = materializedPathOption(current, input)
  if (!target) throw new Error(`Workspace trust input changed or was not captured: ${input}`)
  return target
}

export function materializedPathOption(current: TrustedSnapshot, input: string) {
  const resolved = path.resolve(input)
  if (contains(current.directory, resolved)) return resolved
  const source = snapshotPath(current, resolved)
  if (!hasCapturedPath(current, source)) return
  return path.join(current.directory, materializedRelativePath(source))
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

async function collect(
  input: string,
  files: Map<string, CapturedFile>,
  directories: Set<string>,
  budget: { files: number; bytes: number },
  seen = new Set<string>(),
  depth = 0,
): Promise<void> {
  if (depth > maxDepth) throw new Error(`Workspace trust traversal exceeded ${maxDepth} levels at ${input}`)
  const stat = await fs.lstat(input).catch(() => undefined)
  if (!stat || ignoredFiles.has(path.basename(input)) || stat.isSymbolicLink()) return
  const resolved = path.resolve(input)
  const real = await fs.realpath(input).catch(() => undefined)
  if (!real || normalizePath(real) !== normalizePath(resolved)) return
  if (seen.has(resolved)) return
  seen.add(resolved)
  if (stat.isFile()) {
    if (files.has(resolved)) return
    const value = await captureFile(resolved)
    budget.files++
    budget.bytes += value.content.byteLength
    if (budget.files > maxFiles) throw new Error(`Workspace trust traversal exceeded ${maxFiles} files`)
    if (budget.bytes > maxBytes) throw new Error(`Workspace trust traversal exceeded ${maxBytes} bytes`)
    files.set(resolved, value)
    return
  }
  if (!stat.isDirectory() || ignoredDirectories.has(path.basename(input))) return
  directories.add(resolved)
  if (directories.size > maxDirectories) {
    throw new Error(`Workspace trust traversal exceeded ${maxDirectories} directories`)
  }

  const directory = await fs.opendir(input)
  let count = 0
  for await (const entry of directory) {
    count++
    if (count > maxDirectoryEntries) {
      throw new Error(`Workspace trust traversal exceeded ${maxDirectoryEntries} entries in ${input}`)
    }
    if (ignoredDirectories.has(entry.name) || ignoredFiles.has(entry.name) || entry.isSymbolicLink()) continue
    await collect(path.join(input, entry.name), files, directories, budget, seen, depth + 1)
  }
}

async function captureFile(file: string): Promise<CapturedFile> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`Workspace trust input is not a regular file: ${file}`)
    if (stat.size > maxFileBytes) throw new Error(`Workspace trust input exceeds ${maxFileBytes} bytes: ${file}`)
    return { content: await handle.readFile(), mode: stat.mode }
  } finally {
    await handle.close()
  }
}

function readConfig(content: Buffer) {
  try {
    return parse(content.toString("utf8")) as unknown
  } catch {
    return undefined
  }
}

function fileInputs(config: unknown, source: string) {
  const values: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{file:([^}]+)\}/g)) values.push(match[1]!)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (isRecord(value)) Object.values(value).forEach(visit)
  }
  visit(config)
  return values.flatMap((value) => localPath(value, path.dirname(source)))
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

function normalizeInput(input: string, requested: string, canonical: string) {
  const resolved = path.resolve(input)
  if (!contains(requested, resolved)) return resolved
  return path.resolve(canonical, path.relative(requested, resolved))
}

function snapshotPath(current: Snapshot, input: string) {
  return normalizeInput(input, current[requestedWorkspace], current.workspace)
}

function hasCapturedPath(current: Snapshot, input: string) {
  if (current[captured].has(input)) return true
  if (current[capturedDirectories].has(input)) return true
  const prefix = input.endsWith(path.sep) ? input : `${input}${path.sep}`
  return Array.from(current[captured].keys()).some((file) => file.startsWith(prefix))
}

function materializedRelativePath(file: string) {
  const parsed = path.parse(file)
  const volume = createHash("sha256").update(parsed.root.toLowerCase()).digest("hex").slice(0, 16)
  return path.join(`volume-${volume}`, path.relative(parsed.root, file))
}

async function verifyMaterialized(directory: string, current: Snapshot) {
  for (const [source, value] of current[captured]) {
    const file = path.join(directory, materializedRelativePath(source))
    const hit = await captureFile(file).catch(() => undefined)
    if (!hit || !hit.content.equals(value.content) || (hit.mode & 0o111 ? 1 : 0) !== (value.mode & 0o111 ? 1 : 0)) {
      throw new Error(`Trusted workspace cache ${directory} changed at ${file}`)
    }
  }
  for (const source of current[capturedDirectories]) {
    const target = path.join(directory, materializedRelativePath(source))
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Trusted workspace cache ${directory} is missing ${target}`)
    }
  }
}

function contains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizePath(input: string) {
  const normalized = path.normalize(input)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
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
