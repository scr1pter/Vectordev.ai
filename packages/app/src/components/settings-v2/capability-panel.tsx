import { For, type Component } from "solid-js"
import "./settings-v2.css"

type CapabilityItem = {
  title: string
  description: string
  status?: string
}

export const SettingsCapabilityPanelV2: Component<{
  title: string
  eyebrow?: string
  description: string
  items: CapabilityItem[]
}> = (props) => {
  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{props.title}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <div class="vector-settings-hero">
            <span>{props.eyebrow ?? "Vector workspace"}</span>
            <h3>{props.title}</h3>
            <p>{props.description}</p>
          </div>
        </section>

        <section class="settings-v2-section">
          <div class="vector-settings-capability-grid">
            <For each={props.items}>
              {(item) => (
                <article class="vector-settings-capability-card">
                  <div>
                    <h4>{item.title}</h4>
                    <p>{item.description}</p>
                  </div>
                  <span>{item.status ?? "Ready"}</span>
                </article>
              )}
            </For>
          </div>
        </section>
      </div>
    </>
  )
}

export const capabilityPages = {
  usage: {
    title: "Usage and billing",
    eyebrow: "Plan control",
    description:
      "Track model access, local usage expectations, and the BYOK setup that keeps Vector predictable for builders.",
    items: [
      {
        title: "BYOK-first usage",
        description: "Vector prefers your own provider keys so costs stay visible and portable.",
      },
      {
        title: "Free Vector models",
        description: "The built-in Vector provider appears in model selection when available.",
      },
      {
        title: "Plan-ready surface",
        description: "Billing copy is isolated here so Stripe can be attached cleanly later.",
        status: "UI ready",
      },
    ],
  },
  appshots: {
    title: "Appshots",
    eyebrow: "Visual history",
    description: "Capture meaningful app states for reviews, demos, and before/after product polish.",
    items: [
      { title: "Preview snapshots", description: "Save the current app view as a review artifact.", status: "Local" },
      { title: "Change snapshots", description: "Pair visual state with the files Vector touched." },
      { title: "Demo trail", description: "Keep a lightweight record of what the project looked like after major edits." },
    ],
  },
  mcp: {
    title: "MCP servers",
    eyebrow: "Integrations",
    description: "Connect trusted tools and data sources while keeping Vector's core coding workflow simple.",
    items: [
      { title: "Server registry", description: "Review connected MCP servers and their workspace role." },
      { title: "Tool awareness", description: "Vector can surface available tools to the agent when the runtime exposes them." },
      { title: "Safer prompts", description: "MCP context is kept separate from user-facing brand and design settings." },
    ],
  },
  browser: {
    title: "Browser",
    eyebrow: "Preview and inspect",
    description: "Use browser context for web apps, visual checks, and product QA without leaving the coding flow.",
    items: [
      { title: "Preview-first workflow", description: "Keep the app preview close to the chat and file review surface." },
      { title: "Visual debugging", description: "Use screenshots and browser state as context for repair prompts." },
      { title: "Product checks", description: "Validate layout, spacing, and user-facing behavior from inside Vector." },
    ],
  },
  computer: {
    title: "Computer use",
    eyebrow: "Automation",
    description: "Reserve automation for deliberate workflows where the user stays in control.",
    items: [
      { title: "Explicit actions", description: "Computer-use style actions should be requested clearly before they run." },
      { title: "Visible state", description: "Vector keeps risky automation out of the default coding path." },
      { title: "Review before trust", description: "Generated file changes still belong in review surfaces." },
    ],
  },
  hooks: {
    title: "Hooks",
    eyebrow: "Coding workflow",
    description: "Attach repeatable checks around agent work so code generation feels less random.",
    items: [
      { title: "Before run", description: "Prepare context, files, and model instructions before the agent starts." },
      { title: "After edit", description: "Run cleanup, format checks, and explain what changed." },
      { title: "Before review", description: "Block unsafe edits before they reach the final review step." },
    ],
  },
  connections: {
    title: "Connections",
    eyebrow: "Providers",
    description: "Manage model providers, custom endpoints, and connection health from one place.",
    items: [
      { title: "Provider health", description: "See which providers Vector can use for code generation." },
      { title: "Custom endpoints", description: "Bring compatible endpoints without changing the editor workflow." },
      { title: "Model routing", description: "Keep stronger models available for larger repo work." },
    ],
  },
  git: {
    title: "Git",
    eyebrow: "Version control",
    description: "Keep AI changes attached to real branches, diffs, and commits.",
    items: [
      { title: "Diff-first review", description: "Review generated code before it becomes part of your project." },
      { title: "Branch awareness", description: "Surface current branch context in the workspace." },
      { title: "GitHub path", description: "GitHub push can be connected once OAuth is configured." },
    ],
  },
  environments: {
    title: "Environments",
    eyebrow: "Runtime",
    description: "Keep runtime choices visible so projects can move between local and sandbox execution.",
    items: [
      { title: "Local runtime", description: "Use the user's machine for normal development when available." },
      { title: "Sandbox-ready", description: "Use environment metadata to prepare future sandbox execution." },
      { title: "Secrets discipline", description: "Document required keys without hardcoding them in project files." },
    ],
  },
  worktrees: {
    title: "Worktrees",
    eyebrow: "Parallel work",
    description: "Separate experiments, fixes, and demo branches without losing project context.",
    items: [
      { title: "Safer experiments", description: "Keep risky work separate from the main demo path." },
      { title: "Branch mapping", description: "Pair chats with the project branch they changed." },
      { title: "Review-ready", description: "Make alternate attempts easier to compare before merging." },
    ],
  },
  archived: {
    title: "Archived chats",
    eyebrow: "History",
    description: "Keep old work out of the way while preserving useful context.",
    items: [
      { title: "Cleaner sidebar", description: "Move stale chats away from active project work." },
      { title: "Recoverable context", description: "Bring archived context back when a project needs it." },
      { title: "Pitch prep", description: "Keep demo chats focused and easy to scan." },
    ],
  },
}
