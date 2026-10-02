import { upcomingRelease } from "./vector-releases"

// The tables and lists the documentation pages interpolate.
export const spendRows = [
  [
    "Measured tokens, catalog prices",
    "Token counts come from what the provider reported: input, output, reasoning, cache reads and cache writes. Dollars are those tokens at the model catalog's list price, so plan billing, discounts and negotiated rates are not reflected.",
  ],
  [
    "Unmeasured is not free",
    "In the spend ledger, a run whose provider reported no usage is recorded as unmeasured rather than as zero, because a fabricated zero reads as free and quietly poisons every total built on top of it.",
  ],
  [
    "The ledger is yours and it is local",
    "Spend is kept in a file on your machine, with daily totals retained far longer than the raw events behind them. Vector reads it before an automation or parallel agent starts, and refuses the start once a cap is already spent.",
  ],
  [
    "Your keys, your bill",
    "Connect your own provider account to start. Upcoming 1.999.99 adds guarded personal OpenRouter free access independently of Vector's shared allowance, which remains off. Keep that account free: no credit purchase, payment method, automatic top-ups, paid upstream BYOK credentials, or default or enforced paid plugins. When free limits or eligible endpoints are unavailable, wait; the guarded route does not switch to paid models or providers. Other provider connections have their own pricing.",
  ],
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
  [upcomingRelease.label, upcomingRelease.title, `${upcomingRelease.summary} ${upcomingRelease.status}`],
  [
    "Next release · 1.999.99",
    "Personal free models and Vector's own runtime",
    "Not published yet: until its installers are published, the download page offers desktop 1.99.8 and npm installs CLI 1.99.7, which do not read the VECTOR_ names or vector.json. Prompts no longer go through a shared keyless gateway: connect a provider with your own API key in Settings or with vector auth login, sign in with ChatGPT for OpenAI models (the sign-in now identifies as Vector, and its callback listens only on 127.0.0.1), or use Connect OpenRouter with your own OpenRouter account. Sending a prompt with no provider connected opens the connect-provider dialog and keeps your prompt, and vector run exits with a short setup message. On first launch after upgrading, Vector imports your earlier settings, permission rules, MCP servers, agents, commands, plugins and skills into vector.jsonc and .vector and keeps the originals; recognized earlier environment variables are read as their VECTOR_ equivalents, and a variable already set under Vector's name wins. Configuration, provider, model and agent endpoints no longer return stored API keys, auth headers or MCP tokens, programs started from the integrated terminal no longer inherit Vector's internal secrets, and vector serve and vector web refuse a network address without a password unless you pass --unsecured. Web search turns on with your own Exa or Parallel key. The code reviewer is Vectorscope: vector vectorscope in a terminal, or /vectorscope and /vs on a pull request, with /vector and /vx still working. The send button is a rounded square that lines up with the composer, dialogs have a Vector look of their own, and this documentation is now organized around Vector's features. Personal free-model access works through your own connected OpenRouter account while Vector's shared allowance stays off. The initial selection is limited to online, tool-capable, zero-price endpoints listed by OpenRouter as ZDR, with ZDR and data-collection restrictions enforced on requests. Keep the account free: no credit purchases, payment methods, automatic top-ups, paid upstream BYOK keys or paid plugins. Unavailable endpoints or exhausted limits stop without a paid fallback. Use Settings or OPENROUTER_API_KEY for the credential; a project-only provider.options.apiKey is insufficient. This unsigned release requires a manual download and preserves signed automatic-update feeds.",
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
      "Yes. In the desktop app, switch off General subagents in Settings → Agents. In the terminal, from 1.999.99, the next release, set agent.general.disable to true in ~/.config/vector/vector.json, or in a project's vector.json for that project only. In the terminal it takes effect the next time you start Vector there. Vector's agent then does the work itself, except parts that fit a subagent specialist, which it can still hand to one. You can also still call a specialist yourself with @ and its name.",
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
      "Connect a provider account or API key to start. Upcoming 1.999.99 adds eligible tool-capable OpenRouter free models through your own free account, independently of the disabled shared allowance. This guarded setup is not in desktop 1.99.8. Do not buy credits, add a payment method, enable automatic top-ups, attach paid upstream BYOK keys, or enable default or enforced paid plugins on that account. Free limits or unavailable eligible endpoints stop the request without a paid fallback. The initial selection is limited to online, tool-capable, zero-price endpoints in OpenRouter's ZDR list. Requests enforce ZDR and deny data collection; these routing controls do not cover local history or account logging. Use a saved provider connection or OPENROUTER_API_KEY, since a project-only provider.options.apiKey does not enable guarded free access.",
  },
  {
    question: "How do I buy and activate Vector?",
    answer:
      "Create a Vector account with Google or email, then open Account and choose a desktop subscription: $10 a month or $99 a year. Creating an account does not start a subscription. After Stripe checkout, your private VEC1 license key and billing controls are available in Account. Enter that key when the desktop app asks for activation. Connect your own provider account to start. Upcoming 1.999.99 adds guarded access to eligible free models through a personal free OpenRouter account. Vector's subscription does not increase that account's allowance or include paid model tokens.",
  },
]
