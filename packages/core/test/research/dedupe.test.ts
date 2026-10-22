import { describe, expect, test } from "bun:test"
import { ResearchDedupe } from "../../src/research/dedupe"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

const story = Array.from(
  { length: 12 },
  (_, index) =>
    `Paragraph ${index + 1}: installers in the northern region fitted ${index + 3} hundred air source heat pumps in older homes this season.`,
).join("\n\n")
const known = (id: string, text: string, canonical = `https://${id.toLowerCase()}.example/`) => ({
  ...ResearchDedupe.fingerprint(text),
  id,
  canonical,
})
const page = (text: string, canonical = "https://new.example/") => ({ ...ResearchDedupe.fingerprint(text), canonical })

describe("ResearchDedupe.fingerprint", () => {
  test("hashes the words, so spacing, case and punctuation do not make a new page", () => {
    expect(ResearchDedupe.fingerprint("Heat  pumps, cut BILLS.").hash).toBe(ResearchDedupe.fingerprint("heat pumps cut bills").hash)
    expect(ResearchDedupe.fingerprint("heat pumps cut bills").hash).not.toBe(ResearchDedupe.fingerprint("heat pumps raise bills").hash)
  })

  test("makes 5-word shingles", () => {
    expect([...ResearchDedupe.fingerprint("one two three four five six").shingles]).toEqual([
      "one two three four five",
      "two three four five six",
    ])
    expect(ResearchDedupe.fingerprint("too short").shingles.size).toBe(0)
  })
})

describe("ResearchDedupe.duplicateOf", () => {
  test("finds a copy by its canonical address", () => {
    expect(ResearchDedupe.duplicateOf(page("anything", "https://s1.example/"), [known("S1", story)])).toBe("S1")
  })

  test("finds an exact copy by the hash of its cleaned text", () => {
    expect(ResearchDedupe.duplicateOf(page(story.toUpperCase()), [known("S2", "Other text."), known("S3", story)])).toBe("S3")
  })

  test("finds a near copy by shingles, and a syndicated copy that trims a section", () => {
    const edited = story.replace("Paragraph 7:", "Paragraph seven:")
    const shared = ResearchDedupe.jaccard(ResearchDedupe.fingerprint(edited).shingles, ResearchDedupe.fingerprint(story).shingles)
    expect(shared).toBeGreaterThanOrEqual(ResearchDedupe.JACCARD)
    expect(ResearchDedupe.duplicateOf(page(edited), [known("S1", story)])).toBe("S1")

    const trimmed = `${story.split("\n\n").slice(0, 9).join("\n\n")}\n\nThis article first appeared elsewhere.`
    expect(ResearchDedupe.jaccard(ResearchDedupe.fingerprint(trimmed).shingles, ResearchDedupe.fingerprint(story).shingles)).toBeLessThan(
      ResearchDedupe.JACCARD,
    )
    expect(ResearchDedupe.duplicateOf(page(trimmed), [known("S1", story)])).toBe("S1")
  })

  test("does not call two different pages on one subject copies", () => {
    const other = Array.from(
      { length: 12 },
      (_, index) => `Section ${index + 1}: grid operators reported ${index + 2} new battery sites and slower wind auctions.`,
    ).join("\n\n")
    expect(ResearchDedupe.duplicateOf(page(other), [known("S1", story)])).toBeUndefined()
  })

  test("compares short texts by hash only, so two short notices are not copies", () => {
    expect(ResearchDedupe.duplicateOf(page("Subscribe to our newsletter for heat pump news today"), [
      known("S1", "Subscribe to our newsletter for heat pump news tomorrow"),
    ])).toBeUndefined()
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
