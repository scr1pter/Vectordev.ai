import { describe, expect, test } from "bun:test"
import { decide, knows, perceive } from "./policy"
import { FACTS, TASKS, fact, startOf, type FactID } from "./tasks"

// The scripted model may know a fact only from the request it answers. These build requests by hand: the same task
// with and without the fact somewhere in it, and with the fact only where the blind control deletes it.

const DIR = "/nonexistent/ledger"
const task = (id: string) => TASKS.find((item) => item.id === id)!
const start = (id: string) => startOf(TASKS.findIndex((item) => item.id === id)).files

function request(prompt: string, options: { recall?: string; system?: string; turns?: { name: string; input: Record<string, unknown>; result: string }[] } = {}) {
  const turns = options.turns ?? []
  return {
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: options.system ?? "You are Vector." }],
    tools: [{ name: "bash" }, { name: "read" }, { name: "edit" }, { name: "write" }, { name: "memory" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...(options.recall ? [{ type: "text", text: `<vector_memory_recall>\nMemory that may bear on this request:\n${options.recall}\n</vector_memory_recall>` }] : []),
        ],
      },
      ...turns.flatMap((turn, index) => [
        { role: "assistant", content: [{ type: "tool_use", id: `toolu_${index + 1}`, name: turn.name, input: turn.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${index + 1}`, content: turn.result }] },
      ]),
    ],
  }
}

// Plays a task to the first call that writes code, answering every earlier call with `result`.
function firstWrite(id: string, body: (turns: { name: string; input: Record<string, unknown>; result: string }[]) => Record<string, unknown>, blind = false) {
  const turns: { name: string; input: Record<string, unknown>; result: string }[] = []
  for (const _ of Array.from({ length: 20 })) {
    const call = decide(task(id), start(id), body(turns), { dir: DIR, blind })
    if (!("name" in call)) throw new Error("answered before writing")
    if (call.name === "write" || call.name === "edit") return call.input
    turns.push({ name: call.name, input: call.input, result: "ok" })
  }
  throw new Error("never wrote")
}

const CENTS = `- [m3k2a] decision: ${fact("cents").memory!.text}`

describe("the scripted model", () => {
  test("gets a fact right only when the request carries it", () => {
    const without = firstWrite("t07-order-discount", (turns) => request(task("t07-order-discount").prompt, { turns }))
    const recalled = firstWrite("t07-order-discount", (turns) => request(task("t07-order-discount").prompt, { recall: CENTS, turns }))
    expect(String(without.content)).toContain("order.amount * (1 - percent / 100)")
    expect(String(recalled.content)).toContain("Math.round")
  })

  test("cannot see what the blind control deletes", () => {
    const blind = firstWrite("t07-order-discount", (turns) => request(task("t07-order-discount").prompt, { recall: CENTS, turns }), true)
    expect(String(blind.content)).not.toContain("Math.round")
  })

  test("follows a document pointer on a read, and the blind control never sees one", () => {
    const pointer = "1: export {}\n\n<system-reminder>\nDocuments linked to src/invoice-pdf.ts: [rabcd12345678] constraint (Refunds are allowed for at most 14…).\n</system-reminder>"
    const body = request(task("t15-refund-deadline").prompt, {
      turns: [{ name: "read", input: { filePath: `${DIR}/src/invoice-pdf.ts` }, result: pointer }],
    })
    expect(decide(task("t15-refund-deadline"), start("t15-refund-deadline"), body, { dir: DIR })).toEqual({ name: "memory", input: { action: "get", id: "rabcd12345678" } })
    expect(decide(task("t15-refund-deadline"), start("t15-refund-deadline"), body, { dir: DIR, blind: true })).toEqual({
      name: "read",
      input: { filePath: `${DIR}/src/orders.ts` },
    })
  })

  test("reads a fact from a file it read, like any other part of the request", () => {
    const write = firstWrite("t07-order-discount", (turns) =>
      request(task("t07-order-discount").prompt, {
        turns: turns.map((turn) => (turn.name === "read" ? { ...turn, result: "// amounts are integer cents\nexport type Order = {}" } : turn)),
      }),
    )
    expect(String(write.content)).toContain("Math.round")
  })

  test("ignores its own tool calls: writing a fact itself does not teach it", () => {
    const body = request("Add a helper.", { turns: [{ name: "bash", input: { command: "echo integer cents pnpm" }, result: "" }] })
    const seen = perceive(body)
    for (const item of FACTS) expect(knows(seen, 1, item.id)).toBe(false)
  })

  test("sees no fact in a request that has only a later task's prompt", () => {
    for (const item of TASKS) {
      const seen = perceive(request(item.prompt))
      const taught = new Set<FactID>(item.teaches.flatMap((teach) => (teach.quote ? [teach.fact] : [])))
      for (const need of [...item.needs, ...(item.misleads ?? [])].filter((id) => !taught.has(id))) expect(knows(seen, 0, need)).toBe(false)
    }
  })

  test("knows the pnpm preference from the preference, not from a command that starts with pnpm", () => {
    const lessons = `- [m4r8tq] lesson: ${fact("routes").memory!.text}\n- [m7c2lk] lesson: ${fact("clock").memory!.text}`
    expect(knows(perceive(request("Add a helper.", { recall: lessons })), 0, "pnpm")).toBe(false)
    expect(knows(perceive(request("Add a helper.", { recall: `- [m9p1zz] preference: ${fact("pnpm").memory!.text}` })), 0, "pnpm")).toBe(true)
  })

  test("acts on a correction it is shown, and on the out-of-date fact when that is all it has", () => {
    const stale = "- [rtrc1w45jqejn] constraint · Refund policy p.1 §2: Refunds are allowed for at most 14 days after capture, as REFUND_WINDOW_DAYS sets."
    const correction = `- [mq3w8e] decision: ${fact("window21").memory!.text}`
    const reminder = (recall?: string) =>
      String(firstWrite("t18-refund-reminder", (turns) => request(task("t18-refund-reminder").prompt, { ...(recall ? { recall } : {}), turns })).content)
    expect(reminder(`${stale}\n${correction}`)).toContain("+ 19 * 86_400_000")
    expect(reminder(correction)).toContain("+ 19 * 86_400_000")
    expect(reminder(stale)).toContain("+ 12 * 86_400_000")
    expect(reminder()).toContain("+ 28 * 86_400_000")
  })

  test("is a pure function of the request: the same request gets the same call, with no files to read", () => {
    const body = request(task("t09-refunds-http").prompt, { turns: [{ name: "read", input: { filePath: `${DIR}/src/routes.ts` }, result: "x" }] })
    const first = decide(task("t09-refunds-http"), start("t09-refunds-http"), body, { dir: DIR })
    expect(decide(task("t09-refunds-http"), start("t09-refunds-http"), body, { dir: DIR })).toEqual(first)
  })

  test("refuses a conversation that left its script", () => {
    const body = request(task("t07-order-discount").prompt, { turns: [{ name: "bash", input: { command: "rm -rf /" }, result: "" }] })
    expect(() => decide(task("t07-order-discount"), start("t07-order-discount"), body, { dir: DIR })).toThrow("left the script")
  })

  test("saves what it learned only when Vector offers memory, and not what memory already brought", () => {
    const calls = (recall?: string, tools = true) => {
      const turns: { name: string; input: Record<string, unknown>; result: string }[] = []
      for (const _ of Array.from({ length: 20 })) {
        const body = request(task("t02-late-fee-cents").prompt, { recall, turns })
        if (!tools) body.tools = body.tools.filter((tool) => tool.name !== "memory")
        const call = decide(task("t02-late-fee-cents"), start("t02-late-fee-cents"), body, { dir: DIR })
        if (!("name" in call)) return turns
        turns.push({ name: call.name, input: call.input, result: "ok" })
      }
      return turns
    }
    expect(calls().filter((turn) => turn.name === "memory").map((turn) => turn.input.kind)).toEqual(["decision"])
    expect(calls(undefined, false).some((turn) => turn.name === "memory")).toBe(false)
    expect(calls(CENTS).some((turn) => turn.name === "memory")).toBe(false)
  })
})
