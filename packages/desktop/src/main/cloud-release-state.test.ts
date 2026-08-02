import { describe, expect, test } from "bun:test"

import type { CloudDeployment } from "./cloud-console"
import { transitionReleaseRecords } from "./cloud-release-state"

function release(id: string, status: CloudDeployment["releaseStatus"], target = "vercel"): CloudDeployment {
  return {
    id,
    slug: id,
    url: `https://${id}.example.com`,
    name: "Vector",
    projectPath: "/project",
    taskId: "task",
    target,
    createdAt: "2026-07-26T00:00:00.000Z",
    environment: status === "preview" ? "preview" : "production",
    releaseStatus: status,
    status: "ready",
    checks: [],
  }
}

describe("cloud release transitions", () => {
  test("promotes a preview and supersedes only the current release in the same scope", () => {
    const result = transitionReleaseRecords(
      [release("preview", "preview"), release("current", "current"), release("other-target", "current", "netlify")],
      "preview",
      { productionUrl: "https://vector.example.com", rollback: false, at: "now" },
    )
    expect(result.find((item) => item.id === "preview")).toMatchObject({
      releaseStatus: "current",
      environment: "production",
      productionUrl: "https://vector.example.com",
      promotedAt: "now",
    })
    expect(result.find((item) => item.id === "current")?.releaseStatus).toBe("superseded")
    expect(result.find((item) => item.id === "other-target")?.releaseStatus).toBe("current")
  })

  test("marks the displaced production release as rolled back", () => {
    const result = transitionReleaseRecords(
      [release("old", "superseded"), release("current", "current")],
      "old",
      { rollback: true, at: "now" },
    )
    expect(result.find((item) => item.id === "old")?.releaseStatus).toBe("current")
    expect(result.find((item) => item.id === "current")).toMatchObject({
      releaseStatus: "rolled-back",
      rolledBackAt: "now",
    })
  })
})
