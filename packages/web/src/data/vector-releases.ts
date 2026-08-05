export type VectorRelease = {
  version: string
  title: string
  summary: string
}

export const releaseSeries: VectorRelease[] = [
  {
    version: "1.0",
    title: "Desktop foundation",
    summary: "Vector became a local desktop engineering workspace with repository-aware agent sessions.",
  },
  {
    version: "1.1",
    title: "Project sessions",
    summary: "Projects, conversations, local persistence, and repeatable repository entry flows were established.",
  },
  {
    version: "1.2",
    title: "Provider choice",
    summary: "Bring-your-own-key providers and model selection moved into the desktop workflow.",
  },
  {
    version: "1.3",
    title: "Visible execution",
    summary: "Tool calls, file activity, terminal work, and clearer execution state became part of the session.",
  },
  {
    version: "1.4",
    title: "Vector identity",
    summary: "The interface, desktop packaging, assets, and product language moved to the Vector brand.",
  },
  {
    version: "1.5",
    title: "Review foundations",
    summary: "Changed-file review, checkpoints, and safer project recovery began to form a trust layer.",
  },
  {
    version: "1.6",
    title: "Codespace",
    summary: "A dedicated editor experience added file navigation, language-aware editing, and project diagnostics.",
  },
  {
    version: "1.7",
    title: "Project tools",
    summary: "Terminal, browser preview, project context, and engineering utilities became connected session tools.",
  },
  {
    version: "1.8",
    title: "Personal workspace",
    summary: "Appearance, behavior, keyboard, editor, chat, and local preference controls were expanded.",
  },
  {
    version: "1.9",
    title: "Code intelligence",
    summary: "Search, completion, diagnostics, inline assistance, and code-oriented context were strengthened.",
  },
  {
    version: "1.10",
    title: "Browser engineering",
    summary: "Browser control evolved from a passive preview toward visible testing and diagnostic workflows.",
  },
  {
    version: "1.11",
    title: "Project history",
    summary: "Timeline events, checkpoints, change explanations, and project memory became easier to inspect.",
  },
  {
    version: "1.12",
    title: "Parallel execution",
    summary: "Isolated agent workspaces introduced independent files, branches, terminals, and review boundaries.",
  },
  {
    version: "1.13",
    title: "Cloud connections",
    summary: "Publishing, deployment state, environment configuration, and project connections joined the workspace.",
  },
  {
    version: "1.14",
    title: "Reliability pass",
    summary:
      "Desktop launches, model selection, settings behavior, preview reliability, and cross-platform packaging received sustained fixes.",
  },
  {
    version: "1.15",
    title: "Integrated engineering",
    summary:
      "Agent, editor, browser, review, terminal, and cloud surfaces were brought into a more consistent project model.",
  },
  {
    version: "1.16",
    title: "Agent coordination",
    summary:
      "Parallel workspaces, background status, subagents, model routing, and orchestration controls were expanded.",
  },
  {
    version: "1.17",
    title: "Unified Vector workspace",
    summary:
      "The current line focuses on task-specific state, live multi-agent work, a controlled browser, transparent usage, and production packaging.",
  },
]

export const release117: VectorRelease[] = [
  {
    version: "1.17.0",
    title: "Unified shell",
    summary: "Introduced the current project-centered desktop shell and consolidated the primary engineering surfaces.",
  },
  {
    version: "1.17.1",
    title: "Workspace navigation",
    summary: "Improved movement between project sessions, tools, and isolated workspaces.",
  },
  {
    version: "1.17.2",
    title: "Agent workspace detail",
    summary: "Expanded per-workspace conversation, terminal activity, changed files, status, and review context.",
  },
  {
    version: "1.17.3",
    title: "Background execution",
    summary: "Agent runs could remain visible and manageable while users moved through other Vector surfaces.",
  },
  {
    version: "1.17.4",
    title: "Browser state",
    summary:
      "Connected visible browser state, navigation, screenshots, and diagnostics more closely to project sessions.",
  },
  {
    version: "1.17.5",
    title: "Engineering timeline",
    summary: "Recorded important file, terminal, browser, checkpoint, and review events per project.",
  },
  {
    version: "1.17.6",
    title: "Codespace stabilization",
    summary: "Focused the editor on real repository files, direct local saves, diagnostics, and dependable navigation.",
  },
  {
    version: "1.17.7",
    title: "Review detail",
    summary: "Improved changed-file inspection and the path from agent output to a reviewable diff.",
  },
  {
    version: "1.17.8",
    title: "Project memory",
    summary: "Added repository-owned context and stronger task-specific indexing for later sessions.",
  },
  {
    version: "1.17.9",
    title: "Trust signals",
    summary: "Expanded risk, secret, validation, rollback, and checkpoint information around proposed changes.",
  },
  {
    version: "1.17.10",
    title: "Model economics",
    summary: "Made model usage, token categories, context consumption, and recorded cost easier to inspect.",
  },
  {
    version: "1.17.11",
    title: "Canvas",
    summary: "Introduced a multitasking surface for arranging project tools without abandoning the active repository.",
  },
  {
    version: "1.17.12",
    title: "Cloud workspace",
    summary: "Expanded deployment, domain, environment, health, log, and data-service project controls.",
  },
  {
    version: "1.17.13",
    title: "Desktop hardening",
    summary: "Addressed launch behavior, window lifecycle, permissions, platform identity, and packaging reliability.",
  },
  {
    version: "1.17.14",
    title: "Provider and MCP reliability",
    summary: "Improved provider discovery, model selection, MCP setup, and clear connection states.",
  },
  {
    version: "1.17.15",
    title: "Agent runtime choices",
    summary: "Added clearer integration paths for Vector Agent and detected Claude Code, Codex, and Cursor runtimes.",
  },
  {
    version: "1.17.16",
    title: "Parallel workspace execution",
    summary:
      "Strengthened isolated workspace creation, status, terminal boundaries, review, merge, and discard behavior.",
  },
  {
    version: "1.17.17",
    title: "Controlled-browser loop",
    summary: "Improved the loop from page observation to diagnostics, repair, screenshot evidence, and retesting.",
  },
  {
    version: "1.17.18",
    title: "Task-specific state",
    summary:
      "Scoped browser, usage, context, cloud, and engineering-tool state more consistently to the active task and repository.",
  },
  {
    version: "1.17.19",
    title: "Composer refinement",
    summary: "Refined effort controls, prompt layout, voice dictation feedback, and task steering.",
  },
  {
    version: "1.17.20",
    title: "Stable project workspace",
    summary: "Consolidated the project sidebar, agent workspaces, review affordances, and local execution behavior.",
  },
  {
    version: "1.17.21",
    title: "Follow-up queue",
    summary:
      "Added visible queued prompts, steering, queue limits, completion notifications, and focused settings cleanup.",
  },
  {
    version: "1.17.22",
    title: "Repository language",
    summary:
      "Updated project entry language, onboarding, and home navigation around repositories rather than generic tasks.",
  },
  {
    version: "1.17.23",
    title: "Editor navigation",
    summary:
      "Separated code-editor search from project review navigation and improved direct file opening in Codespace.",
  },
  {
    version: "1.17.24",
    title: "Cross-platform repair",
    summary:
      "Fixed installer, sidebar, browser, cloud, voice, and layout issues across macOS, Windows, and Linux builds.",
  },
  {
    version: "1.17.25",
    title: "In-app updates",
    summary:
      "Introduced the visible update workflow, refreshed release artifacts, and improved the path to the latest desktop build.",
  },
  {
    version: "1.17.26",
    title: "Updater and navigation repair",
    summary:
      "Rebuilt the macOS replacement handoff, added clearer version state, simplified the workspace navigation, and refreshed the Vector website and documentation.",
  },
  {
    version: "1.17.27",
    title: "Living workspace",
    summary:
      "Brought Vector's interactive ASCII field into the desktop Home workspace, made the packaged window open reliably on launch, refreshed the release history, and synchronized the macOS, Windows, and Linux release line.",
  },
  {
    version: "1.17.28",
    title: "Task-bound agents",
    summary:
      "Kept every isolated agent and worktree attached to the task that created it, prevented managed agent folders from appearing as standalone projects, and cleaned stale workspace entries from Vector's project memory.",
  },
  {
    version: "1.17.29",
    title: "Licensed public release",
    summary:
      "Added secure annual Stripe billing, purchase confirmation email, one-computer activation, renewal controls, legal notices, and a gated installer handoff for Vector's paid desktop launch.",
  },
  {
    version: "1.17.30",
    title: "The Vector product suite",
    summary:
      "Introduced one unified Product Hub for Vector Code, Vector Work, and Vector Cloud; added project-based Work tasks with optional repositories; made Cloud globally project-selectable; and launched Vel as Vector's task-aware voice assistant.",
  },
  {
    version: "1.17.31",
    title: "Focused Work and session-bound Vel",
    summary:
      "Limited Vector Work to agent chat, parallel workspaces, browser control, Vel, MCP, and plugins; moved Vel into active task and session tools; and ensured voice requests stay inside the exact visible session.",
  },
  {
    version: "1.17.32",
    title: "Conversational Vel and separate Work projects",
    summary:
      "Turned Vel into a spoken active-session agent with native desktop replies and real coding handoffs, while keeping Vector Work projects separate from Vector Code repositories.",
  },
  {
    version: "1.17.33",
    title: "Natural voice turns with Vel",
    summary:
      "Added automatic end-of-speech detection, voice-first session creation, interruptible spoken replies, and clearly italicized Vel conversations inside the active Vector chat.",
  },
  {
    version: "1.17.34",
    title: "One Vector workspace",
    summary:
      "Retired the Vector Work product split, restored the repository-first home, moved Cloud Services directly into that workflow, and repositioned Vector as one local-first, bring-your-own-key agentic workspace for builders.",
  },
]
