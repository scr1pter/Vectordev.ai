import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { vectorConfigDir } from "./config-path"

// Custom instructions the user wants Vector to follow in every session. This
// writes the global AGENTS.md the engine already loads as an instruction file
// on every prompt (packages/opencode/src/session/instruction.ts reads
// <config>/AGENTS.md), so there is no second mechanism to keep in sync — the
// panel simply edits the file the engine is already reading.

export function customInstructionsPath() {
  return join(vectorConfigDir(), "AGENTS.md")
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
  const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return { path: target, exists: false, bytes: 0, content: "" }
  const content = await readFile(target, "utf8")
  return { path: target, exists: true, bytes: info.size, updatedAt: info.mtime.toISOString(), content }
}

export async function writeCustomInstructions(content: string): Promise<CustomInstructionsState> {
  const target = customInstructionsPath()
  // Saving an empty box means "I have no standing instructions", and leaving an
  // empty AGENTS.md behind would keep loading a useless instruction file into
  // every prompt. Removing it is the honest representation of that.
  if (!content.trim()) return clearCustomInstructions()
  await mkdir(vectorConfigDir(), { recursive: true })
  await writeFile(target, content, "utf8")
  return readCustomInstructions()
}

export async function clearCustomInstructions(): Promise<CustomInstructionsState> {
  await rm(customInstructionsPath(), { force: true })
  return readCustomInstructions()
}
