import type { SpotlightStep } from "./spotlight-tour"

// The full tour: every control in the shipped UI, surface by surface, in the
// order a new user meets them — Home, the composer, the sidebar, the panels,
// Cloud Services, then Settings. Claims here must match what each control
// actually does; when a surface changes, its step changes with it.
//
// The host (layout) supplies the state transitions. Every callback must be
// idempotent: steps re-run prepare when the user goes Back across a boundary.

export type SpotlightTourHost = {
  goHome: () => void
  /** Land on a draft/session route so the composer and sidebar exist. */
  ensureWorkspace: () => void
  /** Un-hide the sidebar and expand the project tree. */
  showSidebar: () => void
  openScheduledPanel: () => void
  closeScheduledPanel: () => void
  goCloud: () => void
  openSettingsDialog: () => void
  closeSettingsDialog: () => void
}

const settingsTab = (value: string) => `.settings-v2 [data-slot="tabs-v2-trigger"][data-value="${value}"]`

const byText = (selector: string, text: string) => () => {
  const nodes = document.querySelectorAll(selector)
  for (const node of nodes) {
    if (node.textContent?.includes(text)) return node
  }
  return undefined
}

export function createSpotlightSteps(host: SpotlightTourHost): SpotlightStep[] {
  const workspace = (step: Omit<SpotlightStep, "group" | "prepare"> & { prepare?: () => void }): SpotlightStep => ({
    ...step,
    group: "workspace",
    prepare: () => {
      host.ensureWorkspace()
      host.showSidebar()
      step.prepare?.()
    },
  })

  return [
    {
      id: "welcome",
      section: "Welcome to Vector",
      title: "Let's walk the whole workspace.",
      body: "Vector is a bring-your-own-key agentic workspace: open a repository, code directly, or hand outcomes to agents. This tour moves screen by screen and lights up every control as we go.",
      tip: "Use → and ← (or Enter) to move, Esc to leave. You can replay the tour any time from Getting started.",
      prepare: host.goHome,
    },
    {
      id: "home-overview",
      section: "Home",
      title: "Home is where every project starts.",
      body: "Open a repository, start a session, or pick up yesterday's work. Everything else in Vector — agents, editor, terminal, browser, review — happens inside a project you open from here.",
      target: "[data-vector-home-overview]",
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-start-building",
      section: "Home",
      title: "Start building.",
      body: "The front door: opens a fresh session on your selected repository. Describe one outcome in plain language and press Enter — the agent plans, edits files, runs commands, and narrates each step.",
      tip: "Brief it like an engineer: name the outcome, not the implementation.",
      target: '[data-vector-home] .vector-home-heading__actions button[data-variant="primary"]',
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-cloud-button",
      section: "Home",
      title: "Cloud Services.",
      body: "One console for shipping: deployments, live health checks, domains, environment variables, databases, and build configuration — scoped to whichever repository you pick. We'll visit it later in the tour.",
      target: byText('[data-vector-home] .vector-home-heading__actions button[data-variant="secondary"]', "Cloud services"),
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-settings-button",
      section: "Home",
      title: "Settings, one click away.",
      body: "Providers and keys, models, appearance, and everything else about how Vector runs. It's also reachable from the gear at the bottom of the sidebar — we'll open it at the end of the tour.",
      target: byText('[data-vector-home] .vector-home-heading__actions button[data-variant="secondary"]', "Settings"),
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-project-deck",
      section: "Home",
      title: "Your repositories.",
      body: "Add a repository to put Vector to work inside it. Click a card to select it, double-click to jump straight into a new session, and use the ⋯ menu to start, edit, or close a repository.",
      target: ".vector-home-project-deck",
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-activity",
      section: "Home",
      title: "Your activity, at a glance.",
      body: "Local streak, token use, completed chats, and your most-used model. Click it to open the full usage report in Settings.",
      target: ".vector-home-usage__summary",
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-search",
      section: "Home",
      title: "Find any session fast.",
      body: "Search filters your recent sessions by title — faster than scrolling once the list grows. Press ⌘F (Ctrl+F) from Home to jump straight here.",
      target: '[data-component="home-session-search"]',
      placement: "bottom",
      prepare: host.goHome,
    },
    {
      id: "home-recents",
      section: "Home",
      title: "Recent work lives here.",
      body: "Every session you've run, newest first. Click one to reopen it exactly where you left off — same conversation, same files, same project.",
      target: ".vector-home-recents",
      placement: "top",
      prepare: host.goHome,
    },

    workspace({
      id: "composer",
      section: "Composer",
      title: "This is where you brief the agent.",
      body: "A session starts with one clear message. Everything around the input — model, mode, effort, speed — tunes how the agent works on it.",
      target: '[data-component="session-new-composer"], [data-component="session-composer"]',
      placement: "top",
      sentinel: true,
    }),
    workspace({
      id: "prompt-editor",
      section: "Composer",
      title: "The message box.",
      body: "Describe one outcome in plain language and press Enter. Paste exact error text when something breaks, and drop files straight in. Typing ! at the start switches to shell mode for a one-off command.",
      target: '[data-component="prompt-input"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-project",
      section: "Composer",
      title: "Pick the repository.",
      body: "A session is always scoped to one repository. Choose it here — or add a new folder — before you send the first message.",
      target: '[data-action="prompt-project"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-model",
      section: "Composer",
      title: "The model chip.",
      body: "Shows which model answers this session. Click to switch — per task, not globally — between the providers and models you've enabled in Settings.",
      tip: "Keep a free model around for quick questions and a strong one for real work.",
      target: '[data-action="prompt-model"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-mode",
      section: "Composer",
      title: "Mode: how much rope the agent gets.",
      body: "Manual asks before edits and commands, Plan makes the agent propose an approach before touching files, and Full access lets it work without pausing for approval.",
      target: '[data-action="prompt-mode"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-effort",
      section: "Composer",
      title: "Model effort.",
      body: "Some models expose reasoning-effort variants. Slide it up for hard problems, down for quick edits — it trades depth for speed and cost.",
      target: '[data-action="prompt-model-variant"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-speed",
      section: "Composer",
      title: "Execution speed.",
      body: "Normal verifies as it goes; Quick and Fast trim the agent's double-checking for simple tasks where you'd rather have the answer sooner.",
      target: '[data-action="prompt-execution-mode"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-vel",
      section: "Composer",
      title: "Vel — talk through the work.",
      body: "Starts a voice call scoped to this exact session. Vel transcribes what you say directly to the active agent, then speaks that agent's real reply — no handoff or separate hidden conversation.",
      target: '[data-action="prompt-vel"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-mic",
      section: "Composer",
      title: "Dictate instead of typing.",
      body: "Tap, speak, and the transcript lands in the box ready to edit. On desktop, transcription runs entirely on your machine with a local Whisper model — audio never leaves your computer.",
      target: '[data-action="prompt-mic"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-attach",
      section: "Composer",
      title: "Attach files.",
      body: "Give the agent screenshots, specs, or logs alongside your message. You can also just drag files onto the composer.",
      target: '[data-action="prompt-attach"]',
      placement: "top",
    }),
    workspace({
      id: "prompt-send",
      section: "Composer",
      title: "Send — and Stop.",
      body: "Sends your message and starts the run. While the agent works this becomes Stop, and new messages queue up so you can keep steering without interrupting.",
      target: '[data-action="prompt-submit"]',
      placement: "top",
    }),

    workspace({
      id: "sidebar-rail",
      section: "Sidebar",
      title: "The sidebar: your whole workspace.",
      body: "Once you're inside a project, everything lives on this rail — the project's agents, its tools, connections, and settings. It appears on project surfaces and stays out of the way on Home.",
      target: "[data-vector-navigation]",
      placement: "right",
    }),
    workspace({
      id: "sidebar-home",
      section: "Sidebar",
      title: "Back to Home.",
      body: "Returns to the overview without closing anything — your session keeps running and you can jump back from Recent work.",
      target: "[data-vector-nav-home]",
      placement: "right",
    }),
    workspace({
      id: "sidebar-find",
      section: "Sidebar",
      title: "Find in project.",
      body: "Opens the file finder for the active project — type a few characters, land on the file. Needs an active session, since it searches that project's tree.",
      target: '[data-vector-navigation] [aria-label="Find in project"]',
      placement: "right",
    }),
    workspace({
      id: "sidebar-hide",
      section: "Sidebar",
      title: "Hide the sidebar.",
      body: "Collapses the rail for full-width work. A floating toggle appears at the top-left corner to bring it back, and the edge handle lets you resize it any time.",
      target: '[aria-label="Hide Vector sidebar"]',
      placement: "right",
    }),
    workspace({
      id: "sidebar-project",
      section: "Sidebar",
      title: "The active project.",
      body: "Shows which repository this workspace is about, with a count of its agents. Click to collapse or expand the tree below it.",
      target: "[data-vector-project-heading]",
      placement: "right",
    }),
    workspace({
      id: "sidebar-new-workspace",
      section: "Sidebar",
      title: "New workspace: parallel agents.",
      body: "Launches an isolated agent in its own git worktree — separate conversation, files, and command history. Split work by ownership (frontend, backend, tests) and let agents move in parallel without touching each other's files.",
      target: '[data-tour="nav-new-workspace"]',
      placement: "right",
    }),
    workspace({
      id: "sidebar-orchestrate",
      section: "Sidebar",
      title: "Coordinate agents.",
      body: "The orchestration drawer splits one objective into dependent workstreams and schedules specialists automatically. Results stay isolated until you review and merge them.",
      target: '[aria-label="Coordinate agents"]',
      placement: "right",
    }),
    workspace({
      id: "sidebar-main-agent",
      section: "Sidebar",
      title: "The main agent.",
      body: "Your primary session on the project's main branch. Parallel workspaces appear as rows below it — drag to reorder, hover for Review and Close, and watch each one's status dot as it works.",
      target: "[data-vector-workspace-list] [data-vector-workspace-row]",
      placement: "right",
    }),
    workspace({
      id: "tools-editor",
      section: "Project tools",
      title: "Code editor.",
      body: "An embedded editor over the project's files, for changes you'd rather make by hand. A Problems list flags issues in the open file, and AI Architect hands the file — problems included — to the agent for a focused pass.",
      tip: "For a one-line tweak, editing here beats prompting.",
      target: '[data-tour="nav-code-editor"]',
      placement: "right",
    }),
    workspace({
      id: "tools-browser",
      section: "Project tools",
      title: "Browser.",
      body: "A real controlled browser beside the chat. Use it yourself, or let Vector operate the same visible page while reading console output, network errors, and runtime failures — inspect, repair, retest without leaving the session.",
      target: '[data-tour="nav-browser"]',
      placement: "right",
    }),
    workspace({
      id: "tools-canvas",
      section: "Project tools",
      title: "Canvas.",
      body: "A spatial surface where project tools run in floating windows you arrange freely — editor, terminal, browser, review, and agents can stay open together. Drive it by voice or with the typed command bar; both do the same things.",
      target: '[data-tour="nav-canvas"]',
      placement: "right",
    }),
    workspace({
      id: "conn-scheduled",
      section: "Connections",
      title: "Scheduled runs.",
      body: "Write a prompt now, pick a time, and Vector launches the agent for you later — even while you work on something else. The badge counts runs that are waiting.",
      tip: "Queue the unglamorous chores — dependency bumps, lint sweeps — for while you're away.",
      target: '[data-tour="nav-scheduled"]',
      placement: "right",
    }),
    workspace({
      id: "scheduled-panel",
      section: "Connections",
      title: "The scheduling panel.",
      body: "Describe the run, set date and time, done. On desktop Vector runs it unattended; elsewhere it saves the prompt, reminds you, and you choose when to run it.",
      target: '[data-tour="scheduled-panel"]',
      placement: "right",
      prepare: host.openScheduledPanel,
    }),
    workspace({
      id: "conn-mcp",
      section: "Connections",
      title: "MCP servers.",
      body: "Connect Model Context Protocol servers — the open standard for giving agents tools. Databases, APIs, internal services: whatever a server exposes becomes available to the agent in this project.",
      tip: "Start with one server you actually need; every tool adds to what the agent weighs each step.",
      target: '[data-tour="nav-mcp"]',
      placement: "right",
      prepare: host.closeScheduledPanel,
    }),
    workspace({
      id: "conn-plugins",
      section: "Connections",
      title: "Plugins.",
      body: "Extend Vector itself: plugins add tools, commands, and hooks to the agent runtime. Manage the project's plugins from here.",
      target: '[data-tour="nav-plugins"]',
      placement: "right",
    }),
    workspace({
      id: "conn-github",
      section: "Connections",
      title: "Push to GitHub.",
      body: "Commit and push without leaving the session — to the repository's existing origin, or to a brand-new GitHub repository created with your local GitHub CLI login.",
      tip: "Run Review changes first: a commit should never contain a diff you haven't read.",
      target: '[data-tour="nav-github"]',
      placement: "right",
    }),
    workspace({
      id: "conn-gitlab",
      section: "Connections",
      title: "Push to GitLab.",
      body: "The same flow for GitLab — connect once, then push this project to a new or existing GitLab repository.",
      target: '[data-tour="nav-gitlab"]',
      placement: "right",
    }),
    workspace({
      id: "sidebar-update",
      section: "Sidebar",
      title: "Update Vector.",
      body: "Checks, downloads, installs, and restarts in one click. The label shows your current version and whether a newer one is ready.",
      target: "[data-vector-update-action]",
      placement: "right",
    }),
    workspace({
      id: "sidebar-settings",
      section: "Sidebar",
      title: "The Settings gear.",
      body: "Same Settings as on Home, always within reach. We'll open it in a moment — one more stop first.",
      target: '[data-vector-navigation] [aria-label="Settings"]',
      placement: "right",
    }),

    {
      id: "cloud-home",
      section: "Cloud Services",
      title: "Ship it from here.",
      body: "Pick a repository and Cloud Services becomes its release console: publish to your own Vercel or Netlify account, check live health, point domains, manage .env variables, wire a Supabase database, and tune build settings. Your code never proxies through Vector.",
      tip: "Deploy early, even half-finished — a live URL makes every change after it feel real.",
      target: "[data-vector-cloud-home]",
      placement: "auto",
      group: "cloud",
      sentinel: true,
      prepare: () => {
        host.closeScheduledPanel()
        host.goCloud()
      },
    },
    {
      id: "cloud-sections",
      section: "Cloud Services",
      title: "Six panels, one console.",
      body: "Deployments publishes and lists live URLs. Observability checks every deployed endpoint. Domains handles DNS with live verification. Environment writes your .env. Database wires Supabase in. Build & runtime detects and pins your build settings.",
      target: "[data-cloud-console] .cloud-sidebar",
      placement: "right",
      group: "cloud",
      prepare: host.goCloud,
    },

    {
      id: "settings-open",
      section: "Settings",
      title: "Everything about how Vector runs.",
      body: "Settings is grouped into General, Models & keys, Workspace, and System. Let's hit the ones that matter on day one.",
      target: ".settings-v2 .settings-v2-nav-shell",
      placement: "right",
      group: "settings",
      sentinel: true,
      prepare: host.openSettingsDialog,
    },
    {
      id: "settings-providers",
      section: "Settings",
      title: "Providers: bring your own keys.",
      body: "Connect OpenAI, Anthropic, Google, and more — and find the free curated starter models, so there's a capable model before you've paid anyone. Keys stay on your machine.",
      target: settingsTab("providers"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },
    {
      id: "settings-models",
      section: "Settings",
      title: "Models: curate your pickers.",
      body: "Choose which models appear in the composer's model chip. Trim the list to the ones you actually use.",
      target: settingsTab("models"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },
    {
      id: "settings-appearance",
      section: "Settings",
      title: "Appearance.",
      body: "Theme and workspace colors — make Vector yours.",
      target: settingsTab("appearance"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },
    {
      id: "settings-usage",
      section: "Settings",
      title: "Usage & streak.",
      body: "The full version of Home's activity strip: tokens, sessions, streaks, and your model mix over time.",
      target: settingsTab("usage"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },
    {
      id: "settings-billing",
      section: "Settings",
      title: "Billing & license.",
      body: "Your Vector license and device activation live here — activate, move to another machine, or manage the subscription.",
      target: settingsTab("billing"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },
    {
      id: "settings-workspace",
      section: "Settings",
      title: "Workspace: Editor and Chat.",
      body: "Editor tunes the embedded code editor; Chat shapes how sessions render and behave.",
      target: settingsTab("editor"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },
    {
      id: "settings-system",
      section: "Settings",
      title: "System: Servers, Notifications, and more.",
      body: "Servers manages engine connections, Notifications controls how Vector gets your attention, and Accessibility and About round out the group.",
      target: settingsTab("servers"),
      placement: "right",
      group: "settings",
      prepare: host.openSettingsDialog,
      onFound: (element) => element.click(),
    },

    {
      id: "finale",
      section: "You're set",
      title: "You know every button now.",
      body: "That's the whole workspace: Home, the composer, the sidebar, project tools, connections, Cloud Services, and Settings. Next up is a short checklist — connect a provider, open a repository, run your first task.",
      tip: "Replay this tour any time from Getting started (the ? in the sidebar footer).",
      prepare: () => {
        host.closeSettingsDialog()
        host.goHome()
      },
    },
  ]
}
