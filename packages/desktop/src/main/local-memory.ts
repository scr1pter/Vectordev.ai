import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Local memory is durable, cross-project knowledge about the user. It lives in
// the same config directory the engine reads from, it is never uploaded, and
// the user can erase it outright. This module is the only writer the desktop
// side has, so "clear" here genuinely means gone.

const APP_NAMESPACE = process.env.VECTOR_APP_NAMESPACE ?? "vector"

// Mirrors xdg-basedir's resolution in packages/core/src/global.ts. If these
// drift, the app would clear a file the engine never reads.
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return join(xdg, APP_NAMESPACE)
  return join(homedir(), ".config", APP_NAMESPACE)
}

export function localMemoryPath() {
  return join(configDir(), "MEMORY.md")
}

export type LocalMemoryState = {
  path: string
  exists: boolean
  bytes: number
  entries: number
  updatedAt?: string
  content: string
}

// Entries are markdown bullets or headings; counting them gives the user a
// concrete sense of how much Vector has retained without reading it all.
function countEntries(content: string) {
  return content.split("\n").filter((line) => /^\s*(?:[-*+]\s+|#{1,6}\s+)\S/.test(line)).length
}

export async function readLocalMemory(): Promise<LocalMemoryState> {
  const target = localMemoryPath()
  const info = await stat(target).catch(() => undefined)
  if (!info) return { path: target, exists: false, bytes: 0, entries: 0, content: "" }
  const content = await readFile(target, "utf8").catch(() => "")
  return {
    path: target,
    exists: true,
    bytes: info.size,
    entries: countEntries(content),
    updatedAt: info.mtime.toISOString(),
    content,
  }
}

export async function writeLocalMemory(content: string): Promise<LocalMemoryState> {
  const target = localMemoryPath()
  await mkdir(configDir(), { recursive: true })
  await writeFile(target, content, "utf8")
  return readLocalMemory()
}

// Deletes the file rather than truncating it, so nothing recoverable is left
// behind for a user who cleared memory specifically because they did not want
// it retained.
export async function clearLocalMemory(): Promise<LocalMemoryState> {
  await rm(localMemoryPath(), { force: true })
  return readLocalMemory()
}
