import { describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import type { Prompt } from "@/context/prompt"
import { taskPartLocations, type TaskAgent } from "./subagent-model"
import { appendTaskQuestion, mergeTaskBoard, taskCost, taskSpend } from "./task-board-model"

function observation(input: Partial<Task.Info> = {}): Task.Info {
  return {
    id: "task_a",
    sessionID: "ses_a",
    parentSessionID: "ses_root",
    source: "subagent",
    title: "Inspect routing",
    status: "running",
    startedAt: 100,
    elapsedMs: 25,
    ownedPaths: ["src/router"],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
    ...input,
  }
}

function agent(input: Partial<TaskAgent> = {}): TaskAgent {
  return {
    key: "a",
    sessionID: "ses_a",
    agent: "explore",
    kind: "specialist",
    custom: false,
    label: "Explore",
    title: "Inspect routing",
    status: "running",
    background: true,
    ...input,
  }
}

describe("task board observations", () => {
  test("groups tasks by batch and keeps dependencies and current activity", () => {
    const cards = mergeTaskBoard(
      [],
      [
        observation({ batchID: "batch_1", currentStep: "Reading src/router" }),
        observation({ id: "task_b", sessionID: "ses_b", batchID: "batch_1", status: "queued", dependsOn: ["task_a"] }),
      ],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]!.kindLabel).toBe("Subagent batch")
    expect(cards[0]!.agents[0]!.currentStep).toBe("Reading src/router")
    expect(cards[0]!.agents[1]!.dependsOn).toEqual(["task_a"])
    expect(cards[0]!.agents[1]!.status).toBe("pending")
  })

  test("refreshes status without duplicating the child or losing chip references", () => {
    const prior = mergeTaskBoard([], [observation()])
    prior[0]!.agents[0]!.partID = "part_launch"
    const next = mergeTaskBoard(prior, [observation({ status: "completed", completedAt: 200, resultAvailable: true })])
    expect(next).toHaveLength(1)
    expect(next[0]!.agents).toHaveLength(1)
    expect(next[0]!.status).toBe("done")
    expect(taskPartLocations(next).get("part_launch")?.agent.task?.resultAvailable).toBe(true)
  })

  test("teams and swarms stay separate, and stopped dependencies are terminal", () => {
    const cards = mergeTaskBoard(
      [],
      [
        observation({ source: "team", groupID: "team_a" }),
        observation({
          id: "task_b",
          sessionID: "ses_b",
          source: "swarm",
          groupID: "swarm_a",
          status: "stopped",
          reason: "Dependency failed",
        }),
      ],
    )
    expect(cards.map((card) => card.kindLabel)).toEqual(["Team", "Swarm"])
    expect(cards[1]!.live).toBe(false)
  })
})

describe("task costs", () => {
  test("counts the newest cumulative child usage only once", () => {
    const agents = [agent({ startedAt: 10, cost: 0.5, tokens: 100 }), agent({ startedAt: 20, cost: 0.75, tokens: 150 })]
    expect(taskSpend(agents)).toEqual({ cost: 0.75, tokens: 150, unknown: false })
    expect(taskCost(agents)).toBe("$0.75")
  })

  test("unknown external usage is never displayed as free", () => {
    expect(taskCost([agent()])).toBe("Cost unknown")
    expect(taskCost([agent({ cost: 0, unpricedSteps: 1 })])).toBe("Cost unknown")
    expect(taskCost([agent({ cost: 0.04, unpricedSteps: 1 })])).toBe("$0.04 + unpriced usage")
  })
})

test("Ask Vector appends a task question while preserving the existing draft and attachments", () => {
  const prompt: Prompt = [
    { type: "text", content: "Keep this draft", start: 0, end: 15 },
    { type: "image", id: "image_1", filename: "plan.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
  ]
  const next = appendTaskQuestion(prompt, agent())
  expect(next.slice(0, 2)).toEqual(prompt)
  expect(prompt).toHaveLength(2)
  expect(next[2]).toMatchObject({ type: "text", start: 15 })
  expect(next[2]!.type === "text" && next[2]!.content).toContain("task ses_a")
})
