import { describe, expect, test } from "bun:test"
import { ResearchDomain } from "../../src/research/domain"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

describe("ResearchDomain.site", () => {
  test("is the registrable domain (eTLD+1) from the public suffix list", () => {
    expect(ResearchDomain.site("https://www.bbc.co.uk/news/1")).toBe("bbc.co.uk")
    expect(ResearchDomain.site("https://news.bbc.co.uk/2")).toBe("bbc.co.uk")
    expect(ResearchDomain.site("https://ncbi.nlm.nih.gov/pmc/")).toBe("nih.gov")
    expect(ResearchDomain.site("docs.example.com")).toBe("example.com")
    expect(ResearchDomain.site("WWW.Example.COM.")).toBe("example.com")
  })

  test("counts private suffixes, so two blogs on one host are two sites", () => {
    expect(ResearchDomain.site("https://alice.github.io/post")).toBe("alice.github.io")
    expect(ResearchDomain.site("https://bob.blogspot.com/")).toBe("bob.blogspot.com")
  })

  test("keeps an address, or a name the list does not know, as its own site", () => {
    expect(ResearchDomain.site("http://192.0.2.10:8080/a")).toBe("192.0.2.10")
    expect(ResearchDomain.site("http://[2001:db8::1]/a")).toBe("2001:db8::1")
    expect(ResearchDomain.site("http://localhost:3000/")).toBe("localhost")
  })
})

describe("ResearchDomain.independent", () => {
  test("counts different sites, not different pages or hosts", () => {
    expect(
      ResearchDomain.independent([
        "https://www.bbc.co.uk/a",
        "https://news.bbc.co.uk/b",
        "https://alice.github.io/c",
        "https://bob.github.io/d",
        "https://www.nature.com/articles/1",
      ]),
    ).toBe(4)
    expect(ResearchDomain.independent([])).toBe(0)
  })
})

describe("ResearchDomain.under", () => {
  test("is true for the domain and hosts under it, and for a *. form", () => {
    expect(ResearchDomain.under("docs.example.com", "example.com")).toBe(true)
    expect(ResearchDomain.under("example.com", "example.com")).toBe(true)
    expect(ResearchDomain.under("https://a.b.example.com/x", "*.example.com")).toBe(true)
    expect(ResearchDomain.under("badexample.com", "example.com")).toBe(false)
    expect(ResearchDomain.under("example.com.evil.test", "example.com")).toBe(false)
    expect(ResearchDomain.under("example.com", "")).toBe(false)
  })
})

describe("ResearchDomain.kind", () => {
  test("names academic, government, standards, reference and forum sites by name and suffix", () => {
    expect(ResearchDomain.kind("https://arxiv.org/abs/2401.00001")).toBe("academic")
    expect(ResearchDomain.kind("https://www.nature.com/articles/x")).toBe("academic")
    expect(ResearchDomain.kind("https://cs.stanford.edu/")).toBe("academic")
    expect(ResearchDomain.kind("https://www.ox.ac.uk/")).toBe("academic")
    expect(ResearchDomain.kind("https://www.energy.gov/")).toBe("government")
    expect(ResearchDomain.kind("https://www.gov.uk/guidance")).toBe("government")
    expect(ResearchDomain.kind("https://www.service.gov.uk/")).toBe("government")
    expect(ResearchDomain.kind("https://www.economie.gouv.fr/")).toBe("government")
    expect(ResearchDomain.kind("https://pubmed.ncbi.nlm.nih.gov/123456/")).toBe("government")
    expect(ResearchDomain.kind("https://www.rfc-editor.org/rfc/rfc9309")).toBe("standards")
    expect(ResearchDomain.kind("https://en.wikipedia.org/wiki/Heat_pump")).toBe("reference")
    expect(ResearchDomain.kind("https://news.ycombinator.com/item?id=1")).toBe("forum")
    expect(ResearchDomain.kind("https://www.example.com/")).toBe("other")
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
