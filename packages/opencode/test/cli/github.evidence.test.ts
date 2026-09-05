import { test, expect, describe } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import {
  BODY_MAX_CHARS,
  buildEvidenceBody,
  collectChecks,
  fmtTokens,
  isCheckCommand,
  judgeTextFromMessages,
  measureCost,
  parseNumstat,
} from "../../src/cli/cmd/github.evidence"
import { parseJudgeScores, parseJudgeVerdict } from "../../src/session/judge-verdict"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_test")

function assistant(
  opts: { cost?: number; tokens?: Partial<SessionV1.Assistant["tokens"]>; providerID?: string; modelID?: string } = {},
): SessionV1.Assistant {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: MessageID.make("msg_user"),
    modelID: opts.modelID ?? "big-pickle",
    providerID: opts.providerID ?? "opencode",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: opts.cost ?? 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      ...opts.tokens,
      cache: { read: 0, write: 0, ...opts.tokens?.cache },
    },
  } as SessionV1.Assistant
}

function user(): SessionV1.User {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "opencode", modelID: "big-pickle" },
  } as SessionV1.User
}

function text(value: string): SessionV1.Part {
  return { id: PartID.ascending(), sessionID, messageID: MessageID.make("msg_test"), type: "text", text: value }
}

// `exit: "omit"` builds a part whose metadata carries no exit code at all
// (older runs), which the builder must report as unknown rather than 0.
function bash(command: string, output: string, exit: number | null | "omit" = 0): SessionV1.Part {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID: MessageID.make("msg_test"),
    type: "tool",
    callID: "c1",
    tool: "bash",
    state: {
      status: "completed",
      input: { command },
      output,
      title: command,
      metadata: exit === "omit" ? {} : { exit, output, truncated: false },
      time: { start: 0, end: 1 },
    },
  }
}

function bashError(command: string, error: string): SessionV1.Part {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID: MessageID.make("msg_test"),
    type: "tool",
    callID: "c1",
    tool: "bash",
    state: { status: "error", input: { command }, error, time: { start: 0, end: 1 } },
  }
}

function withParts(info: SessionV1.Info, parts: SessionV1.Part[] = []): SessionV1.WithParts {
  return { info, parts }
}

describe("isCheckCommand", () => {
  test("matches test, typecheck, lint and build invocations", () => {
    expect(isCheckCommand("bun test test/cli/github.evidence.test.ts")).toBe(true)
    expect(isCheckCommand("cd packages/app && bun run typecheck")).toBe(true)
    expect(isCheckCommand("npx tsc --noEmit")).toBe(true)
    expect(isCheckCommand("npm run lint")).toBe(true)
    expect(isCheckCommand("cargo check")).toBe(true)
    expect(isCheckCommand("bun run build")).toBe(true)
  })

  test("ignores reads, checkouts and the shell test builtin", () => {
    expect(isCheckCommand("cat src/index.ts")).toBe(false)
    expect(isCheckCommand("git checkout -b vector/issue1")).toBe(false)
    expect(isCheckCommand("test -f package.json && echo yes")).toBe(false)
    expect(isCheckCommand("[ -d node_modules ]")).toBe(false)
  })
})

describe("parseNumstat", () => {
  test("parses added/deleted counts and treats binary files as zero", () => {
    const out = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n0\t7\tsrc/{old => new}.ts\n\n")
    expect(out).toEqual([
      { file: "src/a.ts", additions: 12, deletions: 3 },
      { file: "assets/logo.png", additions: 0, deletions: 0 },
      { file: "src/{old => new}.ts", additions: 0, deletions: 7 },
    ])
  })
})

describe("measureCost", () => {
  test("returns undefined when no assistant message reported usage", () => {
    expect(measureCost([withParts(user()), withParts(assistant())])).toBeUndefined()
  })

  test("sums usage and cost, reporting the latest model", () => {
    const cost = measureCost([
      withParts(user()),
      withParts(assistant({ cost: 0.01, tokens: { input: 1000, output: 200 }, providerID: "a", modelID: "m1" })),
      withParts(assistant({ cost: 0, tokens: { input: 0, output: 0 } })),
      withParts(
        assistant({
          cost: 0.02,
          tokens: { input: 500, output: 100, reasoning: 50, cache: { read: 300, write: 0 } },
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
        }),
      ),
    ])
    expect(cost).toEqual({
      costUsd: 0.03,
      input: 1500,
      output: 300,
      reasoning: 50,
      cacheRead: 300,
      cacheWrite: 0,
      provider: "anthropic",
      model: "claude-sonnet-4",
      turns: 2,
    })
  })
})

describe("collectChecks", () => {
  test("keeps only bash parts that look like checks, with exit codes and output tails", () => {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")
    const checks = collectChecks([
      withParts(assistant(), [
        bash("cat README.md", "# hi"),
        bash("bun test src/x.test.ts", many, 0),
        bash("bun run typecheck", "error TS2322\n\n<shell_metadata>\nCommand exited with code 2\n</shell_metadata>", 2),
        bash("npm run lint", "ok", "omit"),
        bashError("bun run build", "spawn failed"),
      ]),
    ])
    expect(checks.map((c) => c.command)).toEqual([
      "bun test src/x.test.ts",
      "bun run typecheck",
      "npm run lint",
      "bun run build",
    ])
    expect(checks[0].exit).toBe(0)
    expect(checks[0].output.split("\n")).toHaveLength(40)
    expect(checks[0].output.startsWith("line 21")).toBe(true)
    expect(checks[1].exit).toBe(2)
    expect(checks[1].output).toBe("error TS2322")
    expect(checks[2].exit).toBeNull()
    expect(checks[3]).toEqual({ command: "bun run build", exit: "error", output: "spawn failed" })
  })
})

describe("judge verdict", () => {
  const report = [
    "The format is `VERDICT: PASS | FAIL | INCONCLUSIVE`.",
    "",
    "**VERDICT:** FAIL",
    "SCORES: requirement 3/4, correctness 1/4, regression 2/4, evidence 2/4, safety 4/4",
    "BLOCKERS:",
    "- tests fail",
  ].join("\n")

  test("last verdict wins and scores are extracted", () => {
    expect(parseJudgeVerdict(report)).toBe("FAIL")
    expect(parseJudgeScores(report)).toBe("requirement 3/4, correctness 1/4, regression 2/4, evidence 2/4, safety 4/4")
    expect(parseJudgeVerdict("no verdict here")).toBeUndefined()
    expect(parseJudgeScores(undefined)).toBeUndefined()
  })

  test("judgeTextFromMessages takes the last assistant text", () => {
    const messages = [
      withParts(user()),
      withParts(assistant(), [text("thinking out loud")]),
      withParts(assistant(), [bash("bun test", "ok"), text(report)]),
    ]
    expect(judgeTextFromMessages(messages)).toBe(report)
    expect(judgeTextFromMessages([withParts(user())])).toBeUndefined()
  })
})

describe("buildEvidenceBody", () => {
  const runUrl = "https://github.com/acme/widgets/actions/runs/42"

  test("renders response, changes table, checks, cost, judge, closes and footer", () => {
    const body = buildEvidenceBody({
      response: "Added the missing null check.",
      changes: [
        { file: "src/a.ts", additions: 12, deletions: 3 },
        { file: "src/a.test.ts", additions: 20, deletions: 0 },
      ],
      messages: [
        withParts(user()),
        withParts(assistant({ cost: 0.0123, tokens: { input: 12_345, output: 1_200 } }), [
          bash("bun test src/a.test.ts", "3 pass\n0 fail", 0),
          bash("bun run typecheck", "error TS2322: boom", 1),
        ]),
      ],
      judge: "VERDICT: PASS\nSCORES: requirement 4/4, correctness 4/4",
      runUrl,
      closes: 7,
    })

    expect(body.startsWith("Added the missing null check.\n\n## Vector evidence")).toBe(true)
    expect(body).toContain("| `src/a.ts` | 12 | 3 |")
    expect(body).toContain("_2 files changed, +32 −3_")
    expect(body).toContain("<summary>✅ <code>bun test src/a.test.ts</code> (exit 0)</summary>")
    expect(body).toContain("<summary>❌ <code>bun run typecheck</code> (exit 1)</summary>")
    expect(body).toContain("```text\n3 pass\n0 fail\n```")
    expect(body).toContain("**Cost:** $0.01 · 12.3k in / 1.2k out · opencode/big-pickle · 1 turn")
    expect(body).toContain("**Judge:** ✅ PASS — requirement 4/4, correctness 4/4")
    expect(body).toContain("\nCloses #7\n")
    expect(body.endsWith(`---\n[Vector run](${runUrl})`)).toBe(true)
    // The upstream share link and social card must not come back.
    expect(body).not.toContain("opencode.ai")
    expect(body).not.toContain("social-cards")
  })

  test("stays under GitHub's body limit, keeping the evidence and Closes line", () => {
    const body = buildEvidenceBody({
      response: "word ".repeat(20_000),
      changes: [{ file: "src/a.ts", additions: 1, deletions: 0 }],
      messages: [],
      judge: undefined,
      runUrl: "https://github.com/o/r/actions/runs/1",
      closes: 7,
    })
    expect(body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
    expect(body).toContain("response truncated")
    expect(body).toContain("## Vector evidence")
    expect(body).toContain("`src/a.ts`")
    expect(body).toContain("Closes #7")
    expect(body.endsWith("[Vector run](https://github.com/o/r/actions/runs/1)")).toBe(true)
  })

  test("degrades cleanly when nothing was measured or run", () => {
    const body = buildEvidenceBody({
      response: "Nothing to do.",
      changes: [],
      messages: [withParts(user()), withParts(assistant())],
      runUrl,
      trigger: "Triggered by workflow_dispatch",
    })
    expect(body).toContain("Nothing to do.\n\nTriggered by workflow_dispatch\n\n## Vector evidence")
    expect(body).toContain("_No file changes._")
    expect(body).toContain("_No test, typecheck, lint or build commands were run._")
    expect(body).toContain("**Cost:** not measured")
    expect(body).toContain("**Judge:** not run")
    expect(body).not.toContain("Closes #")
  })

  test("escapes fences, html and table pipes in tool output and paths", () => {
    const body = buildEvidenceBody({
      response: "",
      changes: [{ file: "weird|name.ts", additions: 1, deletions: 0 }],
      messages: [withParts(assistant(), [bash("bun test <a>", "```\ninner fence\n```", 0)])],
      judge: "VERDICT: INCONCLUSIVE",
      runUrl,
    })
    expect(body).toContain("| `weird\\|name.ts` | 1 | 0 |")
    expect(body).toContain("<code>bun test &lt;a&gt;</code>")
    expect(body).toContain("````text\n```\ninner fence\n```\n````")
    expect(body).toContain("**Judge:** ⚠️ INCONCLUSIVE")
    expect(body.startsWith("## Vector evidence")).toBe(true)
  })
})

describe("fmtTokens", () => {
  test("abbreviates thousands and millions", () => {
    expect(fmtTokens(999)).toBe("999")
    expect(fmtTokens(12_345)).toBe("12.3k")
    expect(fmtTokens(2_500_000)).toBe("2.5M")
  })
})
