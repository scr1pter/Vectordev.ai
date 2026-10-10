import { describe, expect, test } from "bun:test"
import type { CloudDeployment } from "../cloud-api"
import type { VercelDeployment } from "./vercel-api"
import {
  deploymentActions,
  groupRemoteEnv,
  matchRelease,
  publishOutcome,
  settingsPatch,
  suggestedProjectName,
  vercelFramework,
} from "./vercel-model"

function deployment(input: Partial<VercelDeployment> & { id: string }): VercelDeployment {
  return {
    url: `https://${input.id}.vercel.app`,
    name: "shop",
    state: "READY",
    target: "production",
    createdAt: "2026-10-01T00:00:00.000Z",
    current: false,
    aliases: [],
    ...input,
  }
}

describe("Vercel deployment actions", () => {
  const current = deployment({ id: "live", current: true, createdAt: "2026-10-05T00:00:00.000Z" })

  test("a running build can only be canceled, a failed one only rebuilt", () => {
    expect(deploymentActions(deployment({ id: "b", state: "BUILDING" }), current)).toEqual(["cancel"])
    expect(deploymentActions(deployment({ id: "e", state: "ERROR" }), current)).toEqual(["redeploy"])
  })

  test("a later production build is promoted, an earlier one is rolled back to", () => {
    expect(deploymentActions(deployment({ id: "new", createdAt: "2026-10-06T00:00:00.000Z" }), current)).toEqual([
      "redeploy",
      "promote",
    ])
    expect(deploymentActions(deployment({ id: "old", createdAt: "2026-10-04T00:00:00.000Z" }), current)).toEqual([
      "redeploy",
      "rollback",
    ])
    expect(deploymentActions(current, current)).toEqual(["redeploy"])
  })

  test("a preview, or a release whose required checks failed, never moves production", () => {
    expect(deploymentActions(deployment({ id: "p", target: "preview" }), current)).toEqual(["redeploy"])
    const failed = { checks: [{ required: true, status: "failed" }] } as Pick<CloudDeployment, "checks">
    expect(deploymentActions(deployment({ id: "new", createdAt: "2026-10-06T00:00:00.000Z" }), current, failed)).toEqual([
      "redeploy",
    ])
  })

  test("finds Vector's own evidence for a Vercel deployment by id or address", () => {
    const releases = [
      { id: "r1", providerDeploymentId: "dpl_a", url: "https://a.vercel.app/" },
      { id: "r2", url: "https://b.vercel.app/" },
    ] as CloudDeployment[]
    expect(matchRelease(deployment({ id: "dpl_a", url: "https://other.vercel.app" }), releases)?.id).toBe("r1")
    expect(matchRelease(deployment({ id: "dpl_b", url: "https://b.vercel.app" }), releases)?.id).toBe("r2")
    expect(matchRelease(deployment({ id: "dpl_c" }), releases)).toBeUndefined()
  })
})

describe("Vercel project helpers", () => {
  test("suggests a valid project name from the folder", () => {
    expect(suggestedProjectName("/Users/me/My Shop App")).toBe("my-shop-app")
    expect(suggestedProjectName("C:\\code\\__site__")).toBe("site")
    expect(suggestedProjectName("/")).toBe("app")
  })

  test("maps detected frameworks to Vercel's identifiers", () => {
    expect(vercelFramework("Next.js")).toBe("nextjs")
    expect(vercelFramework("Static")).toBe("")
  })

  test("groups remote variables by name", () => {
    const grouped = groupRemoteEnv([
      { id: "2", key: "B", type: "encrypted", targets: ["preview"], syncedByVector: false },
      { id: "1", key: "A", type: "encrypted", targets: ["production"], syncedByVector: true },
      { id: "3", key: "B", type: "encrypted", targets: ["production"], syncedByVector: false },
    ])
    expect(grouped.map((group) => [group.key, group.entries.map((entry) => entry.id)])).toEqual([
      ["A", ["1"]],
      ["B", ["2", "3"]],
    ])
  })
})

describe("Vercel project settings", () => {
  const settings = {
    framework: "vite",
    rootDirectory: null,
    buildCommand: "bun run build",
    outputDirectory: null,
    installCommand: null,
    nodeVersion: "22.x",
  }
  const draft = {
    framework: "vite",
    rootDirectory: "",
    buildCommand: "bun run build",
    outputDirectory: "",
    installCommand: "",
    nodeVersion: "22.x",
  }

  test("sends only the fields the user changed", () => {
    expect(settingsPatch(settings, draft)).toEqual({})
    expect(settingsPatch(settings, { ...draft, rootDirectory: " apps/web ", nodeVersion: "24.x" })).toEqual({
      rootDirectory: "apps/web",
      nodeVersion: "24.x",
    })
  })

  test("an emptied command goes back to automatic, an empty Node.js version is never sent", () => {
    expect(settingsPatch(settings, { ...draft, buildCommand: "  " })).toEqual({ buildCommand: "" })
    expect(settingsPatch(settings, { ...draft, nodeVersion: "" })).toEqual({})
  })
})

describe("publish outcome", () => {
  test("a preview says production did not change, production says it moved", () => {
    expect(
      publishOutcome({ ok: true, target: "vercel", log: "", url: "https://shop-abc.vercel.app", environment: "preview" }),
    ).toEqual({ tone: "success", text: "Preview live at https://shop-abc.vercel.app. Production did not change." })
    expect(
      publishOutcome({ ok: true, target: "vercel", log: "", url: "https://shop.com", environment: "production" }).text,
    ).toBe("Production release live at https://shop.com.")
  })

  test("names the workspace and explains Deployment Protection", () => {
    const outcome = publishOutcome(
      {
        ok: true,
        target: "vercel",
        log: "",
        url: "https://shop-git-agent-fix-acme.vercel.app",
        environment: "preview",
        protectedChecks: "skipped",
      },
      "Fix cart",
    )
    expect(outcome.text).toContain("Preview of Fix cart live at https://shop-git-agent-fix-acme.vercel.app.")
    expect(outcome.text).toContain("let them through in Project settings")
  })

  test("a failure carries the desktop's own reason", () => {
    expect(
      publishOutcome({ ok: false, target: "vercel", log: "", error: "Vercel rejected the stored token." }),
    ).toEqual({ tone: "error", text: "Vercel rejected the stored token." })
    expect(publishOutcome({ ok: true, target: "vercel", log: "" }).tone).toBe("error")
  })
})
