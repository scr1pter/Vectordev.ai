import { describe, expect, test } from "bun:test"
import type { CloudOverview } from "./cloud-api"
import {
  CLOUD_SECTIONS,
  cloudHref,
  deployRepairPrompt,
  parseCloudSection,
  publishPlan,
  publishRan,
  securityFixPrompt,
  supabaseLogsPrompt,
  uncommittedNote,
  vercelLogsPrompt,
} from "./cloud-handoff"

function overview(input: Partial<CloudOverview> = {}): CloudOverview {
  return {
    projectPath: "/work/shop",
    directory: "/work/shop",
    hosting: { provider: "Vercel", connected: false },
    database: { provider: "Supabase", accountConnected: false, connected: false },
    ...input,
  }
}

describe("cloud links", () => {
  test("open Vector Cloud at a project's section", () => {
    expect(cloudHref()).toBe("/cloud")
    expect(cloudHref("/work/my shop", "database")).toBe("/cloud?project=%2Fwork%2Fmy+shop&section=database")
    expect(new URLSearchParams(cloudHref("/work/my shop", "database").split("?")[1]).get("project")).toBe(
      "/work/my shop",
    )
  })

  test("open every Cloud screen a link names, including Database logs and Security", () => {
    for (const section of CLOUD_SECTIONS) {
      const search = new URLSearchParams(cloudHref("/work/shop", section).split("?")[1])
      expect(parseCloudSection(search.get("section"))).toBe(section)
    }
    expect(parseCloudSection("security")).toBe("security")
    expect(parseCloudSection("data-logs")).toBe("data-logs")
    expect(parseCloudSection("aws")).toBeUndefined()
    expect(parseCloudSection(null)).toBeUndefined()
  })
})

describe("deploy repair prompt", () => {
  test("carries the error, each failed check with the end of its output, and the next steps", () => {
    const output = Array.from({ length: 70 }, (_, index) => `line ${index + 1}`).join("\n")
    const prompt = deployRepairPrompt({
      project: "shop",
      environment: "preview",
      url: "https://shop-abc.vercel.app",
      error: "Required pre-deploy checks failed.",
      git: { branch: "main", commit: "abc1234", dirty: true },
      checks: [
        { label: "Install dependencies", status: "passed", output: "added 3 packages" },
        { label: "Production build", status: "failed", details: "Production build failed.", output },
      ],
      log: "the whole log",
    })
    expect(prompt).toStartWith("Fix the failing Vector Cloud deploy of shop (preview).")
    expect(prompt).toContain("Error: Required pre-deploy checks failed.")
    expect(prompt).toContain("Git: main at abc1234, with uncommitted changes")
    expect(prompt).toContain("Failed check, Production build: Production build failed.")
    expect(prompt).toContain("line 70")
    expect(prompt).toContain("line 31\n")
    expect(prompt).not.toContain("line 30\n")
    expect(prompt).not.toContain("added 3 packages")
    expect(prompt).not.toContain("the whole log")
    expect(prompt).toContain("publish a preview with vector_cloud publish")
    expect(prompt).toContain("Vector Cloud > Environment variables")
  })

  test("falls back to the end of the publish log when no check explains the failure", () => {
    const prompt = deployRepairPrompt({
      project: "shop",
      error: "Vercel exited with code 1.",
      checks: [],
      log: "Error: Project not found",
    })
    expect(prompt).toContain("Last lines of the publish log:\n```\nError: Project not found\n```")
  })

  test("sends the agent to a Vercel deployment's logs when the screen had none loaded", () => {
    const bare = deployRepairPrompt({
      project: "shop",
      url: "https://shop-x.vercel.app",
      deploymentId: "dpl_x",
      error: 'Vercel reported: Command "npm run build" exited with 1',
      checks: [],
    })
    expect(bare).toContain("Deployment: https://shop-x.vercel.app (dpl_x)")
    expect(bare).toContain("vector_cloud logs with deploymentId dpl_x")
    const loaded = deployRepairPrompt({
      project: "shop",
      deploymentId: "dpl_x",
      checks: [],
      log: "src/app.ts(3,1): error TS2304",
    })
    expect(loaded).toContain("error TS2304")
    expect(loaded).not.toContain("vector_cloud logs with deploymentId")
  })
})

describe("publish plan", () => {
  test("publishes to the linked Vercel project, or says what to set up", () => {
    const linked = { provider: "Vercel" as const, connected: true, account: "ana", project: { id: "p", name: "shop" } }
    const vercel = { id: "vercel" as const, label: "Vercel", loginHint: "", available: true }
    expect(publishPlan(linked, vercel)).toEqual({ ready: true, project: "shop", account: "ana" })
    expect(publishPlan({ provider: "Vercel", connected: true })).toEqual({
      ready: false,
      reason: "Link a Vercel project to this project in Vector Cloud > Connections.",
      connect: true,
    })
    expect(publishPlan(overview().hosting)).toEqual({
      ready: false,
      reason: "Connect Vercel in Vector Cloud > Connections.",
      connect: true,
    })
    // The agent publishes only through the connected account, so a machine
    // signed in with the Vercel CLI alone is not a second way in.
    expect(publishPlan(overview().hosting, { ...vercel, account: "cli-user" })).toMatchObject({
      ready: false,
      connect: true,
    })
    // What this machine lacks is fixed on the machine, not in Connections.
    const noNode = "Install Node.js from nodejs.org, then publish again."
    expect(publishPlan(linked, { ...vercel, available: false, loginHint: noNode })).toEqual({
      ready: false,
      reason: noNode,
      connect: false,
    })
  })
})

describe("uncommitted changes", () => {
  test("are named before a publish, with the commit the files differ from", () => {
    expect(uncommittedNote()).toBeUndefined()
    expect(uncommittedNote({ branch: "main", commit: "abc1234", dirty: false })).toBeUndefined()
    expect(uncommittedNote({ branch: "main", commit: "abc1234", dirty: true })).toBe(
      "This folder has uncommitted changes. It is built from the files as they are on disk, not from main at abc1234.",
    )
  })
})

describe("a failed publish", () => {
  test("offers a fix only once it reached its checks or the deploy", () => {
    expect(publishRan({ log: "", checks: [] })).toBe(false)
    expect(publishRan({ log: "  \n" })).toBe(false)
    expect(publishRan({ log: "Error: Project not found" })).toBe(true)
    expect(publishRan({ log: "", checks: [{ label: "Production build", status: "failed" }] })).toBe(true)
  })
})

describe("securityFixPrompt", () => {
  test("hands the agent every finding by name and asks for reviewed migrations, never a value", () => {
    const prompt = securityFixPrompt("shop-db", {
      environment: [{ where: "VITE_SUPABASE_SERVICE_KEY", reason: "is public but holds a secret key", level: "ERROR" }],
      bundle: [{ where: "dist/assets/index.js", reason: "ships a secret key", level: "ERROR" }],
      advisors: [
        {
          name: "rls_disabled_in_public",
          title: "RLS Disabled in Public",
          level: "ERROR",
          entity: "public.profiles",
          remediation: "https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public",
        },
        { name: "info_only", title: "Informational", level: "INFO" },
      ],
    })
    expect(prompt).toContain("Supabase project shop-db")
    expect(prompt).toContain("ERROR · the variable VITE_SUPABASE_SERVICE_KEY is public but holds a secret key")
    expect(prompt).toContain("ERROR · the built file dist/assets/index.js ships a secret key")
    expect(prompt).toContain("ERROR · RLS Disabled in Public · public.profiles")
    expect(prompt).not.toContain("Informational")
    expect(prompt).toContain("create_migration")
    expect(prompt).toContain("security_check again")
    expect(prompt).toContain("never print its value")
  })
})

describe("log diagnosis prompts", () => {
  test("point the agent at the logs the user read, by the arguments its log actions take", () => {
    const vercel = vercelLogsPrompt({ deploymentId: "dpl_live", source: "runtime", label: "serving production, ready" })
    expect(vercel).toContain("runtime logs of the Vercel deployment dpl_live (serving production, ready)")
    expect(vercel).toContain("vector_cloud logs (deploymentId dpl_live, source runtime)")
    expect(vercel).toContain("Do not publish to production unless I ask")
    expect(vercel).toContain("never ask me to paste its value")

    const supabase = supabaseLogsPrompt({
      project: "shop-db",
      service: "postgres",
      label: "Postgres",
      minutes: 360,
      search: "permission denied",
    })
    expect(supabase).toContain(
      'Postgres logs of the Supabase project shop-db from the last 360 minutes, filtered to "permission denied"',
    )
    expect(supabase).toContain('vector_cloud supabase_logs (service postgres, minutes 360, search "permission denied")')
    expect(supabase).toContain("create_migration")
    expect(supabaseLogsPrompt({ project: "shop-db", service: "api", label: "API", minutes: 60 })).not.toContain(
      "search",
    )
  })
})
