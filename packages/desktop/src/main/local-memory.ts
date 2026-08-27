import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { vectorConfigDir } from "./config-path"

// Local memory is durable, cross-project knowledge about the user. The plain
// Markdown source lives in the same local config directory the engine reads
// from; when it exists, its contents enter the selected provider's context for
// built-in agent sessions. The user can inspect, edit, or erase it outright,
// and this module is the desktop writer, so "clear" here genuinely means gone.

export function localMemoryPath() {
  return join(vectorConfigDir(), "MEMORY.md")
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
  const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return { path: target, exists: false, bytes: 0, entries: 0, content: "" }
  const content = await readFile(target, "utf8")
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
  await mkdir(vectorConfigDir(), { recursive: true })
  await writeFile(target, content, "utf8")
  return readLocalMemory()
}

// Deletes the file rather than retaining an empty memory file. This is an
// application-level delete, not a promise of secure erasure from storage media
// or backups.
export async function clearLocalMemory(): Promise<LocalMemoryState> {
  await rm(localMemoryPath(), { force: true })
  return readLocalMemory()
}
