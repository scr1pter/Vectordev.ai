// When the composer offers to keep an attachment in Vector's memory, and what it says. A document the user marks is
// read on this computer and kept as a document: "Remember" keeps it and still sends the file; "Remember instead" keeps
// it in place of sending it, so the model gets its outline and the cards that bear on each request instead of every
// page. Nothing is remembered unless the user says so, except office files, which models cannot read as they are.

export type RememberMode = "keep" | "instead"

/** Metadata key of the empty text part that marks an attachment to remember; the engine reads it (SessionMemory.REMEMBER). */
export const REMEMBER = "vector.memory.remember"

/** Past these, sending a document whole costs more than it is worth, so the composer suggests remembering it instead. */
export const LARGE = { bytes: 1024 * 1024, pages: 20 }

/** Pasted text at least this long, that reads as prose, gets a "Remember this text" chip. */
export const PASTE_CHARS = 4_000

export const OFFICE_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const

const OFFICE_MIMES = new Set<string>(Object.values(OFFICE_TYPES))

const DOCUMENT_EXTS = new Set([
  "pdf",
  "md",
  "mdx",
  "markdown",
  "txt",
  "html",
  "htm",
  "json",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "rst",
  "adoc",
])

export type Attachment = { filename: string; mime: string; bytes: number }

/** What kind of document an attachment is, for the chip: images are for the model to look at, so they get none. */
export function documentKind(attachment: Pick<Attachment, "filename" | "mime">) {
  if (attachment.mime.startsWith("image/")) return undefined
  if (OFFICE_MIMES.has(attachment.mime) || officeExtension(attachment.filename)) return "office" as const
  if (attachment.mime === "application/pdf") return "pdf" as const
  if (DOCUMENT_EXTS.has(extension(attachment.filename))) return "text" as const
  return undefined
}

/** The office type for a file name, so the composer can attach one the platform gave no type for. */
export function officeMime(filename: string) {
  const ext = officeExtension(filename)
  return ext ? OFFICE_TYPES[ext] : undefined
}

export type Probe = { pages?: number; tokens: number; suggest: "remember-instead" | "none" }

export type Offer =
  /** Nothing to offer: an image or a file that is not a document. */
  | { type: "none" }
  /** The Remember chip, off until the user turns it on. */
  | { type: "chip" }
  /** Too large to send whole: the composer suggests remembering it instead. */
  | { type: "suggest"; message: string }
  /** An office file models cannot read: it is remembered instead, with Undo. */
  | { type: "office"; message: string }

/**
 * What the composer offers for an attachment. A PDF over 20 pages (counted by the engine when it can read the file by
 * its path) or any document over 1 MB is suggested as memory instead; office files always go through memory.
 */
export function offer(attachment: Attachment, probe?: Probe): Offer {
  const kind = documentKind(attachment)
  if (!kind) return { type: "none" }
  if (kind === "office")
    return {
      type: "office",
      message: `Models can't read ${attachment.filename} as it is, so Vector remembers it instead and brings in the parts that matter.`,
    }
  const pages = kind === "pdf" ? probe?.pages : undefined
  const large =
    probe?.suggest === "remember-instead" ||
    attachment.bytes > LARGE.bytes ||
    (pages !== undefined && pages > LARGE.pages)
  if (!large) return { type: "chip" }
  return { type: "suggest", message: suggestion(attachment, kind, probe) }
}

/** "api-spec.pdf is 212 pages (about 140,000 tokens if sent). Remember it instead, and Vector will bring in…" */
function suggestion(attachment: Attachment, kind: "pdf" | "text", probe?: Probe) {
  // Text is about four bytes to a token; a PDF's size says little about its text, so only the engine's count is used.
  const estimate = probe?.tokens ?? (kind === "text" ? Math.round(attachment.bytes / 4) : undefined)
  const size =
    probe?.pages && kind === "pdf" ? `${probe.pages.toLocaleString("en-US")} pages` : megabytes(attachment.bytes)
  const cost = estimate ? ` (about ${round(estimate)} tokens if sent)` : ""
  return `${attachment.filename} is ${size}${cost}. Remember it instead, and Vector will bring in only the parts that matter.`
}

/**
 * How a request marks an attachment: office files always go through memory instead of being sent; other documents
 * only when the user chose to remember them; images and "Send anyway" never.
 */
export function modeFor(attachment: Pick<Attachment, "filename" | "mime"> & { remember?: RememberMode | "send" }) {
  const kind = documentKind(attachment)
  if (kind === "office") return "instead" as const
  if (!kind || attachment.remember === "send") return undefined
  return attachment.remember
}

/** What the chip says for each choice. */
export function chipLabel(mode: RememberMode | undefined) {
  if (mode === "instead") return "Remembered instead of sent"
  if (mode === "keep") return "Remembered"
  return "Remember"
}

export function chipHint(mode: RememberMode | undefined) {
  if (mode === "instead")
    return "Vector keeps it as a document and brings in only the parts a request needs. It is private to you."
  if (mode === "keep") return "Vector keeps it as a document and sends it too. It is private to you."
  return "Keep it in Vector's memory as a private document, so later requests can use it too."
}

/** The text part that marks an attachment to remember. It has no text, so it costs nothing on the request. */
export function marker(id: string, part: string, mode: RememberMode) {
  return { id, type: "text" as const, text: "", synthetic: true, metadata: { [REMEMBER]: { mode, part } } }
}

/**
 * Whether pasted text reads as prose worth keeping as a document: long, mostly sentences, and not a log, a stack
 * trace or a diff. At least 60% of its lines are sentences and under 20% look like log lines, stack frames,
 * timestamps or diff hunks.
 */
export function prose(text: string) {
  if (text.length < PASTE_CHARS) return false
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  const sentences = lines.filter(sentence).length
  const noise = lines.filter(machine).length
  return sentences / lines.length >= 0.6 && noise / lines.length < 0.2
}

/** A pasted text's name: its first heading, or its first line, short. */
export function pasteName(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line))
  const first = (heading ?? lines.find(Boolean) ?? "Pasted text").replace(/^#{1,6}\s+/, "").replace(/[*_`]+/g, "")
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first
}

export const PASTE_CHIP = "Remember this text"
export const PASTE_HINT = "Keep it in Vector's memory as a private document. It is still sent with this message."

export function pasteKept(name: string) {
  return `Vector is reading "${name}" as a private document.`
}

// A sentence: at least five words, mostly made of letters, with an end mark or long enough to be wrapped prose.
function sentence(line: string) {
  const body = line.replace(/^(?:[-*+>]|\d+[.)])\s+/, "")
  const words = body.split(/\s+/).filter(Boolean)
  if (words.length < 5) return false
  const wordy = words.filter((word) => /^[("“'‘]?\p{L}[\p{L}'’-]*[)"”'’,.;:!?]*$/u.test(word)).length
  return wordy / words.length >= 0.6 && (/[.!?:;)"”]$/.test(body) || words.length >= 10)
}

// Lines a program wrote: logs, stack frames, timestamps and diffs.
function machine(line: string) {
  return (
    /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(line) ||
    /^\[?\d{2}:\d{2}:\d{2}/.test(line) ||
    /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[\]:]?/.test(line) ||
    /^at\s+\S+.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+)$/.test(line) ||
    /^File ".*", line \d+/.test(line) ||
    /^(?:@@ .* @@|diff --git |\+\+\+ |--- a\/|index [0-9a-f]+\.\.[0-9a-f]+)/.test(line) ||
    /^(?:Traceback|Exception in thread|Caused by:)/.test(line)
  )
}

function officeExtension(filename: string) {
  const ext = extension(filename)
  return ext === "docx" || ext === "pptx" || ext === "xlsx" ? ext : undefined
}

function extension(name: string) {
  const at = name.lastIndexOf(".")
  return at === -1 ? "" : name.slice(at + 1).toLowerCase()
}

function megabytes(size: number) {
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function round(value: number) {
  const step = value >= 10_000 ? 1_000 : value >= 1_000 ? 100 : 10
  return Math.max(step, Math.round(value / step) * step).toLocaleString("en-US")
}
