import { describe, expect, test } from "bun:test"
import { ResearchProvenance } from "../../src/research/provenance"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

describe("ResearchProvenance", () => {
  test("accepts search results, page links and the user's typed addresses, by their canonical form", () => {
    const set = ResearchProvenance.add(
      ResearchProvenance.add(
        ResearchProvenance.add(ResearchProvenance.empty(), ["https://example.com/result?b=2&a=1&utm_source=x"], "search"),
        ["https://example.org/linked#part"],
        "link",
      ),
      ResearchProvenance.typed("Please read www.example.net/paper."),
      "typed",
    )
    expect(ResearchProvenance.check(set, "https://EXAMPLE.com/result?a=1&b=2")).toEqual({
      ok: true,
      canonical: "https://example.com/result?a=1&b=2",
      from: "search",
    })
    expect(ResearchProvenance.check(set, "https://example.org/linked")).toMatchObject({ ok: true, from: "link" })
    expect(ResearchProvenance.check(set, "https://www.example.net/paper")).toMatchObject({ ok: true, from: "typed" })
  })

  test("refuses an address the agent wrote itself", () => {
    const set = ResearchProvenance.add(ResearchProvenance.empty(), ["https://example.com/result"], "search")
    expect(ResearchProvenance.check(set, "https://example.com/result?q=private-text")).toEqual({
      ok: false,
      message: ResearchProvenance.REFUSAL,
    })
    expect(ResearchProvenance.check(set, "https://evil.example/collect")).toMatchObject({ ok: false })
    expect(ResearchProvenance.check(set, "file:///etc/passwd")).toMatchObject({ ok: false })
  })

  test("keeps an address the user typed as typed when a search finds it too", () => {
    const typed = ResearchProvenance.add(ResearchProvenance.empty(), ["https://example.com/a"], "typed")
    const searched = ResearchProvenance.add(typed, ["https://example.com/a"], "search")
    expect(ResearchProvenance.check(searched, "https://example.com/a")).toMatchObject({ ok: true, from: "typed" })
  })

  test("finds the http and https addresses in the user's text, without trailing punctuation", () => {
    expect(
      ResearchProvenance.typed(
        "Compare https://example.com/a?x=1, (https://example.org/b) and www.example.net. Not ftp://example.com/c.",
      ),
    ).toEqual(["https://example.com/a?x=1", "https://example.org/b", "https://www.example.net"])
  })
})

describe("ResearchProvenance.dataLike and offered", () => {
  test("drops links whose query is over 64 characters, or that carry encoded data or credentials", () => {
    const links = [
      { url: "https://example.com/articles/heat-pumps-in-cold-climates", text: "ok" },
      { url: "https://example.com/search?q=heat+pumps&page=2", text: "ok" },
      { url: "https://example.com/commit/3f786850e387550fdab836ed7e6dc881de23001b", text: "hash" },
      { url: "https://example.com/item/123e4567-e89b-12d3-a456-426614174000", text: "uuid" },
      { url: `https://example.com/a?${"x=1&".repeat(20)}`, text: "long query" },
      { url: "https://evil.example/c?d=c2VjcmV0cyBnbyBoZXJlIGFuZCBoZXJl", text: "base64 value" },
      { url: "https://evil.example/QUtJQUlPU0ZPRE5ON0VYQU1QTEVhYmNk/x", text: "base64 path" },
      { url: "https://user:pw@example.com/", text: "credentials" },
      { url: "mailto:someone@example.com", text: "mail" },
    ]
    expect(ResearchProvenance.offered(links).map((link) => link.text)).toEqual(["ok", "ok", "hash", "uuid"])
  })

  test("leaves ordinary slugs and file names alone", () => {
    expect(ResearchProvenance.dataLike("https://example.com/2026/03/how-heat-pumps-cut-bills.html")).toBe(false)
    expect(ResearchProvenance.dataLike("https://arxiv.org/pdf/2401.01234v2")).toBe(false)
    expect(ResearchProvenance.dataLike("https://example.com/Annual_Report_2025_Final.pdf")).toBe(false)
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
