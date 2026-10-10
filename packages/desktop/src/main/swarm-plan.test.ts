import { describe, expect, test } from "bun:test"

import { fallbackSwarmPlan, parseSwarmPlan, routeSwarmModels } from "./swarm-plan"

describe("swarm plan", () => {
  test("parses a fenced dependency graph", () => {
    const plan = parseSwarmPlan(
      `\`\`\`json
      {"summary":"Ship safely","tasks":[
        {"id":"inspect","title":"Inspect","prompt":"Map files","role":"explore","dependsOn":[],"modelTier":"fast"},
        {"id":"build","title":"Build","prompt":"Implement","role":"implement","dependsOn":["inspect"],"modelTier":"strong"}
      ]}
      \`\`\``,
      "Build the feature",
    )

    expect(plan.summary).toBe("Ship safely")
    expect(plan.tasks[1]?.dependsOn).toEqual(["inspect"])
    expect(plan.tasks[1]?.role).toBe("implement")
  })

  test("rejects cyclic plans", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({
          tasks: [
            { id: "a", prompt: "A", dependsOn: ["b"] },
            { id: "b", prompt: "B", dependsOn: ["a"] },
          ],
        }),
        "Objective",
      ),
    ).toThrow("cyclic")
  })

  test("rejects self dependencies instead of silently launching the task", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({ tasks: [{ id: "inspect" }, { id: "build", dependsOn: ["build"] }] }),
        "Objective",
      ),
    ).toThrow("cyclic")
  })

  test("rejects missing dependencies instead of turning them into parallel work", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({ tasks: [{ id: "inspect" }, { id: "build", dependsOn: ["missing"] }] }),
        "Objective",
      ),
    ).toThrow("unknown task missing")
  })

  test("rejects oversized plans without dropping required tasks", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({
          tasks: [{ id: "build", dependsOn: ["inspect"] }, { id: "review" }, { id: "inspect" }],
        }),
        "Objective",
        2,
      ),
    ).toThrow("2-task limit")
  })

  test.each([{ dependsOn: "inspect" }, { dependsOn: [null] }, { dependsOn: [1] }, { dependsOn: [""] }])(
    "rejects malformed dependency lists: %j",
    (input) => {
      expect(() =>
        parseSwarmPlan(
          JSON.stringify({ tasks: [{ id: "inspect" }, { id: "build", dependsOn: input.dependsOn }] }),
          "Objective",
        ),
      ).toThrow("invalid dependency")
    },
  )

  test("rejects invalid tasks without silently changing the graph", () => {
    expect(() =>
      parseSwarmPlan(JSON.stringify({ tasks: [{ id: "inspect" }, null, { id: "build" }] }), "Objective"),
    ).toThrow("invalid task")
  })

  test("normalizes dependency IDs and deduplicates repeated edges", () => {
    const plan = parseSwarmPlan(
      JSON.stringify({
        tasks: [{ id: "Map Project" }, { id: "Build", dependsOn: [" Map Project ", "map-project"] }],
      }),
      "Objective",
    )
    expect(plan.tasks[1]?.dependsOn).toEqual(["map-project"])
  })

  test("fallback review waits for validation repairs", () => {
    const plan = fallbackSwarmPlan("Build the feature")
    expect(plan.tasks.find((task) => task.id === "review-result")?.dependsOn).toEqual(["validate-result"])
    expect(plan.tasks.find((task) => task.id === "review-result")?.prompt).toContain("Do not edit files")
    expect(fallbackSwarmPlan("Build the feature", Number.NaN).tasks).toHaveLength(4)
  })

  test("routes strong tasks to strong models and balances equal candidates", () => {
    const tasks = fallbackSwarmPlan("Build the feature").tasks
    const routed = routeSwarmModels(
      tasks,
      [
        { provider: "anthropic", model: "claude-opus" },
        { provider: "google", model: "gemini-flash" },
      ],
      "balanced",
    )

    expect(routed.find((task) => task.id === "map-project")?.model).toBe("gemini-flash")
    expect(routed.find((task) => task.id === "implement-objective")?.model).toBe("claude-opus")
  })

  test("keeps every task the planner returns, past the old cap of 32", () => {
    const tasks = Array.from({ length: 40 }, (_, index) => ({
      id: `t${index}`,
      prompt: `Task ${index}`,
      dependsOn: [],
    }))
    expect(parseSwarmPlan(JSON.stringify({ tasks }), "Objective", 40).tasks).toHaveLength(40)
  })

  test("routes economy work to a fast variant within a strong model family", () => {
    const routed = routeSwarmModels(
      fallbackSwarmPlan("Build the feature").tasks,
      [
        { provider: "openai", model: "gpt-5" },
        { provider: "openai", model: "gpt-5-mini" },
      ],
      "economy",
    )
    expect(routed.every((task) => task.model === "gpt-5-mini")).toBe(true)
  })
})
