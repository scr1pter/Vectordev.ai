// The tables and lists the documentation pages interpolate. Extracted from the
// single-page docs when it became one page per section.
export const ecosystem = [
  "Claude Code",
  "Codex",
  "Cursor Agent",
  "Anthropic",
  "OpenAI",
  "Google",
  "MCP",
  "GitHub",
  "GitLab",
  "Linear",
  "Sentry",
  "Figma",
  "Stripe",
  "Vercel",
  "Netlify",
  "Supabase",
  "AWS",
  "Playwright",
]

// The nine parts of the workspace, in the order the page argues them. Each one
// gets a card here and a full section below, so no single capability carries
// the page on its own.
export const pillars = [
  {
    name: "The workspace",
    eyebrow: "Editor, file search, diagnostics, terminal",
    body: "Agent and Editor are two modes over the same local repository and session, with project-wide file search, diagnostics, a terminal, browser, review, and the same agent beside the file you opened.",
  },
  {
    name: "Local memory",
    eyebrow: "One file, on your machine",
    body: "What you choose to save about how you work is stored in a Markdown file in Vector's local app config directory and deleted when you erase it. The file is not uploaded to Vector's servers; when it exists, Vector automatically includes it in built-in agent context sent to the model provider you chose.",
  },
  {
    name: "Model economics",
    eyebrow: "Provider-reported, or nothing",
    body: "The tokens and cost a run spent, taken from what the provider itself reported. Nothing estimated. A run nothing reported is marked unmeasured rather than shown as free.",
  },
  {
    name: "Controlled browser",
    eyebrow: "Observe, repair, retest",
    body: "A real browser view the agent drives against the running product — and one that refuses to type into password, one-time-code and card fields, handing the step to you instead.",
  },
  {
    name: "Verified completion",
    eyebrow: "Opt-in · not on plan or quick",
    body: "Turn on LLM-as-a-judge and the Judge, a read-only subagent specialist, compares the finished work against your original request and the evidence, and sends it back for repair on a failed verdict.",
  },
  {
    name: "Cloud Services",
    eyebrow: "Your own accounts",
    body: "Deployments, domains with real DNS checks, environment variables, databases and logs, run through the Vercel, Netlify, Supabase and AWS accounts that already belong to you.",
  },
  {
    name: "MCP and plugins",
    eyebrow: "135 ready to connect",
    body: "GitHub, Linear, Sentry, Figma, Playwright, Postgres, Stripe, Slack and more, plus any MCP server you add — and Vector installs the runtime a plugin needs instead of sending you to a terminal.",
  },
  {
    name: "Parallel agents",
    eyebrow: "No agent cap · isolated or shared",
    body: "Vector's agent starts subagents on its own for big tasks and runs them together. When you want separate lines of work, run agents in their own checkouts or together in one, watch them from a single dashboard, and merge only what you trust.",
  },
  {
    name: "Automations",
    eyebrow: "Desktop · runs with no window open",
    body: "Recurring work across repositories on a repeat you set, each run a real session with a transcript waiting, still firing after the last window is closed.",
  },
]

type FeatureKind =
  | "editor"
  | "memory"
  | "browser"
  | "cloud"
  | "agents"
  | "automations"
  | "work"
  | "cost"
  | "terminal"
  | "diff"

type Feature = {
  title: string
  body: string
  tag: string
  note: string
  href: string
  link: string
  demo?: FeatureKind
  proof?: string[][]
}

// Each pillar in full. `proof` stands in for an interactive demo on the
// pillars the product does not show in a single frame.
export const conditions = [
  [
    "Worktrees need clean Git",
    "An isolated agent gets a Git worktree on its own branch only when the project is a Git repository and the working tree is clean. Without one — no repository, uncommitted changes, or a worktree that cannot be created — Vector provisions an isolated copy instead and records which it used in the workspace log.",
  ],
  [
    "Recommendations need evidence",
    "Model economics suggests nothing until a model has at least three recorded runs for that kind of task. There is no cold-start guess, and a model whose spend was never reported never sorts ahead of one that reported a real cost.",
  ],
  [
    "Unmeasured is not zero",
    "Cost and tokens come from the provider's own report for that run. When a provider reports nothing, the run is stored and shown as unmeasured. Vector will not print a zero that reads as free.",
  ],
  [
    "The judge is opt-in",
    "LLM-as-a-judge is off until you switch it on, and it spends extra model calls on every prompt it covers. It cannot apply to the plan lane, which produces nothing to verify, or to the quick lane, which has no ability to spawn the judge at all.",
  ],
  [
    "Subagents share your checkout",
    "Subagents and subagent specialists work in your session's own checkout, not a separate worktree, and by default they cannot start subagents of their own. For work that should not touch your files until you merge it, use an agent workspace instead.",
  ],
  [
    "External runtimes are yours",
    "Claude Code, Codex, and Cursor Agent run as workspace engines, but only where Vector detects that CLI installed on this computer, and the run is signed in by the subscription already in it. Vector never asks for a second key — and teammate messaging is carried by Vector's own agent, so an external runtime shares the checkout but not the message channel.",
  ],
  [
    "Automations are a desktop feature",
    "Scheduling lives in the Vector desktop app, so tasks fire while that app is running — including with every window closed, but not while the machine is off or Vector has been quit from the tray. A scheduled run uses Vector's own agent rather than an external CLI runtime.",
  ],
  [
    "The shell sandbox is off by default",
    "Commands an agent runs can be confined to their workspace by the operating system's own mechanism — a seatbelt profile on macOS, bubblewrap on Linux where it is installed — by setting VECTOR_SHELL_SANDBOX. It is opt-in, off by default, and Windows ships no equivalent, so Vector says so and runs unconfined there rather than pretending.",
  ],
  [
    "Cloud actions need your authorization",
    "Vercel, Netlify, and Supabase work once you authorize them, and AWS reads a profile you already configured for the AWS CLI. Vector acts inside those accounts; it does not host your project itself and does not proxy your code.",
  ],
  [
    "Dictation downloads once, then stays local",
    "Speech is transcribed by a Whisper model that runs on your machine. The model file is fetched and cached the first time, after which nothing is sent to a cloud speech service.",
  ],
]
export const workflow = [
  ["Open", "Attach the repository already on your computer."],
  ["Work", "Open a file in Editor or hand the same session to an agent — one, or several in their own checkouts."],
  ["Observe", "Follow plans, edits, commands, browser actions, and the tokens and cost the provider reported."],
  [
    "Verify",
    "Run checks, inspect the product in the browser, review the diff, and optionally require an independent judge verdict.",
  ],
  ["Ship", "Merge the hunks you trust and publish through your own connected accounts."],
]

// What actually happens when someone buys Vector and when a run spends money.
// Every claim here is checked against the implementation: license-service.ts
// for activation and the grace window, spend-limits.ts for the ledger.
export const licenseRows = [
  [
    "One key, minted per purchase",
    "Your verified Vector account owns the purchase. Stripe takes the payment; Vector never sees a card number. Your existing VEC1 license format is preserved, and the private key is emailed and available from your account.",
  ],
  [
    "Bound to a hash, not to your hardware",
    "Activation reads a stable machine identifier — the platform UUID on macOS and Windows, /etc/machine-id on Linux — and immediately SHA-256 hashes it with a Vector-specific salt. Only that hash is ever sent. The raw identifier never leaves your computer, so the licence can tell two machines apart without ever learning anything about either.",
  ],
  [
    "Stored where only you can read it",
    "The activated licence lives in one file in Vector's own application data, written with 0600 permissions — owner read and write, nobody else — and replaced atomically, so an interrupted write can never leave a half-file behind.",
  ],
  [
    "Seven days offline before it asks again",
    "Vector re-checks in the background. If it cannot reach licensing — you are on a plane, the network is down, the service is having a bad day — it keeps working on the last good answer for seven days and tells you it is doing so. It does not fail closed the moment a request times out.",
  ],
]
export const spendRows = [
  [
    "Measured, never estimated",
    "What a run cost comes from the numbers the provider itself reported — input, output, reasoning, cache reads and cache writes — alongside its own cost figure. Nothing is inferred from character counts.",
  ],
  [
    "Unmeasured is not free",
    "A run whose provider reported no usage is recorded as unmeasured rather than as zero, because a fabricated zero reads as free and quietly poisons every total built on top of it.",
  ],
  [
    "The ledger is yours and it is local",
    "Spend is kept in a file on your machine, with daily totals retained far longer than the raw events behind them. Vector reads it to enforce the caps you set and to stop a run before it goes past them.",
  ],
  [
    "Your keys, your bill",
    "The models included with Vector come with your Vector account and need no key. Bring your own provider keys and that model spend is between you and that provider — Vector does not resell tokens or add a margin to them.",
  ],
]
export const systemRows = [
  [
    "Memory that is one file you can delete",
    "Local memory is a single MEMORY.md in your own config directory, read in every repository. Settings shows its path, size, last change, and full contents, and erasing removes the file rather than emptying it.",
  ],
  [
    "Spend that is measured, not modelled",
    "Tokens and cost come from what the provider reported for that run — input, output, reasoning, cache read and cache write. A run nothing reported is marked unmeasured, and an unmeasured model never outranks one that reported a real cost.",
  ],
  [
    "A judge that can fail the work",
    "Optional LLM-as-a-judge hands the original request, the success criteria, the changed files and the captured test output to the Judge, a separate read-only subagent specialist. A FAIL names the specific repair and the agent goes back to work, up to three rounds.",
  ],
  [
    "A browser that refuses credentials",
    "The browser agent will not type into a password, one-time-code, or card field. It pauses and hands the live browser to you, then resumes with what it can see.",
  ],
  [
    "Plugin runtimes that install themselves",
    "A catalog plugin that needs uvx no longer becomes a terminal errand. Vector resolves the runner, installs it through Astral's own installer when it is missing, and rewrites the command to an absolute path so it spawns without a login shell.",
  ],
  [
    "Publishing on accounts that stay yours",
    "Deploy through your own Vercel, Netlify, or Supabase authorization, manage domains, environment variables, and databases, and verify a domain with a real CNAME lookup — from a workspace that never proxies your repository.",
  ],
  [
    "See who edited what",
    "The editor attributes each live edit to the agent that made it. When two agents hold the same file, Vector names the file and both agents before either merges.",
  ],
  [
    "Start with no key at all",
    "Models are included with Vector, so a capable model is ready before you have connected a provider or added an API key.",
  ],
  [
    "Dictation that stays on device",
    "Speech is transcribed by a Whisper model running on your machine. Nothing is sent to a cloud speech service.",
  ],
  [
    "Merge the hunks you trust",
    "Review an agent's diff and merge selected hunks or files rather than accepting the whole change, with secret scanning and a restorable checkpoint before anything lands on main.",
  ],
  [
    "Run the other agents too",
    "Claude Code, Codex, and Cursor Agent run as engines inside Vector, on the CLIs and subscriptions you already have — alongside Vector's own agent, the browser, the editor, scheduling, and cloud delivery in the same workspace.",
  ],
  [
    "Agents wired the way you want",
    "A team can be everyone-to-everyone, a coordinator broadcasting down to workers, or any pairing you set yourself. A message to a teammate you have not linked is refused and told so, rather than dropped where the sender never finds out.",
  ],
]
export const connectionGroups = [
  ["Models", "Models included with Vector, then Anthropic, OpenAI, Google, and other BYOK providers"],
  ["Agent runtimes", "Local Claude Code, Codex, and Cursor tools when Vector detects them installed"],
  ["Protocols and source", "135 catalog connectors, your own MCP servers, GitHub, and GitLab"],
  ["Cloud and validation", "Vercel, Netlify, Supabase, AWS through its CLI, and Playwright"],
]
export const comparison = [
  [
    "Editor, file search, diagnostics, terminal",
    "Built in",
    "Terminal-first",
    "Terminal-first",
    "IDE-native",
    "Managed editor",
  ],
  ["Memory file the app shows and can erase", "One MEMORY.md, with path, size and one-click erase", "—", "—", "—", "—"],
  [
    "Provider-reported spend recorded per run",
    "Ledger, plus model ranking",
    "Session cost readout",
    "—",
    "Usage dashboard",
    "—",
  ],
  ["Independent judge before “done”", "Opt-in Judge subagent specialist", "—", "—", "—", "—"],
  ["Connector catalog", "135 connectors, plus your own MCP", "Via MCP", "Via MCP", "Via MCP", "—"],
  [
    "Browser the agent drives",
    "Built in, refuses credentials",
    "Via tools",
    "Browser + CDP",
    "Via tools",
    "Preview-centric",
  ],
  [
    "Deploys on accounts you own",
    "Vercel, Netlify, Supabase, AWS",
    "Via tools",
    "Via tools",
    "Via MCP",
    "Native hosting",
  ],
  ["Parallel isolated agents", "No cap", "Subagents", "Worktrees", "Background agents", "—"],
  ["Recurring work with no window open", "Desktop tray", "—", "—", "—", "—"],
]

// The engine's eight subagent specialists (packages/engine/src/agent/agent.ts)
// and the display identities painted over them. `general` is not listed: it is
// the general-purpose Subagent described in `subagentKinds` below. Roles restate
// the engine descriptions and the labels mirror the real permission sets.
// Explore, review, security and judge cannot write (readonlySpecialistBoundary),
// so no card promises more than its agent is allowed to do.
export const crew = [
  {
    label: "explore",
    name: "Explore",
    summary: "Finds code fast",
    hue: 25,
    readOnly: true,
    role: "Finds files by pattern, searches code for keywords, and answers questions about how the codebase works. Never edits.",
  },
  {
    label: "judge",
    name: "Judge",
    summary: "Verifies completion",
    hue: 265,
    readOnly: true,
    role: "Scores finished work against the original request and returns PASS, FAIL or INCONCLUSIVE. Verified completion relies on it, and Vector can also call it for an independent check. Never edits.",
  },
  {
    label: "debug",
    name: "Debug",
    summary: "Finds root causes",
    hue: 95,
    readOnly: false,
    role: "Reproduces a failure, isolates the cause, applies a focused repair and re-checks that it holds.",
  },
  {
    label: "migration",
    name: "Migration",
    summary: "Upgrades safely",
    hue: 200,
    readOnly: false,
    role: "Plans and stages framework, dependency, API, schema and configuration upgrades across compatibility boundaries.",
  },
  {
    label: "performance",
    name: "Performance",
    summary: "Makes it faster",
    hue: 45,
    readOnly: false,
    role: "Measures a baseline, then optimises slow runtime paths, builds, bundles, queries and rendering against it.",
  },
  {
    label: "review",
    name: "Review",
    summary: "Reads the diff",
    hue: 320,
    readOnly: true,
    role: "Inspects a change for correctness, regressions, missing tests and maintainability, with file and line. Never edits.",
  },
  {
    label: "security",
    name: "Security",
    summary: "Checks the boundaries",
    hue: 220,
    readOnly: true,
    role: "Reviews trust boundaries, authentication, secrets, injection risk and unsafe data flow. Never edits.",
  },
  {
    label: "test",
    name: "Test",
    summary: "Writes coverage",
    hue: 175,
    readOnly: false,
    role: "Designs focused coverage, writes or repairs tests, runs the suite and reports failures with evidence.",
  },
]

// The two kinds of agent Vector's agent hands work to. "Subagents" are the
// engine's `general` agent; "Subagent specialists" are the agents in `crew`
// above plus any agent a user defines. Checked against
// packages/engine/src/agent/subagent-kind.ts and src/tool/task.txt.
export const subagentKinds = [
  [
    "What they take on",
    "A subagent takes any self-contained piece of the task. A subagent specialist takes only the kind of work it is named for.",
  ],
  [
    "When Vector uses them",
    "Vector's agent decides on its own. For a big task, one that touches three or more files split across parts that do not depend on each other, or needs broad research as well as changes, it starts one subagent per independent part and launches them together so they run at the same time, while it keeps the integration and the final checks. A small task, such as a single-file change, a quick fix, one lookup, a short answer, or two or three closely linked files, it does itself, without a subagent. It calls a specialist when part of the task fits that specialist's focus. You do not have to ask for either.",
  ],
  [
    "How many",
    "A small task gets no subagents; a big one gets one per independent part. Vector sets no cap on either kind. Your computer and your provider's rate limits are the practical limits, and each one spends its own tokens.",
  ],
  [
    "While they run",
    "By default the main agent waits for their results, then carries on with what they found. In the desktop app it can also leave one running in the background while it does other work, and picks up the result when that one finishes.",
  ],
  [
    "Who they answer to",
    "The main agent. Each one works in its own context and reports back to it once, when it finishes. They cannot ask you questions, though they still ask for permission the way the main agent does, and the main agent tells you what they found.",
  ],
  [
    "What they can change",
    "A subagent can read, edit and run commands like the main agent. Explore, Review, Judge and Security can read your project and run checks, but they cannot edit it. Debug, Test, Performance and Migration can edit.",
  ],
  [
    "Where they work",
    "In your session's checkout, not a separate worktree. Vector refuses to start one whose assigned paths overlap another running subagent's.",
  ],
  ["How deep", "One level. By default, subagents cannot start subagents of their own."],
  [
    "In Plan mode",
    "Vector does not start subagents, and of the built-in specialists it uses only Explore, Review and Security, which cannot edit.",
  ],
  [
    "Turning them off",
    "Subagents are on by default, and you can turn them off in Settings → Agents or in Vector's config file. Subagent specialists are not affected and keep working.",
  ],
]
export const changelog = [
  [
    "September 2026 · 1.99.91",
    "Provider setup and Vectorscope reliability",
    "OpenCode Zen's shared keyless gateway is disabled. Connect your own provider in Settings or with vector auth login; your own OpenCode key is still supported. GitHub automation stops with actionable MODEL and provider-key setup instructions when no model is configured, instead of selecting an unavailable default. Vectorscope's /vectorscope, /vs, /vector and /vx aliases and workflow fixtures agree again, and release checks no longer depend on an unshipped computer tool. Command-F places chat search below the title strip. Unsigned desktop releases require a manual download; signed automatic-update feeds are preserved.",
  ],
  [
    "September 2026 · 1.99.9",
    "Meet Vectorscope, the code review bot",
    "Vector's code reviewer is now Vectorscope: /vectorscope on a pull request, vector vectorscope in a terminal, and the Pull Requests panel in the app, all running the same review that reads the repository around a change. The older /vector and /vx mentions still work. The documentation is now a page per subject with search, and the landing page carries twenty feature cards. You can also delete your Vector account from the account page: it cancels billing, revokes your licence and CLI tokens, and asks you to type your email to confirm.",
  ],
  [
    "September 2026 · 1.99.8",
    "Subagents that work in parallel",
    "For big tasks the main agent launches general-purpose Subagents on its own, one per independent part and in parallel, and does small tasks itself; eight Subagent specialists keep their focus, and Settings → Agents can turn Subagents off. They show as cards in the chat and in the Background tasks panel. Turned on in vector github install, code review covers each pull request when it opens and on every push: one summary, and comments on the exact lines, each with a severity and, where it is safe, a fix you can commit from GitHub. It follows your .vector/review.md rules, re-reviews only what changed and says what got fixed, runs locally as vector review and from the desktop app's Pull Requests panel, and every review states its model and cost. The editor follows every agent live, the main agent included; Claude Code, Codex and Cursor chats answer like any other; the 16-agent limit is gone; and every model your providers offer is listed.",
  ],
  [
    "September 2026 · 1.99.7",
    "A database it can create for you",
    "The agent creates a real Supabase project on your own account, asks which organization when there are several, and writes the keys and client into your repository. Cloud actions that are merely unfinished now say what to connect instead of failing.",
  ],
  [
    "September 2026 · 1.99.6",
    "Cloud that closes the loop",
    "The agent reads your deployment logs to diagnose a failing deploy, and applies the .sql migrations in your repository to the linked database, tracking which already ran so re-running is safe. Publishing still ends with a real browser check of the deployed URL.",
  ],
  [
    "September 2026 · 1.99.5",
    "Multiplayer, Follow mode, and GitHub that ships PRs",
    "vector invite shares a live workspace with teammates over one link; the editor now follows the agent as it types, line by line; /vector on a GitHub issue opens a pull request with a Changes table, check output, measured cost, and the judge's verdict; and MCP servers that stop answering are recovered instead of wedging the app.",
  ],
  [
    "August 2026",
    "One workspace, two ways to work",
    "Agent and Editor now share one session, files open in persistent full-screen tabs, Settings is a searchable full-screen destination, and the Agent Dashboard, browser, terminal and review use one calmer purple project shell.",
  ],
  [
    "August 2026",
    "Scheduled work that runs while you are away",
    "Vector keeps a tray presence and stays resident after the last window closes, so a recurring task still fires with no window open. The tray shows what is armed and when it next runs, can run or pause everything from there, and notifies you when a run finishes.",
  ],
  [
    "August 2026",
    "Economics that actually learn",
    "Every session now feeds measured token and cost evidence into model recommendations, so the ranking is built from what providers actually reported rather than from list prices.",
  ],
  [
    "August 2026",
    "Plugins that install themselves",
    "Vector fetches whatever runtime a plugin needs, so Computer Use and other tools connect without a terminal detour.",
  ],
  [
    "August 2026",
    "Measured spend and in-app help",
    "Model economics now records real provider-reported tokens and cost per run, plus a Help AI Assistant and one-click bug reporting inside the workspace.",
  ],
  [
    "August 2026",
    "Agents can actually reach each other",
    "Fixed the teammate message tool, which was registered where the engine never looked, so collaborating agents could not reach each other.",
  ],
  [
    "August 2026",
    "Agents that work together",
    "Shared workspaces where agents message each other, an Agent Dashboard with clash detection, per-agent edit attribution in the editor, and AI pull request review.",
  ],
  [
    "August 2026",
    "Licensing and disclosure",
    "HEIC conversion moved to the operating system, removing the last copyleft dependency, with expanded privacy and terms coverage.",
  ],
  [
    "July 2026",
    "Vector desktop release and download refresh",
    "Verified installers for macOS, Windows, and Linux, served from the new download pipeline. Signed builds continue through automatic updates; unsigned previews stay manual-download only.",
  ],
  [
    "July 2026",
    "Review tools and shell polish",
    "A refined review panel, window recovery fixes, and a cleaner desktop chrome across the workspace.",
  ],
  [
    "July 2026",
    "Models and settings controls",
    "Restored provider management, model pickers, and execution settings throughout the rebuilt shell.",
  ],
]

export const faqs = [
  {
    question: "Does Vector upload my repository?",
    answer:
      "Vector works on a local repository and does not upload it to Vector's servers by default. Prompts, selected files, tool results, and local-memory context can be sent to the model provider you choose; publishing, Git, MCP, and cloud workflows send only the data required by those connected services.",
  },
  {
    question: "Where are model provider keys stored?",
    answer:
      "Provider credentials are stored with Vector's local application data and are not written into your repository. Keep normal operating-system account security enabled and never paste secrets into project files.",
  },
  {
    question: "Can several agents work on one repository?",
    answer:
      "Yes, in two ways. Inside one session, Vector's agent starts subagents on its own for big tasks and runs them in the same checkout. For separate responsibilities, create agent workspaces: each works on its own copy or Git worktree, and you decide which changes are reviewed and merged.",
  },
  {
    question: "What is the difference between a subagent and a subagent specialist?",
    answer:
      "A subagent is general purpose: it takes whatever self-contained piece of the task Vector's agent hands it. Vector starts them for big tasks, one per independent part, and does small tasks itself. A subagent specialist is one of eight named agents, such as Review or Debug, with a fixed focus and its own permissions. Agents you define yourself count as custom specialists. Vector uses both on its own, and both appear in the chat and in Background tasks.",
  },
  {
    question: "Is there a limit on how many subagents Vector runs?",
    answer:
      "No. Vector sets no cap, though it starts subagents only for big tasks. Your computer and your provider's rate limits are the practical limits, and each subagent spends its own tokens. By default, subagents cannot start subagents of their own.",
  },
  {
    question: "Can I stop Vector from using subagents?",
    answer:
      "Yes. In the desktop app, switch off General subagents in Settings → Agents. In the terminal, set agent.general.disable to true in ~/.config/vector/vector.json, or in a project's vector.json for that project only. In the terminal it takes effect the next time you start Vector there. Vector's agent then does the work itself, except parts that fit a subagent specialist, which it can still hand to one. You can also still call a specialist yourself with @ and its name.",
  },
  {
    question: "Can I edit code myself?",
    answer:
      "Yes. Switch from Agent to Editor to search the project, open files in tabs, edit directly, use diagnostics, and keep the same session agent beside the code.",
  },
  {
    question: "Does the browser replace Chrome or Firefox?",
    answer:
      "No. It is a controlled project browser for previewing, testing, and completing approved web workflows alongside the active agent session.",
  },
  {
    question: "Do I need an API key?",
    answer:
      "No. Vector comes with models included, so you can work without connecting a provider. You can also bring your own key for Claude, GPT, Gemini and the rest; availability and billing for those depend on the provider you connect. Included models are served by outside providers, and some may use your prompts to improve their models, so use your own provider key for confidential code.",
  },
  {
    question: "How do I buy and activate Vector?",
    answer:
      "Create a Vector account with Google or email, then open Account and choose a desktop subscription: $10 a month or $99 a year. Creating an account does not start a subscription. After Stripe checkout, your private VEC1 license key and billing controls are available in Account. Enter that key when the desktop app asks for activation. Both plans include models, so you need no API key.",
  },
]
