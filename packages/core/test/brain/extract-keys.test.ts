import { describe, expect, test } from "bun:test"
import { BrainExtract } from "@vectordevai/core/brain/extract"
import { learn, SPEC_V1, SPEC_V2 } from "./fixture/documents"

const byKey = (records: readonly BrainExtract.Record[]) => new Map(records.map((record) => [record.key, record]))

describe("BrainExtract keys", () => {
  test("a reworded, reordered version keeps every record id, and a changed value keeps its id with a new quote", async () => {
    const v1 = byKey((await learn(SPEC_V1, "auth-spec.md")).records)
    const v2 = byKey((await learn(SPEC_V2, "auth-spec.md")).records)
    expect([...v1.keys()].toSorted()).toEqual([...v2.keys()].toSorted())
    for (const [key, record] of v1) expect(v2.get(key)!.id).toBe(record.id)
    const retries = [...v1.values()].find((record) => record.kind === "constraint" && record.quote.includes("retry"))!
    expect(v2.get(retries.key)!.fields).toMatchObject({ value: 5 })
    expect(v2.get(retries.key)!.quoteHash).not.toBe(retries.quoteHash)
    const uploads = [...v1.values()].find((record) => record.kind === "constraint" && record.quote.includes("Uploads"))!
    expect(v2.get(uploads.key)!.quoteHash).toBe(uploads.quoteHash)
  })

  test("ids are 'r' and six base32 characters from the repository, lineage and key, never the section", async () => {
    const one = (await learn(SPEC_V1, "auth-spec.md")).records
    expect(one.every((record) => /^r[0-9a-hjkmnp-tv-z]{6}$/.test(record.id))).toBe(true)
    expect(new Set(one.map((record) => record.id)).size).toBe(one.length)
    const moved = (await learn(SPEC_V1.replace("## 2 Limits", "## 9 Appendix > Limits"), "auth-spec.md")).records
    expect(moved.map((record) => record.id)).toEqual(one.map((record) => record.id))
    const otherLineage = (await learn(SPEC_V1, "billing-spec.md")).records
    expect(otherLineage.some((record) => one.some((same) => same.id === record.id))).toBe(false)
    const otherRepository = (await learn(SPEC_V1, "auth-spec.md", { repository: "other" })).records
    expect(otherRepository.some((record) => one.some((same) => same.id === record.id))).toBe(false)
  })

  test("subjects: a contract by its canonical name, a requirement by its ref, a term by itself, the rest by sorted terms", async () => {
    expect(BrainExtract.subjectOf("The clients MUST retry at most 3 times")).toBe(
      BrainExtract.subjectOf("Client must retry at most five times"),
    )
    expect(BrainExtract.subjectOf("Uploads per file")).toBe(BrainExtract.subjectOf("file uploads"))
    const records = (
      await learn(
        "REQ-4: Sessions MUST end at sign-out.\n\nREQ-4 is reworded here: sign-out MUST end every session.\n\nCall `GET /v1/users/{userId}/`.",
        "doc.md",
      )
    ).records
    expect(records.filter((record) => record.kind === "requirement").map((record) => record.key)).toEqual([
      "requirement|REQ-4",
      "requirement|REQ-4#2",
    ])
    expect(records.find((record) => record.kind === "contract")!.key).toBe("contract|endpoint:get /v1/users/*")
    expect(BrainExtract.route("/v1/users/{id}/sessions/:session/")).toBe("/v1/users/*/sessions/*")
  })

  test("the same sentence twice is one record; a second record of one subject gets an ordinal", async () => {
    const twice = (
      await learn("Clients MUST retry at most 3 times.\n\n## Again\n\nClients MUST retry at most 3 times.")
    ).records
    expect(twice.filter((record) => record.kind === "requirement")).toHaveLength(1)
    const distinct = (
      await learn("Clients MUST retry at most 3 times.\n\n## Again\n\nThe clients MUST retry, at most 3 times!")
    ).records
    expect(distinct.filter((record) => record.kind === "requirement").map((record) => record.key)).toEqual([
      "requirement|client retry time",
      "requirement|client retry time#2",
    ])
  })
})
