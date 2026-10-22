import { describe, expect, test } from "bun:test"
import { ResearchCanonical } from "../../src/research/canonical"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

describe("ResearchCanonical.canonical", () => {
  test("lowercases the host and drops the fragment, a trailing dot and the default port", () => {
    expect(ResearchCanonical.canonical("HTTPS://Example.COM.:443/Path/Page#section-2")).toBe(
      "https://example.com/Path/Page",
    )
    expect(ResearchCanonical.canonical("http://example.com:80/")).toBe("http://example.com/")
    expect(ResearchCanonical.canonical("http://example.com:8080/a")).toBe("http://example.com:8080/a")
  })

  test("drops tracking parameters and sorts the rest of the query", () => {
    expect(
      ResearchCanonical.canonical(
        "https://example.com/a?utm_source=x&b=2&utm_campaign=y&fbclid=1&gclid=2&mc_cid=3&mc_eid=4&ref=feed&a=1",
      ),
    ).toBe("https://example.com/a?a=1&b=2")
    expect(ResearchCanonical.canonical("https://example.com/a?UTM_Medium=x&msclkid=1")).toBe("https://example.com/a")
    // Keys that only start like a tracking tag stay.
    expect(ResearchCanonical.canonical("https://example.com/a?reference=7&refresh=1")).toBe(
      "https://example.com/a?reference=7&refresh=1",
    )
  })

  test("gives one spelling for the same page found twice", () => {
    const found = [
      "https://example.com/report?b=2&a=1#top",
      "https://EXAMPLE.com/report?a=1&b=2&utm_source=news",
      "https://example.com./report?a=1&b=2",
    ].map(ResearchCanonical.canonical)
    expect(new Set(found)).toEqual(new Set(["https://example.com/report?a=1&b=2"]))
  })

  test("refuses anything but http and https, and addresses with credentials", () => {
    expect(ResearchCanonical.canonical("ftp://example.com/file")).toBeUndefined()
    expect(ResearchCanonical.canonical("javascript:alert(1)")).toBeUndefined()
    expect(ResearchCanonical.canonical("file:///etc/passwd")).toBeUndefined()
    expect(ResearchCanonical.canonical("https://user:secret@example.com/")).toBeUndefined()
    expect(ResearchCanonical.canonical("not a url")).toBeUndefined()
  })
})

describe("ResearchCanonical.follow", () => {
  test("follows a page's rel=canonical on the same site, resolved against the page", () => {
    expect(ResearchCanonical.follow("https://www.example.com/a?print=1", "/a")).toBe("https://www.example.com/a")
    expect(ResearchCanonical.follow("https://m.example.com/a", "https://www.example.com/a?utm_source=x")).toBe(
      "https://www.example.com/a",
    )
  })

  test("ignores one that names another site, so a page cannot claim to be another site's", () => {
    expect(ResearchCanonical.follow("https://blog.example.com/post", "https://news.example.org/post")).toBe(
      "https://blog.example.com/post",
    )
    // Two blogs on one hosting suffix are two sites.
    expect(ResearchCanonical.follow("https://alice.github.io/post", "https://bob.github.io/post")).toBe(
      "https://alice.github.io/post",
    )
  })

  test("keeps the page's own form when the canonical is missing or unreadable", () => {
    expect(ResearchCanonical.follow("https://example.com/a#x", undefined)).toBe("https://example.com/a")
    expect(ResearchCanonical.follow("https://example.com/a", "javascript:void(0)")).toBe("https://example.com/a")
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
