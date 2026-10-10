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
    "Connect your own provider account to start. From 1.99.99, guarded personal OpenRouter free access works independently of Vector's shared allowance, which remains off. Keep that account free: no credit purchase, payment method, automatic top-ups, paid upstream BYOK credentials, or default or enforced paid plugins. When free limits or eligible endpoints are unavailable, wait; the guarded route does not switch to paid models or providers. Other provider connections have their own pricing.",
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
    role: "Finds files by pattern, searches code for keywords, and answers questions about how the codebase works. Runs on your provider's small model when one is available. Never edits.",
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
    "Vector's agent decides on its own, and it delegates only when splitting the work costs less than doing it. An independent part that is substantial on its own, roughly five or more files or a long check-and-repair loop, or broad research that would flood its context, goes to a subagent, and several such parts are launched together so they run at the same time while the agent keeps the integration and the final checks. Each subagent starts with a fresh context and re-reads what it needs, so ordinary multi-file changes, fixes, lookups and answers it does itself. It calls a specialist when part of the task fits that specialist's focus. You do not have to ask for either.",
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
    "October 2026 · 1.99.106",
    "Agents keep working while your computer is idle, and Sign in with ChatGPT is back",
    "While any agent or subagent is running, Vector now keeps your computer from going to sleep, so long runs no longer freeze when you step away; the display can still turn off, and closing a laptop lid still puts it to sleep. When you come back to Vector after it was in the background, or after its connection to the agent engine drops, the open session and its subagent cards reload, so finished subagents no longer stay marked as running. Pressing Stop on a subagent that already finished now settles its card and says so, instead of appearing to do nothing. Sign in with ChatGPT is back: connect OpenAI with a ChatGPT Plus or Pro account to use GPT models. Vector now sends a daily usage count: how many sessions and subagent sessions ran, and, when you are signed in, token totals, recorded cost, the models and effort levels used, and streaks, with the app version and operating system. It never sends prompts, code, file names, model output, keys or IP addresses. Turn it off in Settings, General, Share usage counts.",
  ],
  [
    "October 2026 · 1.99.105",
    "Subagents keep working in the background",
    "Subagents now run in the background by default: the agent hands a task off, keeps working with you, and gets an automated report when the task finishes, and tasks that finish together report in one message. A message sent to a running subagent reaches it at its next step, and one that depends on other tasks waits for them. Stopping the agent's turn leaves the subagents it handed off running; stop them all from the background tasks panel. A settings change, such as a new provider key, no longer stops running subagents: Vector applies it once their work ends. Vectorscope can now review your own changes before you commit: Review my changes reviews the staged, unstaged and new files in the open project, as `vector review --uncommitted` does. Set up automatic reviews opens a pull request that adds the GitHub Actions workflow `vector github install` writes, on your agent's model, and lists the repository secrets to add; no API key is sent to GitHub, and Vector asks GitHub for permission to change workflow files only for this. A repository whose workflow reviews only when someone comments /vector review is shown as such. Branch names and pull request references now show in violet. A new install can start free: Start free with OpenRouter, in the composer and in the getting started checklist, connects your own OpenRouter account and selects its best free model, with your draft kept ready to send. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.104",
    "Vectorscope double-checks its reviews",
    "Pull Requests is now called Vectorscope, with the same icon, and its screen is redesigned. Reviews are more careful: after the review, a second pass re-reads the code behind every finding above a nit and drops the ones it cannot confirm, and the findings it keeps are marked Double-checked. The reviewers also read the failing CI checks for the commit under review, with the log of the step that failed, the places in your project that use the functions and types the pull request changes, and your project's rules in AGENTS.md (or CLAUDE.md) and .vector/RULES.md. A review runs on the model you last chose for the agent, and its progress line names that model; a model set in .vector/review.json still takes precedence. Comment, Request changes and Approve now post each finding on its own line, with GitHub's one-click suggested change when a fix is safe to commit; if GitHub refuses the line comments, the review goes out as one summary that lists every finding. Dismiss a finding with a reason to leave it out of what is posted, and choose Don't flag this again to save a project rule to .vector/RULES.md that later reviews follow. Fix with agent opens an isolated agent on the pull request's code with the finding as its task: it checks the problem is real, fixes it, runs the tests and commits without pushing. Reviews and merges are pinned to the commit you were looking at, so a push that arrives in the meantime is never reviewed or merged by mistake. The panel no longer reloads itself while agents are running, and its header is no longer hidden under the window's title bar. In Settings, text boxes and buttons no longer sit directly on a section's dividing line, and the search field shows one frame instead of two. Built-in Sign in with ChatGPT is turned off until OpenAI authorizes it: connect OpenAI with an API key, or use the separately installed Codex runtime. If you signed in with ChatGPT before, Vector tells you once and stops using that sign-in. The Terms, Privacy Policy and Software License now name Krishna B / VectorDev.ai and keep your rights under the LGPL for the open-source libraries Vector includes. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.103",
    "Pull Requests with your GitHub sign-in",
    "Pull Requests now works with your GitHub sign-in in Vector, and nothing has to be installed. Open Pull Requests, choose Connect GitHub, enter the code it shows on github.com, and your repository's pull requests appear: list, open, read the diff, create, comment, approve, request changes and merge, and run a Vectorscope review, all from Vector. Failed GitHub Actions runs and their logs come through the same sign-in, cut down to the step that failed. This is the same GitHub sign-in Open from GitHub uses, and the token stays in your computer's keychain; Sign out of GitHub in the panel switches accounts. If the GitHub CLI is already signed in on your computer, Pull Requests uses that login without asking again. When an organization requires single sign-on or approval for Vector, the panel says where to authorize it. Links you click in Vector's browser now open, including Google search results, results that pass through a redirect and links that open a new tab; before, a click that led to another website did nothing. The agent still needs your approval for each new website it visits, and when it is stopped it now names the link so it can ask you for it. Release notes and Changelog in the app open the changelog in the documentation. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.102",
    "A redesigned Changes panel",
    "The Changes panel is redesigned. Each changed file is now one row with its name over its folder and its added and removed line counts, under a summary of every file's totals, and a row expands into a short preview of its first change. Opening a file fills the panel with a focused reader instead of a side-by-side diff next to a file tree: one column of line numbers, a + or − beside each changed line, word-level highlights, your line comments inline, and a header with Back, the file's counts, a pager across the changed files, Open in editor, and a menu for the full file, split view (when the panel is wide enough), the previous or next change and Copy path. Back or Esc returns to the list, and a second Esc closes the panel; < and > move between files, [ and ] between changes, and Cmd+F (Ctrl+F on Windows and Linux) finds within the diff. Diffs in the conversation and in file tabs look as before. Background tasks now opens as a floating window by default, beside the Changes panel when there is room; its dock button still docks it, and Esc closes it either way. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.101",
    "Open a GitHub repository from Vector",
    "Besides opening a folder on your computer, you can now open a repository from GitHub: choose Open from GitHub on the Home screen or in the project menu, or press Shift+Cmd+O (Shift+Ctrl+O on Windows and Linux). Pick one of your repositories or paste a GitHub link, choose where to put it, and Vector clones it with a progress bar and opens it like Open Project. Public repositories work without signing in; connect GitHub to see your own and your organizations' repositories and to clone private ones. Vector uses your GitHub sign-in only for the clone and never writes it into the repository, its settings or Vector's logs, and a canceled or failed clone leaves nothing behind and never replaces an existing folder. Push to GitHub now lists only repositories you can push to, and on Windows Vector also finds Git for Windows installed after Vector started. The terminal agent stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.100",
    "Messages work again in the desktop app",
    "This release fixes the desktop app, where in 1.99.99 every message failed with \"Bun is not defined\" on macOS, Windows and Linux. Local plugins and skills loaded from a URL failed in the desktop app with the same error, and plugins installed from npm and providers whose SDK Vector downloads on first use could not load there; all of them work now. The 1.99.99 apps for Intel Macs, Windows on Arm and Linux on Arm did not open, because they were built without the terminal component for their processor. 1.99.100 includes it on every platform, and a terminal component that cannot load now affects only terminals. A copy that does not open never reaches its update check, so on those computers download 1.99.100 from your account page or GitHub releases and install it over the old one; your projects and settings stay where they are. On Windows, Vector's Git commands now follow your Git line-ending and symlink settings: a file whose only change is its line endings no longer shows as edited or blocks switching an agent's branch, and Vector's commits keep the line endings your repository expects. Also on Windows, Claude Code and Codex installed with npm receive the whole Parallel Workspace prompt instead of only its first line, Cursor Agent installed as a command script says it cannot take the prompt instead of running with part of it, detecting these agents no longer fails when one of them or VS Code is installed as a command script, Publish finds Vercel and Netlify CLIs installed with npm, and merge and pull-request checks run npm, pnpm and yarn instead of skipping them. A failed agent check no longer repeats in a loop while the Parallel Workspace composer is open. On Linux, Restart in 1.99.99 and in-app updates to it could open a new, empty profile; 1.99.100 opens your original profile again, so anything you signed in to or set up only in that empty profile needs to be set up again. The terminal agent was not affected and stays at 1.99.99. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "October 2026 · 1.99.99",
    "Vector is free, updates itself, and agents can change branch",
    "Vector is now free: create a free Vector account to download the desktop app, and the same account signs in the terminal agent. Installed copies now update from inside the app: choose Check for Updates and Vector downloads the new release, installs it and restarts. You can change an agent's branch: click the branch name in the session header to switch that checkout to another local branch, or type a new name to create one from the current commit. Vector never stashes or discards your work to switch, and it refuses while a Vector agent is running in that checkout; in agent workspaces Vector manages, you can create a branch but not switch to an existing one. 1.99.99 is the first release with no dependency on the upstream service. Connect a provider with your own API key, sign in with ChatGPT for OpenAI models, or use Connect OpenRouter with your own OpenRouter account; its eligible zero-price models appear under Free models inside of Vector and stop at their limits instead of switching to a paid model, and Vector's shared free allowance stays off. The model list is current again, including GPT-6 Astra, GPT-6 Sol, GPT-6.1 Sol and GPT-6 Luna for ChatGPT sign-in, and Vector refreshes it from vectordev.ai when it starts and every hour. On first launch after upgrading, Vector imports your 1.99.8 settings, agents, commands, skills, plugins, MCP servers and permission rules, and keeps the originals. Security fixes keep stored API keys, auth headers and MCP tokens out of what Vector's server sends to connected clients and invite guests (an invite guest still has full access to your workspace, including the terminal, so invite only people you trust), keep Vector's internal secrets out of the integrated terminal, and protect passwordless local servers from rebinding web pages. Cloud connections keep client secrets on Vector's server, project variables keep their names when you change projects, local .env writes preserve literal values, and agent publishing uses one linked destination or asks you to choose; registration of the Cloud sign-ins is still pending. Reliability: stopping a prompt during first startup no longer leaves later prompts stuck, search recovers after an interrupted first lookup, an interrupted workspace no longer hangs shutdown, shell commands keep their final output when a process exits quickly, local plugins resolve JavaScript-style imports to their TypeScript source, and switching agents keeps the selected free model. Code Archaeology has been removed; Rewind code + chat still takes you back to earlier work. Dialogs have a look of their own, the send button lines up with the composer, the code reviewer is called Vectorscope, crash reports open as editable drafts, and providers without artwork use a neutral Vector icon. The Terms and software licence now include a minimum liability cap. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.",
  ],
  [
    "September 2026 · 1.99.9",
    "Meet Vectorscope, the code review bot",
    "Vector's code reviewer is now Vectorscope: /vectorscope on a pull request, vector vectorscope in a terminal, and the Pull Requests panel in the app, all running the same review that reads the repository around a change. The older /vector and /vx mentions still work. The documentation is now a page per subject with search, and the landing page carries twenty feature cards. You can also delete your Vector account from the account page: it revokes your CLI tokens and asks you to type your email to confirm.",
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
      "Yes. In the desktop app, switch off General subagents in Settings → Agents. In the terminal, from 1.99.99, set agent.general.disable to true in ~/.config/vector/vector.json, or in a project's vector.json for that project only. In the terminal it takes effect the next time you start Vector there. Vector's agent then does the work itself, except parts that fit a subagent specialist, which it can still hand to one. You can also still call a specialist yourself with @ and its name.",
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
      "Connect a provider account or API key to start. From 1.99.99, Vector adds eligible tool-capable OpenRouter free models through your own free account, independently of the disabled shared allowance. Releases before 1.99.99, such as desktop 1.99.8, do not include this guarded setup. Do not buy credits, add a payment method, enable automatic top-ups, attach paid upstream BYOK keys, or enable default or enforced paid plugins on that account. Free limits or unavailable eligible endpoints stop the request without a paid fallback. The initial selection is limited to online, tool-capable, zero-price endpoints in OpenRouter's ZDR list. Requests enforce ZDR and deny data collection; these routing controls do not cover local history or account logging. Use a saved provider connection or OPENROUTER_API_KEY, since a project-only provider.options.apiKey does not enable guarded free access.",
  },
  {
    question: "Is Vector free?",
    answer:
      "Yes. Create a free Vector account with Google or email, then download the desktop app from your account page. The same account signs in the terminal agent. Connect your own model provider to start; that provider bills its own usage.",
  },
]
