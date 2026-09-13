import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import {
  ALL_SUBAGENTS,
  COMPLETION_POLICY,
  LOCAL_MEMORY_POLICY,
  SUBAGENT_POLICY,
  SystemPrompt,
  subagentAvailability,
  subagentPolicy,
} from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  it.effect("ships a model-neutral subagent delegation policy", () =>
    Effect.sync(() => {
      expect(SUBAGENT_POLICY).toContain("real child agents")
      expect(SUBAGENT_POLICY).toContain("explore for read-only discovery")
      expect(SUBAGENT_POLICY).toContain("general for other self-contained implementation")
      expect(SUBAGENT_POLICY).toContain("review for code review")
      expect(SUBAGENT_POLICY).toContain("judge for independent rubric-based completion evaluation")
      expect(SUBAGENT_POLICY).toContain("security for security analysis")
      expect(SUBAGENT_POLICY).toContain("debug for reproducing and repairing failures")
      expect(SUBAGENT_POLICY).toContain("test for focused test design and execution")
      expect(SUBAGENT_POLICY).toContain("background mode")
      expect(SUBAGENT_POLICY).toContain("owned_paths")
      expect(SUBAGENT_POLICY).toContain("depends_on")
      expect(SUBAGENT_POLICY).toContain("inherit the current provider and model")
      expect(SUBAGENT_POLICY).toContain("separate child sessions")
      expect(SUBAGENT_POLICY).toContain("stop that coordination attempt")
      expect(SUBAGENT_POLICY).toContain("Do not search outside the workspace")
      expect(SUBAGENT_POLICY).toContain("report the unavailable exchange to the parent")
    }),
  )

  it.effect("general variant: a countable big-task trigger, and small tasks stay with the main agent", () =>
    Effect.sync(() => {
      const policy = subagentPolicy({ general: true, specialists: true })
      expect(policy).toBe(SUBAGENT_POLICY)
      expect(subagentPolicy()).toBe(SUBAGENT_POLICY)
      expect(subagentPolicy(ALL_SUBAGENTS)).toBe(SUBAGENT_POLICY)
      expect(policy).toContain("Size the task before you start: count the files")
      expect(policy).toContain("three or more files that fall into two or more independent parts")
      expect(policy).toContain("The counts decide, not the size of each file")
      expect(policy).not.toContain("handful of steps")
      expect(policy).toContain("needs broad research across the codebase as well as changes")
      expect(policy).toContain("you MUST launch general Subagents with the task tool (omit subagent_type)")
      expect(policy).toContain("before you write those files yourself")
      expect(policy).toContain("one per independent part")
      expect(policy).toContain("all in ONE message")
      expect(policy).toContain("non-overlapping owned_paths")
      expect(policy).toContain("Keep integration and final verification yourself")
      expect(policy).toContain("do not wait to be asked")
      expect(policy).toContain("In a big task, also use Subagents for broad research")
      expect(policy).toContain("single-file change")
      expect(policy).toContain("closely coupled parts of one unit")
      expect(policy).toContain("Do small tasks yourself and do not launch a general Subagent")
      expect(policy).toContain("the default when you omit subagent_type")
      expect(policy).toContain("explore for read-only discovery")
      expect(policy).toContain("Otherwise, for the independent parts of a big task, use the Subagent")
      expect(policy).toContain("general for other self-contained implementation")
      expect(policy).not.toContain("almost every time")
      expect(policy).not.toContain("turned off")
    }),
  )

  it.effect("unavailable variant: specialists only, the real reason, and no advice to omit subagent_type", () =>
    Effect.sync(() => {
      const reasons = [
        [{ reason: "disabled" }, "General Subagents are turned off in Vector settings (agent.general.disable)."],
        [{ reason: "denied", agent: "plan" }, "The plan agent cannot launch general Subagents in this session."],
        [{ reason: "nested" }, "You are a Subagent working on a brief from a parent agent"],
        [{}, "General Subagents are not available in this session."],
      ] as const
      for (const [extra, line] of reasons) {
        const policy = subagentPolicy({ general: false, specialists: true, ...extra })
        expect(policy).toContain(line)
        expect(policy).toContain("Every task call must set subagent_type to a Subagent specialist")
        expect(policy).toContain("never request general")
        expect(policy).toContain("Do the work that no specialist covers yourself, big tasks included")
        expect(policy).toContain("clearly matches its focus")
        for (const kept of [
          "real child agents",
          "explore for read-only discovery",
          "review for code review",
          "judge for independent rubric-based completion evaluation",
          "security for security analysis",
          "debug for reproducing and repairing failures",
          "test for focused test design and execution",
          "background mode",
          "owned_paths",
          "depends_on",
          "inherit the current provider and model",
          "separate child sessions",
          "stop that coordination attempt",
          "Do not search outside the workspace",
          "report the unavailable exchange to the parent",
          "Keep ownership of the user's request",
        ])
          expect(policy).toContain(kept)
        expect(policy).not.toContain("omit")
        expect(policy).not.toContain("general for other self-contained")
        expect(policy).not.toContain("MUST launch general Subagents")
        expect(policy).not.toContain("Otherwise, for the independent parts of a big task")
      }
      // A permission denial is not blamed on the Settings switch, and the switch is not blamed on the agent.
      expect(subagentPolicy({ general: false, specialists: true, reason: "denied", agent: "plan" })).not.toContain(
        "Vector settings",
      )
      expect(subagentPolicy({ general: false, specialists: true, reason: "disabled" })).not.toContain("agent cannot")
    }),
  )

  it.effect("names only the specialists the agent may launch", () =>
    Effect.sync(() => {
      const plan = subagentPolicy({
        general: false,
        specialists: true,
        reason: "denied",
        agent: "plan",
        permitted: ["explore", "review", "security"],
      })
      expect(plan).toContain(
        "task tool's list: explore for read-only discovery; review for code review; security for security analysis. Otherwise do that part yourself.",
      )
      for (const denied of ["judge for", "debug for", "test for", "performance for", "migration for"])
        expect(plan).not.toContain(denied)
      // Only custom specialists: no built-in focus list, and the task tool's list still applies.
      const custom = subagentPolicy({
        general: false,
        specialists: true,
        reason: "disabled",
        permitted: ["docs-writer"],
      })
      expect(custom).toContain("choose the narrowest one in the task tool's list. Otherwise do that part yourself.")
      // General with no specialist at all.
      const lone = subagentPolicy({ general: true, specialists: false, permitted: [] })
      expect(lone).toContain("No Subagent specialists are available to you")
      expect(lone).toContain("you MUST launch general Subagents")
      expect(lone).not.toContain("explore for read-only discovery")
    }),
  )

  it.effect("no-subagent variant keeps only the teammate guidance", () =>
    Effect.sync(() => {
      const policy = subagentPolicy({ general: false, specialists: false })
      expect(policy).toContain("No subagents are available in this session")
      expect(policy).toContain("do not call the task tool")
      expect(policy).toContain("stop that coordination attempt")
      expect(policy).toContain("report the unavailable exchange to the parent")
      expect(policy).not.toContain("Subagent specialist")
      expect(policy).not.toContain("deploy general Subagents")
      expect(policy).not.toContain("omit")
    }),
  )

  it.effect("subagentAvailability applies the task tool's rules and says why general is off", () =>
    Effect.sync(() => {
      const agents = [
        { name: "build", mode: "primary" as const },
        { name: "plan", mode: "primary" as const },
        { name: "general", mode: "subagent" as const },
        { name: "review", mode: "subagent" as const },
        { name: "explore", mode: "subagent" as const },
      ]
      const allow = Permission.fromConfig({ "*": "allow" })
      const pick = (input: Parameters<typeof subagentAvailability>[0]) => {
        const { general, specialists, reason } = subagentAvailability(input)
        return { general, specialists, reason }
      }
      expect(subagentAvailability({ agents, permission: allow, agent: "build" })).toEqual({
        general: true,
        specialists: true,
        agent: "build",
        permitted: ["explore", "review"],
      })
      // No task rule at all means "ask", which is not a deny.
      expect(pick({ agents, permission: [] })).toEqual({ general: true, specialists: true, reason: undefined })
      // Plan mode denies general by permission, and denied specialists drop out of the list.
      expect(
        subagentAvailability({
          agents,
          permission: Permission.merge(allow, Permission.fromConfig({ task: { general: "deny", review: "deny" } })),
          agent: "plan",
        }),
      ).toEqual({ general: false, specialists: true, reason: "denied", agent: "plan", permitted: ["explore"] })
      // agent.general.disable removes general from the agent list.
      expect(pick({ agents: agents.filter((a) => a.name !== "general"), permission: allow })).toEqual({
        general: false,
        specialists: true,
        reason: "disabled",
      })
      // Session rules come after the agent's, as in task.ts.
      expect(
        pick({ agents, permission: allow, session: Permission.fromConfig({ task: { general: "deny" } }) }),
      ).toEqual({ general: false, specialists: true, reason: "denied" })
      // Child sessions normally deny the task tool outright.
      expect(
        pick({
          agents,
          permission: allow,
          session: [{ permission: "task", pattern: "*", action: "deny" }],
          nested: true,
        }),
      ).toEqual({ general: false, specialists: false, reason: "denied" })
      // A child session whose rules still allow the task tool must not fan out through general.
      expect(pick({ agents, permission: allow, nested: true })).toEqual({
        general: false,
        specialists: true,
        reason: "nested",
      })
      expect(
        pick({ agents: agents.filter((a) => a.name !== "explore" && a.name !== "review"), permission: allow }),
      ).toEqual({ general: true, specialists: false, reason: undefined })
    }),
  )

  it.effect("ships a bounded evidence-based completion loop", () =>
    Effect.sync(() => {
      expect(COMPLETION_POLICY).toContain("full implementation and verification loop")
      expect(COMPLETION_POLICY).toContain("three unsuccessful attempts")
      expect(COMPLETION_POLICY).toContain("Completion requires")
    }),
  )

  it.effect("describes local memory storage and provider context honestly", () =>
    Effect.sync(() => {
      expect(LOCAL_MEMORY_POLICY).toContain("stored as plain Markdown only on this computer")
      expect(LOCAL_MEMORY_POLICY).toContain("context sent to the model provider")
      expect(LOCAL_MEMORY_POLICY).toContain("inspect, edit, or erase")
      expect(LOCAL_MEMORY_POLICY).toContain("Do not create or update it on your own")
      expect(LOCAL_MEMORY_POLICY).not.toContain("never leaves")
    }),
  )

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
