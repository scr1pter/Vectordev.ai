export * as BrainPaths from "./paths"

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"
import type { BrainSchema } from "./schema"

// Where the brain keeps what it learns. Pure, with no import-time side effects, so the desktop main process can use it
// to place failure memory where the engine reads it.

/** The brain's folder inside Vector's data directory. Erasing all memory deletes it. */
export function directory(data: string) {
  return path.join(data, "brain")
}

function canonical(root: string) {
  try {
    return realpathSync.native(root)
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

/**
 * A file as the brain names it: relative to the working tree's root, with forward slashes. Both are compared where
 * they really are, so a file read through a symlinked spelling of the root (macOS /tmp and /var, a linked folder of
 * projects) has the same name as one read through the real path git reports. A file that really lands outside the
 * root, through `..` or a link, comes back starting with `..`, which callers refuse.
 */
export function relative(root: string, file: string) {
  return path.relative(real(root), real(path.resolve(root, file))).split(path.sep).join("/")
}

// Where a path really is, following links in it and in its parents. One that cannot be resolved (it does not exist
// yet or any more, or it is a link loop) is its deepest resolvable parent's real path with the rest put back, so it
// cannot pass for a file inside the root when a parent leads out. The native call also spells out Windows short names
// (C:\Users\RUNNER~1), which git never gives, so a folder named both ways is one folder.
function real(target: string): string {
  try {
    return realpathSync.native(target)
  } catch {
    const parent = path.dirname(target)
    return parent === target ? target : path.join(real(parent), path.basename(target))
  }
}

/** The repository key for a folder outside git, which has no repository ID of its own. */
export function folderKey(directory: string) {
  return `dir:${createHash("sha256").update(canonical(directory)).digest("hex").slice(0, 16)}`
}

/** Kept originals of added documents, for repositories that keep them. Erasing all memory deletes them. */
export function documents(data: string) {
  return path.join(directory(data), "documents")
}

const EXTENSIONS: Readonly<Record<BrainSchema.Format, string>> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  csv: "csv",
  markdown: "md",
  html: "html",
  json: "json",
  yaml: "yaml",
  openapi: "json",
  text: "txt",
}

/** A kept original in `folder`: named by its content hash, with its format's extension. */
export function original(folder: string, hash: string, format: BrainSchema.Format) {
  return path.join(folder, `${hash}.${EXTENSIONS[format]}`)
}
