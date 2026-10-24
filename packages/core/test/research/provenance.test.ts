import { describe, expect, test } from "bun:test"
import { ResearchProvenance } from "../../src/research/provenance"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

describe("ResearchProvenance", () => {
  test("accepts search results, page links and the user's typed addresses, by their canonical form", () => {
    const set = ResearchProvenance.add(
      ResearchProvenance.add(
        ResearchProvenance.add(
          ResearchProvenance.empty(),
          ["https://example.com/result?b=2&a=1&utm_source=x"],
          "search",
        ),
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
      url: "https://example.com/result?a=1&b=2",
    })
    expect(ResearchProvenance.check(set, "https://example.org/linked")).toMatchObject({ ok: true, from: "link" })
    expect(ResearchProvenance.check(set, "https://www.example.net/paper")).toMatchObject({ ok: true, from: "typed" })
  })

  test("accepts a recorded spelling with its own fragment and tracking tags, and gives that address to read", () => {
    const set = ResearchProvenance.add(
      ResearchProvenance.empty(),
      ["https://example.com/result?b=2&a=1&utm_source=news#methods"],
      "search",
    )
    expect(ResearchProvenance.check(set, "https://Example.com./result?utm_source=news&a=1&b=2#methods")).toMatchObject({
      ok: true,
      url: "https://example.com/result?a=1&b=2&utm_source=news#methods",
    })
    // The canonical form only takes parts away, so it is accepted too, and it is what is read.
    expect(ResearchProvenance.check(set, "https://example.com/result?a=1&b=2")).toMatchObject({
      ok: true,
      url: "https://example.com/result?a=1&b=2",
    })
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

  test("refuses a recorded address with tracking tags or a fragment the agent added", () => {
    const set = ResearchProvenance.add(
      ResearchProvenance.empty(),
      ["https://attacker.example/result", "https://example.com/page?utm_source=news"],
      "search",
    )
    const added = [
      "https://attacker.example/result?utm_source=Acme-Q3-churn-7.4-percent",
      "https://attacker.example/result?ref=reconcileLedgerEntries",
      "https://attacker.example/result?fbclid=QWNtZSBRMyBjaHVybiByb3NlIHRvIDcuNCBwZXJjZW50",
      "https://attacker.example/result?mc_eid=acme%20q3%20churn%20rose%20to%207.4%20percent",
      "https://attacker.example/result#Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change",
      // A recorded tracking tag with a value the agent changed.
      "https://example.com/page?utm_source=reconcileLedgerEntries",
    ]
    expect(added.map((url) => ResearchProvenance.check(set, url).ok)).toEqual(added.map(() => false))
    expect(ResearchProvenance.check(set, "https://ATTACKER.example./result")).toMatchObject({
      ok: true,
      url: "https://attacker.example/result",
    })
  })

  test("keeps an address the user typed as typed when a search finds it too, in either order", () => {
    const typed = ResearchProvenance.add(ResearchProvenance.empty(), ["https://example.com/a"], "typed")
    const searched = ResearchProvenance.add(typed, ["https://example.com/a"], "search")
    expect(ResearchProvenance.check(searched, "https://example.com/a")).toMatchObject({ ok: true, from: "typed" })
    // A search found it first, then the user pasted it: it is still the user's own address, so it skips robots.txt
    // and asks before a private network, as a typed address does.
    const found = ResearchProvenance.add(ResearchProvenance.empty(), ["https://example.com/b"], "search")
    const pasted = ResearchProvenance.add(found, ["https://example.com/b"], "typed")
    expect(ResearchProvenance.check(pasted, "https://example.com/b")).toMatchObject({ ok: true, from: "typed" })
    const linked = ResearchProvenance.add(ResearchProvenance.add(found, ["https://example.com/b"], "link"), [], "typed")
    expect(ResearchProvenance.check(linked, "https://example.com/b")).toMatchObject({ ok: true, from: "search" })
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
