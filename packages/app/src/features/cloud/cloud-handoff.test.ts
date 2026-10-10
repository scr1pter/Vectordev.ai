import { describe, expect, test } from "bun:test"
import type { CloudOverview } from "./cloud-api"
import {
  cloudHref,
  cloudStatus,
  deployRepairPrompt,
  onComposerPrompt,
  publishPlan,
  requestComposerPrompt,
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
})

describe("composer prompts", () => {
  test("go to exactly one composer and report whether one took them", () => {
    expect(requestComposerPrompt({ text: "nobody listening", send: true })).toBe(false)
    const first: ComposerPrompt[] = []
    const second: ComposerPrompt[] = []
    const stopFirst = onComposerPrompt((request) => first.push(request))
    const stopSecond = onComposerPrompt((request) => second.push(request))
    expect(requestComposerPrompt({ text: "Fix the deploy", send: true })).toBe(true)
    expect(first).toEqual([{ text: "Fix the deploy", send: true }])
    expect(second).toEqual([])
    stopFirst()
    stopSecond()
    expect(requestComposerPrompt({ text: "after", send: false })).toBe(false)
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
})

describe("publish plan", () => {
  test("publishes to the linked Vercel project, or says what to set up", () => {
    expect(
      publishPlan(
        overview({
          hosting: { provider: "Vercel", connected: true, account: "ana", project: { id: "p", name: "shop" } },
        }),
      ),
    ).toEqual({ ready: true, project: "shop", account: "ana", via: "connection" })
    expect(publishPlan(overview({ hosting: { provider: "Vercel", connected: true } }))).toEqual({
      ready: false,
      reason: "Link a Vercel project to this project in Vector Cloud > Connections.",
    })
    expect(
      publishPlan(overview(), { id: "vercel", label: "Vercel", loginHint: "", available: true, account: "cli-user" }),
    ).toMatchObject({ ready: true, via: "cli", account: "cli-user" })
    expect(publishPlan(overview())).toEqual({
      ready: false,
      reason: "Connect Vercel in Vector Cloud > Connections with an access token.",
    })
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
