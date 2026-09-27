// The documentation's shape: groups in order, each leaf a page under /docs.
// Generated from the single-page docs; edit here and the sidebar, the pager and
// the search index all follow.
export type DocLink = { id: string; title: string; blurb: string }
export type DocGroup = { label: string; links: DocLink[] }

export const docsNav: DocGroup[] = [
  {
    label: "Start here",
    links: [
      {
        id: "install",
        title: "Install Vector",
        blurb:
          "Download the installer that matches your computer, open it, and move through the operating system's installation flow.",
      },
      {
        id: "open-repository",
        title: "Open a repository",
        blurb: "From Home, choose Open repository and select a local project folder.",
      },
      {
        id: "first-task",
        title: "Run your first task",
        blurb: "Describe the result, the constraints, and how Vector should verify the work.",
      },
    ],
  },
  {
    label: "Build",
    links: [
      {
        id: "vector-agent",
        title: "Vector Agent",
        blurb:
          "The main session can inspect the repository, edit files, run commands, use project tools, and report a reviewable result.",
      },
      {
        id: "agent-workspaces",
        title: "Agent workspaces",
        blurb:
          "Use another workspace when work can happen independently: one agent can handle the interface while another investigates tests or infrastructure.",
      },
      {
        id: "project-rules",
        title: "Project rules",
        blurb:
          'A rule is a standard written the way you would say it to a new teammate — "we don\'t put database query logic in the controller".',
      },
      {
        id: "agent-dashboard",
        title: "Agent Dashboard",
        blurb: "Every agent in the project on one board: Running, Needs you and Done.",
      },
      {
        id: "external-agents",
        title: "Claude Code, Codex and Cursor",
        blurb: "A workspace can run someone else's CLI instead of Vector's own agent.",
      },
      {
        id: "automations",
        title: "Automations",
        blurb: "An automation is one task Vector runs again and again on a schedule.",
      },
      {
        id: "agent-editor",
        title: "Agent and Editor",
        blurb: "Agent and Editor are two modes over one Vector session.",
      },
      {
        id: "browser",
        title: "Using the browser",
        blurb: "The Browser is attached to the current repository and session.",
      },
      {
        id: "terminal-review",
        title: "Terminal and review",
        blurb: "The Terminal runs commands inside the active repository or isolated workspace.",
      },
    ],
  },
  {
    label: "Ship and connect",
    links: [
      {
        id: "cloud-services",
        title: "Cloud Services",
        blurb: "Cloud work is part of the task, not a panel you operate afterwards.",
      },
      {
        id: "models",
        title: "Models and BYOK",
        blurb: "You do not need an API key.",
      },
      {
        id: "connections",
        title: "MCP and connections",
        blurb: "MCP servers and project connections give an agent structured access to approved tools.",
      },
      {
        id: "review",
        title: "Review and recovery",
        blurb: "Review changed files before merging or publishing.",
      },
      {
        id: "multiplayer",
        title: "Multiplayer",
        blurb: "One workspace, several people.",
      },
      {
        id: "github",
        title: "GitHub automation",
        blurb: "Task in, pull request out.",
      },
      {
        id: "code-review",
        title: "Vectorscope, the code review bot",
        blurb: "Vector's code review bot: on every pull request, on your branch before you push, and in the workspace.",
      },
      {
        id: "review-pipeline",
        title: "How a review runs",
        blurb:
          "The path from a trigger to a comment: the skip ladder, what the reviewer reads, the verify pass, noise control and the limits.",
      },
      {
        id: "follow",
        title: "Follow mode",
        blurb: "Watch the agent type.",
      },
    ],
  },
  {
    label: "The workspace",
    links: [
      {
        id: "composer",
        title: "The composer",
        blurb:
          "The box at the bottom of a session is where you type the task, and it carries every per-message control: which agent answers, which model, how hard that model thinks, how fast to run, dictat",
      },
      {
        id: "transcript",
        title: "The session transcript",
        blurb:
          "The conversation is a timeline of turns: your messages, the agent's text, collapsible thinking blocks, tool calls with their status and error cards, and a per-turn summary of how many tools ",
      },
      {
        id: "checkpoints",
        title: "Checkpoints, archaeology and the timeline",
        blurb: "Vector snapshots the files an agent changed as named checkpoints.",
      },
      {
        id: "workspace-rail",
        title: "The rail, the palette and search",
        blurb:
          "The slim rail down the left edge is the app's top-level navigation: Home, Projects, Search, Agent Dashboard, Browser, Pull Requests, Plugins, Connections and Settings, with a help cluster fo",
      },
      {
        id: "settings-appearance",
        title: "Appearance and workspace settings",
        blurb:
          "Appearance sets the colour scheme, theme, language and Vector's own palette — accent, workspace, sidebar and chat colours — with no external service involved.",
      },
      {
        id: "help-assistant",
        title: "Help inside the app",
        blurb: "The help panel answers questions without leaving Vector.",
      },
    ],
  },
  {
    label: "How the agent works",
    links: [
      {
        id: "tools",
        title: "The agent's tools",
        blurb:
          "The agent changes your project through a fixed set of first-class tools rather than free-form shell commands, so its behaviour is the same in the desktop app, in the terminal and in GitHub A",
      },
      {
        id: "permissions",
        title: "Permissions",
        blurb: "Every tool action is checked against a ruleset whose effect is allow, ask or deny.",
      },
      {
        id: "context",
        title: "Context and compaction",
        blurb: "A long session does not fail when it reaches the model's context limit.",
      },
      {
        id: "skills",
        title: "Skills",
        blurb:
          "A skill is a packaged set of instructions for a recurring kind of work — a house style, a review checklist, a deployment runbook.",
      },
      {
        id: "commands",
        title: "Custom commands",
        blurb:
          "Your own commands are Markdown files in a command/ or commands/ folder, in the project or in your global config.",
      },
      {
        id: "custom-agents",
        title: "Custom agents and subagents",
        blurb:
          "Vector ships nine subagents an agent can delegate to: a general one, and the specialists explore, review, judge, debug, test, security, performance and migration.",
      },
    ],
  },
  {
    label: "Terminal",
    links: [
      {
        id: "cli-terminal",
        title: "The terminal agent",
        blurb:
          "Running vector with no subcommand starts the interactive agent in the current directory, or in the path you pass.",
      },
      {
        id: "cli-run",
        title: "One-shot and scripted runs",
        blurb: "vector run sends one prompt and prints the result.",
      },
      {
        id: "cli-account",
        title: "Account and CLI tokens",
        blurb: "The published vector binary is free but needs a Vector account.",
      },
      {
        id: "cli-models",
        title: "Models and variants in the terminal",
        blurb:
          "vector models lists every model available to you — the ones included with Vector and the providers you have connected.",
      },
      {
        id: "cli-sessions",
        title: "Sessions: list, export, share",
        blurb:
          "vector session list prints recent sessions, with --max-count to cap them and --format for scripting; vector session delete &lt;id&gt; removes one permanently.",
      },
      {
        id: "cli-mcp",
        title: "MCP from the terminal",
        blurb:
          "vector mcp add registers a server: --url for a remote one with --header KEY=VALUE, or a command with --env KEY=VALUE for a local one.",
      },
      {
        id: "cli-plugins",
        title: "Plugins",
        blurb:
          "vector plugin &lt;module&gt; installs an npm module as a plugin and writes it into your config; --global installs into the global config rather than the project's, and --force replaces a ver",
      },
      {
        id: "cli-server",
        title: "Server, web and editors",
        blurb:
          "vector serve runs the agent as a headless server with --port and --hostname; vector web starts the same server and opens the browser interface.",
      },
      {
        id: "sdk",
        title: "JavaScript SDK",
        blurb: "Connect typed JavaScript integrations to a local Vector server.",
      },
      {
        id: "cli-github",
        title: "GitHub from the terminal",
        blurb:
          "vector pr &lt;number&gt; fetches a pull request's branch, checks it out and starts Vector in that working tree — the shortcut for picking a review conversation up on your own machine.",
      },
      {
        id: "cli-maintenance",
        title: "Upkeep, flags and your data",
        blurb:
          "vector upgrade moves the CLI to the newest version, or one you name, with --method when several installation methods are possible.",
      },
    ],
  },
  {
    label: "Help",
    links: [
      {
        id: "delete-account",
        title: "Delete your account",
        blurb: "Delete your Vector account, what that removes, and what stays on your own machine.",
      },
      {
        id: "troubleshooting",
        title: "Troubleshooting",
        blurb:
          "Confirm a provider and model are connected, then check whether the provider reports a quota or authentication error.",
      },
      {
        id: "faq",
        title: "Frequently asked questions",
        blurb: "{item.answer}",
      },
    ],
  },
  {
    label: "Why Vector",
    links: [
      {
        id: "why-vector",
        title: "Why Vector",
        blurb: "Most tools write the code.",
      },
      {
        id: "operating-loop",
        title: "One operating loop",
        blurb: "From a brief to verified, shipped work.",
      },
      {
        id: "local-memory",
        title: "Local memory",
        blurb:
          "Vector lets you save durable facts about how you work — your stack, your conventions, the corrections you would otherwise repeat — in one MEMORY.md file inside Vector's local app config dire",
      },
      {
        id: "tokenomics",
        title: "Tokenomics engine",
        blurb: "Priced from the tokens your provider reported.",
      },
      {
        id: "hulk",
        title: "HULK — hidden unique licence keys",
        blurb: "Every copy has its own key.",
      },
      {
        id: "verified-completion",
        title: "Verified completion",
        blurb: "Completion you can check, instead of a confident summary.",
      },
      {
        id: "controlled-browser",
        title: "Controlled browser",
        blurb: "The browser is a real Chromium view embedded in the Vector window, not a screenshot service.",
      },
      {
        id: "only-in-vector",
        title: "Only in Vector",
        blurb: "Things that are rarely true in one place.",
      },
      {
        id: "conditions",
        title: "The conditions, stated",
        blurb: "Where a capability has a catch, here it is.",
      },
      {
        id: "subagents",
        title: "Subagents and subagent specialists",
        blurb: "Vector's agent does not have to do every part of a task itself.",
      },
      {
        id: "comparison",
        title: "How Vector compares",
        blurb:
          "Vector combines capabilities commonly split across an agent, an editor, a browser, a Git client, and a deployment dashboard.",
      },
      {
        id: "velocity",
        title: "Vector Velocity model Coming soon",
        blurb:
          "Vector Velocity is Vector's own model — over 300 billion parameters — tuned for the loop Vector actually runs — planning, tool calls, edits, checks, and verification — rather than for open-e",
      },
      {
        id: "api-platform",
        title: "API platform Coming soon",
        blurb:
          "Programmatic access to the same workspace: start sessions, run tasks, read transcripts and measured spend, manage connections, and trigger automations from your own systems and CI.",
      },
      {
        id: "changelog",
        title: "Changelog",
        blurb: "Keep the whole build in view.",
      },
    ],
  },
]

export const docsOrder: DocLink[] = docsNav.flatMap((group) => group.links)

export const groupOf = (id: string) => docsNav.find((group) => group.links.some((link) => link.id === id))?.label ?? ""

export const neighbours = (id: string) => {
  const index = docsOrder.findIndex((link) => link.id === id)
  return { previous: index > 0 ? docsOrder[index - 1] : undefined, next: index >= 0 ? docsOrder[index + 1] : undefined }
}
