import { describe, expect, test } from "bun:test"
import { ResearchExtract } from "../../src/research/extract"
import { ResearchSignals } from "../../src/research/signals"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const now = Date.parse("2026-10-22T00:00:00Z")
const base = {
  meta: { ids: {}, data: false, references: false },
  flagged: 0,
  paywalled: false,
  corroborated: 0,
  now,
} satisfies Omit<ResearchSignals.Input, "url">

describe("ResearchSignals.signals", () => {
  test("names a paper with a DOI, its date, age and author, as a primary source", () => {
    const signal = ResearchSignals.signals({
      ...base,
      url: "https://journals.example.com/article/1",
      meta: {
        ids: { doi: "10.1000/xyz123" },
        published: "2026-10-12",
        author: "Mara Lindqvist",
        data: false,
        references: true,
      },
      corroborated: 2,
    })
    expect(signal).toMatchObject({
      kind: "other",
      primary: true,
      doi: "10.1000/xyz123",
      published: "2026-10-12",
      age_days: 10,
      author: "Mara Lindqvist",
      references: true,
      corroborated: 2,
    })
  })

  test("counts academic, government and standards sites, and data publishers, as primary", () => {
    expect(ResearchSignals.signals({ ...base, url: "https://arxiv.org/abs/2401.00001" }).primary).toBe(true)
    expect(ResearchSignals.signals({ ...base, url: "https://www.energy.gov/eere" }).primary).toBe(true)
    expect(ResearchSignals.signals({ ...base, url: "https://www.rfc-editor.org/rfc/rfc9309" }).primary).toBe(true)
    expect(
      ResearchSignals.signals({ ...base, url: "https://blog.example.com/", meta: { ...base.meta, data: true } })
        .primary,
    ).toBe(true)
    expect(ResearchSignals.signals({ ...base, url: "https://blog.example.com/" }).primary).toBe(false)
    expect(ResearchSignals.signals({ ...base, url: "https://en.wikipedia.org/wiki/Heat_pump" })).toMatchObject({
      kind: "reference",
      primary: false,
    })
  })

  test("marks copies, paywalls, text addressed to AI assistants and the user's site preferences", () => {
    const signal = ResearchSignals.signals({
      ...base,
      url: "https://news.example.com/a",
      duplicateOf: "S1",
      paywalled: true,
      flagged: 2,
      prefer: ["example.com"],
    })
    expect(signal).toMatchObject({ duplicate_of: "S1", paywalled: true, addressed_to_ai: true, preference: "trusted" })
    const avoided = ResearchSignals.signals({
      ...base,
      url: "https://news.example.com/a",
      prefer: ["example.com"],
      avoid: ["news.example.com"],
    })
    expect(avoided.preference).toBe("avoided")
  })

  test("reads identifiers from an address alone", () => {
    expect(ResearchExtract.addressIds("https://arxiv.org/abs/2401.01234v2")).toEqual({ arxiv: "2401.01234v2" })
    expect(ResearchExtract.addressIds("https://pubmed.ncbi.nlm.nih.gov/31452104/")).toEqual({ pmid: "31452104" })
    expect(ResearchExtract.addressIds("https://doi.org/10.1038/s41586-020-2649-2")).toEqual({
      doi: "10.1038/s41586-020-2649-2",
    })
    expect(ResearchExtract.addressIds("https://example.com/post")).toEqual({})
  })
})

describe("ResearchSignals.labels", () => {
  test("words each signal, and never says a source is verified", () => {
    const labels = ResearchSignals.labels(
      ResearchSignals.signals({
        ...base,
        url: "https://arxiv.org/abs/2401.00001",
        meta: { ids: { arxiv: "2401.00001" }, published: "2026-01-02", data: true, references: true },
        flagged: 1,
        corroborated: 1,
        avoid: ["arxiv.org"],
      }),
    )
    expect(labels).toEqual([
      "Primary source",
      "arXiv 2401.00001",
      "Published 2026-01-02",
      "Publishes data",
      "Lists references",
      "Contains text addressed to AI assistants",
      "Also said by 1 other site",
      "You avoid this site",
    ])
    expect(labels.join(" ").toLowerCase()).not.toContain("verified")
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
