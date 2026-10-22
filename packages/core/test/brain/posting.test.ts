import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrainPosting } from "@vectordevai/core/brain/posting"
import { BrainPrivate } from "@vectordevai/core/brain/private"
import { withKnowledge } from "./fixture/knowledge"

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

  test("finds a sentence split across two line comments, since the whole post is read as one text", () => {
    const result = check(["The handler looks right. Acme drops the Q3", "platform contract with Globex. The test is fine."])
    expect(result.dropped.map((item) => item.part)).toEqual([0, 1])
    expect(result.parts).toEqual(["The handler looks right.", "The test is fine."])
  })

  test("a rare token from a private fact is dropped unless the repository holds it", () => {
    const facts = ["Our billing host is pay.acme-internal.com and the account is 4417283"]
    const result = BrainPosting.check({
      parts: ["Retry against pay.acme-internal.com here. Use account 4417283 for tests. Use `Effect.fn` here."],
      typed: false,
      memory: { habits: [], facts },
      known: none,
    })
    expect(result.parts[0]).toBe("Use `Effect.fn` here.")
    const kept = BrainPosting.check({
      parts: ["Retry against pay.acme-internal.com here."],
      typed: false,
      memory: { habits: [], facts },
      known: new Set(["pay.acme-internal.com"]),
    })
    expect(kept.status).toBe("clean")
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

  test("reveal spells out what text hides", () => {
    expect(BrainPrivate.words("Ac​me&#32;drоps %51%33")).toEqual(["acme", "drops", "q3"])
  })
})

// The check against a real brain: MEMORY.md, personal facts, entries learned beside a private document, and the
// owner's preferences, with the repository asked about tokens.
describe("BrainPosting.run", () => {
  test("compares a post with MEMORY.md, personal facts and how the owner works", async () => {
    const result = await withKnowledge(({ brain, place, dir }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, "config"), { recursive: true })
          await fs.writeFile(path.join(dir, "config", "MEMORY.md"), "- My manager Dana Whitfield approves every release on Fridays\n")
        })
        for (const item of [
          { kind: "fact" as const, text: "The owner's partner company Initech pays invoices through account 99812345" },
          { kind: "preference" as const, text: "Write review comments as short questions instead of orders" },
        ])
          yield* brain.propose(place, { ...item, scope: "personal", origin: "user", evidence: { type: "user" } })
        const asked: string[][] = []
        const outcome = yield* BrainPosting.run(place, {
          parts: [
            "Release checklist updated.",
            "My manager Dana Whitfield approves every release on Fridays.",
            "Initech pays through 99812345.",
            "Write review comments as short questions instead of orders.",
          ],
          typed: false,
          sessionIDs: [],
          known: (tokens) => Effect.sync(() => (asked.push([...tokens]), new Set<string>())),
        })
        return { outcome, asked }
      }),
    )
    expect(result.outcome.parts).toEqual(["Release checklist updated.", "", "", ""])
    expect(result.outcome.dropped).toHaveLength(3)
    // Only tokens memory shares are asked about, never the whole post.
    expect(result.asked.flat()).toEqual(["99812345"])
  })
})
