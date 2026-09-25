// The route job's script, taken from the generated workflow and run with fake `github`, `context` and `core` objects,
// the way actions/github-script runs it.

import { describe, expect, test } from "bun:test"
import { parseReviewCommand } from "@vectordevai/core/review/command"
import { buildWorkflowYaml } from "../../src/cli/cmd/github.workflow"

type Script = (github: unknown, context: unknown, core: unknown) => Promise<void>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => Script

const MENTIONS = ["/vector", "/vx"]
const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const MERGE_BASE = "c".repeat(40)

function script(app = false): string {
  const yaml = buildWorkflowYaml({
    provider: "openai",
    model: "gpt-4.1",
    keys: [],
    autoReview: true,
    version: "1.17.14",
    ...(app ? { auth: "auto" as const } : {}),
  })
  const workflow = Bun.YAML.parse(yaml) as { jobs: { route: { steps: { with: { script: string } }[] } } }
  return workflow.jobs.route.steps[0]!.with.script
}

interface Options {
  app?: boolean
  permission?: string
  role?: string
  permissionStatus?: number
  fork?: boolean
  compareStatus?: number
  removeStatus?: number
}

function fakeGithub(options: Options = {}) {
  const calls: { method: string; args: Record<string, unknown> }[] = []
  const fails = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
  const record =
    (method: string, answer: (args: Record<string, unknown>) => unknown = () => ({ data: {} })) =>
    async (args: Record<string, unknown>) => {
      calls.push({ method, args })
      return answer(args)
    }
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: record("permission", () => {
          if (options.permissionStatus) throw fails(options.permissionStatus)
          const permission = options.permission ?? "write"
          return { data: { permission, role_name: options.role ?? permission } }
        }),
        compareCommitsWithBasehead: record("compare", () => {
          if (options.compareStatus) throw fails(options.compareStatus)
          return { data: { status: "ahead", merge_base_commit: { sha: MERGE_BASE } } }
        }),
      },
      pulls: {
        get: record("pulls.get", (args) => ({
          data: {
            number: args["pull_number"],
            head: { sha: HEAD, repo: { full_name: options.fork ? "someone/r" : "o/r", id: options.fork ? 2 : 1 } },
            base: { sha: BASE, repo: { full_name: "o/r", id: 1 } },
          },
        })),
      },
      reactions: {
        createForIssueComment: record("react.issue"),
        createForPullRequestReviewComment: record("react.review"),
      },
      issues: {
        addLabels: record("labels.add"),
        removeLabel: record("labels.remove", () => {
          if (options.removeStatus) throw fails(options.removeStatus)
          return { data: [] }
        }),
      },
    },
  }
  return { github, calls }
}

async function route(context: object, options: Options = {}) {
  const { github, calls } = fakeGithub(options)
  const outputs: Record<string, string> = {}
  const core = {
    setOutput: (name: string, value: string) => {
      outputs[name] = value
    },
    info: () => {},
    warning: () => {},
    setFailed: (message: string) => {
      outputs["failed"] = message
    },
  }
  await new AsyncFunction("github", "context", "core", script(options.app))(
    github,
    { repo: { owner: "o", repo: "r" }, ...context },
    core,
  )
  return { outputs, calls }
}

function issueComment(body: string, options: { pr?: boolean; type?: string } = {}) {
  return {
    eventName: "issue_comment",
    payload: {
      issue: { number: 7, ...(options.pr === false ? {} : { pull_request: {} }) },
      comment: { id: 11, body, user: { login: "alice", type: options.type ?? "User" } },
    },
  }
}

function reviewComment(body: string) {
  return {
    eventName: "pull_request_review_comment",
    payload: { pull_request: { number: 8 }, comment: { id: 12, body, user: { login: "alice", type: "User" } } },
  }
}

// Section 2.4's corpus, and the command cases from section 11.1.
const CORPUS = [
  "/vector review",
  "/vector review full",
  "/vx review",
  "/VX Review Full",
  "  /vector review  ",
  "LGTM\n/vector review",
  "/vector review the auth code and fix it",
  "/vector reviewer",
  "/vector review full please",
  "/vector pause",
  "/vector resume",
  "/vector dismiss this is intended",
  "> /vector review\nthanks",
  "```\n/vector review\n```",
  "please take a look /vector",
  "/vector fix the flaky test",
  "no command here",
]

describe("the route script", () => {
  test("its outputs agree with core's parseReviewCommand for every command in the corpus", async () => {
    for (const body of CORPUS) {
      const parsed = parseReviewCommand(body, MENTIONS).kind
      const expected = parsed === "review" || parsed === "review-full" || parsed === "task" ? parsed : "none"
      const { outputs } = await route(issueComment(body))
      expect({ body, kind: outputs["kind"] }).toEqual({ body, kind: expected })
      if (expected === "task") expect(outputs["pr"]).toBe("7")
      if (expected === "review" || expected === "review-full")
        expect(outputs).toEqual({ kind: expected, pr: "7", ref: HEAD })
      if (expected === "none") expect(outputs["pr"]).toBe("")
    }
  })

  test("a user without write access gets a confused reaction and no runner", async () => {
    const denied = await route(issueComment("/vector review"), { permission: "read" })
    expect(denied.outputs).toEqual({ kind: "none", pr: "", ref: "" })
    expect(denied.calls.map((call) => call.method)).toEqual(["permission", "react.issue"])
    expect(denied.calls[1]?.args).toMatchObject({ comment_id: 11, content: "confused" })

    // Any error counts as no; so does triage.
    expect((await route(issueComment("/vector review"), { permissionStatus: 404 })).outputs["kind"]).toBe("none")
    expect((await route(issueComment("/vector review"), { permission: "read", role: "triage" })).outputs["kind"]).toBe(
      "none",
    )
    // A maintainer shows as "write" with role "maintain".
    expect(
      (await route(issueComment("/vector review"), { permission: "write", role: "maintain" })).outputs["kind"],
    ).toBe("review")

    const review = await route(reviewComment("/vector review"), { permission: "none" })
    expect(review.calls.at(-1)).toMatchObject({ method: "react.review", args: { comment_id: 12, content: "confused" } })
  })

  test("pause adds the label and resume removes it; a missing label is fine", async () => {
    const paused = await route(issueComment("/vector pause"))
    expect(paused.outputs["kind"]).toBe("none")
    expect(paused.calls.map((call) => call.method)).toEqual(["permission", "labels.add", "react.issue"])
    expect(paused.calls[1]?.args).toMatchObject({ issue_number: 7, labels: ["vector:paused"] })
    expect(paused.calls[2]?.args).toMatchObject({ content: "+1" })

    const resumed = await route(issueComment("/vector resume"), { removeStatus: 404 })
    expect(resumed.outputs["kind"]).toBe("none")
    expect(resumed.calls.map((call) => call.method)).toEqual(["permission", "labels.remove", "react.issue"])
    expect(resumed.calls[1]?.args).toMatchObject({ issue_number: 7, name: "vector:paused" })

    // Pausing is a writer's call too.
    const denied = await route(issueComment("/vector pause"), { permission: "read" })
    expect(denied.calls.map((call) => call.method)).toEqual(["permission", "react.issue"])
  })

  test("a fork's ref is the merge-base, and the base commit when compare fails", async () => {
    const fork = await route(issueComment("/vector review"), { fork: true })
    expect(fork.outputs).toEqual({ kind: "review", pr: "7", ref: MERGE_BASE })
    expect(fork.calls.find((call) => call.method === "compare")?.args).toMatchObject({ basehead: `${BASE}...${HEAD}` })
    const fallback = await route(issueComment("/vector review"), { fork: true, compareStatus: 404 })
    expect(fallback.outputs).toEqual({ kind: "review", pr: "7", ref: BASE })
    const same = await route(issueComment("/vector review full"))
    expect(same.outputs).toEqual({ kind: "review-full", pr: "7", ref: HEAD })
    expect(same.calls.some((call) => call.method === "compare")).toBe(false)
  })

  test("workflow_dispatch reviews the pull request it names, with no permission check", async () => {
    const dispatched = await route({ eventName: "workflow_dispatch", payload: { inputs: { pr: "12" } } })
    expect(dispatched.outputs).toEqual({ kind: "review", pr: "12", ref: HEAD })
    expect(dispatched.calls.map((call) => call.method)).toEqual(["pulls.get"])
    const bad = await route({ eventName: "workflow_dispatch", payload: { inputs: { pr: "x" } } })
    expect(bad.outputs["kind"]).toBe("none")
    expect(bad.outputs["failed"]).toContain("inputs.pr")
  })

  test("bots, issues that are not pull requests, and tasks on issues", async () => {
    const bot = await route(issueComment("/vector review", { type: "Bot" }))
    expect(bot.outputs["kind"]).toBe("none")
    expect(bot.calls).toEqual([])
    const issue = await route(issueComment("/vector review", { pr: false }))
    expect(issue.outputs["kind"]).toBe("none")
    expect(issue.calls).toEqual([])
    const task = await route(issueComment("/vector add a settings page", { pr: false }))
    expect(task.outputs).toEqual({ kind: "task", pr: "7", ref: "" })
    expect(task.calls.map((call) => call.method)).toEqual(["permission"])
  })

  test("a task needs write access too, so nobody else starts the task job or takes a queued task's place", async () => {
    const denied = await route(issueComment("/vector hi", { pr: false }), { permission: "read" })
    expect(denied.outputs).toEqual({ kind: "none", pr: "", ref: "" })
    expect(denied.calls.map((call) => call.method)).toEqual(["permission", "react.issue"])
    expect(denied.calls[1]?.args).toMatchObject({ comment_id: 11, content: "confused" })
    const failed = await route(reviewComment("/vector fix the typo"), { permissionStatus: 500 })
    expect(failed.outputs["kind"]).toBe("none")
  })
})

test("App opt-in rejects fork tasks before an OIDC-enabled job and routes fork review through the safe fallback", async () => {
  const denied = await route(issueComment("/vector fix the bug"), { app: true, fork: true })
  expect(denied.outputs.kind).toBe("none")
  expect(denied.calls.filter((call) => call.method === "pulls.get")).toHaveLength(1)
  const fork = await route(issueComment("/vector review"), { app: true, fork: true })
  expect(fork.outputs).toMatchObject({ kind: "review", app: "false", ref: MERGE_BASE })
  const own = await route(issueComment("/vector review"), { app: true })
  expect(own.outputs).toMatchObject({ kind: "review", app: "true", ref: HEAD })
  const unsupported = await route(reviewComment("/vector review"), { app: true })
  expect(unsupported.outputs).toMatchObject({ kind: "review", app: "false" })
})
