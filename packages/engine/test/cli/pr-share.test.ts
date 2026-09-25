import { describe, expect, test } from "bun:test"
import { publicSessionLinks } from "../../src/cli/cmd/pr"

const url = "https://vectordev.ai/s/0123456789abcdef0123456789abcdef"

describe("PR linked session extraction", () => {
  test("finds complete owned links in Markdown and plain text, without duplicate imports", () => {
    expect(publicSessionLinks(`[Session](${url})\n<${url}>\nHistory: ${url}.`)).toEqual([url])
  })

  test("never fetches a lookalike prefix, alternative origin, credentials, or query URL", () => {
    for (const value of [
      url.replace("https:", "http:"),
      url.replace("vectordev.ai", "vectordev.ai.evil.invalid"),
      url.replace("vectordev.ai", "user:password@vectordev.ai"),
      url.replace("vectordev.ai", "vectordev.ai:443"),
      `${url}?secret=private`,
      `${url}#fragment`,
      `${url}/extra`,
      `https://evil.invalid/${url}`,
      url.replace("/s/", "/api/shares/"),
      url.replace("0123456789abcdef0123456789abcdef", "../private"),
    ])
      expect(publicSessionLinks(`[Link](${value})`)).toEqual([])
  })

  test("retains distinct valid candidates so the caller can ask for an explicit choice", () => {
    const second = url.replace("0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210")
    expect(publicSessionLinks(`${url}\n${second}`)).toEqual([url, second])
  })
})
