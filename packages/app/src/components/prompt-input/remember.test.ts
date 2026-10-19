import { describe, expect, test } from "bun:test"
import {
  LARGE,
  OFFICE_TYPES,
  REMEMBER,
  chipLabel,
  documentKind,
  marker,
  modeFor,
  offer,
  officeMime,
  pasteName,
  prose,
} from "./remember"

const MB = 1024 * 1024

describe("remember decision", () => {
  test("offers nothing for images and files that are not documents", () => {
    expect(offer({ filename: "shot.png", mime: "image/png", bytes: 5 * MB })).toEqual({ type: "none" })
    expect(offer({ filename: "main.ts", mime: "text/plain", bytes: 100 })).toEqual({ type: "none" })
    expect(documentKind({ filename: "photo.heic", mime: "image/heic" })).toBeUndefined()
  })

  test("offers the Remember chip, off, for a small document", () => {
    expect(offer({ filename: "notes.md", mime: "text/plain", bytes: 20_000 })).toEqual({ type: "chip" })
    expect(
      offer(
        { filename: "brief.pdf", mime: "application/pdf", bytes: 400_000 },
        { pages: 12, tokens: 8_000, suggest: "none" },
      ),
    ).toEqual({
      type: "chip",
    })
    // Without the engine's page count, a small PDF is a chip too.
    expect(offer({ filename: "brief.pdf", mime: "application/pdf", bytes: 400_000 })).toEqual({ type: "chip" })
  })

  test("suggests Remember instead for a PDF over 20 pages, with the engine's count", () => {
    expect(
      offer(
        { filename: "api-spec.pdf", mime: "application/pdf", bytes: 900_000 },
        { pages: 212, tokens: 139_920, suggest: "remember-instead" },
      ),
    ).toEqual({
      type: "suggest",
      message:
        "api-spec.pdf is 212 pages (about 140,000 tokens if sent). Remember it instead, and Vector will bring in only the parts that matter.",
    })
    // 20 pages is not over 20.
    expect(
      offer(
        { filename: "a.pdf", mime: "application/pdf", bytes: 900_000 },
        { pages: LARGE.pages, tokens: 9_000, suggest: "none" },
      ),
    ).toEqual({
      type: "chip",
    })
    expect(
      offer(
        { filename: "a.pdf", mime: "application/pdf", bytes: 900_000 },
        { pages: 21, tokens: 9_000, suggest: "none" },
      ).type,
    ).toBe("suggest")
  })

  test("suggests Remember instead for any document over 1 MB, and not at 1 MB", () => {
    expect(offer({ filename: "log-free.md", mime: "text/plain", bytes: LARGE.bytes })).toEqual({ type: "chip" })
    expect(offer({ filename: "handbook.md", mime: "text/plain", bytes: 2 * MB })).toEqual({
      type: "suggest",
      message:
        "handbook.md is 2.0 MB (about 524,000 tokens if sent). Remember it instead, and Vector will bring in only the parts that matter.",
    })
    // A PDF's size says nothing about its text, so with no page count only its size is named.
    expect(offer({ filename: "scan.pdf", mime: "application/pdf", bytes: 3 * MB })).toEqual({
      type: "suggest",
      message: "scan.pdf is 3.0 MB. Remember it instead, and Vector will bring in only the parts that matter.",
    })
  })

  test("always sends office files through memory", () => {
    for (const [ext, mime] of Object.entries(OFFICE_TYPES)) {
      expect(offer({ filename: `deck.${ext}`, mime, bytes: 10_000 })).toEqual({
        type: "office",
        message: `Models can't read deck.${ext} as it is, so Vector remembers it instead and brings in the parts that matter.`,
      })
      // Also when the platform gave no type.
      expect(
        offer({ filename: `deck.${ext.toUpperCase()}`, mime: "application/octet-stream", bytes: 10_000 }).type,
      ).toBe("office")
      expect(officeMime(`deck.${ext}`)).toBe(mime)
    }
    expect(officeMime("deck.doc")).toBeUndefined()
  })

  test("marks a request's attachment only as the user chose, office files always", () => {
    const pdf = { filename: "spec.pdf", mime: "application/pdf" }
    expect(modeFor(pdf)).toBeUndefined()
    expect(modeFor({ ...pdf, remember: "keep" })).toBe("keep")
    expect(modeFor({ ...pdf, remember: "instead" })).toBe("instead")
    expect(modeFor({ ...pdf, remember: "send" })).toBeUndefined()
    expect(modeFor({ filename: "deck.pptx", mime: OFFICE_TYPES.pptx })).toBe("instead")
    expect(modeFor({ filename: "deck.pptx", mime: OFFICE_TYPES.pptx, remember: "send" })).toBe("instead")
    expect(modeFor({ filename: "shot.png", mime: "image/png", remember: "keep" })).toBeUndefined()
  })

  test("marks an attachment with an empty text part the engine reads", () => {
    expect(marker("prt_1", "prt_file", "instead")).toEqual({
      id: "prt_1",
      type: "text",
      text: "",
      synthetic: true,
      metadata: { [REMEMBER]: { mode: "instead", part: "prt_file" } },
    })
    expect(REMEMBER).toBe("vector.memory.remember")
    expect(chipLabel(undefined)).toBe("Remember")
    expect(chipLabel("keep")).toBe("Remembered")
    expect(chipLabel("instead")).toBe("Remembered instead of sent")
  })
})

describe("paste chip", () => {
  const paragraph =
    "Clients must wait for the number of seconds in the Retry-After header after a 429 response, and they retry at most three times before they give up and report the failure to the user."

  test("offers to remember long prose, and never short text", () => {
    const doc = ["# Retry policy", "", ...Array.from({ length: 30 }, () => paragraph)].join("\n")
    expect(doc.length).toBeGreaterThan(4_000)
    expect(prose(doc)).toBe(true)
    expect(prose(paragraph)).toBe(false)
    // Bullets of prose are prose.
    expect(prose(Array.from({ length: 30 }, () => `- ${paragraph}`).join("\n"))).toBe(true)
  })

  test("does not offer it for logs, stack traces, diffs or code", () => {
    const log = Array.from(
      { length: 80 },
      (_, at) =>
        `2026-10-19T08:${String(at % 60).padStart(2, "0")}:01Z INFO server listening on port 4096 after ${at} retries`,
    ).join("\n")
    expect(log.length).toBeGreaterThan(4_000)
    expect(prose(log)).toBe(false)

    const trace = Array.from({ length: 120 }, (_, at) => `    at handler (/srv/app/src/routes/user.ts:${at}:17)`).join(
      "\n",
    )
    expect(prose(`TypeError: cannot read properties of undefined\n${trace}`)).toBe(false)

    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      ...Array.from({ length: 60 }, (_, at) => `@@ -${at},7 +${at},7 @@ ${paragraph}`),
    ].join("\n")
    expect(prose(diff)).toBe(false)

    const code = Array.from({ length: 200 }, (_, at) => `const value${at} = compute(input.items[${at}], options)`).join(
      "\n",
    )
    expect(prose(code)).toBe(false)

    // Prose with a few log lines mixed in is still prose; with many, it is not.
    const mixed = (logs: number) =>
      [
        ...Array.from({ length: 30 }, () => paragraph),
        ...Array.from({ length: logs }, () => "[12:00:01] ERROR request failed"),
      ].join("\n")
    expect(prose(mixed(4))).toBe(true)
    expect(prose(mixed(10))).toBe(false)
  })

  test("names pasted text by its first heading or line", () => {
    expect(pasteName("Some intro\n## Retry *policy*\ntext")).toBe("Retry policy")
    expect(pasteName("\n\nRelease notes v1.2\nbody")).toBe("Release notes v1.2")
    expect(pasteName("x".repeat(100))).toBe(`${"x".repeat(57)}…`)
    expect(pasteName("")).toBe("Pasted text")
  })
})
