import { describe, expect, test } from "bun:test"
import { actorScript, returnedTaskID } from "./footprint-actors"
import { createPromptCache, price } from "./prompt-cache"

const request = (text: string) => ({ messages: [{ role: "user", content: [{ type: "text", text }] }] })
const result = (id: string, text: string, failed = false) => ({
  messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: failed }] }],
})

describe("offline actor scripts", () => {
  test("routes concurrent children by their own brief even when they use identical tools", async () => {
    const script = actorScript({
      steps: [
        {
          kind: "delegate",
          actor: "a",
          agent: "explore",
          description: "Read A",
          prompt: "Read only A",
          background: true,
        },
        {
          kind: "delegate",
          actor: "b",
          agent: "explore",
          description: "Read B",
          prompt: "Read only B",
          background: true,
        },
        { kind: "answer", text: "parent" },
      ],
      actors: { a: [{ kind: "answer", text: "a" }], b: [{ kind: "answer", text: "b" }] },
    })
    const first = await script.next("parent", request("main"))
    expect(first.kind).toBe("delegate")
    expect(script.identify(request("Read only B"), {})).toBe("b")
    expect((await script.next("b", request("Read only B"))).kind).toBe("answer")
    expect((await script.next("a", request("Read only A"))).kind).toBe("answer")
    expect((await script.next("parent", request("main"))).kind).toBe("delegate")
    await script.next("parent", request("main"))
    expect(script.remaining()).toBe(0)
  })

  test("a quoted child brief later in parent history does not reclassify the parent", () => {
    const script = actorScript({
      steps: [{ kind: "delegate", actor: "a", agent: "explore", description: "A", prompt: "Read only A" }],
      actors: { a: [] },
    })
    expect(script.identify({ messages: [...request("main").messages, ...request("Read only A").messages] }, {})).toBe(
      "parent",
    )
  })

  test("observes task IDs and reports failed controls instead of accepting incomplete work", async () => {
    const script = actorScript({
      steps: [{ kind: "delegate", actor: "a", agent: "explore", description: "A", prompt: "Read only A" }],
      actors: { a: [{ kind: "answer", text: "done" }] },
    })
    const launch = await script.next("parent", request("main"))
    script.track("call-1", launch)
    script.observe(result("call-1", "task_id: ses_fixture"))
    expect(script.id("a")).toBe("ses_fixture")
    expect(script.remaining()).toBe(1)
    script.track("call-2", { kind: "manage", action: "stop", actor: "a" })
    script.observe(result("call-2", "No task found", true))
    expect(script.errors).toHaveLength(1)
  })

  test("gates synthetic in-flight responses on a real control receipt without polling", async () => {
    const script = actorScript({ steps: [], actors: { a: [] } })
    const order: string[] = []
    const pending = script.waitForControl("a", "message").then(() => order.push("delivered"))
    await Promise.resolve()
    expect(order).toEqual([])
    script.track("message-1", { kind: "manage", action: "message", actor: "a", text: "correction" })
    script.observe(result("message-1", "Message admitted"))
    await pending
    expect(order).toEqual(["delivered"])
  })

  test("requires dependency and steer evidence in the receiving child's actual request", async () => {
    const script = actorScript({ steps: [], actors: { a: [{ kind: "answer", text: "done", requires: "handoff" }] } })
    await script.next("a", request("no finding"))
    expect(script.errors).toEqual(["a did not receive required context: handoff"])
  })

  test("understands launch IDs from native runtime outputs", () => {
    expect(returnedTaskID("task_id: ses_abcd")).toBe("ses_abcd")
    expect(returnedTaskID("agentId: a90de42 (save this ID)")).toBe("a90de42")
    expect(returnedTaskID('{"sessionId":"ses_json"}')).toBe("ses_json")
    expect(returnedTaskID("<task-id>a123</task-id>")).toBe("a123")
    expect(returnedTaskID("No task was launched")).toBeUndefined()
  })

  test("prices identical toolsets as distinct actors when explicit routing is present", () => {
    const costs = price(
      ["parent", "a", "b"].map((actor) => ({
        actor,
        body: { tools: [{ name: "read" }], messages: request("fixture").messages },
        output: "done",
        sentBytes: 50,
      })),
      createPromptCache(),
      { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
    )
    expect(costs.map((cost) => cost.who)).toEqual(["agent", "subagent", "subagent"])
  })
})
