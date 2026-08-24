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
  {
    version: "1.17.53",
    title: "Plugins that install themselves",
    summary:
      "Connecting a plugin no longer sends you to a terminal. Vector resolves whatever runner a plugin needs, fetches it when it is missing, and pins an interpreter the package can actually run on, so Computer Use — full desktop control with screen reading, mouse, keyboard, and window management — connects on machines that had neither uv nor a recent Python. Retired the in-session Review PR button in favour of Project tools, Pull Requests, which lists, reviews, and merges rather than acting on one pasted link.",
  },
  {
    version: "1.17.54",
    title: "Licensing and disclosure",
    summary:
      "Removed the last copyleft dependency: HEIC images are now converted by the operating system rather than a bundled LGPL decoder, which also drops about three megabytes from every build. Expanded the privacy policy to cover local memory, the help assistant, bug reports, and optional screen and desktop control, and added a terms section describing what Vector can do on your machine and on services you connect.",
  },
  {
    version: "1.17.55",
    title: "Economics that actually learn",
    summary:
      "Model economics only ever learned from validated parallel runs, so it rarely gathered enough evidence to recommend anything. Every ordinary session now contributes what it truly cost — provider-reported tokens, spend, latency, and files touched — so recommendations appear from normal use. Removed a ranking signal nothing ever produced, which had been the primary sort key and rendered a permanently blank win rate. The site now says plainly which capabilities exist nowhere else: agents that message each other while working, per-agent attribution of live edits, and running Claude Code, Codex, or Cursor as engines inside Vector.",
  },
  {
    version: "1.17.56",
    title: "Agents can actually reach each other",
    summary:
      "Collaborative agents could not message each other. The teammate tool was registered in one tool registry while sessions resolve tools through another, so every call returned an unknown-tool error and the agent wrote its message into its own reply instead. The tool now lives where the engine looks, and the workspace is resolved through the location layer so the message queue lands in the right tree whether agents share one or work in isolation. Verified against a live model on a real repository: one agent renamed an export and told its teammate, and the teammate fixed the failing import.",
  },
  {
    version: "1.17.57",
    title: "Undo that cannot delete your work",
    summary:
      "Session snapshots were written as bare git trees with nothing pointing at them, so the engine's own scheduled garbage collection removed them after a week. Reverting to a collected snapshot then read as \"this file was never in the snapshot\" and deleted the file from your working tree, while reporting that the undo had succeeded. Snapshots are now anchored behind a ref so collection cannot reach them, a revert that cannot read its snapshot refuses to delete anything and says why, and a restore that fails no longer claims to have worked. Scheduled tasks became usable: the screen had no way to create one, so the list was always empty. It now has a real form with one-off, daily, weekday, and weekly schedules, and the suggestions fill it in. Agent teams were running unisolated, because a coordination file was written into the workspace before the git worktree was created; git refuses to create a worktree in a directory that already has contents, so every team silently fell back to a plain copy. Teams now get real isolated worktrees. Files inside newly created directories were missing from every workspace diff. LLM-as-a-judge now applies to every prompt and every agent workspace instead of only the session you typed in, and a failed verdict must name the specific repair rather than only the problem. Model economics prices runs from the engine's own live rate catalog instead of a hand-maintained table that had no entry for the default models and billed cached tokens at ten times their real rate. An unsubstantiated performance comparison was removed from the site.",
  },
  {
    version: "1.17.58",
    title: "Merges that keep a copy",
    summary:
      'Merging an agent workspace back into a project that is not a git repository could destroy work permanently. The copy-mode merge deleted and overwrote files in the real project directly, and the "checkpoint" it promised beforehand was only a map of file hashes — enough to detect a conflict, but incapable of restoring a single byte. Both copy merge paths now copy every file they are about to overwrite or delete into the checkpoint first, and a non-git checkpoint stores real file copies alongside a README explaining how to put them back. The same guarantee already covered git projects and now covers all four merge paths.',
  },
  {
    version: "1.17.59",
    title: "Nothing spends your key without saying so",
    summary:
      "Vector silently rerouted prompts it judged complex to a stronger model — on a bring-your-own-key product that can be many times the token price you chose — while the composer kept showing the model you picked, so there was no way to tell what you were being billed for. Routing is now off by default, has its own setting, honours models you hid in Settings, and switches the composer to whatever it actually used. Theme, colour scheme, and language controls returned: they existed only in a legacy shell that a hardcoded flag made unreachable, so the shipped app had no way to change any of them. Billing stopped re-posting stale Stripe metadata, which let two webhooks arriving together drop the checkout session and permanently invalidate a licence key that had already been emailed. A dead or wiped computer is no longer a permanent lockout — moving a licence is self-service and simply bounded. The one-installer-per-licence rule became a rate limit, and a download is recorded once the bytes arrive rather than before they are sent. The what's-new feed is now generated at build time; it had never existed, so the release-notes dialog had never run.",
  },
]

export const release118: VectorRelease[] = [
  {
    version: "1.18.0",
    title: "Agents you can leave alone",
    summary:
      "Vector can now sandbox the commands its agents run. Enable OPENCODE_SHELL_SANDBOX and every shell command from an agent is confined to the workspace it belongs to by the operating system's own mechanism \u2014 a seatbelt profile on macOS, bubblewrap on Linux \u2014 with reads of SSH keys, cloud credentials, and keychains denied outright. Windows has no equivalent that ships with the OS, so Vector says so and runs unconfined rather than pretending. It is off by default and degrades to an ordinary command whenever a host cannot sandbox, so it can never cost you a command that used to work. Scheduled work now actually happens while you are away: Vector keeps a tray presence and stays resident after the last window closes, showing what is armed and when it next runs, notifying you when a run finishes, and never staying alive without a tray to quit from. Repository context stopped being a keyword search. An on-device structural index ranks files with BM25 over identifiers and paths, then spreads through the real import graph and the files git history shows change together, so an agent receives the code that matters instead of whatever happened to share a word with the request. Vector now remembers how a project fails: normalised failure signatures accumulate per repository, a repair that worked once is offered the next time the same failure appears, and a test that passes and fails without any relevant change is reported as flaky instead of being chased through another repair loop. Unattended spend is capped rather than merely displayed \u2014 five dollars a run and twenty-five a day by default for scheduled and background agents, with a run that reports no usage recorded as unmeasured rather than free, so it can never silently trip a limit. Adds an eval harness that scores Vector's own agent against objectively-checkable tasks, and can run the same set through the Claude Code, Codex, and Cursor runtimes for comparison. The model effort slider is now a dot matrix that brightens toward the level you pick. Fixed continuous integration: tests and typechecks were gated on a branch this repository does not have, so no push had run them.",
  },
]

export const release119: VectorRelease[] = [
  {
    version: "1.19.0",
    title: "Work that repeats, and agents you can pair",
    summary:
      "Scheduled work moved out of the session and onto the home screen as Automations, and became a real automation engine rather than a reminder. Write the task yourself, then choose the repositories it runs in and, for each one, a fresh session or an existing thread to keep adding to. Every repository reports its own result, so one failing does not condemn the rest, and a recurring task now computes its next occurrence from the rule itself instead of drifting forward from whenever the last run happened to finish. A schedule missed while Vector was closed catches up once and says so rather than firing a burst. Agents can now be paired deliberately: a team is everyone-to-everyone, a coordinator broadcasting down to workers who do not chatter among themselves, or any pairing you set, and a message to an unlinked teammate is refused and told so instead of vanishing. Launching Claude Code, Codex, or Cursor Agent works again on ordinary machines: Vector looked for those CLIs using the stripped-down environment a desktop app inherits when it is opened from Finder, so anyone whose tools live under nvm, fnm, mise, asdf, volta, or a custom prefix was told the runtime was not installed, and the picker then hid it entirely. Vector now reads your login shell the way the engine already did, reports a runtime that is present but signed out as signed out with the command that fixes it, and shows an uninstalled runtime with its install steps rather than hiding the option. Fixed a defect that had been quietly deleting your work since 14 August: identifiers pack a millisecond timestamp into six bytes, which overflows and repeats roughly every 795 days, and the most recent repeat inverted the comparison behind tool-output retention — so every cleanup deleted the newest saved output and kept the oldest. Timestamps are now reconstructed across that boundary, with the identifier format unchanged. The test suite is green again: 24 failures, most of them assertions left behind by the rebrand, were repaired rather than deleted, and continuous integration, which had been running on a branch this repository does not have, now runs on every push.",
  },
  {
    version: "1.19.1",
    title: "One workspace, evenly told",
    summary:
      "The site led with running many agents at once, which is one capability rather than the reason to use Vector. It now gives equal weight to nine parts of the same workspace \u2014 the editor with search, diagnostics and a terminal; local memory that stays on your machine; spend measured from what the provider actually reported; the browser that will not type into a password field; optional judge verification; deployments on accounts that are already yours; the connector catalogue; parallel agents; and recurring automations \u2014 with a section that states plainly where each one is conditional. The model effort control is now a rounded rectangle rather than a capsule, so its frame matches the handle inside it, and at full effort the dot matrix carries purple flowing toward the handle instead of a flat pulse. Repaired the first-run test, which had asserted onboarding copy that stopped existing when the tour was rebuilt on 10 August and had been failing unnoticed ever since.",
  },
  {
    version: "1.19.2",
    title: "Undo that keeps your files",
    summary:
      "Undo could delete the work it was meant to restore. Reverting a step that touched two or more files asked git which of them were in the snapshot without disabling path quoting, so any name that is not plain ASCII came back quoted, failed to match, and the file was deleted as though it had never been in the snapshot \u2014 including untracked work that existed nowhere else. That path was also the only one that never checked the snapshot was readable first, so an unreadable snapshot read as an empty one. Reverting a rename was worse: git collapses a rename into a single entry naming only the destination, so undo deleted the new file and never restored the original. Both are fixed, the batch now refuses to delete when it cannot read the snapshot, and each has a regression test that fails without the fix. Scheduled automations could never report success \u2014 the poller looked for a message shape the route it calls does not return, so every run polled to its six-hour ceiling and was recorded as failed. A parallel agent whose turn ended in a provider error was recorded as complete with no changes, on exactly the unattended path the feature exists to protect. Merging was impossible in any project with local dev dependencies, because an isolated workspace has no node_modules and the resulting exit 127 was treated as a failed check rather than a skipped one. Non-ASCII paths broke merges after they had already written to the project, and files with Windows line endings could never be merged hunk by hunk. The one function guarding a merge against data loss silently skipped symlinks and swallowed every copy failure. Vector's subagents now have names and faces: Scout the fox explores, Veri the owl judges, Rook the raven watches the boundaries, and six more, each shown by name in the timeline and in the Agent Dashboard, with a new Pets page in Settings introducing the whole crew. Settings also gains Voice and Personalization, where custom instructions you write are applied to every new session in every repository. Pull Requests moved to Connections and now lists your CI runs, turning a failed one into a repair prompt. Scheduled runs left the session sidebar, since Automations on the home screen replaced it. Adds Graphify to the plugin catalogue.",
  },
  {
    version: "1.19.3",
    title: "Trust before autonomy",
    summary:
      "Vector now treats agent autonomy as a security boundary. Packaged builds seal the credential-vault key with the operating system's secure storage and stop visibly if no protected store is available instead of falling back to a plaintext vault. Agent shell confinement remains an opt-in preview on supported macOS and Linux hosts instead of being enabled during this release; set OPENCODE_SHELL_SANDBOX=1 to try it. When enabled, unavailable confinement needs explicit approval and linked-worktree Git objects, refs, and reflogs stay read-only, while web access and reads of common SSH, cloud, Kubernetes, Docker, environment, and private-key files ask first. The hosted help and bug-report endpoints now validate origins, content types, sizes, and structured fields, and use atomic Redis rate limits that fail closed in production before model or email capacity can be spent. First launch no longer forces the exhaustive tour. It presents a short activation path with a read-only starter task, keeps the full guide optional, and only marks provider setup and the first task complete after a real model response finishes successfully. V2 sessions now calculate model spend from catalog input, output, reasoning, cache read, cache write, and context-tier prices, honor authoritative Copilot billing metadata, persist normalized token breakdowns, and keep session totals exact through event replay, replacement, and revert paths; usage without a finite catalog price keeps the existing $0 compatibility fallback. Releases are now blocked on package typechecks, unit tests, and desktop and website build smoke tests; macOS artifacts must be signed and notarized, Windows installers must carry a valid signature and an updater publisher identity, every expected architecture is checked, checksums are published, and update feeds must succeed before the GitHub release becomes public. The objective agent eval expands from five tasks to eight with billing-idempotency, path-containment, and concurrent-allowance cases, plus repeated trials for exposing run-to-run variance. Embedded SDK hosts now resolve their database location when their runtime is built rather than capturing a stale import-time path. The subagents Vector delegates to are now named and described for the work they do \u2014 Explore, General, Judge, Debug, Migration, Performance, Review, Security and Test \u2014 each with its own mark, a summary of what it handles, and a read-only badge where that matches its permissions. They appear by name in the session timeline, in the Agent Dashboard, and on a new Subagents page in Settings. Settings also gains Voice and Personalization, where custom instructions you write are saved to the instruction file every new session already loads. The settings panels scroll again: they were scrollable all along, but the scrollbar was hidden, so a page taller than the dialog simply looked cut off.",
  },
  {
    version: "1.19.4",
    title: "The boundaries hold",
    summary:
      "A symlink committed inside a project defeated the permission gate that keeps an agent within your workspace. The check compared paths as text, so a link placed by a dependency, a merged pull request, or an agent following instructions in a page it fetched gave read and write access to the rest of the disk with no prompt. Containment is now decided on where a path really lands, dangling links are followed by hand, and a file that does not exist yet is resolved through its parent, so creating one cannot escape either; a permission you already granted on a link keeps working, because only the containment decision changed. The edit tool could replace more than it was asked to and report success: a difference of a single space matched a whole indented line and wrote back an unindented replacement, and an anchored match swallowed a line the model never saw. Edits are now reconciled against exactly what was described, and an edit that cannot be reconciled is refused rather than quietly applied. The browser's refusal to type into password, one-time-code and card fields was reachable only through one input path, so the agent's own key-press command walked around it; every path that can put characters into a field now shares the same check, decides on the focused element rather than a named selector, recognises a masked field whose type claims otherwise, and refuses on an unfamiliar key. Beyond those: the shell tool now tells the model when a command exits non-zero instead of leaving it to assume success, searching a single file no longer searches its whole directory, the Cloud Console and the agent's own cloud tool finally read the same saved setup, the secret scan inspects the directory that actually gets deployed, deployments are no longer silently cut off at two hundred files, publish and cloud logs are redacted, the file holding cloud environment variables is no longer world-readable, and joining an existing team no longer erases the pairing you configured.",
  },
  {
    version: "1.19.5",
    title: "Agents that actually reach each other",
    summary:
      "Putting agents in one workspace so they can message each other is something only Vector offers, and it did not work. The machinery was right \u2014 an agent really did queue its message \u2014 but there was one point where messages were read and one where they were written, and they sat at opposite ends of a run. Every member of a team starts at the same moment, so when the first prompts went out nobody had written anything yet, and by the time anything was collected everyone had already finished. The tool told each agent its message would arrive at the start of its teammate's next turn, and there was no next turn. Messages are now delivered while the team is still working, so one agent renaming a module can tell another to fix its imports and have that actually land. A repair pass counts as a turn and delivers too, and a run that fails or is stopped no longer strands whatever it had queued. Claude Code, Codex and Cursor agents can now be told what their teammates did, but they cannot reply \u2014 none of them has a teammate-message tool to call \u2014 so the launch screen now says which runtimes can send instead of promising it to all of them.",
  },
]
