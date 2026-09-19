import { describe, expect, test } from "bun:test"
import { DEFAULT_MENTIONS, parseReviewCommand, type ReviewCommandKind } from "@opencode-ai/core/review/command"

const CORPUS: [string, ReviewCommandKind][] = [
  // section 2.4
  ["/vector review", "review"],
  ["/vector review full", "review-full"],
  ["/vector pause", "pause"],
  ["/vector resume", "resume"],
  ["/vector dismiss", "dismiss"],
  ["/vector review the auth code and fix it", "task"],
  ["/vector reviewer", "task"],
  ["LGTM\n/vector review", "review"],
  ["/vector review full please", "task"],
  ["no mention here", "none"],
  // section 11.1
  ["/VX Review Full", "review-full"],
  ["/vx review", "review"],
  ["> /vector review\nthanks", "none"],
  ["> /vector review\n/vector review full", "review-full"],
  ["```\n/vector review\n```", "none"],
  ["```sh\n/vector review\n```\n/vector pause", "pause"],
  ["~~~\n/vector review\n~~~", "none"],
  ["````\n```\n/vector review\n```\n````", "none"],
  ["/vector dismiss not an issue here", "dismiss"],
  ["/vector dismissal", "task"],
  // the task rule from before reviews
  ["please /vector fix the typo", "task"],
  ["/vector", "task"],
  ["/vector fix the failing test", "task"],
  ["/vectorx review", "task"],
  ["see a/vector for details", "none"],
  // whitespace and line endings
  ["   /vector review   ", "review"],
  ["/vector\treview", "review"],
  ["/vector   review    full", "review-full"],
  ["LGTM\r\n/vector review\r\n", "review"],
  ["/vector review\n/vector pause", "review"],
  ["", "none"],
  // trailing punctuation, invisible characters and HTML comments
  ["/vector review.", "review"],
  ["/vector review full!", "review-full"],
  ["/vector pause.", "pause"],
  ["/vector review\u200b", "review"],
  ["/vector review <!-- sent from mobile -->", "review"],
  ["<!-- /vector review -->", "none"],
  ["/vector review the auth code.", "task"],

  // Vecbot is the name now; the older mentions still work, because they are
  // written into workflows people already installed.
  ["/vecbot review", "review"],
  ["/vecbot review full", "review-full"],
  ["/vecbot pause", "pause"],
  ["/vecbot resume", "resume"],
  ["/vecbot fix the flaky auth test", "task"],
]

describe("parseReviewCommand", () => {
  test("parses the corpus with the default mentions", () => {
    expect(DEFAULT_MENTIONS).toEqual(["/vecbot", "/vector", "/vx"])
    for (const [body, kind] of CORPUS)
      expect([body, parseReviewCommand(body, DEFAULT_MENTIONS).kind]).toEqual([body, kind])
  })

  test("uses custom mentions", () => {
    const mentions = ["@vector-bot", "/Review-Bot", "/v+x"]
    expect(parseReviewCommand("@vector-bot review", mentions)).toEqual({ kind: "review" })
    expect(parseReviewCommand("/review-bot PAUSE", mentions)).toEqual({ kind: "pause" })
    expect(parseReviewCommand("/v+x review full", mentions)).toEqual({ kind: "review-full" })
    expect(parseReviewCommand("/vector review", mentions)).toEqual({ kind: "none" })
    expect(parseReviewCommand("/vector review", [])).toEqual({ kind: "none" })
    expect(parseReviewCommand("/vector review", [" ", ""])).toEqual({ kind: "none" })
  })

  test("is self-contained, so the route script can embed its source", () => {
    const source = parseReviewCommand.toString()
    expect(source).not.toMatch(/\bimport\b|\brequire\(/)
    const embedded = new Function(`return (${source})`)() as typeof parseReviewCommand
    for (const [body, kind] of CORPUS) expect([body, embedded(body, DEFAULT_MENTIONS).kind]).toEqual([body, kind])
  })
})
