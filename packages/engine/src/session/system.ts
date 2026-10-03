import { LayerNode } from "@vectordevai/core/effect/layer-node"
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
import { GENERAL_SUBAGENT } from "@/agent/subagent-kind"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Location } from "@vectordevai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Reference } from "@vectordevai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@vectordevai/core/v1/permission"

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

/** What the current agent may launch through the task tool in this session. */
export type SubagentAvailability = {
  /** The general Subagent: present in agent.list() (agent.general.disable removes it), not denied by task permission, and not requested from inside a subagent. */
  general: boolean
  /** Any Subagent specialist: another non-primary agent that task permission does not deny. */
  specialists: boolean
  /** Why general is unavailable: turned off in config, denied to this agent by permission, or this session is itself a subagent. */
  reason?: "disabled" | "denied" | "nested"
  /** The current agent's name, used to explain a permission denial. */
  agent?: string
  /** The specialists this agent may launch. When set, the policy names only these. */
  permitted?: readonly string[]
  /** A Parallel Workspace team is configured, so send_teammate_message is offered and its guidance applies. */
  teammates?: boolean
}

export const ALL_SUBAGENTS: SubagentAvailability = { general: true, specialists: true }

/**
 * The task tool's own test (task.ts): a disabled general is missing from
 * agent.list(), and a denied one fails Permission.evaluate over the agent's
 * rules followed by the session's. That covers Plan mode (task.general deny)
 * and child sessions (task "*" deny) as well as the Settings switch. A child
 * session whose rules still allow the task tool (a task rule in the user's
 * permission config reaches general's) is told not to launch general
 * Subagents of its own, so delegation does not fan out.
 */
export function subagentAvailability(input: {
  agents: readonly Pick<Agent.Info, "name" | "mode">[]
  permission: PermissionV1.Ruleset
  session?: PermissionV1.Ruleset
  /** The current agent's name. */
  agent?: string
  /** True in a subagent's own session, that is, one with a parent session. */
  nested?: boolean
}): SubagentAvailability {
  const denied = (name: string) =>
    Permission.evaluate("task", name, input.permission, input.session ?? []).action === "deny"
  const permitted = input.agents
    .filter((agent) => agent.mode !== "primary" && agent.name !== GENERAL_SUBAGENT && !denied(agent.name))
    .map((agent) => agent.name)
    .toSorted()
  const reason = !input.agents.some((agent) => agent.name === GENERAL_SUBAGENT)
    ? ("disabled" as const)
    : denied(GENERAL_SUBAGENT)
      ? ("denied" as const)
      : input.nested
        ? ("nested" as const)
        : undefined
  return {
    general: reason === undefined,
    specialists: permitted.length > 0,
    ...(reason === undefined ? {} : { reason }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    permitted,
  }
}

const SUBAGENT_INTRO = "You can delegate work to real child agents with the task tool when it is available."
/** The built-in Subagent specialists and their focus. Custom specialists appear only in the task tool's list. */
const SUBAGENT_FOCUS: ReadonlyArray<readonly [name: string, focus: string]> = [
  ["explore", "read-only discovery"],
  ["review", "code review"],
  ["judge", "independent rubric-based completion evaluation"],
  ["security", "security analysis"],
  ["debug", "reproducing and repairing failures"],
  ["test", "focused test design and execution"],
  ["performance", "measured optimization"],
  ["migration", "upgrades"],
]

/** ": explore for …; review for …" naming only the permitted built-in specialists, or "" when none of them is. */
function specialistFocus(permitted?: readonly string[]) {
  const listed = SUBAGENT_FOCUS.filter(([name]) => permitted === undefined || permitted.includes(name))
  if (listed.length === 0) return ""
  return `: ${listed.map(([name, focus]) => `${name} for ${focus}`).join("; ")}`
}
// Sizing, ownership (owned_paths, depends_on, success_criteria) and briefing rules live in the task tool's
// description alone, so a request does not carry them twice.
const SUBAGENT_ORCHESTRATION = [
  "The task tool's description has the rules for sizing, owned_paths, depends_on, success_criteria and writing a brief.",
  "Subagents inherit the current provider and model unless an agent is explicitly configured with another model; explore runs on the provider's small model when one is available.",
]
const SUBAGENT_TEAMMATES = [
  "Task-tool sibling subagents are separate child sessions; they are not automatically members of a Parallel Workspace team. Require send_teammate_message only when a workspace team is actually configured.",
  "If send_teammate_message reports that no team is configured, stop that coordination attempt. Do not search outside the workspace for team state, inspect Vector application data, logs, or packaged resources, or create a team marker. Continue independently and report the unavailable exchange to the parent.",
]
const SUBAGENT_OWNERSHIP =
  "Keep ownership of the user's request: inspect subagent results, integrate them, run final verification, and explain the completed outcome to the user. A subagent summary is not proof of completion."

/** Why general Subagents are off, so a permission rule is never reported to the user as the Settings switch. */
function generalOffLine(input: SubagentAvailability) {
  switch (input.reason) {
    case "disabled":
      return "General Subagents are turned off in Vector settings (agent.general.disable)."
    case "denied":
      return `The ${input.agent ?? "current"} agent cannot launch general Subagents in this session.`
    case "nested":
      return "You are a Subagent working on a brief from a parent agent, so do not launch general Subagents of your own."
    default:
      return "General Subagents are not available in this session."
  }
}

function subagentPolicyLines(input: SubagentAvailability): string[] {
  const focus = specialistFocus(input.permitted)
  if (input.general)
    return [
      SUBAGENT_INTRO,
      // Every Subagent starts from an empty context and pays for its own prompt and reading, so delegation is for
      // work that is cheaper split up, not the default for multi-file changes.
      "Do the work yourself by default, multi-file changes included. Launch a general Subagent (omit subagent_type) only when that costs less than doing the work yourself: for an independent part that is itself substantial, roughly five or more files or a long check-and-repair loop, and can proceed alongside your own work, or for broad research whose raw output would flood your context. Each Subagent starts with an empty context and reads everything again, so splitting small parts across Subagents costs more than doing them.",
      input.specialists
        ? `When part of the work clearly matches a Subagent specialist, choose the narrowest one${focus}.`
        : "No Subagent specialists are available to you.",
      ...SUBAGENT_ORCHESTRATION,
      ...(input.teammates ? SUBAGENT_TEAMMATES : []),
      SUBAGENT_OWNERSHIP,
    ]
  if (input.specialists)
    return [
      SUBAGENT_INTRO,
      `${generalOffLine(input)} Every task call must set subagent_type to a Subagent specialist from the task tool's list; never request general.`,
      "Do the work that no specialist covers yourself, big tasks included, and keep integration and final verification yourself.",
      `Use a Subagent specialist only when part of the work clearly matches its focus, and choose the narrowest one in the task tool's list${focus}. Otherwise do that part yourself.`,
      ...SUBAGENT_ORCHESTRATION,
      ...(input.teammates ? SUBAGENT_TEAMMATES : []),
      SUBAGENT_OWNERSHIP,
    ]
  // Child sessions and read-only specialists cannot delegate, but teammate guidance still applies to them.
  return [
    "No subagents are available in this session; do the work yourself and do not call the task tool.",
    ...(input.teammates ? SUBAGENT_TEAMMATES : []),
  ]
}

/** The delegation policy for what the current agent may launch; it advises general Subagents only where they exist. */
export function subagentPolicy(input: SubagentAvailability = ALL_SUBAGENTS) {
  return ["<subagent_policy>", ...subagentPolicyLines(input), "</subagent_policy>"].join("\n")
}

export const SUBAGENT_POLICY = subagentPolicy(ALL_SUBAGENTS)

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

export type EnvironmentOptions = {
  /** What the current agent may launch through the task tool; selects the subagent policy. Defaults to everything. */
  subagents?: SubagentAvailability
  /** The tool ids offered this step. A policy for a tool that is not offered is left out, so it costs no tokens. */
  tools?: readonly string[]
  /** This is a subagent's own session: it reports to its parent, never to the user. */
  nested?: boolean
}

export interface Interface {
  /**
   * `stable` is the same for every session of an agent on a model, so it goes out ahead of `session` (directory, date,
   * references) and the provider's prompt cache can reuse it across sessions and directories.
   */
  readonly environment: (
    model: Provider.Model,
    options?: EnvironmentOptions,
  ) => Effect.Effect<{ stable: string[]; session: string[] }>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (
        model: Provider.Model,
        options?: EnvironmentOptions,
      ) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        const session = [
          [
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
        ].filter((part): part is string => part !== undefined)
        // Without a tools list every policy is sent, as for callers that do not know what is offered.
        const offered = (id: string) => options?.tools === undefined || options.tools.includes(id)
        // Read-only agents such as explore and review cannot change the project or stop processes, so the
        // implementation loop and process-safety rules are not theirs to follow.
        const changes = ["edit", "write", "apply_patch"].some(offered)
        // A subagent never talks to the user and leaves memory to the main agent, so the identity answer and the
        // memory policies are not sent to it.
        const nested = options?.nested === true
        const stable = [
          [
            `You are Vector, an AI coding workspace for planning, editing, reviewing, and running software projects.`,
            nested
              ? undefined
              : `If the user asks what you are, answer as Vector. Do not describe yourself as a CLI tool unless the user is explicitly asking about internal compatibility layers.`,
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
          ]
            .filter((line) => line !== undefined)
            .join("\n"),
          subagentPolicy(options?.subagents ?? ALL_SUBAGENTS),
          changes && COMPLETION_POLICY,
          offered("browser") &&
            [
              "<browser_engineering_policy>",
              "When the browser tool is available, it controls the same task-specific browser the user sees in Vector.",
              "For user-facing web changes, start or discover the local preview, open it in the browser, inspect DOM and console/network/runtime evidence, exercise the affected flow, repair failures, and retest before declaring the task complete.",
              "Prefer evidence from the running application over assumptions from source code alone.",
              "External websites require approval. Never enter credentials, one-time codes, card data, make purchases, send messages, or perform destructive remote actions; pause for the user at those boundaries.",
              "</browser_engineering_policy>",
            ].join("\n"),
          offered("vector_cloud") &&
            [
              "<vector_cloud_policy>",
              "Vector Cloud is the default backend and publishing surface when the vector_cloud tool is available.",
              "For authentication, user accounts, databases, persistence, environment-backed features, or backend setup, inspect Vector Cloud database readiness before implementation and prepare the connected project database when available.",
              "If the project has no connected database, clearly recommend Vector Cloud > Database and explain that setup is required; never invent credentials.",
              "When the user asks to publish or deploy without naming a provider, publish through Vector Cloud, report its validation checks, and return the final URL.",
              "Use a directly named provider such as Vercel, Netlify, or Supabase only when the user explicitly requests that provider.",
              "</vector_cloud_policy>",
            ].join("\n"),
          changes &&
            [
              "<process_safety_policy>",
              "Never stop, kill, or replace a process unless you started it during the current task or the user explicitly approved stopping that specific process.",
              "When a preferred development port is occupied, choose another available port and report it instead of terminating the existing listener.",
              "Treat broad kill commands, PID discovery pipelines followed by kill, and process-name termination as destructive host actions requiring explicit user approval.",
              "</process_safety_policy>",
            ].join("\n"),
          !nested && LOCAL_MEMORY_POLICY,
          !nested &&
            changes &&
            [
              "<vector_project_memory>",
              "When .vector/BRAIN.md is present, treat it as durable project memory.",
              "Keep it concise and update it only for stable architecture decisions, accepted conventions, important user corrections, and recurring failure lessons.",
              "Never store API keys, passwords, tokens, private user data, transient logs, or a verbatim conversation transcript in project memory.",
              "Do not rewrite memory merely to narrate routine work.",
              "</vector_project_memory>",
            ].join("\n"),
        ].filter((part): part is string => typeof part === "string")
        return { stable, session }
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
