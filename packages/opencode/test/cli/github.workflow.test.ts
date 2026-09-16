import { describe, expect, test } from "bun:test"
import { buildRouteScript, buildWorkflowYaml, cliVersionSpec } from "../../src/cli/cmd/github.workflow"

// The route script is the embedded parser and is covered by github.route-script.test.ts.
function withoutScript(yaml: string) {
  const open = "          script: |\n"
  const start = yaml.indexOf(open) + open.length
  const end = yaml.indexOf("\n\n  review:")
  return yaml.slice(0, start) + "            <route script>" + yaml.slice(end)
}

interface Step {
  uses?: string
  name?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

interface Job {
  if?: string
  permissions: Record<string, string>
  concurrency?: { group: string; "cancel-in-progress": boolean }
  steps: Step[]
}

interface Workflow {
  on: Record<string, unknown>
  jobs: { route: Job; review: Job; vector: Job }
}

function parse(yaml: string): Workflow {
  const parsed = Bun.YAML.parse(yaml) as Record<string, unknown>
  // YAML 1.1 parsers read the `on` key as true.
  return { ...(parsed as object), on: (parsed["on"] ?? parsed["true"]) as Record<string, unknown> } as Workflow
}

const OPENCODE = {
  provider: "opencode",
  model: "big-pickle",
  keys: ["OPENCODE_API_KEY"],
  autoReview: true,
  version: "1.17.14",
}

const ANTHROPIC = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  keys: ["ANTHROPIC_API_KEY"],
  autoReview: false,
  monthlyUsd: 50,
  version: "local",
}

const OPENCODE_AUTO = `name: vector

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number to review
        required: true

jobs:
  # Decides who gets a runner. No checkout, and no share of the review queue.
  route:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&
        github.event.comment.user.type != 'Bot' &&
        (contains(github.event.comment.body, '/vector') || contains(github.event.comment.body, '/vx')))
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      contents: read
      pull-requests: write
      issues: write
    outputs:
      kind: \${{ steps.route.outputs.kind }}
      pr: \${{ steps.route.outputs.pr }}
      ref: \${{ steps.route.outputs.ref }}
    steps:
      - id: route
        uses: actions/github-script@v7
        with:
          script: |
            <route script>

  review:
    needs: route
    if: >-
      !cancelled() && (
        (github.event_name == 'pull_request' &&
          github.event.pull_request.head.repo.full_name == github.repository &&
          github.event.pull_request.draft == false &&
          !contains(github.event.pull_request.labels.*.name, 'vector:skip') &&
          !contains(github.event.pull_request.labels.*.name, 'vector:paused') &&
          github.event.pull_request.user.login != 'dependabot[bot]' &&
          github.event.pull_request.user.login != 'renovate[bot]') ||
        needs.route.outputs.kind == 'review' || needs.route.outputs.kind == 'review-full')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: vector-review-\${{ github.event.pull_request.number || needs.route.outputs.pr }}
      cancel-in-progress: false # queue, never cancel; a newer push replaces a queued run
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # The route job's ref wins: on a fork it is the merge-base, never the fork's head.
          ref: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          fetch-depth: 1 # the CLI fetches exactly the commits it needs, only if a review runs
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: vector-cli-1.17.14-\${{ runner.os }}
      - name: Install Vector
        run: npm install -g @vectordevai/cli@1.17.14 --prefer-offline --no-audit --no-fund
      - name: Review
        run: vector github review
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          VECTOR_REVIEW_PR: \${{ github.event.pull_request.number || needs.route.outputs.pr }}
          VECTOR_REVIEW_REF: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          MODEL: opencode/big-pickle
          # REVIEW_AUTO_MODEL: provider/cheaper-model # automatic reviews only
          OPENCODE_PURE: "1"
          OPENCODE_DISABLE_PROJECT_CONFIG: "1"
          OPENCODE_CONFIG_CONTENT: '{"lsp":false,"formatter":false,"snapshot":false}'
          # Provider keys are only needed for models not included with Vector.
          # OPENCODE_API_KEY: \${{ secrets.OPENCODE_API_KEY }}
          # ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}

  vector:
    needs: route
    if: needs.route.outputs.kind == 'task'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      # One group per comment: GitHub keeps one queued run per group, so a shared group would drop tasks.
      group: vector-\${{ needs.route.outputs.pr }}-\${{ github.event.comment.id || github.run_id }}
      cancel-in-progress: false
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: write # dispatches reviews of pull requests Vector opens
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Vector
        run: npm install -g @vectordevai/cli

      - name: Run Vector
        run: vector github run
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          USE_GITHUB_TOKEN: "true"
          MODEL: opencode/big-pickle
          VECTOR_REVIEW_AUTO: "1"
          # Provider keys are only needed for models not included with Vector.
          # OPENCODE_API_KEY: \${{ secrets.OPENCODE_API_KEY }}
          # ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
`

const ANTHROPIC_COMMANDS_ONLY = `name: vector

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number to review
        required: true

jobs:
  # Decides who gets a runner. No checkout, and no share of the review queue.
  route:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&
        github.event.comment.user.type != 'Bot' &&
        (contains(github.event.comment.body, '/vector') || contains(github.event.comment.body, '/vx')))
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      contents: read
      pull-requests: write
      issues: write
    outputs:
      kind: \${{ steps.route.outputs.kind }}
      pr: \${{ steps.route.outputs.pr }}
      ref: \${{ steps.route.outputs.ref }}
    steps:
      - id: route
        uses: actions/github-script@v7
        with:
          script: |
            <route script>

  review:
    needs: route
    if: >-
      !cancelled() && (
        needs.route.outputs.kind == 'review' || needs.route.outputs.kind == 'review-full')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: vector-review-\${{ github.event.pull_request.number || needs.route.outputs.pr }}
      cancel-in-progress: false # queue, never cancel; a newer push replaces a queued run
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # The route job's ref wins: on a fork it is the merge-base, never the fork's head.
          ref: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          fetch-depth: 1 # the CLI fetches exactly the commits it needs, only if a review runs
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: vector-cli-latest-\${{ runner.os }}
      - name: Install Vector
        run: npm install -g @vectordevai/cli@latest --no-audit --no-fund
      - name: Review
        run: vector github review
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          VECTOR_REVIEW_PR: \${{ github.event.pull_request.number || needs.route.outputs.pr }}
          VECTOR_REVIEW_REF: \${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}
          MODEL: anthropic/claude-sonnet-4-5
          REVIEW_MAX_COST_USD_PER_MONTH: "50" # "0" means no limit
          OPENCODE_PURE: "1"
          OPENCODE_DISABLE_PROJECT_CONFIG: "1"
          OPENCODE_CONFIG_CONTENT: '{"lsp":false,"formatter":false,"snapshot":false}'
          # Provider keys are only needed for models not included with Vector.
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}

  vector:
    needs: route
    if: needs.route.outputs.kind == 'task'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      # One group per comment: GitHub keeps one queued run per group, so a shared group would drop tasks.
      group: vector-\${{ needs.route.outputs.pr }}-\${{ github.event.comment.id || github.run_id }}
      cancel-in-progress: false
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Vector
        run: npm install -g @vectordevai/cli

      - name: Run Vector
        run: vector github run
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VECTOR_CLI_TOKEN: \${{ secrets.VECTOR_CLI_TOKEN }}
          USE_GITHUB_TOKEN: "true"
          MODEL: anthropic/claude-sonnet-4-5
          # Provider keys are only needed for models not included with Vector.
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
`

const COMBOS = [
  { name: "opencode, automatic review", options: OPENCODE },
  { name: "opencode, commands only", options: { ...OPENCODE, autoReview: false } },
  { name: "anthropic, automatic review", options: { ...ANTHROPIC, autoReview: true } },
  { name: "anthropic, commands only", options: ANTHROPIC },
]

describe("buildWorkflowYaml", () => {
  test("golden: opencode with automatic review", () => {
    expect(withoutScript(buildWorkflowYaml(OPENCODE))).toBe(OPENCODE_AUTO)
  })

  test("golden: anthropic with commands only", () => {
    expect(withoutScript(buildWorkflowYaml(ANTHROPIC))).toBe(ANTHROPIC_COMMANDS_ONLY)
  })

  for (const combo of COMBOS)
    test(`${combo.name}: parses, and every job has exactly its permissions`, () => {
      const yaml = buildWorkflowYaml(combo.options)
      const workflow = parse(yaml)
      const auto = combo.options.autoReview
      expect(Object.keys(workflow.on).sort()).toEqual(
        [...(auto ? ["pull_request"] : []), "issue_comment", "pull_request_review_comment", "workflow_dispatch"].sort(),
      )
      expect(workflow.jobs.route.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "write" })
      expect(workflow.jobs.review.permissions).toEqual({ contents: "read", "pull-requests": "write" })
      expect(workflow.jobs.vector.permissions).toEqual({
        contents: "write",
        "pull-requests": "write",
        issues: "write",
        ...(auto ? { actions: "write" } : {}),
      })
      expect(yaml).not.toContain("id-token")
      // The route job checks nothing out.
      expect(workflow.jobs.route.steps.map((step) => step.uses)).toEqual(["actions/github-script@v7"])
    })

  for (const combo of COMBOS)
    test(`${combo.name}: the review job checks out only what the route resolved, and never cancels`, () => {
      const workflow = parse(buildWorkflowYaml(combo.options))
      const review = workflow.jobs.review
      const checkout = review.steps.find((step) => step.uses === "actions/checkout@v4")
      expect(checkout?.with).toEqual({
        ref: "${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
      })
      expect(review.concurrency).toEqual({
        group: "vector-review-${{ github.event.pull_request.number || needs.route.outputs.pr }}",
        "cancel-in-progress": false,
      })
      expect(workflow.jobs.vector.concurrency?.["cancel-in-progress"]).toBe(false)
      const env = review.steps.find((step) => step.run === "vector github review")?.env ?? {}
      expect(env["OPENCODE_PURE"]).toBe("1")
      expect(env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1")
      expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"] ?? "{}")).toEqual({
        lsp: false,
        formatter: false,
        snapshot: false,
      })
      expect(env["VECTOR_REVIEW_REF"]).toBe("${{ needs.route.outputs.ref || github.event.pull_request.head.sha }}")
      const task = workflow.jobs.vector.steps.find((step) => step.run === "vector github run")?.env ?? {}
      expect(task["VECTOR_REVIEW_AUTO"] ?? "unset").toBe(combo.options.autoReview ? "1" : "unset")
    })

  test("the automatic branch filters forks, drafts, the skip and pause labels, and dependency bots", () => {
    const auto = parse(buildWorkflowYaml(OPENCODE)).jobs.review.if ?? ""
    for (const condition of [
      "github.event_name == 'pull_request'",
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.event.pull_request.draft == false",
      "!contains(github.event.pull_request.labels.*.name, 'vector:skip')",
      "!contains(github.event.pull_request.labels.*.name, 'vector:paused')",
      "github.event.pull_request.user.login != 'dependabot[bot]'",
      "github.event.pull_request.user.login != 'renovate[bot]'",
      "needs.route.outputs.kind == 'review' || needs.route.outputs.kind == 'review-full'",
    ])
      expect(auto).toContain(condition)
    expect(auto.startsWith("!cancelled() && (")).toBe(true)
    const off = parse(buildWorkflowYaml({ ...OPENCODE, autoReview: false })).jobs.review.if ?? ""
    expect(off).not.toContain("pull_request.draft")
    expect(off).not.toContain("github.event_name == 'pull_request'")
    expect(off).toContain("needs.route.outputs.kind == 'review'")
  })

  test("the route job ignores bots and runs only for the mentions it was built with", () => {
    const route = parse(buildWorkflowYaml({ ...OPENCODE, mentions: ["/bot"] })).jobs.route
    expect(route.if).toContain("github.event.comment.user.type != 'Bot'")
    expect(route.if).toContain("contains(github.event.comment.body, '/bot')")
    expect(route.if).not.toContain("'/vector'")
    expect(String(route.steps[0]?.with?.["script"])).toContain('const mentions = ["/bot"]')
  })

  test("the monthly limit is written only when one is given, and 0 means none", () => {
    const env = (yaml: string) =>
      parse(yaml).jobs.review.steps.find((step) => step.run === "vector github review")?.env ?? {}
    expect(env(buildWorkflowYaml(OPENCODE))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBeUndefined()
    expect(env(buildWorkflowYaml(ANTHROPIC))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBe("50")
    expect(env(buildWorkflowYaml({ ...ANTHROPIC, monthlyUsd: 0 }))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBe("0")
    expect(env(buildWorkflowYaml({ ...ANTHROPIC, monthlyUsd: 12.5 }))["REVIEW_MAX_COST_USD_PER_MONTH"]).toBe("12.5")
  })

  test("the CLI is pinned to a release, and anything else falls back to latest without the offline cache", () => {
    expect(cliVersionSpec("1.17.14")).toEqual({ spec: "1.17.14", pinned: true })
    expect(cliVersionSpec("1.18.0-beta.2")).toEqual({ spec: "1.18.0-beta.2", pinned: true })
    expect(cliVersionSpec("local")).toEqual({ spec: "latest", pinned: false })
    expect(cliVersionSpec("0.0.0-dev-202609141200")).toEqual({ spec: "latest", pinned: false })
    const install = (version: string) =>
      parse(buildWorkflowYaml({ ...OPENCODE, version })).jobs.review.steps.find(
        (step) => step.name === "Install Vector",
      )
    expect(install("1.17.14")?.run).toBe(
      "npm install -g @vectordevai/cli@1.17.14 --prefer-offline --no-audit --no-fund",
    )
    expect(install("local")?.run).toBe("npm install -g @vectordevai/cli@latest --no-audit --no-fund")
  })

  test("the route script never contains an Actions expression", () => {
    expect(buildRouteScript()).not.toContain("${{")
  })
})
