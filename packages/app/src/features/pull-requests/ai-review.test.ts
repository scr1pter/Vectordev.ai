import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff } from "@opencode-ai/core/review/diff"
import { reviewPermissionRules } from "@opencode-ai/core/review/permission"
import { buildFinalizePrompt } from "@opencode-ai/core/review/prompt"
import { REVIEW_REPORT_JSON_SCHEMA } from "@opencode-ai/core/review/schema"
import {
  buildDesktopSummary,
  checkoutLabel,
  chooseCheckout,
  costKindOf,
  countBySeverity,
  estimateText,
  FREE_MODEL,
  findingGroups,
  pickReviewModel,
  reviewCatalog,
  reviewEvents,
  runPullRequestReview,
  type ReviewClient,
  type ReviewEstimate,
  type ReviewMessage,
  type ReviewModel,
  type ReviewRunInput,
} from "./ai-review"

const BASE = "export function last(items: number[]) {\n  return items[items.length - 1]\n}\n"
const HEAD = "export function last(items: number[]) {\n  return items[items.length]\n}\n"

function fileDiff(path: string, lines: string[]) {
  return [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, ...lines]
}

const listDiff = fileDiff("src/list.ts", [
  "@@ -1,3 +1,3 @@",
  " export function last(items: number[]) {",
  "-  return items[items.length - 1]",
  "+  return items[items.length]",
  " }",
])
const lockDiff = fileDiff("bun.lock", ["@@ -1 +1 @@", "-a", "+b"])
const authDiff = fileDiff("src/auth/login.ts", [
  "@@ -1 +1 @@",
  "-export const retries = 1",
  "+export const retries = 3",
])
const configDiff = fileDiff(".vector/review.json", ["@@ -1 +1 @@", '-{"minConfidence":0.5}', '+{"minConfidence":0.99}'])
const join = (...parts: string[][]) => parts.flat().join("\n") + "\n"
const diff = join(listDiff, lockDiff)

const pr = {
  number: 7,
  title: "Fix last()",
  body: "Fixes the helper.",
  author: "alice",
  url: "https://github.com/o/r/pull/7",
  baseRefName: "main",
  headRefName: "fix-last",
  headRefOid: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
  baseRefOid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
}

const sonnet: ReviewModel = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
  context: 200_000,
  price: { input: 3, output: 15 },
  costKind: "priced",
}
const pickle: ReviewModel = { providerID: "opencode", modelID: "big-pickle", context: 200_000, costKind: "free" }

const offByOne = {
  path: "src/list.ts",
  line: 2,
  severity: "blocking",
  category: "bug",
  title: "last() reads past the end of the array",
  body: "`items[items.length]` is always undefined.",
  suggestion: "  return items[items.length - 1]",
  confidence: 0.95,
}

function report(findings: object[] = [offByOne]) {
  return {
    summary: "The helper now reads past the end of the array.",
    risk: "high",
    files: [{ path: "src/list.ts", note: "Off by one" }],
    findings,
  }
}

function answer(structured: unknown, cost = 0.01): ReviewMessage {
  return {
    info: {
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      cost,
      tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      structured,
    },
    parts: [],
  }
}

type CreateCall = Parameters<ReviewClient["session"]["create"]>[0]
type PromptCall = Parameters<ReviewClient["session"]["prompt"]>[0]
type UpdateCall = Parameters<ReviewClient["session"]["update"]>[0]

function fakeClient(
  options: {
    files?: Record<string, string>
    branch?: string
    reply?: (input: PromptCall) => ReviewMessage | undefined | Promise<ReviewMessage | undefined>
    onAbort?: () => void
  } = {},
) {
  const calls = {
    create: [] as CreateCall[],
    prompt: [] as PromptCall[],
    update: [] as UpdateCall[],
    abort: [] as string[],
  }
  const replies = new Map<string, ReviewMessage[]>()
  const client: ReviewClient = {
    session: {
      create: async (input) => {
        calls.create.push(input)
        return { data: { id: `ses_${calls.create.length}` } }
      },
      prompt: async (input) => {
        calls.prompt.push(input)
        const message = await (options.reply ?? (() => answer(report())))(input)
        if (message) replies.set(input.sessionID, [...(replies.get(input.sessionID) ?? []), message])
        return { data: message }
      },
      update: async (input) => {
        calls.update.push(input)
        return { data: true }
      },
      abort: async (input) => {
        calls.abort.push(input.sessionID)
        options.onAbort?.()
        return { data: true }
      },
      messages: async (input) => ({ data: replies.get(input.sessionID) ?? [] }),
    },
    // A missing file reads back empty, as the engine's file route does.
    file: { read: async ({ path }) => ({ data: { type: "text", content: options.files?.[path] ?? "" } }) },
    vcs: { get: async () => ({ data: { branch: options.branch } }) },
  }
  return { client, calls }
}

function run(client: ReviewClient, input: Partial<ReviewRunInput> = {}) {
  return runPullRequestReview(
    {
      directory: "/w/project",
      pr,
      diff,
      catalog: [sonnet, pickle],
      preferredModels: ["anthropic/claude-sonnet-4-5"],
      ...input,
    },
    client,
  )
}

describe("chooseCheckout", () => {
  const files = parseUnifiedDiff(join(listDiff))

  test("reviews in place when the checkout already is the pull request", async () => {
    const checkout = await chooseCheckout(files, async () => HEAD)
    expect(checkout).toEqual({ mode: "in-place", trust: "trusted", headFiles: [], fromDiff: [] })
    expect(checkoutLabel(checkout, { baseRef: "main" })).toBe("Reviewing your checkout")
  })

  test("rebuilds each file exactly from a base checkout", async () => {
    const checkout = await chooseCheckout(files, async () => BASE)
    expect(checkout.mode).toBe("rebuilt")
    expect(checkout.trust).toBe("untrusted")
    expect(checkout.headFiles).toEqual([{ path: "src/list.ts", text: HEAD, exact: true }])
    expect(checkout.fromDiff).toEqual([])
    expect(checkoutLabel(checkout, { branch: "main", baseRef: "main" })).not.toContain("from the diff only")
  })

  test("falls back to the hunks on another branch, and says so", async () => {
    const checkout = await chooseCheckout(files, async () => "export const other = 1\n")
    expect(checkout.headFiles).toHaveLength(1)
    expect(checkout.headFiles[0]!.exact).toBe(false)
    expect(checkout.headFiles[0]!.text).toContain("+  return items[items.length]")
    expect(checkout.fromDiff).toEqual(["src/list.ts"])
    expect(checkoutLabel(checkout, { branch: "feature-x", baseRef: "main" })).toBe(
      "Your checkout is on `feature-x`, not this pull request. Vector rebuilt the pull request's version of each changed file from its diff and reads other files from your checkout, which may differ from `main`. 1 file is reviewed from the diff only.",
    )
  })
})

describe("runPullRequestReview", () => {
  test("creates the session with the review rules and prompts the review agent with the schema", async () => {
    const { client, calls } = fakeClient({ files: { "src/list.ts": HEAD } })
    const outcome = await run(client)
    expect(calls.create).toEqual([
      { directory: "/w/project", title: "Vector review · #7 · review", permission: reviewPermissionRules({}) },
    ])
    // The reviewer can only read: nothing that edits, runs commands or starts other agents is allowed back.
    const allowed = calls.create[0]!.permission!.filter((rule) => rule.action === "allow").map(
      (rule) => rule.permission,
    )
    expect(allowed).not.toContain("bash")
    expect(allowed).not.toContain("edit")
    expect(allowed).not.toContain("task")
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0]).toMatchObject({
      sessionID: "ses_1",
      directory: "/w/project",
      agent: "review",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      format: { type: "json_schema", schema: REVIEW_REPORT_JSON_SCHEMA, retryCount: 0 },
    })
    expect(outcome?.checkout.mode).toBe("in-place")
    expect(outcome?.selection.inline.map((finding) => finding.title)).toEqual([offByOne.title])
    expect(outcome?.skipped).toEqual([{ path: "bun.lock", reason: "lockfile" }])
    expect(outcome?.cost).toMatchObject({ costUsd: 0.01, kind: "priced", model: "anthropic/claude-sonnet-4-5" })
  })

  test("places the rebuilt pull request files in the prompt when the checkout is elsewhere", async () => {
    const progress: string[] = []
    const { client, calls } = fakeClient({ files: { "src/list.ts": BASE }, branch: "main" })
    const outcome = await run(client, {
      onProgress: (event) => progress.push(event.type === "checkout" ? event.label : event.text),
    })
    expect(outcome?.checkout.trust).toBe("untrusted")
    const text = calls.prompt[0]!.parts![0]!.text
    expect(text).toContain('<untrusted_pr_file path="src/list.ts" exact="true">')
    expect(text).toContain("The working tree is the base branch.")
    expect(progress.some((line) => line.startsWith("Your checkout is on `main`"))).toBe(true)
  })

  test("runs the security reviewer too when a sensitive path changes, and sums the cost of both", async () => {
    const { client, calls } = fakeClient({ reply: () => answer(report(), 0.02) })
    const outcome = await run(client, { diff: join(listDiff, authDiff) })
    expect(calls.prompt.map((call) => call.agent).toSorted()).toEqual(["review", "security"])
    expect(outcome?.specialists.map((specialist) => specialist.status)).toEqual(["ok", "ok"])
    expect(outcome?.cost?.costUsd).toBeCloseTo(0.04)
    expect(outcome?.cost?.input).toBe(2_000)
  })

  test("falls back to a report in the reply's text", async () => {
    const { client, calls } = fakeClient({
      files: { "src/list.ts": HEAD },
      reply: () => ({
        info: { role: "assistant" },
        parts: [{ type: "text", text: "Here it is:\n```json\n" + JSON.stringify(report()) + "\n```" }],
      }),
    })
    const outcome = await run(client)
    expect(calls.prompt).toHaveLength(1)
    expect(outcome?.selection.inline).toHaveLength(1)
  })

  test("Stop aborts the session, then finalizes it with only StructuredOutput left", async () => {
    const controller = new AbortController()
    let release = (_message: ReviewMessage) => {}
    const { client, calls } = fakeClient({
      files: { "src/list.ts": HEAD },
      reply: (input) => {
        if (input.parts?.[0]?.text === buildFinalizePrompt()) return answer(report())
        queueMicrotask(() => controller.abort())
        return new Promise<ReviewMessage>((resolve) => {
          release = resolve
        })
      },
      onAbort: () => release({ info: { role: "assistant", error: { name: "MessageAbortedError" } }, parts: [] }),
    })
    const outcome = await run(client, { signal: controller.signal })
    expect(calls.abort).toEqual(["ses_1"])
    expect(calls.update[0]!.permission!.slice(-2)).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "StructuredOutput", pattern: "*", action: "allow" },
    ])
    expect(calls.prompt.at(-1)!.parts![0]!.text).toBe(buildFinalizePrompt())
    expect(outcome?.specialists[0]!.status).toBe("stopped")
    expect(outcome?.banners[0]).toContain("Partial review")
    expect(outcome?.selection.inline).toHaveLength(1)
  })

  test("the time cap stops and finalizes the same way", async () => {
    let release = (_message: ReviewMessage) => {}
    const { client, calls } = fakeClient({
      files: { "src/list.ts": HEAD },
      reply: (input) => {
        if (input.parts?.[0]?.text === buildFinalizePrompt()) return answer(report())
        return new Promise<ReviewMessage>((resolve) => {
          release = resolve
        })
      },
      onAbort: () => release({ info: { role: "assistant" }, parts: [] }),
    })
    const outcome = await run(client, { timeoutMs: 5 })
    expect(calls.abort).toEqual(["ses_1"])
    expect(outcome?.specialists[0]!.status).toBe("timeout")
  })

  test("shows the estimate before reviewing more than 50 files, and does nothing when declined", async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      [
        `diff --git a/src/f${index}.ts b/src/f${index}.ts`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/src/f${index}.ts`,
        "@@ -0,0 +1 @@",
        `+export const value${index} = ${index}`,
      ].join("\n"),
    )
    const estimates: ReviewEstimate[] = []
    const { client, calls } = fakeClient()
    const outcome = await run(client, {
      diff: many.join("\n") + "\n",
      confirm: async (estimate) => {
        estimates.push(estimate)
        return false
      },
    })
    expect(outcome).toBeUndefined()
    expect(calls.create).toEqual([])
    expect(estimates).toHaveLength(1)
    expect(estimates[0]).toMatchObject({ files: 51, model: "anthropic/claude-sonnet-4-5", costKind: "priced" })
    expect(estimates[0]!.low!).toBeLessThan(estimates[0]!.high!)
    expect(estimateText(estimates[0]!)).toStartWith(
      "This pull request changes 51 files. With anthropic/claude-sonnet-4-5 a review costs about $",
    )
  })

  test("reads review.json from the checkout, unless the pull request changes it", async () => {
    const strict = { "src/list.ts": HEAD, ".vector/review.json": '{"minConfidence":0.99}' }
    const checkout = await run(fakeClient({ files: strict }).client)
    expect(checkout?.selection.inline).toEqual([])
    expect(checkout?.selection.dropped).toEqual([{ reason: "low-confidence", count: 1 }])

    const changed = await run(fakeClient({ files: strict }).client, { diff: join(listDiff, configDiff) })
    expect(changed?.selection.inline).toHaveLength(1)
  })

  test("uses the model named in review.json first", async () => {
    const { client, calls } = fakeClient({
      files: { "src/list.ts": HEAD, ".vector/review.json": `{"model":"${FREE_MODEL}"}` },
    })
    await run(client)
    expect(calls.prompt[0]!.model).toEqual({ providerID: "opencode", modelID: "big-pickle" })
  })

  test("keeps a finding outside the diff only when the checkout has that file", async () => {
    const outside = { ...offByOne, severity: "concern", suggestion: undefined }
    const { client } = fakeClient({
      files: { "src/list.ts": HEAD, "src/api.ts": "export const api = 1\n" },
      reply: () =>
        answer(
          report([
            { ...outside, path: "src/ghost.ts", line: 3, title: "A file that does not exist" },
            { ...outside, path: "src/api.ts", line: 1, title: "The caller still expects the old value" },
          ]),
        ),
    })
    const outcome = await run(client)
    expect(outcome?.selection.outsideDiff.map((finding) => finding.path)).toEqual(["src/api.ts"])
    expect(outcome?.selection.dropped).toEqual([{ reason: "unknown-path", count: 1 }])
  })

  test("refuses a model with less than 32k tokens of context", async () => {
    const small = { ...sonnet, context: 16_000 }
    const { client, calls } = fakeClient({ files: { "src/list.ts": HEAD } })
    await expect(run(client, { catalog: [small] })).rejects.toThrow("at least 32k tokens of context")
    expect(calls.create).toEqual([])
  })
})

describe("models", () => {
  test("picks the first connected candidate", () => {
    expect(pickReviewModel(["missing/model", "anthropic/claude-sonnet-4-5", FREE_MODEL], [sonnet, pickle])).toBe(sonnet)
    expect(pickReviewModel([undefined, "missing/model", FREE_MODEL], [sonnet, pickle])).toBe(pickle)
    expect(pickReviewModel(["missing/model"], [sonnet])).toBeUndefined()
  })

  test("names the cost kind the way the summary words it", () => {
    expect(costKindOf({ id: "opencode" }, { input: 0, output: 0 })).toBe("free")
    expect(costKindOf({ id: "anthropic", source: "env" }, { input: 3, output: 15 })).toBe("priced")
    expect(costKindOf({ id: "openai", source: "api" }, { input: 0, output: 0 })).toBe("plan")
    expect(costKindOf({ id: "local", source: "config" }, { input: 0, output: 0 })).toBe("unknown")
    expect(
      reviewCatalog([
        {
          id: "anthropic",
          source: "env",
          models: {
            sonnet: {
              id: "claude-sonnet-4-5",
              cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } },
              limit: { context: 200_000 },
            },
          },
        },
      ]),
    ).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        context: 200_000,
        price: { input: 3, output: 15, cacheRead: 0.3 },
        costKind: "priced",
      },
    ])
  })

  test("words the estimate for a model included with Vector", () => {
    expect(estimateText({ files: 51, model: FREE_MODEL, costKind: "free" })).toBe(
      "This pull request changes 51 files. It runs on opencode/big-pickle, a model included with Vector.",
    )
  })
})

describe("showing and posting", () => {
  test("groups findings by severity, with each fix as a diff against the anchored code", async () => {
    // In its own file: a nit within 3 lines of the blocking finding would be deduped into it by location.
    const namesDiff = fileDiff("src/names.ts", ["@@ -1 +1 @@", "-export const i = 0", "+export const index = 0"])
    const nit = { ...offByOne, path: "src/names.ts", line: 1, severity: "nit", title: "Name it", suggestion: undefined }
    const { client } = fakeClient({
      files: { "src/list.ts": HEAD, "src/names.ts": "export const index = 0\n" },
      reply: () => answer(report([nit, offByOne])),
    })
    const outcome = (await run(client, { diff: join(listDiff, namesDiff) }))!
    const groups = findingGroups(outcome)
    expect(groups.map((group) => group.severity)).toEqual(["blocking", "nit"])
    expect(groups[0]!.findings[0]).toMatchObject({
      path: "src/list.ts",
      line: 2,
      place: "changed",
      fix: { removed: ["  return items[items.length]"], added: ["  return items[items.length - 1]"] },
    })
    expect(countBySeverity(groups)).toEqual({ blocking: 1, concern: 0, nit: 1 })
  })

  test("Approve is off while any blocking finding stands", async () => {
    const blocking = await run(fakeClient({ files: { "src/list.ts": HEAD } }).client)
    expect(reviewEvents(blocking!.selection)).toEqual({ comment: true, approve: false, "request-changes": true })

    const concern = { ...offByOne, severity: "concern" }
    const minor = await run(
      fakeClient({ files: { "src/list.ts": HEAD }, reply: () => answer(report([concern])) }).client,
    )
    expect(reviewEvents(minor!.selection).approve).toBe(true)
  })

  test("the posted summary has no state marker or commands, and shows the fix as a diff", async () => {
    const outcome = (await run(fakeClient({ files: { "src/list.ts": HEAD } }).client))!
    const body = buildDesktopSummary(outcome, pr.url)
    expect(body).toContain("## Vector review · Risk: High")
    expect(body).toContain("src/list.ts:2")
    expect(body).toContain("```diff\n+  return items[items.length - 1]")
    expect(body).not.toContain("vector-review:")
    expect(body).not.toContain("/vector")
  })

  test("a token the model read goes out redacted", async () => {
    const leaked = { ...offByOne, body: `Also, ghp_${"a".repeat(36)} is committed in the fixture.` }
    const client = fakeClient({ files: { "src/list.ts": HEAD }, reply: () => answer(report([leaked])) }).client
    const body = buildDesktopSummary((await run(client))!, pr.url)
    expect(body).not.toContain("ghp_")
    expect(body).toContain("[redacted]")
  })
})
