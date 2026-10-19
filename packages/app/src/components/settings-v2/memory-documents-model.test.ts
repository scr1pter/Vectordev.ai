import { describe, expect, test } from "bun:test"
import type { MemoryDocument } from "@vectordevai/sdk/v2/client"
import {
  addedLabel,
  bytes,
  DROP,
  FORGET,
  KEEP_ORIGINALS,
  REPOSITORY_DOCS,
  documentHoldLabel,
  documentList,
  documentMeta,
  documentsSummary,
  heldLabel,
  highlight,
  kindCounts,
  needsLook,
  needsLookCount,
  notApplicableLabel,
  originLabel,
  outlineRows,
  pageHeading,
  pageList,
  pausable,
  polling,
  precheck,
  recordKindLabel,
  recordStatusLabel,
  recordUsage,
  refusal,
  refusalLabel,
  reindexable,
  replaceable,
  resumable,
  statusLabel,
  statusTone,
  steps,
  tokens,
  uploadMode,
  visibilityLabel,
  warningLabel,
  type DocumentHold,
  type DocumentStatus,
  type DocumentWarning,
  type RecordKind,
  type Refusal,
} from "./memory-documents-model"

const stats = {
  tokens: 140_210,
  read: 212,
  sections: 31,
  passages: 400,
  records: 120,
  kinds: {
    requirement: 12,
    constraint: 4,
    decision: 0,
    contract: 3,
    procedure: 0,
    term: 0,
    entity: 0,
    fact: 0,
    question: 1,
  },
  held: 0,
  linked: 0,
  embedded: 0,
}

function doc(input: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    id: "dabc12345",
    ordinal: 1,
    version: 1,
    name: "api-spec.pdf",
    title: "API spec",
    format: "pdf",
    origin: "upload",
    visibility: "private",
    status: "searchable",
    bytes: 1_468_006,
    pages: 212,
    unread: [],
    stored: false,
    stats,
    warnings: [],
    createdAt: 0,
    updatedAt: 0,
    ...input,
  }
}

const STATUSES: DocumentStatus[] = [
  "queued",
  "reading",
  "linking",
  "searchable",
  "embedding",
  "ready",
  "partial",
  "held",
  "failed",
  "superseded",
]
const HOLDS: DocumentHold[] = [
  "web",
  "mcp",
  "subagent",
  "untrusted-repository",
  "guest",
  "instruction-like",
  "hidden-unicode",
  "hidden-text",
  "suggested",
]
const WARNINGS: DocumentWarning[] = [
  "truncated",
  "scanned",
  "encrypted",
  "macros-ignored",
  "external-links",
  "secrets-removed",
  "tables-approximate",
]
const REFUSALS: Refusal[] = [
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
const KINDS: RecordKind[] = [
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

describe("documents page model", () => {
  test("names every status the way the list shows it", () => {
    expect(STATUSES.map((status) => statusLabel(doc({ status, hold: "instruction-like" })))).toEqual([
      "Queued",
      "Reading",
      "Linking to code",
      "Searchable",
      "Searchable",
      "Ready",
      "Partly read",
      "Held for your review: parts of it read like instructions to an AI",
      "Could not read",
      "Replaced by a newer version",
    ])
    expect(statusLabel(doc({ status: "partial", unread: [3, 4] }))).toBe("Scanned pages skipped")
    expect(statusLabel(doc({ status: "partial", warnings: ["scanned"] }))).toBe("Scanned pages skipped")
    expect(statusLabel(doc({ status: "reading", paused: true }))).toBe("Paused")
    // A finished document that was paused once reads as finished.
    expect(statusLabel(doc({ status: "ready", paused: true }))).toBe("Ready")
  })

  test("gives each status a tone for its dot", () => {
    expect(STATUSES.map((status) => statusTone({ status }))).toEqual([
      "busy",
      "busy",
      "busy",
      "good",
      "good",
      "good",
      "waiting",
      "waiting",
      "problem",
      "idle",
    ])
    expect(statusTone({ status: "reading", paused: true })).toBe("idle")
  })

  test("says why a document waits, for every hold", () => {
    const labels = HOLDS.map(documentHoldLabel)
    expect(new Set(labels).size).toBe(HOLDS.length)
    expect(documentHoldLabel("instruction-like")).toBe("parts of it read like instructions to an AI")
    expect(documentHoldLabel("untrusted-repository")).toBe("this repository's settings are not trusted yet")
    expect(documentHoldLabel(undefined)).toBe("Vector could not check where it came from")
  })

  test("explains every warning, naming the scanned pages", () => {
    expect(new Set(WARNINGS.map((warning) => warningLabel(warning))).size).toBe(WARNINGS.length)
    expect(warningLabel("scanned", { unread: [9, 3, 4, 5] })).toBe(
      "Scanned pages (p.3-5, 9) are pictures of text, which Vector does not read.",
    )
    expect(pageList([1, 2, 3, 7, 9, 10])).toBe("p.1-3, 7, 9-10")
  })

  test("shows a stepper that only lists what applies", () => {
    expect(steps(doc({ status: "reading", stats: { ...stats, read: 40 } }))).toEqual([
      { label: "Read 40/212 pages", state: "active" },
      { label: "Structured", state: "pending" },
    ])
    expect(steps(doc({ status: "queued", stats: { ...stats, read: 0 } }))[0]).toEqual({
      label: "Read 0/212 pages",
      state: "pending",
    })
    expect(steps(doc())).toEqual([
      { label: "Read 212/212 pages", state: "done" },
      { label: "Structured 31 sections", state: "done" },
    ])
    // Code links and the search model show up once they apply.
    expect(
      steps(doc({ status: "embedding", embedModel: "arctic", stats: { ...stats, linked: 23, embedded: 213 } })),
    ).toEqual([
      { label: "Read 212/212 pages", state: "done" },
      { label: "Structured 31 sections", state: "done" },
      { label: "Linked 23 files", state: "done" },
      { label: "Meaning 40%", state: "active" },
    ])
    expect(steps(doc({ status: "linking" }))[2]).toEqual({ label: "Linking to code", state: "active" })
    // Formats without pages say "Read" alone, and one section is one.
    expect(steps(doc({ format: "markdown", pages: undefined, stats: { ...stats, sections: 1 } }))).toEqual([
      { label: "Read", state: "done" },
      { label: "Structured 1 section", state: "done" },
    ])
    expect(steps(doc({ format: "pptx", pages: 12, stats: { ...stats, read: 12 } }))[0]?.label).toBe("Read 12/12 slides")
    expect(steps(doc({ status: "failed" }))[0]?.state).toBe("pending")
    expect(steps(doc({ status: "held" }))[0]?.state).toBe("done")
  })

  test("describes a document in one line", () => {
    expect(documentMeta(doc({ createdAt: 0 }), 2 * 86_400_000)).toBe(
      "PDF · 212 pages · 1.4 MB · about 140,000 tokens if sent · You added this 2 days ago",
    )
    expect(
      documentMeta(
        doc({
          format: "markdown",
          pages: undefined,
          bytes: 2048,
          origin: "repository",
          stats: { ...stats, tokens: 512 },
        }),
        0,
      ),
    ).toBe("Markdown · 2 KB · about 510 tokens if sent · From this repository's docs today")
    expect(bytes(900)).toBe("900 B")
    expect(bytes(64 * 1024 * 1024)).toBe("64 MB")
    expect(tokens(139_920)).toBe("140,000")
    expect(tokens(4_321)).toBe("4,300")
  })

  test("counts what waits for the user, whole documents and held passages", () => {
    const documents = [
      doc({ id: "d1", title: "Held", status: "held", hold: "hidden-text" }),
      doc({ id: "d2", title: "Spec", stats: { ...stats, held: 3 } }),
      doc({ id: "d3", title: "Fine" }),
      doc({ id: "d4", title: "Old", status: "superseded", stats: { ...stats, held: 2 } }),
    ]
    expect(needsLook(documents)).toEqual([
      { document: "d1", title: "Held", text: "Held for your review: it has text a reader would not see", count: 1 },
      { document: "d2", title: "Spec", text: "3 passages held for your review, the rest is in use", count: 3 },
    ])
    expect(needsLookCount(documents)).toBe(4)
    expect(heldLabel([], true)).toBe("")
    expect(heldLabel([{ hold: "instruction-like" }], false)).toBe(
      "1 passage is held for your review and never reaches the agent: parts of it read like instructions to an AI.",
    )
    expect(heldLabel([{ hold: "instruction-like" }, { hold: "hidden-text" }, { hold: "instruction-like" }], true)).toBe(
      "3 passages are held for your review and never reach the agent: parts of it read like instructions to an AI; it has text a reader would not see. They are marked in Pages.",
    )
    expect(documentsSummary({ documents, indexing: false })).toBe(
      "3 documents · 4 to look at · only the parts a request needs are sent",
    )
    expect(documentsSummary({ documents: [], indexing: false })).toBe("No documents yet")
    expect(documentsSummary({ documents: [doc({ status: "reading" })], indexing: true })).toBe(
      "1 document · 1 being read · only the parts a request needs are sent",
    )
  })

  test("polls only while something is read or the search model downloads", () => {
    const model = { state: "absent" as const }
    expect(polling(undefined)).toBe(false)
    expect(polling({ indexing: false, model })).toBe(false)
    expect(polling({ indexing: true, model })).toBe(true)
    expect(polling({ indexing: false, model: { state: "downloading" } })).toBe(true)
    expect(polling({ indexing: false, model: { state: "ready" } })).toBe(false)
    // An engine that answers without a model status (or at all) is not polled, and does not break the page.
    expect(polling({ indexing: false } as Parameters<typeof polling>[0])).toBe(false)
    expect(documentList({})).toBeUndefined()
    expect(documentList({ documents: "x" })).toBeUndefined()
    expect(documentList(undefined)).toBeUndefined()
    const list = { documents: [], indexing: false, model, settings: {}, limits: {}, worker: {} }
    expect(documentList(list)).toBe(list as never)
  })

  test("offers pause, resume and reindex only where they apply", () => {
    expect(pausable({ status: "reading" })).toBe(true)
    expect(pausable({ status: "ready" })).toBe(false)
    expect(pausable({ status: "reading", paused: true })).toBe(false)
    expect(resumable({ status: "reading", paused: true })).toBe(true)
    expect(reindexable({ status: "ready", stored: false })).toBe(false)
    expect(reindexable({ status: "ready", stored: true })).toBe(true)
    expect(reindexable({ status: "ready", stored: false, sourcePath: "/repo/docs/a.md" })).toBe(true)
    expect(reindexable({ status: "superseded", stored: true })).toBe(false)
    expect(replaceable({ status: "ready", origin: "upload" })).toBe(true)
    expect(replaceable({ status: "ready", origin: "chat" })).toBe(true)
    expect(replaceable({ status: "ready", origin: "repository" })).toBe(false)
    expect(replaceable({ status: "superseded", origin: "upload" })).toBe(false)
  })

  test("refuses what the engine would refuse, before sending it", () => {
    expect(precheck({ name: "diagram.png", size: 10 })).toBe(
      "Attach images to a message so the model can look at them. Vector does not read text in images.",
    )
    expect(precheck({ name: "Spec.DOC", size: 10 })).toBe(
      "Vector reads .docx, not .doc. Save it as .docx and add that.",
    )
    expect(precheck({ name: "deck.ppt", size: 10 })).toBe(
      "Vector reads .pptx, not .ppt. Save it as .pptx and add that.",
    )
    expect(precheck({ name: "docs.zip", size: 10 })).toContain("archives")
    expect(precheck({ name: "setup.exe", size: 10 })).toContain("programs")
    expect(precheck({ name: "empty.md", size: 0 })).toBe("empty.md is empty.")
    expect(precheck({ name: "huge.pdf", size: 65 * 1024 * 1024 })).toBe(
      "huge.pdf is 65 MB. Vector keeps documents of up to 64 MB.",
    )
    expect(precheck({ name: "spec.pdf", size: 64 * 1024 * 1024 })).toBeUndefined()
    expect(precheck({ name: "notes.md", size: 10 })).toBeUndefined()
  })

  test("sends a path only to its own engine, and only when it knows the path", () => {
    expect(uploadMode({ builtin: true, path: "/Users/a/spec.pdf" })).toBe("path")
    expect(uploadMode({ builtin: true })).toBe("bytes")
    expect(uploadMode({ builtin: false, path: "/Users/a/spec.pdf" })).toBe("bytes")
  })

  test("words every refusal, with the engine's own message where it gave one", () => {
    const labels = REFUSALS.map((reason) => refusalLabel(reason, undefined, "spec.pdf"))
    expect(new Set(labels).size).toBe(REFUSALS.length)
    expect(refusalLabel("version", "spec.pdf is already document 1 (v1). Add it again with replace…", "spec.pdf")).toBe(
      "spec.pdf is already here. Read this file as its next version? Your edits, pins and links carry over.",
    )
    expect(refusalLabel("unsupported", "Save it as .docx.", "a.doc")).toBe("Save it as .docx.")
    expect(refusalLabel("encrypted", undefined, "a.pdf")).toBe(
      "This file is password protected. Vector doesn't ask for document passwords; add an unprotected copy.",
    )
    expect(
      refusal({ name: "MemoryError", data: { code: "refused", reason: "version", message: "already here" } }),
    ).toEqual({
      reason: "version",
      message: "already here",
    })
    expect(refusal({ name: "MemoryTooLargeError", data: { message: "At most 64 MB." } })).toEqual({
      message: "At most 64 MB.",
    })
    expect(refusal({ data: { reason: "made-up", message: "x" } })).toEqual({ message: "x" })
    expect(refusal(new Error("offline"))).toEqual({ message: "offline" })
    expect(refusal(undefined)).toEqual({})
    expect(addedLabel({ type: "unchanged" }, "a.md")).toBe("a.md is already here, unchanged.")
    expect(addedLabel({ type: "queued" }, "a.md")).toContain("Reading a.md")
    expect(addedLabel({ type: "version" }, "a.md")).toContain("new version")
  })

  test("counts records by kind, largest first, and names each kind", () => {
    expect(kindCounts(stats.kinds)).toBe("12 requirements · 4 constraints · 3 contracts · 1 open question")
    expect(kindCounts({})).toBe("Nothing learned from it yet")
    expect(KINDS.map((kind) => recordKindLabel(kind))).toEqual([
      "Requirement",
      "Constraint",
      "Decision",
      "Contract",
      "Procedure",
      "Term",
      "Entity",
      "Fact",
      "Open question",
    ])
    expect(notApplicableLabel("requirement")).toBe("Not a requirement")
    expect(notApplicableLabel("entity")).toBe("Not an entity")
    expect(notApplicableLabel("question")).toBe("Not an open question")
  })

  test("describes a record's use and state", () => {
    expect(recordUsage({ uses: 0 })).toBe("Not used yet")
    expect(recordUsage({ uses: 1 })).toBe("Used in 1 run")
    expect(recordUsage({ uses: 4 })).toBe("Used in 4 runs")
    expect(recordStatusLabel({ status: "active", pinned: true, userEdited: true })).toBe("Pinned · Edited by you")
    expect(recordStatusLabel({ status: "active", pinned: false, userEdited: false })).toBe("")
    expect(
      recordStatusLabel({ status: "quarantined", hold: "instruction-like", pinned: false, userEdited: false }),
    ).toBe("Held for your review: parts of it read like instructions to an AI")
    expect(recordStatusLabel({ status: "archived", pinned: false, userEdited: false })).toBe(
      "Not used: you set it aside",
    )
  })

  test("lists the outline with pages and marks sections with unread pages", () => {
    expect(
      outlineRows(
        {
          outline: [
            { id: "s1", heading: "Limits", path: "3 Limits", level: 2, pageStart: 12, pageEnd: 15 },
            { id: "s2", heading: "Retries", path: "3 Limits > 3.2 Retries", level: 3, pageStart: 14 },
            { id: "s3", heading: "", path: "", level: 2 },
          ],
        },
        [13],
      ),
    ).toEqual([
      { id: "s1", heading: "Limits", level: 0, pages: "pp.12-15", unread: true },
      { id: "s2", heading: "Retries", level: 1, pages: "p.14", unread: false },
      { id: "s3", heading: "Untitled section", level: 0, pages: "", unread: false },
    ])
  })

  test("cuts a passage where its records sit, clamping and skipping overlaps", () => {
    expect(
      highlight({
        text: "Clients must retry at most 3 times. Uploads are at most 50 MB.",
        records: [
          { id: "r2", kind: "constraint", start: 36, end: 62 },
          { id: "r1", kind: "requirement", start: 0, end: 35 },
          { id: "r3", kind: "fact", start: 30, end: 36 },
          { id: "r4", kind: "fact", start: 80, end: 90 },
        ],
      }),
    ).toEqual([
      { text: "Clients must retry at most 3 times.", record: { id: "r1", kind: "requirement" } },
      { text: " ", record: { id: "r3", kind: "fact" } },
      { text: "Uploads are at most 50 MB.", record: { id: "r2", kind: "constraint" } },
    ])
    expect(highlight({ text: "Plain.", records: [] })).toEqual([{ text: "Plain." }])
    expect(pageHeading({ page: 3, pages: 9, unread: true })).toBe(
      "Page 3 of 9: a picture of text, which Vector does not read.",
    )
  })

  test("says repository docs are shared like the repository's memory, and only documents the user adds are private", () => {
    expect(REPOSITORY_DOCS).toContain("not private")
    expect(REPOSITORY_DOCS).toContain("shared like the repository's memory")
    expect(DROP.private).toStartWith("Documents you add")
    expect(visibilityLabel("repository")).toContain("also with guests")
  })

  test("never says project", () => {
    const words = [
      FORGET,
      KEEP_ORIGINALS,
      REPOSITORY_DOCS,
      ...Object.values(DROP),
      ...STATUSES.map((status) => statusLabel(doc({ status }))),
      ...HOLDS.map(documentHoldLabel),
      ...WARNINGS.map((warning) => warningLabel(warning, { unread: [1] })),
      ...REFUSALS.map((reason) => refusalLabel(reason, undefined, "a.pdf")),
      ...(["upload", "chat", "agent", "repository", "cli"] as const).map(originLabel),
      visibilityLabel("private"),
      visibilityLabel("repository"),
    ]
    expect(words.length).toBeGreaterThan(40)
    for (const word of words) expect(word.toLowerCase()).not.toContain("project")
  })
})
