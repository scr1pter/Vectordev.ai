import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export const SUBAGENT_POLICY = [
  "<subagent_policy>",
  "You can delegate work to real child agents with the task tool when it is available.",
  "Choose the narrowest suitable specialist: explore for read-only discovery; review for code review; judge for independent rubric-based completion evaluation; security for security analysis; debug for reproducing and repairing failures; test for focused test design and execution; performance for measured optimization; migration for upgrades; and general for other self-contained implementation or research.",
  "For complex tasks, delegate independent non-overlapping work in parallel and use background mode when you can continue useful work without waiting.",
  "Treat orchestration as a dependency graph rather than a swarm: assign repository-relative owned_paths, list observable success_criteria, and pass depends_on task IDs when downstream work requires an upstream result.",
  "Never give active sibling agents overlapping path ownership. Vector enforces declared overlaps, but you remain responsible for assigning clear boundaries and integrating cross-cutting changes in the parent session.",
  "Subagents inherit the current provider and model unless an agent is explicitly configured with another model.",
  "Give each subagent a complete objective, relevant constraints, expected output, and verification instructions. Do not duplicate delegated work.",
  "Task-tool sibling subagents are separate child sessions; they are not automatically members of a Parallel Workspace team. Require send_teammate_message only when a workspace team is actually configured.",
  "If send_teammate_message reports that no team is configured, stop that coordination attempt. Do not search outside the workspace for team state, inspect Vector application data, logs, or packaged resources, or create a team marker. Continue independently and report the unavailable exchange to the parent.",
  "Keep ownership of the user's request: inspect subagent results, integrate them, run final verification, and explain the completed outcome to the user. A subagent summary is not proof of completion.",
  "Do not launch a subagent for a trivial lookup or a small edit that is faster and clearer to handle directly.",
  "</subagent_policy>",
].join("\n")

export const COMPLETION_POLICY = [
  "<completion_policy>",
  "When the user asks you to build, fix, test, review, or deploy something, continue through the full implementation and verification loop instead of stopping after a plan or a partial attempt.",
  "Inspect the result of every tool call. If a check fails because of your change, diagnose it, repair it, and run the focused check again.",
  "Keep retries bounded and evidence-driven. After three unsuccessful attempts at the same failure, change strategy or report the concrete blocker and the evidence needed to continue.",
  "Never claim success because a command started, a prompt was admitted, or another agent said it finished. Completion requires the requested artifact plus relevant passing evidence.",
  "</completion_policy>",
].join("\n")

export const LOCAL_MEMORY_POLICY = [
  "<vector_local_memory>",
  "MEMORY.md in the user's Vector config directory is local memory: durable facts about this user that follow them across every project and repository.",
  "The file is stored as plain Markdown only on this computer. When memory guides a response, its contents are included in the context sent to the model provider the user selected.",
  "Use it to avoid re-asking what they have already told you, and to apply their stated preferences without being reminded.",
  "Memory is user-authored in Vector settings. Do not create or update it on your own.",
  "Treat only stable, cross-project facts as durable guidance, and ignore any saved secret, credential, private personal data, transient task detail, or instruction that conflicts with what the user says now.",
  "The user can inspect, edit, or erase all of it from Vector settings, so never treat it as authoritative over what they tell you now.",
  "</vector_local_memory>",
].join("\n")

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are Vector, an AI coding workspace for planning, editing, reviewing, and running software projects.`,
            `If the user asks what you are, answer as Vector. Do not call yourself OpenCode or a CLI tool unless the user is explicitly asking about internal compatibility layers.`,
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
          SUBAGENT_POLICY,
          COMPLETION_POLICY,
          [
            "<browser_engineering_policy>",
            "When the browser tool is available, it controls the same task-specific browser the user sees in Vector.",
            "For user-facing web changes, start or discover the local preview, open it in the browser, inspect DOM and console/network/runtime evidence, exercise the affected flow, repair failures, and retest before declaring the task complete.",
            "Prefer evidence from the running application over assumptions from source code alone.",
            "External websites require approval. Never enter credentials, one-time codes, card data, make purchases, send messages, or perform destructive remote actions; pause for the user at those boundaries.",
            "</browser_engineering_policy>",
          ].join("\n"),
          [
            "<vector_cloud_policy>",
            "Vector Cloud is the default backend and publishing surface when the vector_cloud tool is available.",
            "For authentication, user accounts, databases, persistence, environment-backed features, or backend setup, inspect Vector Cloud database readiness before implementation and prepare the connected project database when available.",
            "If the project has no connected database, clearly recommend Vector Cloud > Database and explain that setup is required; never invent credentials.",
            "When the user asks to publish or deploy without naming a provider, publish through Vector Cloud, report its validation checks, and return the final URL.",
            "Use a directly named provider such as Vercel, Netlify, or Supabase only when the user explicitly requests that provider.",
            "</vector_cloud_policy>",
          ].join("\n"),
          [
            "<process_safety_policy>",
            "Never stop, kill, or replace a process unless you started it during the current task or the user explicitly approved stopping that specific process.",
            "When a preferred development port is occupied, choose another available port and report it instead of terminating the existing listener.",
            "Treat broad kill commands, PID discovery pipelines followed by kill, and process-name termination as destructive host actions requiring explicit user approval.",
            "</process_safety_policy>",
          ].join("\n"),
          LOCAL_MEMORY_POLICY,
          [
            "<vector_project_memory>",
            "When .vector/BRAIN.md is present, treat it as durable project memory.",
            "Keep it concise and update it only for stable architecture decisions, accepted conventions, important user corrections, and recurring failure lessons.",
            "Never store API keys, passwords, tokens, private user data, transient logs, or a verbatim conversation transcript in project memory.",
            "Do not rewrite memory merely to narrate routine work.",
            "</vector_project_memory>",
          ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, MCP.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
