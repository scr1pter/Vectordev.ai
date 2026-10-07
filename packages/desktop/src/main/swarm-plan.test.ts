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

  test("rejects a self dependency instead of scheduling it as ready", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({ tasks: [{ id: "inspect", dependsOn: ["inspect"] }, { id: "build" }] }),
        "Objective",
      ),
    ).toThrow("cyclic")
  })

  test("rejects unknown prerequisites instead of removing them", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({ tasks: [{ id: "inspect" }, { id: "build", dependsOn: ["missing"] }] }),
        "Objective",
      ),
    ).toThrow("unknown task: missing")
    expect(() =>
      parseSwarmPlan(JSON.stringify({ tasks: [{}, { id: "build", dependsOn: ["!!!"] }] }), "Objective"),
    ).toThrow("unknown task: !!!")
  })

  test("rejects an oversized graph without losing a prerequisite beyond the limit", () => {
    expect(() =>
      parseSwarmPlan(
        JSON.stringify({
          tasks: [{ id: "inspect" }, { id: "build", dependsOn: ["prepare"] }, { id: "prepare" }],
        }),
        "Objective",
        2,
      ),
    ).toThrow("more than the requested 2 tasks")
  })

  test("rejects malformed dependency lists and task entries", () => {
    for (const dependsOn of ["inspect", [null], [""]]) {
      expect(() =>
        parseSwarmPlan(JSON.stringify({ tasks: [{ id: "inspect" }, { id: "build", dependsOn }] }), "Objective"),
      ).toThrow("invalid dependency")
    }
    expect(() => parseSwarmPlan(JSON.stringify({ tasks: [{ id: "inspect" }, []] }), "Objective")).toThrow(
      "invalid task",
    )
  })

  test("normalizes task IDs without dropping valid deduplicated prerequisites", () => {
    const plan = parseSwarmPlan(
      JSON.stringify({
        tasks: [{ id: "Inspect Project" }, { id: "Build Feature", dependsOn: ["Inspect Project", "inspect-project"] }],
      }),
      "Objective",
    )
    expect(plan.tasks[1]?.dependsOn).toEqual(["inspect-project"])
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
})
