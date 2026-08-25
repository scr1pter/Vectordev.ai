import { createMemo, createSignal, For, Show } from "solid-js"
import { buildReviewPrompt, countBySeverity, formatReviewComment, parseReview, type PullRequestReview } from "./ai-review"

type CliStatus = {
  installed: boolean
  authenticated: boolean
  login?: string
  installCommand?: string
  installUrl: string
  installDetail: string
  authCommand: string
  detail: string
}

type PullRequest = {
  number: number
  title: string
  author: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
  url: string
  updatedAt: string
  reviewDecision?: string
}

type PullRequestDetail = PullRequest & {
  body: string
  files: { path: string; additions: number; deletions: number }[]
  comments: { author: string; body: string; createdAt: string }[]
}

type PullRequestsApi = {
  status: () => Promise<CliStatus>
  list: (cwd: string, options?: { state?: string; limit?: number }) => Promise<PullRequest[]>
  view: (cwd: string, number: number) => Promise<PullRequestDetail>
  diff: (cwd: string, number: number) => Promise<string>
  review: (input: { cwd: string; number: number; body: string; event: string }) => Promise<{ posted: boolean }>
  merge: (input: { cwd: string; number: number; strategy: string }) => Promise<{ merged: boolean }>
}

function api(): PullRequestsApi | undefined {
  return (globalThis.window as unknown as { api?: { pullRequests?: PullRequestsApi } } | undefined)?.api?.pullRequests
}

type CiRun = {
  id: number
  workflow: string
  title: string
  branch: string
  status: string
  conclusion: string
  url: string
  createdAt: string
}

type CiFailedStep = { job: string; step: string; kind: string; excerpt: string }

type CiApi = {
  runs: (
    projectPath: string,
    options?: { branch?: string; limit?: number },
  ) => Promise<{ ok: true; runs: CiRun[] } | { ok: false; reason: string; detail: string; command: string }>
  repair: (
    projectPath: string,
    runId: number,
  ) => Promise<
    { ok: true; failure: { steps: CiFailedStep[] }; prompt: string } | { ok: false; detail: string; command: string }
  >
}

function ciApi(): CiApi | undefined {
  return (globalThis.window as unknown as { api?: { ci?: CiApi } } | undefined)?.api?.ci
}

function CopyableCommand(props: { command: string }) {
  const [copied, setCopied] = createSignal(false)
  return (
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] px-3 py-2 text-left font-mono text-[12px] text-white/80 transition hover:border-[color:var(--vx-purple)]"
      onClick={() => {
        void navigator.clipboard?.writeText(props.command)
        setCopied(true)
        setTimeout(() => setCopied(false), 1_500)
      }}
    >
      <span class="min-w-0 flex-1 truncate">{props.command}</span>
      <span class="shrink-0 text-[11px] text-white/45">{copied() ? "Copied" : "Copy"}</span>
    </button>
  )
}

export function PullRequests(props: { open: boolean; projectPath?: string; onClose: () => void; onAiReview: (prompt: string) => Promise<string> }) {
  const [status, setStatus] = createSignal<CliStatus>()
  const [list, setList] = createSignal<PullRequest[]>([])
  const [selected, setSelected] = createSignal<PullRequestDetail>()
  const [review, setReview] = createSignal<PullRequestReview>()
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [posted, setPosted] = createSignal(false)
  const [ciRuns, setCiRuns] = createSignal<CiRun[]>([])
  const [ciNote, setCiNote] = createSignal<string>()
  const [ciOpenRun, setCiOpenRun] = createSignal<number>()
  const [ciDetail, setCiDetail] = createSignal<{ steps: CiFailedStep[]; prompt: string }>()
  const [ciPromptCopied, setCiPromptCopied] = createSignal(false)

  const refresh = async () => {
    const bridge = api()
    if (!bridge) {
      setError("Pull requests are available in the Vector desktop app.")
      return
    }
    setBusy("Checking GitHub CLI…")
    setError(undefined)
    const cli = await bridge.status().catch(() => undefined)
    setStatus(cli)
    if (!cli?.installed || !cli.authenticated || !props.projectPath) {
      setBusy(undefined)
      return
    }
    setBusy("Loading pull requests…")
    const prs = await bridge.list(props.projectPath, { state: "open", limit: 100 }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return [] as PullRequest[]
    })
    setList(prs)
    setBusy(undefined)
    // CI shares the same gh sign-in the panel just confirmed, so load it after
    // the PR list rather than gating the whole panel on it — a repo with no
    // workflows should still show its pull requests.
    const ci = ciApi()
    if (!ci) return
    const runs = await ci.runs(props.projectPath, { limit: 10 }).catch(() => undefined)
    if (!runs) return
    if (!runs.ok) {
      setCiRuns([])
      setCiNote(runs.detail)
      return
    }
    setCiNote(undefined)
    setCiRuns(runs.runs)
  }

  const inspectCiRun = async (runId: number) => {
    const ci = ciApi()
    if (!ci || !props.projectPath) return
    if (ciOpenRun() === runId) {
      setCiOpenRun(undefined)
      setCiDetail(undefined)
      return
    }
    setCiOpenRun(runId)
    setCiDetail(undefined)
    setBusy("Reading the failure log…")
    const result = await ci.repair(props.projectPath, runId).catch(() => undefined)
    setBusy(undefined)
    if (!result?.ok) {
      setCiNote(result ? result.detail : "Vector could not read that run's log.")
      return
    }
    setCiDetail({ steps: result.failure.steps, prompt: result.prompt })
  }

  // Refresh whenever the panel opens rather than on an interval; gh shells out
  // and a background poll would spawn a process every few seconds.
  const opened = createMemo(() => props.open)
  createMemo(() => {
    if (opened()) void refresh()
  })

  const openPr = async (number: number) => {
    const bridge = api()
    if (!bridge || !props.projectPath) return
    setBusy(`Loading #${number}…`)
    setReview(undefined)
    setPosted(false)
    const detail = await bridge.view(props.projectPath, number).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    setSelected(detail)
    setBusy(undefined)
  }

  const runAiReview = async () => {
    const bridge = api()
    const pr = selected()
    if (!bridge || !pr || !props.projectPath) return
    setBusy("Reading the diff…")
    setError(undefined)
    const diff = await bridge.diff(props.projectPath, pr.number).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return ""
    })
    if (!diff) {
      setBusy(undefined)
      return
    }
    setBusy("Vector is reviewing…")
    const answer = await props
      .onAiReview(buildReviewPrompt({ title: pr.title, body: pr.body, baseRef: pr.baseRefName, headRef: pr.headRefName, diff }))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        return ""
      })
    // Constrain findings to files actually in this PR so a hallucinated path
    // never reaches someone else's pull request.
    const parsed = parseReview(answer, pr.files.map((file) => file.path))
    if (!parsed) setError("Vector could not produce a structured review for this diff.")
    setReview(parsed)
    setBusy(undefined)
  }

  const postReview = async () => {
    const bridge = api()
    const pr = selected()
    const current = review()
    if (!bridge || !pr || !current || !props.projectPath) return
    setBusy("Posting review…")
    const result = await bridge
      .review({ cwd: props.projectPath, number: pr.number, body: formatReviewComment(current), event: current.verdict })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        return undefined
      })
    setPosted(Boolean(result?.posted))
    setBusy(undefined)
  }

  return (
    <Show when={props.open}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pull Requests"
        class="fixed inset-0 z-[90] flex flex-col bg-[color:var(--vx-canvas)]"
      >
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] px-5">
          <div class="min-w-0 flex-1">
            <div class="text-[14px] font-semibold text-white">Pull Requests</div>
            <div class="truncate text-[11px] text-white/45">
              {status()?.detail ?? "Create, review, and merge without leaving Vector"}
            </div>
          </div>
          <Show when={busy()}>
            <span class="shrink-0 text-[11.5px] text-white/45">{busy()}</span>
          </Show>
          <button
            type="button"
            aria-label="Close Pull Requests"
            class="grid size-7 place-items-center rounded-[5px] text-white/45 transition hover:bg-white/[0.06] hover:text-white"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Show when={error()}>
            <div class="mb-3 rounded-[6px] border border-rose-400/40 bg-rose-400/[0.07] px-3 py-2 text-[12px] text-rose-200">
              {error()}
            </div>
          </Show>

          <Show when={status() && !status()!.installed}>
            <div class="mx-auto max-w-[560px] rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-5">
              <h2 class="mb-1 text-[14px] font-semibold text-white">Install the GitHub CLI</h2>
              <p class="mb-3 text-[12.5px] leading-relaxed text-white/60">
                Vector drives your own <span class="font-mono">gh</span> installation, so it uses your existing GitHub
                sign-in and respects your organization's policies. No extra token needed.
              </p>
              <Show
                when={status()!.installCommand}
                fallback={
                  <a
                    class="flex items-center justify-between gap-3 rounded-[6px] border border-[color:var(--vx-line)] bg-black/25 px-3 py-2.5 text-[12.5px] text-white/80 transition hover:border-[color:var(--vx-purple)]"
                    href={status()!.installUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>Download the GitHub CLI</span>
                    <span class="shrink-0 text-[11.5px] text-white/40">{status()!.installUrl}</span>
                  </a>
                }
              >
                <CopyableCommand command={status()!.installCommand!} />
              </Show>
              <p class="mt-2 text-[11.5px] leading-relaxed text-white/45">{status()!.installDetail}</p>
              <p class="mb-2 mt-3 text-[12px] text-white/50">Then sign in:</p>
              <CopyableCommand command={status()!.authCommand} />
              <button
                type="button"
                class="mt-4 rounded-[6px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12.5px] font-medium text-white"
                onClick={() => void refresh()}
              >
                Check again
              </button>
            </div>
          </Show>

          <Show when={status()?.installed && !status()?.authenticated}>
            <div class="mx-auto max-w-[560px] rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-5">
              <h2 class="mb-1 text-[14px] font-semibold text-white">Sign in to GitHub</h2>
              <p class="mb-3 text-[12.5px] text-white/60">The GitHub CLI is installed but not signed in.</p>
              <CopyableCommand command={status()!.authCommand} />
              <button
                type="button"
                class="mt-4 rounded-[6px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12.5px] font-medium text-white"
                onClick={() => void refresh()}
              >
                Check again
              </button>
            </div>
          </Show>

          <Show when={status()?.authenticated}>
            <div class="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
              <div class="flex flex-col gap-1.5">
                <Show
                  when={list().length}
                  fallback={<div class="rounded-[6px] border border-[color:var(--vx-line)] px-4 py-6 text-center text-[12.5px] text-white/45">No open pull requests.</div>}
                >
                  <For each={list()}>
                    {(pr) => (
                      <button
                        type="button"
                        class="rounded-[6px] border px-3 py-2.5 text-left transition"
                        classList={{
                          "border-[color:var(--vx-purple)] bg-[color:var(--vx-surface)]": selected()?.number === pr.number,
                          "border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] hover:border-white/20":
                            selected()?.number !== pr.number,
                        }}
                        onClick={() => void openPr(pr.number)}
                      >
                        <div class="flex items-baseline gap-2">
                          <span class="shrink-0 text-[11px] text-white/40">#{pr.number}</span>
                          <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-white">{pr.title}</span>
                          <Show when={pr.isDraft}>
                            <span class="shrink-0 rounded-full bg-white/[0.07] px-1.5 py-px text-[9.5px] uppercase text-white/50">draft</span>
                          </Show>
                        </div>
                        <div class="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-white/40">
                          <span>{pr.author}</span>
                          <span>{pr.headRefName} → {pr.baseRefName}</span>
                          <span class="text-emerald-300/70">+{pr.additions}</span>
                          <span class="text-rose-300/70">−{pr.deletions}</span>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>

                <div class="mt-4 border-t border-[color:var(--vx-line)] pt-3">
                  <div class="mb-1.5 flex items-baseline justify-between">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-white/45">CI runs</span>
                    <Show when={ciRuns()[0]}>
                      <span class="text-[10.5px] text-white/35">{ciRuns()[0]!.branch}</span>
                    </Show>
                  </div>
                  <Show when={ciNote()}>
                    <p class="mb-1.5 text-[11.5px] leading-relaxed text-white/45">{ciNote()}</p>
                  </Show>
                  <Show when={!ciNote() && ciRuns().length === 0}>
                    <p class="text-[11.5px] text-white/40">No workflow runs for this branch.</p>
                  </Show>
                  <For each={ciRuns()}>
                    {(run) => (
                      <div class="mb-1 rounded-[6px] border border-[color:var(--vx-line)]">
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                          onClick={() => {
                            if (run.conclusion === "failure") {
                              void inspectCiRun(run.id)
                              return
                            }
                            globalThis.window?.open(run.url, "_blank")
                          }}
                        >
                          <span
                            class="size-1.5 shrink-0 rounded-full"
                            classList={{
                              "bg-emerald-400": run.conclusion === "success",
                              "bg-rose-400": run.conclusion === "failure",
                              "bg-amber-400": run.status !== "completed",
                              "bg-white/30":
                                run.status === "completed" && !["success", "failure"].includes(run.conclusion),
                            }}
                          />
                          <span class="min-w-0 flex-1 truncate text-[11.5px] text-white/70">
                            {run.workflow} · {run.title}
                          </span>
                          <span class="shrink-0 text-[10.5px] text-white/35">
                            {run.conclusion === "failure" ? (ciOpenRun() === run.id ? "Hide" : "Inspect") : run.conclusion || run.status}
                          </span>
                        </button>
                        <Show when={ciOpenRun() === run.id && ciDetail()}>
                          <div class="border-t border-[color:var(--vx-line)] px-2.5 py-2">
                            <For each={ciDetail()!.steps.slice(0, 2)}>
                              {(step) => (
                                <div class="mb-1.5">
                                  <div class="text-[10.5px] text-rose-300/80">
                                    {step.job} › {step.step} · {step.kind}
                                  </div>
                                  <pre class="mt-1 max-h-28 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-white/60">
                                    {step.excerpt}
                                  </pre>
                                </div>
                              )}
                            </For>
                            <button
                              type="button"
                              class="rounded-[6px] bg-[color:var(--vx-purple)] px-2.5 py-1 text-[11.5px] font-medium text-white"
                              onClick={() => {
                                void navigator.clipboard?.writeText(ciDetail()!.prompt)
                                setCiPromptCopied(true)
                                setTimeout(() => setCiPromptCopied(false), 1_500)
                              }}
                            >
                              {ciPromptCopied() ? "Copied — paste it to the agent" : "Copy fix prompt for the agent"}
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div>
                <Show
                  when={selected()}
                  fallback={<div class="rounded-[6px] border border-[color:var(--vx-line)] px-4 py-10 text-center text-[12.5px] text-white/45">Select a pull request.</div>}
                >
                  <div class="rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-4">
                    <h2 class="text-[14px] font-semibold text-white">
                      #{selected()!.number} {selected()!.title}
                    </h2>
                    <div class="mt-1 text-[11.5px] text-white/45">
                      {selected()!.author} · {selected()!.changedFiles} files
                    </div>

                    <div class="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={Boolean(busy())}
                        class="rounded-[6px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50"
                        onClick={() => void runAiReview()}
                      >
                        Run Vector AI review
                      </button>
                      <Show when={review() && !posted()}>
                        <button
                          type="button"
                          disabled={Boolean(busy())}
                          class="rounded-[6px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12.5px] text-white/75 hover:text-white disabled:opacity-50"
                          onClick={() => void postReview()}
                        >
                          Post to GitHub ({review()!.verdict})
                        </button>
                      </Show>
                      <Show when={posted()}>
                        <span class="self-center text-[12px] text-emerald-300">Review posted</span>
                      </Show>
                    </div>

                    <Show when={review()}>
                      <div class="mt-4 border-t border-[color:var(--vx-line)] pt-3">
                        <div class="mb-2 flex flex-wrap gap-3 text-[11.5px]">
                          <span class="text-rose-300">{countBySeverity(review()!.findings).blocking} blocking</span>
                          <span class="text-amber-300">{countBySeverity(review()!.findings).concern} concerns</span>
                          <span class="text-white/45">{countBySeverity(review()!.findings).nit} nits</span>
                        </div>
                        <p class="mb-3 text-[12.5px] leading-relaxed text-white/70">{review()!.summary}</p>
                        <For each={review()!.findings}>
                          {(finding) => (
                            <div class="mb-2 rounded-[6px] border border-[color:var(--vx-line)] px-3 py-2">
                              <div class="flex items-baseline gap-2">
                                <span
                                  class="shrink-0 text-[10.5px] uppercase tracking-wide"
                                  classList={{
                                    "text-rose-300": finding.severity === "blocking",
                                    "text-amber-300": finding.severity === "concern",
                                    "text-white/40": finding.severity === "nit",
                                  }}
                                >
                                  {finding.severity}
                                </span>
                                <span class="min-w-0 flex-1 text-[12.5px] font-medium text-white">{finding.title}</span>
                              </div>
                              <div class="mt-0.5 font-mono text-[11px] text-[color:var(--vx-purple-bright)]">
                                {finding.file}
                                {finding.line ? `:${finding.line}` : ""}
                              </div>
                              <p class="mt-1 text-[12px] leading-relaxed text-white/65">{finding.detail}</p>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
