import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { COMPLETION_POLICY, LOCAL_MEMORY_POLICY, SUBAGENT_POLICY, SystemPrompt } from "../../src/session/system"
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
