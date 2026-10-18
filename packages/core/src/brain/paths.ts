export * as BrainPaths from "./paths"

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"

// Where the brain keeps what it learns. Pure, with no import-time side effects, so the desktop main process can use it
// to place failure memory where the engine reads it.

/** The brain's folder inside Vector's data directory. Erasing all memory deletes it. */
export function directory(data: string) {
  return path.join(data, "brain")
}

function canonical(root: string) {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

/**
 * Failure memory for one working tree, kept on this computer rather than in the repository: a file inside a repository
 * travels with every clone and commit, and one that came with a clone fed its "repairs" into Vector's prompts.
 */
export function failureFile(data: string, root: string) {
  const key = createHash("sha256").update(canonical(root)).digest("hex").slice(0, 16)
  return path.join(directory(data), "failures", `${key}.json`)
}

/** The repository key for a folder outside git, which has no repository ID of its own. */
export function folderKey(directory: string) {
  return `dir:${createHash("sha256").update(canonical(directory)).digest("hex").slice(0, 16)}`
}
