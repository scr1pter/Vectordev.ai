import { describe, expect, test } from "bun:test"
import type { Part } from "@vectordevai/sdk/v2"
import {
  KNOWLEDGE,
  LINKS,
  PERSONAL,
  RECALL,
  UNVERIFIED,
  chipTitle,
  cites,
  delivered,
  locator,
  reason,
  recallOf,
  segments,
  used,
  type KnowledgeCard,
} from "./knowledge-citations"

const record = "r7f2qa9k3m4xz"
const second = "r2b9xk4m7q1aa"
const passage = "p8w3k2m5n6q7r"
const document = "d4h7k2m9q"
const entry = "m3k2a7"
const failure = "f9q2abc"
const base = { sessionID: "ses_1", messageID: "msg_1" }

function recallPart(input: {
  ids: string[]
  cards?: string[]
  personal?: string[]
  tokens?: number
  why?: Record<string, string>
  text?: string
}) {
  return {
    ...base,
    id: "prt_recall",
    type: "text",
    text: input.text ?? "",
    synthetic: true,
    metadata: {
      [RECALL]: {
        ids: input.ids,
        tokens: input.tokens ?? 0,
        personal: input.personal ?? [],
        ...(input.cards ? { cards: input.cards, why: input.why ?? {} } : {}),
      },
    },
  } as Part
}

function memoryTool(input: { output: string; metadata: Record<string, unknown>; status?: "completed" | "error" }) {
  return {
    ...base,
    id: `prt_tool_${Math.random()}`,
    type: "tool",
    callID: "call_1",
    tool: "memory",
    state:
      input.status === "error"
        ? { status: "error", input: {}, error: "failed", time: { start: 0, end: 1 } }
        : {
            status: "completed",
            input: {},
            output: input.output,
            title: "Memory",
            metadata: input.metadata,
            time: { start: 0, end: 1 },
          },
  } as Part
}

describe("knowledge citations", () => {
  test("a delivered id is solid, an undelivered id is plain and unverified, an unknown prefix is ignored", () => {
    const text = `Retry at most 3 times [${record}]. Uploads are capped [r0000000000zz]. See [x7f2qa9k3m4xz] and [demand].`
    expect(segments(text, new Set([record]))).toEqual([
      { type: "text", text: "Retry at most 3 times " },
      { type: "citation", id: record, verified: true },
      { type: "text", text: ". Uploads are capped " },
      { type: "citation", id: "r0000000000zz", verified: false },
      { type: "text", text: ". See [x7f2qa9k3m4xz] and [demand]." },
    ])
    expect(cites(text)).toBe(true)
    expect(cites("See [x7f2qa9k3m4xz], [demand], [default] and [r123].")).toBe(false)
    expect(segments("No citations.", new Set())).toEqual([{ type: "text", text: "No citations." }])
  })

  test("knows every id shape the brain writes, and only those", () => {
    for (const id of [record, passage, document, entry, failure, "m0123456789abc"]) expect(cites(`[${id}]`)).toBe(true)
    // Wrong lengths, letters outside the alphabet, upper case.
    for (const id of ["r7f2qa", "m3k2", "d4h7k2m9qq", "r7f2qa9k3m4xu", "R7F2QA9K3M4XZ", "m3k2abc"])
      expect(cites(`[${id}]`)).toBe(false)
  })

  test("collects what recall, attachments and memory tool calls gave the model", () => {
    const parts = [
      recallPart({ ids: [entry, record], cards: [record], personal: ["m9z8y7"] }),
      {
        ...base,
        id: "prt_kept",
        type: "text",
        text: "",
        synthetic: true,
        metadata: { [KNOWLEDGE]: { part: "prt_file", document } },
      } as Part,
      memoryTool({
        output: `[${failure}] lesson: run the tests one file at a time\n[${second}] (document)`,
        metadata: { action: "search", [KNOWLEDGE]: { cards: [second] }, [PERSONAL]: ["m7w6v5"] },
      }),
      memoryTool({
        output: `[${passage}] (document)`,
        metadata: { action: "get", id: passage, [KNOWLEDGE]: { get: [{ id: passage, budget: 600 }] } },
      }),
      // A failed call gave the model nothing.
      memoryTool({ output: "", metadata: {}, status: "error" }),
    ]
    expect([...delivered(parts)].toSorted()).toEqual(
      [entry, record, "m9z8y7", document, failure, second, "m7w6v5", passage].toSorted(),
    )
  })

  test("counts what a read pointed at and what an edit's spec guard named", () => {
    const tool = (name: string, metadata: Record<string, unknown>) =>
      ({
        ...base,
        id: `prt_${name}`,
        type: "tool",
        callID: `call_${name}`,
        tool: name,
        state: { status: "completed", input: {}, output: "", title: name, metadata, time: { start: 0, end: 1 } },
      }) as Part
    const parts = [
      tool("read", { loaded: [`knowledge:${record}`], [LINKS]: [{ mode: "pointer", file: "src/a.ts", ids: [record] }] }),
      tool("edit", { [LINKS]: [{ mode: "guard", file: "src/a.ts", ids: [second] }] }),
      tool("apply_patch", { [LINKS]: [{ mode: "guard", file: "src/b.ts", ids: ["not-an-id"] }] }),
      // Another tool's metadata gave the model none of it.
      tool("bash", { [LINKS]: [{ mode: "guard", file: "src/c.ts", ids: [passage] }] }),
    ]
    expect([...delivered(parts)].toSorted()).toEqual([record, second].toSorted())
  })

  test("ignores knowledge metadata a user could type on a part that is not synthetic", () => {
    const typed = {
      ...base,
      id: "prt_typed",
      type: "text",
      text: "hi",
      metadata: { [KNOWLEDGE]: { cards: [record] } },
    } as Part
    expect(delivered([typed]).has(record)).toBe(false)
  })

  test("reads the recall part, with the kinds of its saved lines", () => {
    const part = recallPart({
      ids: [entry, record],
      cards: [record],
      tokens: 214,
      why: { [record]: "terms:retry,429", [entry]: "path" },
      text: `<vector_memory_recall>\nMemory that may bear on this request:\n- [${entry}] lesson (packages/engine/test): Run engine tests one file at a time.\n</vector_memory_recall>`,
    })
    expect(recallOf(part)).toEqual({
      ids: [entry, record],
      cards: [record],
      personal: [],
      tokens: 214,
      why: { [record]: "terms:retry,429", [entry]: "path" },
      kinds: { [entry]: "lesson" },
    })
    expect(recallOf({ ...base, id: "x", type: "text", text: "plain" } as Part)).toBeUndefined()
  })

  test("sums up the turn's memory, grouped by document, with a reason for each", () => {
    const resolved = new Map<string, KnowledgeCard>([
      [
        record,
        {
          id: record,
          kind: "requirement",
          title: "API spec",
          page: 14,
          text: "Clients must wait Retry-After seconds.",
        },
      ],
      [second, { id: second, kind: "contract", title: "API spec", page: 22, text: "GET /v1/users/{id}" }],
      [
        passage,
        { id: passage, kind: "passage", title: "SLA", section: "2 Availability > 2.1 Targets", text: "99.9% monthly." },
      ],
    ])
    const recall = recallOf(
      recallPart({
        ids: [entry, record, second, passage],
        cards: [record, second, passage],
        tokens: 214,
        why: {
          [record]: "terms:retry,429",
          [second]: "anchor:src/api/users.ts:definition",
          [passage]: "meaning",
          [entry]: "path",
        },
        text: `- [${entry}] lesson: Run engine tests one file at a time.`,
      }),
    )!
    const summary = used(recall, resolved)!
    expect(summary.summary).toBe("3 document cards (API spec p.14, p.22; SLA §2.1), 1 lesson · 214 tokens")
    expect(summary.items).toEqual([
      { id: entry, label: "Lesson", reason: "It is about a file the request names." },
      {
        id: record,
        label: "Requirement · API spec p.14",
        text: "Clients must wait Retry-After seconds.",
        reason: "It shares words with the request: retry, 429.",
      },
      {
        id: second,
        label: "Contract · API spec p.22",
        text: "GET /v1/users/{id}",
        reason: "It is linked to src/api/users.ts, which the request touches.",
      },
      {
        id: passage,
        label: "Passage · SLA §2.1",
        text: "99.9% monthly.",
        reason: "It is close in meaning to the request.",
      },
    ])
    // Without the owner's engine (a guest), the footer still counts what was used.
    expect(
      used(
        recallOf(recallPart({ ids: [record, "m9z8y7"], cards: [record], personal: ["m9z8y7"], tokens: 40 }))!,
        new Map(),
      )?.summary,
    ).toBe("1 document card, 1 thing about you · 40 tokens")
    expect(used(recallOf(recallPart({ ids: [] }))!, new Map())).toBeUndefined()
  })

  test("words hover text, places and reasons", () => {
    expect(
      chipTitle(record, { id: record, kind: "question", title: "API spec", page: 3, text: "TBD: rate limits." }),
    ).toBe("Open question · API spec p.3\nTBD: rate limits.")
    expect(chipTitle(record, undefined)).toBe(`${record}: given to the model in this session`)
    expect(locator({ section: "Runbook > Limits and quotas for uploads" })).toBe("§Limits and quotas for u…")
    expect(locator({ section: "Retries" })).toBe("§Retries")
    expect(locator({})).toBe("")
    expect(reason(undefined)).toBe("Vector found it relevant to the request.")
    expect(reason("terms:")).toBe("It shares words with the request.")
    expect(UNVERIFIED.toLowerCase()).not.toContain("project")
  })
})
