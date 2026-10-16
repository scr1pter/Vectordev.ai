import { describe, expect, test } from "bun:test"
import type { CloudOverview } from "./cloud-api"
import {
  CLOUD_SECTIONS,
  cloudHref,
  cloudStatus,
  composerTakes,
  DATABASE_SETUP_PROMPT,
  deployRepairPrompt,
  holdsHandoff,
  onComposerPrompt,
  parseCloudSection,
  promoteFailed,
  publishPlan,
  publishRan,
  requestComposerPrompt,
  securityFixPrompt,
  supabaseLogsPrompt,
  uncommittedNote,
  vercelLogsPrompt,
  type ComposerPrompt,
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

const release = {
  id: "dep_1",
  url: "https://shop-abc.vercel.app/",
  environment: "preview" as const,
  releaseStatus: "preview" as const,
  status: "ready" as const,
  createdAt: "2026-10-10T10:00:00.000Z",
  failedChecks: [],
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

describe("composer prompts", () => {
  test("go to exactly one composer and report whether one took them", () => {
    expect(requestComposerPrompt({ text: "nobody listening", send: true })).toBe(false)
    const first: ComposerPrompt[] = []
    const second: ComposerPrompt[] = []
    const stopFirst = onComposerPrompt((request) => first.push(request) > 0)
    const stopSecond = onComposerPrompt((request) => second.push(request) > 0)
    expect(requestComposerPrompt({ text: "Fix the deploy", send: true })).toBe(true)
    expect(first).toEqual([{ text: "Fix the deploy", send: true }])
    expect(second).toEqual([])
    stopFirst()
    stopSecond()
    expect(requestComposerPrompt({ text: "after", send: false })).toBe(false)
  })

  test("a composer that declines (it holds an unsent draft) leaves the request to the next, or to the caller", () => {
    const taken: string[] = []
    const stopBusy = onComposerPrompt(() => false)
    expect(requestComposerPrompt({ text: "Set up the database", send: true })).toBe(false)
    const stopFree = onComposerPrompt((request) => taken.push(request.text) > 0)
    expect(requestComposerPrompt({ text: "Set up the database", send: true })).toBe(true)
    expect(taken).toEqual(["Set up the database"])
    stopBusy()
    stopFree()
  })
})

describe("composer handoff", () => {
  test("a composer takes a prompt only when it is empty and its session shows a message box", () => {
    expect(composerTakes({ dirty: false, context: [], open: true })).toBe(true)
    // A selection added to context stays across sends, so it is not a draft.
    expect(composerTakes({ dirty: false, context: [{}, { comment: "  " }], open: true })).toBe(true)
    expect(composerTakes({ dirty: true, context: [], open: true })).toBe(false)
    // A line comment is sent and cleared with the next message, so it is unsent work.
    expect(composerTakes({ dirty: false, context: [{ comment: "rename this" }], open: true })).toBe(false)
    // A subagent session, or one waiting on a permission or a question, has no message box.
    expect(composerTakes({ dirty: false, context: [], open: false })).toBe(false)
  })

  test("a handed-over prompt is sent only while the composer still holds exactly it", () => {
    const text = "Fix the deploy"
    const part = (content: string) => ({ type: "text", content, start: 0, end: content.length })
    expect(holdsHandoff([part(text)], text)).toBe(true)
    // An empty composer is never sent: a submit there stops a running turn.
    expect(holdsHandoff([part("")], text)).toBe(false)
    expect(holdsHandoff([part("")], "")).toBe(false)
    expect(holdsHandoff([part(`${text} and also this`)], text)).toBe(false)
    expect(holdsHandoff([part(text), { type: "image" }], text)).toBe(false)
  })
})

describe("database setup prompt", () => {
  test("creates or links the database through the agent, after the user chooses", () => {
    expect(DATABASE_SETUP_PROMPT).toContain("find it with supabase_projects and link it with link_database")
    expect(DATABASE_SETUP_PROMPT).toContain("Vector Cloud > Database")
    expect(DATABASE_SETUP_PROMPT).toContain("If I choose a new one, run create_database")
    expect(DATABASE_SETUP_PROMPT).not.toContain("or create a new one, then run create_database")
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

describe("a failed promote", () => {
  test("keeps the live preview and its link, and lets Promote run again", () => {
    const done = {
      phase: "done" as const,
      url: "https://shop-abc.vercel.app/",
      deploymentId: "dep_1",
      promote: "working" as const,
    }
    const log = new Error("Vercel CLI 39.0.0\nRetrieving project…\n  Error: You do not have permission to promote.  \n")
    expect(promoteFailed(done, log)).toEqual({
      phase: "done",
      url: "https://shop-abc.vercel.app/",
      deploymentId: "dep_1",
      promote: undefined,
      promoteError: "Error: You do not have permission to promote.",
    })
    expect(promoteFailed(done, new Error("")).promoteError).toBe("Vercel did not promote the preview.")
    expect(promoteFailed(done, "offline").promoteError).toBe("Vercel did not promote the preview.")
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

describe("cloud status", () => {
  test("names the state that most needs attention", () => {
    expect(cloudStatus()).toEqual({ tone: "idle", label: "Checking Vector Cloud" })
    expect(cloudStatus(overview())).toEqual({ tone: "idle", label: "Not published yet" })
    expect(cloudStatus(overview({ hosting: { provider: "Vercel", connected: true } }))).toMatchObject({
      tone: "warning",
    })
    expect(cloudStatus(overview({ latest: release }))).toEqual({ tone: "success", label: "Preview published" })
    const live = { ...release, environment: "production" as const, releaseStatus: "current" as const }
    expect(cloudStatus(overview({ latest: live, production: live }))).toEqual({
      tone: "success",
      label: "Live in production",
    })
    expect(cloudStatus(overview({ latest: live, production: { ...live, status: "unreachable" } }))).toMatchObject({
      tone: "error",
    })
    expect(cloudStatus(overview({ latest: { ...release, failedChecks: [{ label: "Browser smoke test" }] } }))).toEqual({
      tone: "error",
      label: "Latest release failed its checks",
    })
    const failure = { at: "2026-10-10T11:00:00.000Z", environment: "preview" as const, error: "failed", checks: [] }
    expect(cloudStatus(overview({ latest: release, failure }))).toEqual({ tone: "error", label: "Last publish failed" })
    // A release published after the failure is the newer state.
    expect(cloudStatus(overview({ latest: release, failure: { ...failure, at: "2026-10-10T09:00:00.000Z" } }))).toEqual(
      { tone: "success", label: "Preview published" },
    )
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
