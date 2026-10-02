// The documentation's shape: groups in order, each leaf a page under /docs.
// Edit here and the sidebar, the pager and the search index all follow.
export type DocLink = { id: string; title: string; blurb: string }
export type DocGroup = { label: string; links: DocLink[] }

export const docsNav: DocGroup[] = [
  {
    label: "Get started",
    links: [
      {
        id: "install",
        title: "Install Vector",
        blurb: "Download the installer for your computer and run it.",
      },
      {
        id: "first-task",
        title: "Your first task",
        blurb: "Open a repository, then describe the result, the constraints and how Vector should verify the work.",
      },
    ],
  },
  {
    label: "Agents",
    links: [
      {
        id: "vector-agent",
        title: "Vector Agent",
        blurb: "The main session inspects the repository, edits files, runs commands and reports a reviewable result.",
      },
      {
        id: "subagents",
        title: "Subagents and subagent specialists",
        blurb: "Vector's agent hands self-contained pieces of a task to other agents that run at the same time.",
      },
      {
        id: "parallel-agents",
        title: "Parallel agents",
        blurb: "Run several agents at once, each in its own checkout, and watch them from one dashboard.",
      },
      {
        id: "external-agents",
        title: "Orchestrate Claude Code, Codex and Cursor",
        blurb: "Run Claude Code, Codex and Cursor in Vector workspaces, on the CLIs and subscriptions you already have.",
      },
      {
        id: "automations",
        title: "Automations",
        blurb: "An automation is one task Vector runs again and again on a schedule.",
      },
    ],
  },
  {
    label: "Features",
    links: [
      {
        id: "browser-agent",
        title: "Browser agent",
        blurb: "A real Chromium view inside Vector that the agent drives against your running product.",
      },
      {
        id: "vectorscope",
        title: "Vectorscope code review",
        blurb: "Vector's code review bot: on every pull request, on your branch before you push, and in the app.",
      },
      {
        id: "tokenomics",
        title: "Vector Tokenomics Engine",
        blurb: "Measures what each run spends from the tokens your provider reports, and stops starting automations once your daily cap is spent.",
      },
      {
        id: "mcp-and-plugins",
        title: "MCP, custom MCP servers and plugins",
        blurb: "MCP servers and plugins give an agent structured access to approved tools.",
      },
      {
        id: "skills-and-commands",
        title: "Skills and custom commands",
        blurb: "Packaged instructions for recurring work, and your own prompt templates as Markdown files.",
      },
      {
        id: "verified-completion",
        title: "Verified completion",
        blurb: "Completion you can check, instead of a confident summary.",
      },
      {
        id: "checkpoints",
        title: "Checkpoints and recovery",
        blurb: "Vector snapshots the files an agent changed as named checkpoints you can restore.",
      },
      {
        id: "local-memory",
        title: "Local memory",
        blurb: "Durable facts about how you work, kept in one MEMORY.md file on your machine.",
      },
      {
        id: "models",
        title: "Models, free models and your own keys",
        blurb: "Connect a provider account or API key, or use Free models inside of Vector where eligible.",
      },
      {
        id: "cloud-services",
        title: "Cloud services",
        blurb: "Deployments, domains, databases and logs through your own Vercel, Netlify, Supabase and AWS accounts.",
      },
      {
        id: "multiplayer",
        title: "Multiplayer and Follow mode",
        blurb: "One workspace, several people, and an editor that follows the agent as it types.",
      },
      {
        id: "desktop-app",
        title: "The desktop app",
        blurb: "Agent and Editor are two modes over the same local repository and session.",
      },
    ],
  },
  {
    label: "Terminal",
    links: [
      {
        id: "terminal-agent",
        title: "The terminal agent",
        blurb: "Run vector in any directory for the interactive agent, scripted runs and a headless server.",
      },
      {
        id: "sdk",
        title: "JavaScript SDK",
        blurb: "Connect typed JavaScript integrations to a local Vector server.",
      },
    ],
  },
  {
    label: "Reference",
    links: [
      {
        id: "permissions",
        title: "Permissions",
        blurb: "Every tool action is checked against a ruleset whose effect is allow, ask or deny.",
      },
      {
        id: "troubleshooting",
        title: "Troubleshooting and FAQ",
        blurb: "Fixes for common problems, frequent questions, and deleting your account.",
      },
      {
        id: "changelog",
        title: "Changelog",
        blurb: "Every Vector release, newest first.",
      },
    ],
  },
]

export const docsOrder: DocLink[] = docsNav.flatMap((group) => group.links)

// Pages that were merged into another one, and where each now lives. The /docs
// hash shim reads this, and vercel.json carries the same map as redirects, so an
// old /docs/<id> or /docs#<id> link still lands on its subject.
export const docsMoved: Record<string, string> = {
  "open-repository": "first-task#open-repository",
  "project-rules": "vector-agent#project-rules",
  tools: "vector-agent#tools",
  context: "vector-agent#context",
  "why-vector": "vector-agent",
  "operating-loop": "vector-agent",
  "only-in-vector": "vector-agent",
  conditions: "vector-agent",
  comparison: "vector-agent",
  "custom-agents": "subagents#custom-agents",
  "agent-workspaces": "parallel-agents",
  "agent-dashboard": "parallel-agents#agent-dashboard",
  browser: "browser-agent",
  "controlled-browser": "browser-agent#controlled-browser",
  "code-review": "vectorscope",
  "review-pipeline": "vectorscope#review-pipeline",
  github: "vectorscope#github",
  "cli-github": "vectorscope#cli-github",
  connections: "mcp-and-plugins",
  "cli-mcp": "mcp-and-plugins#cli-mcp",
  "cli-plugins": "mcp-and-plugins#cli-plugins",
  skills: "skills-and-commands",
  commands: "skills-and-commands#commands",
  review: "checkpoints#review",
  "cli-models": "models#cli-models",
  velocity: "models",
  "api-platform": "sdk",
  follow: "multiplayer#follow",
  "agent-editor": "desktop-app#agent-editor",
  composer: "desktop-app#composer",
  transcript: "desktop-app#transcript",
  "workspace-rail": "desktop-app#workspace-rail",
  "settings-appearance": "desktop-app#settings-appearance",
  "help-assistant": "desktop-app#help-assistant",
  "terminal-review": "desktop-app#terminal-review",
  "cli-terminal": "terminal-agent",
  "cli-run": "terminal-agent#cli-run",
  "cli-account": "terminal-agent#cli-account",
  "cli-sessions": "terminal-agent#cli-sessions",
  "cli-server": "terminal-agent#cli-server",
  "cli-maintenance": "terminal-agent#cli-maintenance",
  faq: "troubleshooting#faq",
  "delete-account": "troubleshooting#delete-account",
  hulk: "troubleshooting#faq",
}

export const groupOf = (id: string) => docsNav.find((group) => group.links.some((link) => link.id === id))?.label ?? ""

export const neighbours = (id: string) => {
  const index = docsOrder.findIndex((link) => link.id === id)
  return { previous: index > 0 ? docsOrder[index - 1] : undefined, next: index >= 0 ? docsOrder[index + 1] : undefined }
}
