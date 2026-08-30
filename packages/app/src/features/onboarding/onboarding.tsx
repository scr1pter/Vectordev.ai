import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import "./onboarding.css"

// The ambient sky both onboarding surfaces share: purple hues drifting on a
// slow loop across the whole screen, plus a pointer glow — the patch of sky
// under the cursor brightens slightly and follows it. Same recipe as the
// landing page's .aurora/.pointer-glow, tuned quieter for in-app use.
export function AmbientSky() {
  let root!: HTMLDivElement
  onMount(() => {
    // No rAF throttle: two custom-property writes per move are cheap, and a
    // lost frame callback would freeze the glow behind a stuck guard flag.
    const move = (event: MouseEvent) => {
      root.style.setProperty("--mx", `${event.clientX}px`)
      root.style.setProperty("--my", `${event.clientY}px`)
    }
    globalThis.window?.addEventListener("mousemove", move, { passive: true })
    onCleanup(() => globalThis.window?.removeEventListener("mousemove", move))
  })
  return (
    <div class="vx-sky" ref={root} aria-hidden="true">
      <div class="vx-sky-aurora" />
      <div class="vx-sky-stars" />
      <div class="vx-sky-pointer" />
    </div>
  )
}

// First-run activation stays intentionally short. The exhaustive spotlight
// tour and feature reference remain opt-in from this surface.

export type ProgressStep = {
  id: string
  title: string
  detail: string
  done: boolean
  cta: string
  onGo: () => void
}

// ---- Feature guide ---------------------------------------------------------
// The whole product, surface by surface, below the progress timeline. Data
// only — no navigation callbacks — so the guide stays a quiet reference the
// user scrolls at their own pace. Every claim here matches what the feature
// actually does; when a surface changes, its entry changes with it.

export type GuideEntry = {
  title: string
  /** Where the feature lives / how to open it — the locator line under the title. */
  where: string
  body: string
  tip: string
}

export type GuideSection = {
  kicker: string
  intro?: string
  entries: GuideEntry[]
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    kicker: "Start here",
    entries: [
      {
        title: "New project session",
        where: "The gradient button at the top of the sidebar — or ⌘N (Ctrl+N on Windows/Linux).",
        body: "This is the front door: a fresh project session with the Vector agent. Describe one result in plain language and press Enter. The agent plans the work, edits files, runs commands, and narrates each step so you can follow along or interrupt. The model chip in the composer shows which model is answering.",
        tip: "Brief it like an engineer: name the outcome (“a pricing page with three tiers”), not the implementation — and when something breaks, paste the exact error text.",
      },
      {
        title: "Overview",
        where: "The house icon at the top of the sidebar — Vector's home.",
        body: "Overview is where every project starts and returns. Open a project, start one focused session, or pick up yesterday's work from the searchable session list. The activity strip shows your real local streak, token use, completed chats, and favorite model at a glance.",
        tip: "The search box filters your recent sessions — faster than scrolling once the list grows.",
      },
      {
        title: "Code it yourself",
        where: "Project tools → Code editor.",
        body: "Open the project in Vector's editor, search for a file, and make the change directly. Your manual edits and the agent's edits share the same active project, so you can take over for a precise change and hand larger work back to the agent.",
        tip: "Use direct editing for exact, local changes; use an agent when the job spans files or needs commands and verification.",
      },
      {
        title: "Work with one agent",
        where: "Start a project session and describe the outcome in the message box.",
        body: "The main agent can inspect the project, plan, edit, run Terminal commands, operate the visible Browser, and repair failures. You can steer it while it works, change the model or effort, and inspect the result before keeping it.",
        tip: "Ask for a working outcome and a verification step, not just generated code.",
      },
      {
        title: "Work with multiple agents",
        where: "Use New workspace under the active project in the sidebar.",
        body: "Launch isolated agents for separate parts of the same project. Each one receives its own worktree, conversation, files, and command history. When an agent finishes, review its diff and checks, then merge only the work you trust.",
        tip: "Split work by ownership — for example frontend, backend, auth, and tests — so agents can move in parallel without editing one another's files.",
      },
    ],
  },
  {
    kicker: "Cloud Services",
    intro:
      "One repository-scoped console for releases, health, domains, environment, data, and build configuration. Open it from Vector Home.",
    entries: [
      {
        title: "Deployments",
        where: "Cloud Services → Deployments.",
        body: "Publish your app to the web in one click. Vector runs the whole deploy on your own Vercel or Netlify account — authorize once (for example, vercel login in the Terminal), and every deploy after that is a single click. Your code is never proxied through Vector: the build runs on your account, and finished deployments are listed with their live URLs. If no publisher is detected, the panel tells you exactly what to install and run.",
        tip: "Deploy early, even half-finished — a live URL makes every change after it feel real.",
      },
      {
        title: "Observability",
        where: "Cloud Services → Observability.",
        body: "Check every deployed URL from Vector and see real HTTP status, response time, last-check time, and the exact network failure when a release cannot be reached. Results stay attached to the current project session, so a different app never inherits the wrong health history.",
        tip: "Run Check all immediately after a production release, then inspect any degraded endpoint before sharing the link.",
      },
      {
        title: "Domains",
        where: "Cloud Services → Domains.",
        body: "Point a domain you own at the project. Add the domain and Vector shows the exact CNAME record to create at your registrar; click Verify and Vector checks your DNS live. Domains are scoped per project, so each app manages its own list.",
        tip: "DNS changes can take a few minutes to propagate — if verification doesn't pass immediately, wait a little and verify again.",
      },
      {
        title: "Environment variables",
        where: "Cloud Services → Environment.",
        body: "Manage the project's configuration as key–value pairs. Add or remove variables in the panel, then apply them and Vector writes them into the project's .env file, where your app — and the code the agent writes — can read them. It's the right home for the API keys and service URLs your app needs at runtime.",
        tip: "Keep secrets out of chat messages — put them here and just tell the agent the variable name.",
      },
      {
        title: "Database",
        where: "Cloud Services → Database.",
        body: "Connect a Supabase project: paste the URL and keys from Supabase → Settings → API, and Vector writes them to your .env and adds a ready-configured client in src/lib. From then on the agent codes against a real database and auth setup instead of mocks. You may not even need to open this panel yourself — when the agent detects that your task involves accounts, logins, or stored data, a “Set up database” banner appears and offers to wire Supabase in for you.",
        tip: "Connect the database before asking for signup or login features — the agent builds against the real client on the first pass.",
      },
      {
        title: "Build & runtime",
        where: "Cloud Services → Build & runtime.",
        body: "Detect the framework, package manager, install command, build command, output directory, and Node requirement from the actual repository. You can correct any value and save it for that repository; Cloud Services then uses the configured build and output directory when it publishes.",
        tip: "Detect once after opening a project, then verify the output directory before the first publish.",
      },
    ],
  },
  {
    kicker: "Agents",
    entries: [
      {
        title: "Scheduled runs",
        where: "Agents group in the sidebar.",
        body: "Write a prompt now, pick a date and time, and let it run later. On desktop, Vector launches the agent for you at the scheduled time — even while you work on something else; where a real scheduler isn't available, Vector saves the prompt, reminds you, and you choose when to load and run it. The badge on the sidebar item shows how many runs are waiting. Open a project first — the scheduled agent runs inside it.",
        tip: "Queue the unglamorous chores — dependency bumps, lint sweeps — for a time you're away, and review the result when you're back.",
      },
      {
        title: "Agent tabs",
        where: "Inside every active project.",
        body: "Launch a specialist into its own isolated git worktree or managed project copy. Every agent is a complete Vector session with its own model, conversation, tools, terminal activity, and file changes. Coordination can split one objective into dependent workstreams and schedule specialists automatically. Results pass guardrail checks and remain isolated until you review the diff and merge all or only approved hunks.",
        tip: "Give auth, frontend, backend, and testing to separate agents, then merge only the verified results.",
      },
      {
        title: "MCP",
        where: "Agents group in the sidebar.",
        body: "Connect Model Context Protocol servers — the open standard for giving agents tools. Add a server and its capabilities become available to the agent in your projects: databases, APIs, internal services, whatever the server exposes. The dialog manages all of your connections in one place.",
        tip: "Start with one server you actually need — every connected tool adds to what the agent weighs on each step.",
      },
    ],
  },
  {
    kicker: "Project tools",
    entries: [
      {
        title: "Code editor",
        where: "Switch from Agent to Editor at the top of the sidebar inside an active project.",
        body: "A focused editor over your project's files, for when you'd rather change something by hand. Search for a file, open it in a tab, edit it in place, and ask the agent to work on that same file without losing the session's context.",
        tip: "For a one-line tweak, editing here is faster than prompting — save the agent for changes worth delegating.",
      },
      {
        title: "Browser",
        where: "Project group in the sidebar, inside an active task.",
        body: "A real controlled browser beside the chat. You can use it directly, and Vector can inspect and operate that exact same visible page while reading DOM state, console output, runtime failures, and network errors. The diagnostics sidebar can be hidden when you want the full browser width.",
        tip: "Ask Vector to test the visible flow after an edit; it can inspect, repair, and retest without switching to a separate browser screen.",
      },
      {
        title: "Review changes",
        where: "Project group in the sidebar, inside an active task.",
        body: "Everything the task changed, as diffs — read it like a pull request before you accept it. Each file shows its additions and deletions with a Low / Medium / High risk read based on the size and nature of the change, so you know where to slow down. Vector's own guidance applies here too: review carefully, run the app, and keep a checkpoint before accepting broad edits.",
        tip: "Make Review the last step of every task — two minutes of reading beats an hour of debugging a change you never saw.",
      },
      {
        title: "Terminal",
        where: "Project group in the sidebar, inside an active task.",
        body: "A real shell in your project's directory, opened as a panel inside the task. Run the dev server, git commands, package installs — anything you'd type into any terminal — without leaving Vector. It needs an active task; the sidebar item toggles it open and closed.",
        tip: "One-off commands are often faster typed here yourself than asked of the agent.",
      },
    ],
  },
  {
    kicker: "Your safety net",
    entries: [
      {
        title: "Code Archaeology",
        where: "Inside a task — open it from the session's side panel.",
        body: "Vector captures a checkpoint automatically every time an agent edits your files — no setup, nothing to remember. The panel lists the task's whole history in order as Checkpoint 1, 2, 3… from the first to the latest; click a checkpoint's name to rename it, and use its notes field to write your own documentation of what changed and why. Every touched file gets a chip that opens straight into its diff. Restore writes a checkpoint's stored file snapshots back into your workspace — a one-click undo for an agent run that went the wrong way.",
        tip: "If a later prompt regresses behavior, don't argue with the agent — restore the last good checkpoint and re-prompt from there.",
      },
    ],
  },
  {
    kicker: "Everyday flow",
    entries: [
      {
        title: "Dictation",
        where: "The mic button in the message composer.",
        body: "Talk instead of typing. Tap the mic, speak your prompt, and the transcript lands in the composer ready to edit or send. On the desktop app, transcription runs entirely on your machine with a local Whisper model — audio never leaves your computer; in the browser, Vector uses the browser's built-in speech recognition, streaming interim text as you speak.",
        tip: "Dictate the messy first version, tidy the words that matter, then hit Enter.",
      },
      {
        title: "Push to GitHub or GitLab",
        where: "Cloud Services → Integrations, after choosing a repository.",
        body: "Commit and push a selected repository from its Cloud Services workspace. Vector can use an existing origin or create a new GitHub or GitLab repository through your connected account, while keeping source-control publishing attached to the repository it belongs to.",
        tip: "Run Review changes first, then push — a commit should never contain a diff you haven't read.",
      },
      {
        title: "Settings",
        where: "The gear at the bottom of the sidebar.",
        body: "Everything about how Vector runs. Providers is where you bring your own keys — OpenAI, Anthropic, Google, and more — and where OpenCode Zen's free curated models live, so there's a capable model before you've paid anyone. Models manages which models appear in your pickers. Keybinds remaps Vector's shortcuts to fit your fingers, and Appearance sets the theme and workspace colors.",
        tip: "Set up one paid provider and keep a free model around — then switch per task from the composer's model chip.",
      },
    ],
  },
]

export function OnboardingProgress(props: {
  open: boolean
  steps: ProgressStep[]
  onReplayTour: () => void
  onClose: () => void
}) {
  const doneCount = createMemo(() => props.steps.filter((step) => step.done).length)
  const allDone = createMemo(() => doneCount() === props.steps.length)

  return (
    <Show when={props.open}>
      <div
        class="vprogress"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose()
        }}
      >
        <AmbientSky />
        <div class="vprogress-card">
          <button type="button" class="vprogress-close" aria-label="Close getting started" onClick={props.onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="m4.5 4.5 7 7M11.5 4.5l-7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <div class="vtour-eyebrow">
            <span class="vtour-eyebrow-dot" />
            Getting started
          </div>
          <h1 class="vprogress-title">
            <Show
              when={!allDone()}
              fallback={
                <>
                  Vector is <em>yours.</em>
                </>
              }
            >
              <em>
                {doneCount()} of {props.steps.length}
              </em>{" "}
              first steps
            </Show>
          </h1>
          <p class="vprogress-sub">
            {allDone()
              ? "You've run the whole loop. Everything in Vector is yours now."
              : "No rush — Vector checks these off as you actually do them."}
          </p>

          <div class="vprogress-timeline">
            <div class="vprogress-rail">
              <div
                class="vprogress-rail-fill"
                style={{ height: `${(doneCount() / Math.max(1, props.steps.length)) * 100}%` }}
              />
            </div>
            <div class="vprogress-steps">
              <For each={props.steps}>
                {(step) => (
                  <div class="vprogress-step" data-done={step.done}>
                    <span class="vprogress-node" data-done={step.done}>
                      <Show when={step.done}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="m3.5 8.5 3 3 6-7"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </span>
                    <div class="vprogress-copy">
                      <div class="vprogress-step-title">{step.title}</div>
                      <div class="vprogress-step-detail">{step.detail}</div>
                    </div>
                    <Show when={!step.done}>
                      <button type="button" class="vprogress-go" onClick={step.onGo}>
                        {step.cta} →
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>

          <details class="vguide">
            <summary class="vguide-toggle">
              <span>
                <span class="vguide-kicker">Optional reference</span>
                <strong>Explore the full feature guide</strong>
              </span>
              <span class="vguide-toggle-icon" aria-hidden="true">
                ↓
              </span>
            </summary>
            <div class="vguide-content">
              <div class="vguide-head">
                <div class="vguide-kicker">Feature guide</div>
                <h2 class="vguide-title">Everything Vector can do</h2>
                <p class="vguide-lede">
                  The whole workspace, surface by surface — what each one is for, where it lives, and how to get the
                  most out of it. Scroll at your own pace; it'll be here whenever you need it.
                </p>
              </div>
              <For each={GUIDE_SECTIONS}>
                {(section) => (
                  <section class="vguide-section">
                    <div class="vguide-kicker">{section.kicker}</div>
                    <Show when={section.intro}>
                      <p class="vguide-intro">{section.intro}</p>
                    </Show>
                    <div class="vguide-entries">
                      <For each={section.entries}>
                        {(entry) => (
                          <article class="vguide-entry">
                            <h3 class="vguide-entry-title">{entry.title}</h3>
                            <div class="vguide-entry-where">{entry.where}</div>
                            <p class="vguide-entry-body">{entry.body}</p>
                            <p class="vguide-entry-tip">
                              <span class="vguide-tip-label">Pro tip</span>
                              {entry.tip}
                            </p>
                          </article>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </details>

          <div class="vprogress-footer">
            <button type="button" class="vtour-back" onClick={props.onReplayTour}>
              Take the full tour
            </button>
            <button type="button" class="vtour-next" onClick={props.onClose}>
              {allDone() ? "Done" : "Keep building"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
