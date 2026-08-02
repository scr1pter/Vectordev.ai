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
})
