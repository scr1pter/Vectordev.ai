import { afterEach, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"

// Research permissions only narrow (section 5.3, RC1). The research agents take the read-only specialists' pattern:
// a user or repository rule can narrow a research agent within its own tools and subagents, and the coding tools are
// denied last, so a global `"*": "allow"` reopens no edit and no shell in Deep research. Every other agent is denied
// the research tools and the research workers.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const get = (name: string) => Agent.Service.use((agents) => agents.get(name))
const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent.permission).action
const offered = (agent: Agent.Info, tools: string[]) => {
  const disabled = Permission.disabled(tools, agent.permission)
  return tools.filter((tool) => !disabled.has(tool))
}

const CODING = ["edit", "write", "apply_patch", "bash", "todowrite", "plan_enter", "webfetch", "websearch", "skill"]
const RESEARCH_TOOLS = [
  "research_plan",
  "research_search",
  "research_read",
  "research_browser",
  "research_note",
  "research_report",
]
const OTHER = [
  "mcp_github_create_or_update_file",
  "vector_cloud",
  "vector_cloud_publish",
  "lsp",
  "escalate",
  "my_plugin_tool",
]

it.instance(
  "a global allow, a repository allow and the agents' own allows reopen no coding tool in research",
  () =>
    Effect.gen(function* () {
      const research = (yield* get("research"))!
      const researcher = (yield* get("researcher"))!
      const judge = (yield* get("research-judge"))!

      // The lead: its own tools, nothing else, whatever the rules allow.
      for (const tool of [...CODING, ...OTHER]) expect(action(research, tool)).toBe("deny")
      expect(offered(research, [...CODING, ...OTHER])).toEqual([])
      expect(
        offered(research, [...RESEARCH_TOOLS, "memory", "question", "read", "grep", "glob", "list", "browser", "task"]),
      ).toEqual([...RESEARCH_TOOLS, "memory", "question", "read", "grep", "glob", "list", "browser", "task"])
      // It delegates to its researchers alone: the task allow names no other subagent.
      expect(action(research, "task", "researcher")).toBe("allow")
      expect(action(research, "task", "research-judge")).toBe("allow")
      for (const agent of ["general", "debug", "build", "explore", "research"])
        expect(action(research, "task", agent)).toBe("deny")

      // A researcher has no files, no memory, no browser of the user's and no subagents.
      for (const tool of [...CODING, ...OTHER, "read", "grep", "glob", "list", "memory", "browser", "task", "question"])
        expect(action(researcher, tool)).toBe("deny")
      expect(offered(researcher, [...RESEARCH_TOOLS, "read", "memory", "browser", "task"])).toEqual([
        "research_search",
        "research_read",
        "research_browser",
        "research_note",
      ])

      // The judge has nothing at all.
      expect(offered(judge, [...RESEARCH_TOOLS, ...CODING, ...OTHER, "read", "memory", "task", "browser"])).toEqual([])
      expect(judge.hidden).toBe(true)
    }),
  {
    trusted: true,
    config: {
      permission: { bash: "allow", edit: "allow", "*": "allow", webfetch: "allow", task: "allow" },
      agent: {
        research: { permission: { "*": "allow", bash: "allow", edit: "allow", task: { "*": "allow" } } },
        researcher: { permission: { read: "allow", memory: "allow", browser: "allow", "*": "allow" } },
        "research-judge": { permission: { "*": "allow" } },
      },
    },
  },
)

it.instance("by default the run's first read asks, a private address asks, and secret files keep asking", () =>
  Effect.gen(function* () {
    const research = (yield* get("research"))!
    const researcher = (yield* get("researcher"))!
    for (const agent of [research, researcher]) {
      expect(action(agent, "research_read", "run_1")).toBe("ask")
      expect(action(agent, "private_network", "http://10.0.0.5")).toBe("ask")
      expect(action(agent, "research_search")).toBe("allow")
    }
    expect(action(research, "read", "src/app.ts")).toBe("allow")
    expect(action(research, "read", ".env")).toBe("ask")
    expect(action(research, "read", "keys/server.pem")).toBe("ask")
    expect(action(research, "external_directory", "/somewhere/else/*")).toBe("ask")
    expect(action(research, "browser_external", "https://example.com")).toBe("ask")
    expect(research.mode).toBe("all")
    expect(researcher.mode).toBe("subagent")
  }),
)

it.instance(
  "the user's denies and asks still narrow the research agents",
  () =>
    Effect.gen(function* () {
      const research = (yield* get("research"))!
      const researcher = (yield* get("researcher"))!
      expect(action(research, "read", "secrets/token.txt")).toBe("deny")
      expect(action(research, "research_search")).toBe("deny")
      expect(action(researcher, "research_search")).toBe("deny")
      expect(action(research, "task", "researcher")).toBe("ask")
      expect(action(research, "memory")).toBe("ask")
      // An ask never reopens what an agent may not use.
      expect(action(researcher, "memory")).toBe("deny")
      expect(action(research, "bash")).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      permission: {
        read: { "secrets/*": "deny" },
        research_search: "deny",
        memory: "ask",
        bash: "ask",
        task: { "*": "ask" },
      },
    },
  },
)

it.instance(
  "every other agent is denied the research tools and the research workers; build alone keeps research as a tool",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service.use((service) => service.list())
      for (const agent of agents) {
        if (["research", "researcher", "research-judge"].includes(agent.name)) continue
        expect(offered(agent, RESEARCH_TOOLS)).toEqual([])
        expect(action(agent, "task", "researcher")).toBe("deny")
        expect(action(agent, "task", "research-judge")).toBe("deny")
        expect(action(agent, "research")).toBe(agent.name === "build" ? "allow" : "deny")
      }
      // A rule for the workers is not the last word on task for an agent that launches no subagent.
      const quick = (yield* get("quick"))!
      expect(offered(quick, ["task"])).toEqual([])
      const explore = (yield* get("explore"))!
      expect(offered(explore, ["task"])).toEqual([])
      // Build and plan still delegate to everything else they could before, the research lead included.
      const build = (yield* get("build"))!
      expect(action(build, "task", "general")).toBe("allow")
      expect(action(build, "task", "research")).toBe("allow")
      const plan = (yield* get("plan"))!
      expect(action(plan, "task", "explore")).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      permission: { "*": "allow", research_plan: "allow", "research_*": "allow" },
      agent: { build: { permission: { research_read: "allow", task: { researcher: "allow" } } } },
    },
  },
)
