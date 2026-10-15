import { describe, expect, test } from "bun:test"

import {
  fallbackSwarmPlan,
  parseSwarmPlan,
  routeSwarmModels,
  selectSwarmPlannerModel,
  swarmModelPool,
} from "./swarm-plan"

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

  test("folds oversized plans in dependency order without losing instructions", () => {
    const plan = parseSwarmPlan(
      JSON.stringify({
        tasks: [
          { id: "build", prompt: "Implement the change", dependsOn: ["inspect"] },
          { id: "review", prompt: "Run all checks", dependsOn: ["build"] },
          { id: "inspect", prompt: "Inspect first", dependsOn: null },
        ],
      }),
      "Objective",
      2,
    )
    expect(plan.tasks).toHaveLength(2)
    expect(plan.tasks[0]?.id).toBe("inspect")
    expect(plan.tasks[0]?.dependsOn).toEqual([])
    expect(plan.tasks[1]?.dependsOn).toEqual(["inspect"])
    expect(plan.tasks[1]?.prompt).toContain("Implement the change")
    expect(plan.tasks[1]?.prompt).toContain("Run all checks")
    expect(plan.tasks[1]?.prompt.indexOf("Implement the change")).toBeLessThan(
      plan.tasks[1]!.prompt.indexOf("Run all checks"),
    )
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

  test("routes work to Vector Codium only in a swarm whose chosen model is a Codium model", () => {
    const connected = [
      { provider: "vector", model: "qwen/qwen3-coder:free" },
      { provider: "vector-plan", model: "xiaomi/mimo-v2.6-flash" },
      { provider: "vector-plan", model: "anthropic/claude-haiku-5.5" },
    ]
    const free = swarmModelPool({ provider: "vector", model: "qwen/qwen3-coder:free" }, connected)
    expect(free).toEqual([{ provider: "vector", model: "qwen/qwen3-coder:free" }])
    // Neither the planner nor any task can land on a model that spends credits the person did not choose to spend.
    expect(selectSwarmPlannerModel(free, "quality").provider).toBe("vector")
    expect(
      routeSwarmModels(fallbackSwarmPlan("Build the feature").tasks, free, "economy").map((task) => task.provider),
    ).not.toContain("vector-plan")

    const codium = swarmModelPool({ provider: "vector-plan", model: "deepseek/deepseek-v4.1-flash" }, connected)
    expect(codium.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "vector-plan/deepseek/deepseek-v4.1-flash",
      "vector/qwen/qwen3-coder:free",
      "vector-plan/xiaomi/mimo-v2.6-flash",
      "vector-plan/anthropic/claude-haiku-5.5",
    ])
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

  test("routes Gemini Pro as a strong model, not as a mini model", () => {
    const tasks = fallbackSwarmPlan("Build the feature").tasks
    const pool = [
      { provider: "google", model: "gemini-2.5-pro" },
      { provider: "google", model: "gemini-2.5-flash" },
      { provider: "openai", model: "gpt-4.1" },
    ]

    expect(selectSwarmPlannerModel(pool, "quality").model).toBe("gemini-2.5-pro")
    expect(routeSwarmModels(tasks, pool, "quality").every((task) => task.model === "gemini-2.5-pro")).toBe(true)
    expect(routeSwarmModels(tasks, pool, "economy").every((task) => task.model === "gemini-2.5-flash")).toBe(true)
    expect(
      routeSwarmModels(tasks, [{ provider: "openai", model: "o4-mini" }, ...pool], "economy").map((task) => task.model),
    ).not.toContain("gemini-2.5-pro")
  })
})
