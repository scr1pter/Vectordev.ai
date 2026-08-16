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
  {
    version: "1.17.35",
    title: "Vel, inside every session",
    summary:
      "Moved Vel into the chat composer, connected every spoken request directly to the selected session's real agent and reply, and made Cloud Services a repository-level destination available from Home.",
  },
  {
    version: "1.17.36",
    title: "Guided workspace onboarding",
    summary:
      "Introduced an interactive spotlight tour over Vector's real controls, added a durable Getting Started guide, and made the path from repository setup to agents, tools, Cloud Services, and Settings easier to learn.",
  },
  {
    version: "1.17.37",
    title: "Open beta downloads",
    summary:
      "Opened direct beta access to current macOS, Windows, and Linux installers, refreshed Vector's animated product story, and introduced a more distinct neon workspace editor treatment.",
  },
  {
    version: "1.17.38",
    title: "Faster parallel sessions",
    summary:
      "Made isolated agents appear faster as complete Vector sessions with their own subagent access, simplified inactive Settings controls, and introduced a continuous purple Matrix rainfall across the landing page.",
  },
  {
    version: "1.17.39",
    title: "A more focused private beta",
    summary:
      "Expanded Vector's engineering plugin catalog, refined the new-session workspace, and closed public installer access while preserving every cross-platform release artifact for controlled distribution.",
  },
  {
    version: "1.17.40",
    title: "Reliable visual context",
    summary:
      "Made JPEG and other common image attachments dependable, added local conversion for camera and design formats, and taught Vector to select a connected image-capable model before a visual task begins.",
  },
  {
    version: "1.17.41",
    title: "Cloud command center",
    summary:
      "Rebuilt Cloud Services around explicit repository selection, moved GitHub and GitLab publishing into Cloud, added provider-backed Supabase and AWS service views, and connected Vector's main agent to real cloud preparation, inspection, environment sync, and deployment actions.",
  },
  {
    version: "1.17.42",
    title: "Editor Agent workbench",
    summary:
      "Rebuilt the Code Editor into a focused explorer, Monaco, and resizable agent workspace; added shared model, effort, speed, Plan, and permission controls; and replaced the editor-only review queue with direct, visible workspace edits and inline Cmd+K changes.",
  },
  {
    version: "1.17.43",
    title: "One agent across chat and code",
    summary:
      "Unified the Code Editor with the active Vector conversation, model, effort, speed, permissions, attachments, and voice controls; added live file following with conflict-safe drafts; and refined the full IDE shell with workspace search, a resizable explorer, code outline, Monaco editing, and a responsive agent pane.",
  },
  {
    version: "1.17.44",
    title: "A quieter, focused IDE",
    summary:
      "Reduced the Code Editor to one Explorer control and one Agent control, moved the compact shared-agent composer beneath its conversation, removed Vel from the editor composer, and replaced the purple file canvas with a mature charcoal Monaco theme.",
  },
  {
    version: "1.17.45",
    title: "Flexible Vector billing",
    summary:
      "Added a separate $10 monthly subscription alongside the existing $99 annual license, with plan-aware desktop billing, failed-payment email notices, a three-day monthly grace period, automatic recovery after payment, and clear reactivation choices.",
  },
  {
    version: "1.17.46",
    title: "Unified account foundation",
    summary:
      "Introduced unified Vector accounts and entitlements, protected subscription downloads, server-managed provider and MCP connections, and production-safe billing, quota, and security boundaries.",
  },
  {
    version: "1.17.47",
    title: "One account for every Vector surface",
    summary:
      "Rebuilt the signed-in experience as an animated Vector command center, added complete website settings for profile, security, billing, and legal controls, unified product access behind one membership, and introduced secure internal grants for founder and beta accounts without weakening paid subscription enforcement.",
  },
  {
    version: "1.17.48",
    title: "Your models, tools, and computer",
    summary:
      "Added encrypted BYOK model providers, managed MCP connections, and an approval-gated Vector desktop companion with independent browser and terminal permissions.",
  },
  {
    version: "1.17.49",
    title: "Desktop-first Vector",
    summary:
      "Retired the experimental website account, Builder, Cloud Agent, and API Studio surfaces; restored Vector's public site to product, documentation, purchase, releases, and legal pages; preserved Stripe licensing; and removed the unused desktop companion while keeping Vector Cloud Services inside the IDE.",
  },
  {
    version: "1.17.50",
    title: "Orchestrated and verified completion",
    summary:
      "Added dependency-aware subagent orchestration with file ownership boundaries, optional LLM-as-a-judge verification and repair loops, durable scheduled-agent completion tracking, in-session GitHub pull-request review, visible testing state, and a substantially expanded MCP plugin catalog.",
  },
  {
    version: "1.17.51",
    title: "Real spend, real answers",
    summary:
      "The model economics engine now records the provider's own reported tokens and cost for every run instead of estimating from character counts, and ranks models on measured spend once correctness ties. Added the Vector Help AI Assistant, a docs-and-chat side panel answering strictly from Vector's own documentation so it cannot invent controls that do not exist. Replaced the workspace settings gear with a one-click bug reporter that sends your app version and platform along with the report.",
  },
  {
    version: "1.17.52",
    title: "Agents that work together",
    summary:
      "Agents can now share one workspace instead of each getting their own: they see each other's edits as they happen, message each other while working, and Vector names the file and both agents when two of them hold the same one. The Agent Dashboard in Project tools shows every agent live with its task, model, spend, and the conversation between them, and the code editor attributes each edit to the agent that made it. Adds Pull Requests with Vector AI review, local memory that follows you across every repository and can be erased outright, a Vector Help AI Assistant answering only from Vector's own documentation, one-click bug reporting, selectable Claude Code, Codex, and Cursor runtimes, and a rebuilt Scheduled tasks screen with real recurrence.",
  },
]
