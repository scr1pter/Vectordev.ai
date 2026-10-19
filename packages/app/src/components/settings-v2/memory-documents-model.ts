// What Settings > Memory > Documents says about each document, kept apart from the page so the wording is tested and
// stays honest. Every word here is shown to the user: it says "repository", never the other word.

import type {
  MemoryDocument,
  MemoryDocumentDetail,
  MemoryDocumentList,
  MemoryDocumentPage,
  MemoryRecord,
} from "@vectordevai/sdk/v2/client"

export type DocumentStatus = MemoryDocument["status"]
export type DocumentHold = NonNullable<MemoryDocument["hold"]>
export type DocumentWarning = MemoryDocument["warnings"][number]
export type RecordKind = MemoryRecord["kind"]
export type Refusal =
  | "too-large"
  | "unsupported"
  | "encrypted"
  | "empty"
  | "secret"
  | "invalid"
  | "limit"
  | "guest"
  | "forgotten"
  | "not-found"
  | "outside"
  | "busy"
  | "version"

/** How often the page asks for progress while something is being read or downloaded. */
export const POLL = 2_000

/** The largest file the page sends; the engine refuses anything bigger. */
export const UPLOAD_BYTES = 64 * 1024 * 1024

/** What the drop zone and "Add documents…" take, by extension. */
export const DOCUMENT_EXTENSIONS = [
  "pdf",
  "docx",
  "docm",
  "pptx",
  "xlsx",
  "csv",
  "tsv",
  "md",
  "mdx",
  "markdown",
  "html",
  "htm",
  "json",
  "yaml",
  "yml",
  "txt",
  "rst",
  "adoc",
] as const

export const DOCUMENT_ACCEPT = DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).join(",")

const LEGACY_OFFICE: Record<string, string> = { doc: "docx", ppt: "pptx", xls: "xlsx" }
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif", "svg"])
const ARCHIVES = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso"])
const PROGRAMS = new Set(["exe", "msi", "app", "dll", "so", "dylib", "bin", "sh", "bat", "cmd", "ps1", "jar"])

/** Whether the page sends a file at all, and if not, why: the same answers the engine gives, without the upload. */
export function precheck(file: { name: string; size: number }) {
  const ext = extension(file.name)
  if (IMAGES.has(ext))
    return "Attach images to a message so the model can look at them. Vector does not read text in images."
  if (LEGACY_OFFICE[ext])
    return `Vector reads .${LEGACY_OFFICE[ext]}, not .${ext}. Save it as .${LEGACY_OFFICE[ext]} and add that.`
  if (ARCHIVES.has(ext)) return "Vector does not open archives. Add the documents inside it one by one."
  if (PROGRAMS.has(ext)) return "Vector only keeps documents, not programs or scripts."
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > UPLOAD_BYTES) return `${file.name} is ${bytes(file.size)}. Vector keeps documents of up to 64 MB.`
  return undefined
}

/**
 * How a dropped file reaches the engine: by its path when the app talks to its own engine on this computer and knows
 * where the file is (nothing is copied through the app), otherwise as the file's bytes.
 */
export function uploadMode(input: { builtin: boolean; path?: string }) {
  return input.builtin && input.path ? ("path" as const) : ("bytes" as const)
}

/** The status the list shows, in the user's words. */
export function statusLabel(document: Pick<MemoryDocument, "status" | "hold" | "paused" | "unread" | "warnings">) {
  if (document.paused && !done(document.status)) return "Paused"
  if (document.status === "queued") return "Queued"
  if (document.status === "reading") return "Reading"
  if (document.status === "linking") return "Linking to code"
  if (document.status === "searchable" || document.status === "embedding") return "Searchable"
  if (document.status === "ready") return "Ready"
  if (document.status === "held") return `Held for your review: ${documentHoldLabel(document.hold)}`
  if (document.status === "failed") return "Could not read"
  if (document.status === "superseded") return "Replaced by a newer version"
  if (document.unread.length > 0 || document.warnings.includes("scanned")) return "Scanned pages skipped"
  return "Partly read"
}

/** Whether the status reads as fine, in progress, waiting for the user, or a problem: it picks the dot's colour. */
export function statusTone(document: Pick<MemoryDocument, "status" | "paused">) {
  if (document.paused && !done(document.status)) return "idle" as const
  if (document.status === "held") return "waiting" as const
  if (document.status === "failed") return "problem" as const
  if (document.status === "partial") return "waiting" as const
  if (document.status === "superseded") return "idle" as const
  if (document.status === "searchable" || document.status === "ready" || document.status === "embedding")
    return "good" as const
  return "busy" as const
}

/** Why a whole document, or a passage of one, waits for the user, short enough to follow "Held for your review:". */
export function documentHoldLabel(hold: DocumentHold | undefined) {
  if (hold === "instruction-like") return "parts of it read like instructions to an AI"
  if (hold === "hidden-text") return "it has text a reader would not see"
  if (hold === "hidden-unicode") return "it contains hidden characters"
  if (hold === "untrusted-repository") return "this repository's settings are not trusted yet"
  if (hold === "suggested") return "Vector offered to keep it without you asking"
  if (hold === "web") return "it was kept in a session that read web content"
  if (hold === "mcp") return "it was kept in a session that used an MCP tool"
  if (hold === "subagent") return "a subagent kept it"
  if (hold === "guest") return "it was kept while an invited guest was in the session"
  return "Vector could not check where it came from"
}

export type Step = { label: string; state: "done" | "active" | "pending" }

/**
 * The progress line under a document: what is read, how it is structured, what code it links to and how much of it is
 * searchable by meaning. Steps that do not apply yet (no code links, no search model) are left out.
 */
export function steps(document: Pick<MemoryDocument, "status" | "format" | "pages" | "stats" | "embedModel">): Step[] {
  const order: readonly DocumentStatus[] = ["queued", "reading", "linking", "searchable", "embedding", "ready"]
  const at = order.indexOf(document.status)
  // Partial, held and superseded documents were read; a failed one was not.
  const past = (step: number) => (at === -1 ? document.status !== "failed" : at >= step)
  const unit = units(document.format)
  const total = document.stats.passages + document.stats.records
  return [
    {
      label:
        unit && document.pages
          ? `Read ${Math.min(document.stats.read, document.pages).toLocaleString()}/${document.pages.toLocaleString()} ${plural(document.pages, unit)}`
          : "Read",
      state: past(2) ? "done" : document.status === "reading" ? "active" : "pending",
    },
    {
      label: past(2) ? `Structured ${count(document.stats.sections, "section")}` : "Structured",
      state: past(2) ? "done" : "pending",
    },
    ...(document.stats.linked > 0 || document.status === "linking"
      ? [
          {
            label: document.stats.linked > 0 ? `Linked ${count(document.stats.linked, "file")}` : "Linking to code",
            state: past(3)
              ? ("done" as const)
              : document.status === "linking"
                ? ("active" as const)
                : ("pending" as const),
          },
        ]
      : []),
    ...(document.status === "embedding" || document.embedModel || document.stats.embedded > 0
      ? [
          {
            label: `Meaning ${total > 0 ? Math.min(100, Math.floor((document.stats.embedded / total) * 100)) : 0}%`,
            state:
              document.status === "ready"
                ? ("done" as const)
                : document.status === "embedding"
                  ? ("active" as const)
                  : ("pending" as const),
          },
        ]
      : []),
  ]
}

/** The line of facts under a document's title. */
export function documentMeta(
  document: Pick<MemoryDocument, "format" | "pages" | "bytes" | "stats" | "origin" | "createdAt">,
  now = Date.now(),
) {
  const unit = units(document.format)
  return [
    formatLabel(document.format),
    ...(unit && document.pages ? [count(document.pages, unit)] : []),
    bytes(document.bytes),
    ...(document.stats.tokens > 0 ? [`about ${tokens(document.stats.tokens)} tokens if sent`] : []),
    `${originLabel(document.origin)} ${ago(document.createdAt, now)}`,
  ].join(" · ")
}

export function formatLabel(format: MemoryDocument["format"]) {
  return {
    pdf: "PDF",
    docx: "Word",
    pptx: "PowerPoint",
    xlsx: "Excel",
    csv: "CSV",
    markdown: "Markdown",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    openapi: "OpenAPI",
    text: "Text",
  }[format]
}

export function originLabel(origin: MemoryDocument["origin"]) {
  return {
    upload: "You added this",
    chat: "Remembered from a message",
    agent: "Vector kept this",
    repository: "From this repository's docs",
    cli: "Added from the command line",
  }[origin]
}

/** What a document's visibility means for who may use it. */
export function visibilityLabel(visibility: MemoryDocument["visibility"]) {
  if (visibility === "repository")
    return "Part of this repository, so it is used like the repository's own files, also with guests."
  return "Private: kept from invited guests and from models that may train on prompts."
}

export function warningLabel(warning: DocumentWarning, document?: Pick<MemoryDocument, "unread">) {
  if (warning === "truncated") return "Vector read the first part only; the rest was past its limits."
  if (warning === "scanned")
    return document?.unread.length
      ? `Scanned pages (${pageList(document.unread)}) are pictures of text, which Vector does not read.`
      : "Some pages are pictures of text, which Vector does not read."
  if (warning === "encrypted") return "Parts of it are password protected and were not read."
  if (warning === "macros-ignored") return "Its macros were ignored; they never run."
  if (warning === "external-links") return "Links to outside files were not followed."
  if (warning === "secrets-removed") return "Secrets in it were removed before anything was saved."
  return "Some tables were read approximately."
}

/**
 * What waits for the user across documents: whole documents held, and passages held inside documents that are
 * otherwise in use. Code drift and conflicts join this list when Vector checks them.
 */
export function needsLook(documents: readonly Pick<MemoryDocument, "id" | "title" | "status" | "hold" | "stats">[]) {
  return documents.flatMap((document) => {
    if (document.status === "superseded") return []
    if (document.status === "held")
      return [
        {
          document: document.id,
          title: document.title,
          text: `Held for your review: ${documentHoldLabel(document.hold)}`,
          count: 1,
        },
      ]
    if (document.stats.held > 0)
      return [
        {
          document: document.id,
          title: document.title,
          text: `${count(document.stats.held, "passage")} held for your review, the rest is in use`,
          count: document.stats.held,
        },
      ]
    return []
  })
}

export function needsLookCount(documents: Parameters<typeof needsLook>[0]) {
  return needsLook(documents).reduce((sum, item) => sum + item.count, 0)
}

/** What a document's page says about its held passages: how many, why, and where to read them. */
export function heldLabel(held: readonly { hold?: DocumentHold }[], paged: boolean) {
  if (held.length === 0) return ""
  const why = [...new Set(held.map((item) => documentHoldLabel(item.hold)))].join("; ")
  const one = held.length === 1
  return [
    `${one ? "1 passage is" : `${held.length} passages are`} held for your review and never ${one ? "reaches" : "reach"} the agent: ${why}.`,
    ...(paged ? [`${one ? "It is" : "They are"} marked in Pages.`] : []),
  ].join(" ")
}

/** The tab's one-line summary. */
export function documentsSummary(list: Pick<MemoryDocumentList, "documents" | "indexing">) {
  const shown = list.documents.filter((document) => document.status !== "superseded")
  if (shown.length === 0) return "No documents yet"
  const busy = shown.filter((document) => statusTone(document) === "busy").length
  const waiting = needsLookCount(shown)
  return [
    count(shown.length, "document"),
    ...(busy > 0 ? [`${busy} being read`] : []),
    ...(waiting > 0 ? [`${waiting} to look at`] : []),
    "only the parts a request needs are sent",
  ].join(" · ")
}

/** Whether the page keeps asking for progress: while anything is read, or the search model downloads. */
export function polling(list: Pick<MemoryDocumentList, "indexing" | "model"> | undefined) {
  if (!list) return false
  return list.indexing || list.model?.state === "downloading" || list.model?.state === "verifying"
}

/**
 * The engine's answer when it is a document list. An engine from before documents answers this path some other way,
 * and the page then says documents are not available rather than failing.
 */
export function documentList(value: unknown): MemoryDocumentList | undefined {
  if (!value || typeof value !== "object" || !("documents" in value) || !Array.isArray(value.documents))
    return undefined
  return value as MemoryDocumentList
}

/** Pausing applies while a document is still being read or embedded; a finished one has nothing to pause. */
export function pausable(document: Pick<MemoryDocument, "status" | "paused">) {
  return !document.paused && !done(document.status)
}

export function resumable(document: Pick<MemoryDocument, "status" | "paused">) {
  return !!document.paused && !done(document.status)
}

/** Reading a document again needs what it was read from: a kept copy or the file it was added from. */
export function reindexable(document: Pick<MemoryDocument, "status" | "stored" | "sourcePath">) {
  return document.status !== "superseded" && (document.stored || !!document.sourcePath)
}

export function approvable(document: Pick<MemoryDocument, "status">) {
  return document.status === "held"
}

// Statuses past reading, where Pause no longer applies.
function done(status: DocumentStatus) {
  return (
    status === "searchable" ||
    status === "ready" ||
    status === "partial" ||
    status === "held" ||
    status === "failed" ||
    status === "superseded"
  )
}

/** What the page says when the engine refused a file. Its message already names the file and says what to do. */
export function refusalLabel(reason: Refusal | undefined, message: string | undefined, name: string) {
  if (reason === "version")
    return `${name} is already here. Read this file as its next version? Your edits, pins and links carry over.`
  if (reason === "guest") return "Only the owner of this computer adds documents."
  if (reason === "busy") return "Vector is reading many documents at once. Add this one again in a minute."
  if (message) return message
  if (reason === "too-large") return `${name} is too large for Vector to read.`
  if (reason === "unsupported") return `Vector cannot read ${name}.`
  if (reason === "encrypted")
    return "This file is password protected. Vector doesn't ask for document passwords; add an unprotected copy."
  if (reason === "empty") return `${name} has no text Vector can read.`
  if (reason === "secret") return `${name} looks like a file of secrets, so Vector does not keep it.`
  if (reason === "limit") return "This repository holds the most documents Vector keeps. Forget some to add more."
  if (reason === "forgotten") return `You forgot ${name} earlier. Add it again here to keep it.`
  if (reason === "outside") return `${name} is outside this repository.`
  if (reason === "not-found") return `Vector could not find ${name}.`
  return `Vector could not read ${name}.`
}

/** Why the engine said no: its reason and message, from a MemoryError or a too-large answer the SDK returned. */
export function refusal(error: unknown): { reason?: Refusal; message?: string } {
  if (!error || typeof error !== "object") return {}
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : undefined
  const message =
    data && "message" in data && typeof data.message === "string"
      ? data.message
      : error instanceof Error
        ? error.message
        : undefined
  const reason =
    data && "reason" in data && typeof data.reason === "string"
      ? REFUSALS.find((item) => item === data.reason)
      : undefined
  return { ...(reason ? { reason } : {}), ...(message ? { message } : {}) }
}

const REFUSALS: readonly Refusal[] = [
  "too-large",
  "unsupported",
  "encrypted",
  "empty",
  "secret",
  "invalid",
  "limit",
  "guest",
  "forgotten",
  "not-found",
  "outside",
  "busy",
  "version",
]

/** What the page says once a file went in. */
export function addedLabel(result: { type: "queued" | "unchanged" | "version" }, name: string) {
  if (result.type === "unchanged") return `${name} is already here, unchanged.`
  if (result.type === "version") return `Reading ${name} as a new version. Your edits, pins and links carry over.`
  return `Reading ${name}. It is searchable in a few seconds; large files take longer.`
}

export const FORGET = "Forget this document for good? Its records, passages and links go too, also from old sessions."

export function forgottenLabel(title: string) {
  return `Forgot ${title}. Vector will not keep it again on its own; you can always add it again.`
}

export function recordKindLabel(kind: RecordKind, many = false) {
  const one = {
    requirement: "Requirement",
    constraint: "Constraint",
    decision: "Decision",
    contract: "Contract",
    procedure: "Procedure",
    term: "Term",
    entity: "Entity",
    fact: "Fact",
    question: "Open question",
  }[kind]
  return many ? `${one}s` : one
}

export const RECORD_KINDS: readonly RecordKind[] = [
  "requirement",
  "constraint",
  "decision",
  "contract",
  "procedure",
  "term",
  "entity",
  "fact",
  "question",
]

/** "12 requirements · 4 constraints · 1 open question", largest first, nothing for kinds it has none of. */
export function kindCounts(kinds: Partial<Record<RecordKind, number>>) {
  const items = RECORD_KINDS.flatMap((kind) =>
    (kinds[kind] ?? 0) > 0 ? [{ kind, n: kinds[kind] ?? 0 }] : [],
  ).toSorted((a, b) => b.n - a.n || RECORD_KINDS.indexOf(a.kind) - RECORD_KINDS.indexOf(b.kind))
  if (items.length === 0) return "Nothing learned from it yet"
  return items
    .map((item) => `${item.n.toLocaleString()} ${recordKindLabel(item.kind, item.n !== 1).toLowerCase()}`)
    .join(" · ")
}

/** What the user can say about a record that Vector called the wrong kind: "Not a requirement". */
export function notApplicableLabel(kind: RecordKind) {
  const label = recordKindLabel(kind).toLowerCase()
  return `Not ${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`
}

export function recordUsage(record: Pick<MemoryRecord, "uses">) {
  if (!record.uses) return "Not used yet"
  return `Used in ${count(record.uses, "run")}`
}

/** Where a record comes from in its document. */
export function recordPlace(record: Pick<MemoryRecord, "page" | "section">) {
  return [...(record.page ? [`p.${record.page}`] : []), ...(record.section ? [record.section] : [])].join(" · ")
}

export function recordStatusLabel(record: Pick<MemoryRecord, "status" | "hold" | "userEdited" | "pinned">) {
  if (record.status === "quarantined" || record.status === "proposed")
    return `Held for your review: ${documentHoldLabel(record.hold)}`
  if (record.status === "archived") return "Not used: you set it aside"
  return [record.pinned ? "Pinned" : "", record.userEdited ? "Edited by you" : ""].filter(Boolean).join(" · ")
}

export type OutlineRow = { id: string; heading: string; level: number; pages: string; unread: boolean }

/** The outline as the page lists it: indented headings with their pages, and whether a page in it was not read. */
export function outlineRows(detail: Pick<MemoryDocumentDetail, "outline">, unread: readonly number[]): OutlineRow[] {
  const top = Math.min(...detail.outline.map((section) => section.level), Infinity)
  return detail.outline.map((section) => ({
    id: section.id,
    heading: section.heading || "Untitled section",
    level: Math.max(0, section.level - (Number.isFinite(top) ? top : 0)),
    pages:
      section.pageStart === undefined
        ? ""
        : section.pageEnd === undefined || section.pageEnd === section.pageStart
          ? `p.${section.pageStart}`
          : `pp.${section.pageStart}-${section.pageEnd}`,
    unread:
      section.pageStart !== undefined &&
      unread.some((page) => page >= section.pageStart! && page <= (section.pageEnd ?? section.pageStart!)),
  }))
}

export type Span = { text: string; record?: { id: string; kind: RecordKind } }

/**
 * A passage's text cut where its records sit, so the page can mark them. Spans out of range are clamped, and one that
 * overlaps an earlier one only marks what is left of it.
 */
export function highlight(passage: Pick<MemoryDocumentPage["passages"][number], "text" | "records">): Span[] {
  const length = passage.text.length
  const marks = passage.records
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      start: clamp(record.start, length),
      end: clamp(record.end, length),
    }))
    .filter((record) => record.end > record.start)
    .toSorted((a, b) => a.start - b.start || b.end - a.end)
  const state = { at: 0, spans: [] as Span[] }
  for (const mark of marks) {
    const start = Math.max(mark.start, state.at)
    if (start >= mark.end) continue
    if (start > state.at) state.spans.push({ text: passage.text.slice(state.at, start) })
    state.spans.push({ text: passage.text.slice(start, mark.end), record: { id: mark.id, kind: mark.kind } })
    state.at = mark.end
  }
  if (state.at < length || state.spans.length === 0) state.spans.push({ text: passage.text.slice(state.at) })
  return state.spans
}

/** What a page of the Pages view says above its text. */
export function pageHeading(page: Pick<MemoryDocumentPage, "page" | "pages" | "unread">) {
  if (page.unread) return `Page ${page.page} of ${page.pages}: a picture of text, which Vector does not read.`
  return `Page ${page.page} of ${page.pages}`
}

/** "p.3, 7-9": scanned pages, compressed. */
export function pageList(pages: readonly number[]) {
  const sorted = [...new Set(pages)].toSorted((a, b) => a - b)
  const runs = sorted.reduce<{ start: number; end: number }[]>((all, page) => {
    const last = all.at(-1)
    if (last && page === last.end + 1) return [...all.slice(0, -1), { start: last.start, end: page }]
    return [...all, { start: page, end: page }]
  }, [])
  return `p.${runs.map((run) => (run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`)).join(", ")}`
}

export const REPOSITORY_DOCS =
  "Vector reads this repository's READMEs, docs folder, decision records and API specs, in repositories you trust. Turning it off forgets what it read of them."

export const KEEP_ORIGINALS =
  "Keep a copy of each file you add on this computer, so Vector can read it again with a better reader. The copy is the file as you added it, secrets included; turning this off deletes the copies."

/** The drop zone's words. */
export const DROP = {
  idle: "Drop documents here, or add them from your computer",
  over: "Drop to add",
  formats: "PDF, Word, PowerPoint, Excel, Markdown, HTML, OpenAPI, JSON, YAML, CSV and text, up to 64 MB each",
  private:
    "Documents are read on this computer and stay private: kept from invited guests and from models that may train on prompts.",
}

export function bytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Token counts are estimates, so they are rounded the way they are read: "about 140,000". */
export function tokens(value: number) {
  const step = value >= 10_000 ? 1_000 : value >= 1_000 ? 100 : 10
  return Math.max(step, Math.round(value / step) * step).toLocaleString("en-US")
}

function ago(at: number, now: number) {
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

function units(format: MemoryDocument["format"]) {
  if (format === "pdf" || format === "docx") return "page"
  if (format === "pptx") return "slide"
  if (format === "xlsx") return "sheet"
  return undefined
}

function count(n: number, unit: string) {
  return `${n.toLocaleString()} ${plural(n, unit)}`
}

function plural(n: number, unit: string) {
  return n === 1 ? unit : `${unit}s`
}

function extension(name: string) {
  const at = name.lastIndexOf(".")
  return at === -1 ? "" : name.slice(at + 1).toLowerCase()
}

function clamp(value: number, length: number) {
  return Math.min(Math.max(0, value), length)
}
