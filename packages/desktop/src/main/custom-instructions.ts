import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Custom instructions the user wants Vector to follow in every session. This
// writes the global AGENTS.md the engine already loads as an instruction file
// on every prompt (packages/opencode/src/session/instruction.ts reads
// <config>/AGENTS.md), so there is no second mechanism to keep in sync — the
// panel simply edits the file the engine is already reading.

const APP_NAMESPACE = process.env.VECTOR_APP_NAMESPACE ?? "vector"

// Mirrors xdg-basedir's resolution in packages/core/src/global.ts, the same way
// local-memory.ts does. If these drift, the app would write a file the engine
// never loads.
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return join(xdg, APP_NAMESPACE)
  return join(homedir(), ".config", APP_NAMESPACE)
}

export function customInstructionsPath() {
  return join(configDir(), "AGENTS.md")
}

export type CustomInstructionsState = {
  path: string
  exists: boolean
  bytes: number
  updatedAt?: string
  content: string
}

export async function readCustomInstructions(): Promise<CustomInstructionsState> {
  const target = customInstructionsPath()
  const info = await stat(target).catch(() => undefined)
  if (!info) return { path: target, exists: false, bytes: 0, content: "" }
  const content = await readFile(target, "utf8").catch(() => "")
  return { path: target, exists: true, bytes: info.size, updatedAt: info.mtime.toISOString(), content }
}

export async function writeCustomInstructions(content: string): Promise<CustomInstructionsState> {
  const target = customInstructionsPath()
  // Saving an empty box means "I have no standing instructions", and leaving an
  // empty AGENTS.md behind would keep loading a useless instruction file into
  // every prompt. Removing it is the honest representation of that.
  if (!content.trim()) return clearCustomInstructions()
  await mkdir(configDir(), { recursive: true })
  await writeFile(target, content, "utf8")
  return readCustomInstructions()
}

export async function clearCustomInstructions(): Promise<CustomInstructionsState> {
  await rm(customInstructionsPath(), { force: true })
  return readCustomInstructions()
}
