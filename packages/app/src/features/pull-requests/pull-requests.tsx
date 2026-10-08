import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { githubApi, GithubDeviceSignIn } from "@/components/github-connect"
import {
  buildDesktopSummary,
  countBySeverity,
  estimateText,
  findingGroups,
  REBUILT_HINT,
  repoOf,
  reviewEvents,
  reviewFooter,
  skippedText,
  type ReviewCheckout,
  type ReviewEstimate,
  type ReviewEvent,
  type ReviewFindingView,
  type ReviewOutcomeLite,
  type ReviewRequest,
} from "./ai-review"
import {
  buildPullRequestCreateInput,
  buildPullRequestMergeInput,
  createPullRequestRequestScope,
  pullRequestErrorMessage,
  pullRequestMergeAction,
  pullRequestProjectIsCurrent,
} from "./pull-request-actions"

// Whether Vector can act on GitHub: the user's GitHub sign-in in Vector, or an existing GitHub CLI login.
type AccessStatus = {
  authenticated: boolean
  configured: boolean
  login?: string
  source?: "vector" | "gh"
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
  headRefOid?: string
  baseRefOid?: string
  isCrossRepository?: boolean
}

type PullRequestsApi = {
  status: () => Promise<AccessStatus>
  list: (cwd: string, options?: { state?: string; limit?: number }) => Promise<PullRequest[]>
  view: (cwd: string, number: number) => Promise<PullRequestDetail>
  diff: (cwd: string, number: number, head?: string) => Promise<string>
  create: (input: {
    cwd: string
    title: string
    body: string
    base?: string
    draft?: boolean
  }) => Promise<{ url: string }>
  review: (input: {
    cwd: string
    number: number
    head?: string
    body: string
    event: "comment" | "approve" | "request-changes"
  }) => Promise<{ posted: boolean }>
  merge: (input: {
    cwd: string
    number: number
    strategy: "merge" | "squash" | "rebase"
    head?: string
  }) => Promise<{ merged: boolean }>
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

const SEVERITY = {
  blocking: { label: "Blocking", one: "blocking", many: "blocking", tone: "var(--vx-red)" },
  concern: { label: "Concerns", one: "concern", many: "concerns", tone: "var(--vx-amber)" },
  nit: { label: "Nits", one: "nit", many: "nits", tone: "var(--vx-text-muted)" },
} as const

const RISK = {
  low: { level: 1, tone: "var(--vx-green)" },
  medium: { level: 2, tone: "var(--vx-amber)" },
  high: { level: 3, tone: "var(--vx-red)" },
} as const

const DECISION: Record<string, { text: string; tone: string }> = {
  APPROVED: { text: "Approved", tone: "var(--vx-green)" },
  CHANGES_REQUESTED: { text: "Changes requested", tone: "var(--vx-red)" },
  REVIEW_REQUIRED: { text: "Review required", tone: "var(--vx-amber)" },
}

const MERGE_STRATEGIES = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
] as const

const BUTTON =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium transition duration-150 disabled:cursor-default disabled:opacity-45"
const PRIMARY = `${BUTTON} bg-[color:var(--vx-purple)] text-white hover:enabled:brightness-110`
const SECONDARY = `${BUTTON} border border-[color:var(--vx-line-strong)] bg-[color:var(--vx-control)] text-[color:var(--vx-text)] hover:enabled:bg-[color:var(--vx-control-hover)]`
const GHOST = `${BUTTON} text-[color:var(--vx-text-subtle)] hover:enabled:bg-[color:var(--vx-control)] hover:enabled:text-[color:var(--vx-text)]`
const DANGER = `${BUTTON} border border-[color:color-mix(in_srgb,var(--vx-red)_45%,transparent)] text-[color:var(--vx-red)] hover:enabled:bg-[color:color-mix(in_srgb,var(--vx-red)_12%,transparent)]`
const FIELD =
  "rounded-[6px] border border-[color:var(--vx-line-strong)] bg-[color:var(--vx-canvas)] px-3 py-2 text-[color:var(--vx-text)] outline-none transition placeholder:text-[color:var(--vx-text-muted)] focus:border-[color:var(--vx-purple)]"
// The panel shows this many of a pull request's files and latest comments; GitHub has the rest.
const FILES_SHOWN = 12
const COMMENTS_SHOWN = 5
const SECTION_TITLE = "text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--vx-text-muted)]"

const ICONS = {
  pull: () => (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5A1.5 1.5 0 0 0 10 5H7.5M9 3.5 7.5 5 9 6.5" />
    </>
  ),
  draft: () => (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 4v.5M11.5 7v1M11.5 10v.5" />
    </>
  ),
  external: () => <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" />,
  search: () => (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="m10 10 3 3" />
    </>
  ),
  logout: () => <path d="M6.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.5M10 5l3 3-3 3M13 8H6.5" />,
  close: () => <path d="m4 4 8 8m0-8-8 8" />,
  scope: () => (
    <>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1.75" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </>
  ),
  refresh: () => <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.75v2.5h-2.5" />,
  check: () => <path d="m3.5 8.5 3 3 6-7" />,
  stop: () => <rect x="4.5" y="4.5" width="7" height="7" rx="1.25" />,
  merge: () => (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="9" r="1.5" />
      <path d="M4.5 5v6M4.5 5c0 2.5 2 4 5.5 4" />
    </>
  ),
  plus: () => <path d="M8 3.5v9M3.5 8h9" />,
  comment: () => <path d="M3 4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L5 13v-2H4a1 1 0 0 1-1-1z" />,
} satisfies Record<string, () => JSX.Element>

function Icon(props: { name: keyof typeof ICONS; class?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class ?? "size-3.5"}
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {ICONS[props.name]()}
    </svg>
  )
}

function Spinner() {
  return (
    <span class="size-3 shrink-0 rounded-full border-[1.5px] border-[color:var(--vx-line-strong)] border-t-[color:var(--vx-purple-bright)] motion-safe:animate-spin" />
  )
}

// Backticks mark code in Vector's own copy and in model titles; they are shown as code, not as raw backticks.
function CodeText(props: { text: string }) {
  return (
    <For each={props.text.split("`")}>
      {(part, index) =>
        index() % 2 === 1 ? (
          <code class="rounded-[3px] bg-[color:var(--vx-control)] px-1 font-mono text-[0.92em]">{part}</code>
        ) : (
          part
        )
      }
    </For>
  )
}

function BranchName(props: { name: string }) {
  return (
    <span class="rounded-[4px] bg-[color:var(--vx-purple-soft)] px-1.5 py-px font-mono text-[11px] text-[color:var(--vx-purple-bright)]">
      {props.name}
    </span>
  )
}

function RiskMeter(props: { risk: keyof typeof RISK; counts: { blocking: number; concern: number; nit: number } }) {
  return (
    <div class="flex flex-col gap-2 rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] p-3">
      <div class="flex items-baseline justify-between">
        <span class={SECTION_TITLE}>Risk</span>
        <span class="text-[13px] font-semibold" style={{ color: RISK[props.risk].tone }}>
          {capital(props.risk)}
        </span>
      </div>
      <div class="grid grid-cols-3 gap-1" aria-hidden="true">
        <For each={[1, 2, 3]}>
          {(step) => (
            <span
              class="h-1 rounded-full"
              style={{
                background: step <= RISK[props.risk].level ? RISK[props.risk].tone : "var(--vx-control-hover)",
              }}
            />
          )}
        </For>
      </div>
      <div class="flex flex-wrap gap-x-2.5 gap-y-1 text-[11.5px] text-[color:var(--vx-text-subtle)]">
        <For each={["blocking", "concern", "nit"] as const}>
          {(severity) => (
            <span class="inline-flex items-center gap-1.5">
              <span class="size-1.5 rounded-full" style={{ background: SEVERITY[severity].tone }} />
              {props.counts[severity]} {props.counts[severity] === 1 ? SEVERITY[severity].one : SEVERITY[severity].many}
            </span>
          )}
        </For>
      </div>
    </div>
  )
}

function FindingCard(props: { finding: ReviewFindingView }) {
  return (
    <article class="rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] px-3.5 py-3">
      <div class="flex items-start gap-2.5">
        <span
          class="mt-[5px] size-2 shrink-0 rounded-full"
          style={{ background: SEVERITY[props.finding.severity].tone }}
          title={SEVERITY[props.finding.severity].label}
        />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h4 class="text-[13px] font-medium leading-snug text-[color:var(--vx-text)]">
              <CodeText text={props.finding.title} />
            </h4>
            <span class="text-[10.5px] text-[color:var(--vx-text-muted)]">{props.finding.category}</span>
          </div>
          <div class="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-[color:var(--vx-purple-bright)]">
            <span class="break-all">
              {props.finding.path}:{props.finding.line}
            </span>
            <Show when={props.finding.place !== "changed"}>
              <span class="font-sans text-[color:var(--vx-text-muted)]">
                {props.finding.place === "outside" ? "outside the changed lines" : "elsewhere in this pull request"}
              </span>
            </Show>
          </div>
          <Show when={props.finding.body}>
            <p class="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--vx-text-subtle)]">
              <CodeText text={props.finding.body} />
            </p>
          </Show>
          <Show when={props.finding.fix}>
            {(fix) => (
              <div class="mt-2.5 overflow-hidden rounded-[6px] border border-[color:var(--vx-line)]">
                <div class="border-b border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-2.5 py-1 text-[10.5px] text-[color:var(--vx-text-muted)]">
                  Suggested change
                </div>
                <pre class="max-h-56 overflow-auto bg-[color:var(--vx-surface)] py-1 font-mono text-[11px] leading-[1.55]">
                  <For each={fix().removed}>
                    {(line) => (
                      <div class="bg-[color:color-mix(in_srgb,var(--vx-red)_10%,transparent)] px-2.5 text-[color:var(--vx-red)]">
                        -{line}
                      </div>
                    )}
                  </For>
                  <For each={fix().added}>
                    {(line) => (
                      <div class="bg-[color:color-mix(in_srgb,var(--vx-green)_10%,transparent)] px-2.5 text-[color:var(--vx-green)]">
                        +{line}
                      </div>
                    )}
                  </For>
                </pre>
              </div>
            )}
          </Show>
        </div>
      </div>
    </article>
  )
}

function capital(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function since(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes)) return ""
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  if (minutes < 60 * 24 * 30) return `${Math.round(minutes / (60 * 24))}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function initial(name: string) {
  return (name.replace(/^@/, "").charAt(0) || "?").toUpperCase()
}

export function PullRequests(props: {
  open: boolean
  projectPath?: string
  onClose: () => void
  onReview: (input: ReviewRequest) => Promise<ReviewOutcomeLite | undefined>
}) {
  const [status, setStatus] = createSignal<AccessStatus>()
  const [list, setList] = createSignal<PullRequest[]>([])
  const [selected, setSelected] = createSignal<PullRequestDetail>()
  const [review, setReview] = createSignal<ReviewOutcomeLite>()
  const [reviewRun, setReviewRun] = createSignal<{ controller: AbortController; number: number }>()
  const [checkout, setCheckout] = createSignal<{ mode: ReviewCheckout["mode"]; label: string }>()
  const [estimate, setEstimate] = createSignal<{ value: ReviewEstimate; answer: (go: boolean) => void }>()
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [posted, setPosted] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [severityFilter, setSeverityFilter] = createSignal<"all" | ReviewFindingView["severity"]>("all")
  const [ciRuns, setCiRuns] = createSignal<CiRun[]>([])
  const [ciNote, setCiNote] = createSignal<string>()
  const [ciOpenRun, setCiOpenRun] = createSignal<number>()
  const [ciDetail, setCiDetail] = createSignal<{ steps: CiFailedStep[]; prompt: string }>()
  // A failure log loads inside its own row, so it never takes over the panel's busy state that guards posting and
  // merging.
  const [ciLoading, setCiLoading] = createSignal<number>()
  const [ciPromptCopied, setCiPromptCopied] = createSignal(false)
  const [createOpen, setCreateOpen] = createSignal(false)
  const [createTitle, setCreateTitle] = createSignal("")
  const [createBody, setCreateBody] = createSignal("")
  const [createBase, setCreateBase] = createSignal("")
  const [createDraft, setCreateDraft] = createSignal(false)
  const [createdUrl, setCreatedUrl] = createSignal<string>()
  const [mergeStrategy, setMergeStrategy] = createSignal<"merge" | "squash" | "rebase">("squash")
  const [confirmingMerge, setConfirmingMerge] = createSignal(false)
  let observedProjectPath = props.projectPath
  let projectRevision = 0
  let refreshRequest = 0
  const selectionRequests = createPullRequestRequestScope(() => ({
    path: props.projectPath,
    revision: projectRevision,
  }))
  const ciRequests = createPullRequestRequestScope(() => ({ path: props.projectPath, revision: projectRevision }))

  const groups = () => {
    const outcome = review()
    return outcome ? findingGroups(outcome) : []
  }
  const counts = () => countBySeverity(groups())
  const events = () => {
    const outcome = review()
    return outcome ? reviewEvents(outcome.selection) : undefined
  }
  const visibleFindings = () =>
    groups().flatMap((group) =>
      severityFilter() === "all" || group.severity === severityFilter() ? group.findings : [],
    )
  const shown = () => {
    const words = query().trim().toLowerCase()
    if (!words) return list()
    return list().filter((pr) =>
      [`#${pr.number}`, pr.title, pr.author, pr.headRefName].some((field) => field.toLowerCase().includes(words)),
    )
  }
  const repoName = () => {
    const repo = list()[0] ? repoOf(list()[0]!.url) : undefined
    return repo ? `${repo.owner}/${repo.repo}` : props.projectPath?.split(/[\\/]/).filter(Boolean).pop()
  }
  const reviewing = () => {
    const run = reviewRun()
    return Boolean(run) && run!.number === selected()?.number
  }

  // A review of another project's pull request is stopped, not left running for a panel that moved on.
  const discardReview = () => {
    estimate()?.answer(false)
    reviewRun()?.controller.abort()
    setReviewRun(undefined)
    setCheckout(undefined)
  }

  onCleanup(() => {
    projectRevision++
    selectionRequests.invalidate()
    ciRequests.invalidate()
    discardReview()
  })

  const clearProjectState = () => {
    discardReview()
    setList([])
    setSelected(undefined)
    setReview(undefined)
    setPosted(false)
    setCiRuns([])
    setCiNote(undefined)
    setCiOpenRun(undefined)
    setCiDetail(undefined)
    setCiLoading(undefined)
    setCreateOpen(false)
    setCreateTitle("")
    setCreateBody("")
    setCreateBase("")
    setCreateDraft(false)
    setCreatedUrl(undefined)
    setConfirmingMerge(false)
  }

  const refresh = async (projectPath = props.projectPath) => {
    const request = ++refreshRequest
    const current = () => request === refreshRequest && props.open && props.projectPath === projectPath
    const bridge = api()
    if (!bridge) {
      if (current()) {
        setError("Pull requests are available in the Vector desktop app.")
        setBusy(undefined)
      }
      return
    }
    setBusy("Checking your GitHub sign-in…")
    setError(undefined)
    const access = await bridge.status().catch((cause: unknown) => {
      if (current()) setError(pullRequestErrorMessage(cause))
      return undefined
    })
    if (!current()) return
    setStatus(access)
    if (!access?.authenticated || !projectPath) {
      setBusy(undefined)
      return
    }
    setBusy("Loading pull requests…")
    const prs = await bridge.list(projectPath, { state: "open", limit: 100 }).catch((cause: unknown) => {
      if (current()) setError(pullRequestErrorMessage(cause))
      return [] as PullRequest[]
    })
    if (!current()) return
    setList(prs)
    setBusy(undefined)
    // CI shares the same GitHub sign-in the panel just confirmed, so load it after
    // the PR list rather than gating the whole panel on it — a repo with no
    // workflows should still show its pull requests.
    const ci = ciApi()
    if (!ci) return
    const runs = await ci.runs(projectPath, { limit: 10 }).catch(() => undefined)
    if (!current() || !runs) return
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
    const projectPath = props.projectPath
    if (!ci || !projectPath) return
    const current = ciRequests.start()
    setCiDetail(undefined)
    setCiLoading(undefined)
    if (ciOpenRun() === runId) {
      setCiOpenRun(undefined)
      return
    }
    setCiOpenRun(runId)
    setCiLoading(runId)
    const result = await ci.repair(projectPath, runId).catch(() => undefined)
    if (!current() || !props.open) return
    setCiLoading(undefined)
    if (!result?.ok) {
      setCiNote(result ? result.detail : "Vector could not read that run's log.")
      return
    }
    setCiDetail({ steps: result.failure.steps, prompt: result.prompt })
  }

  // Refresh on open or repository change rather than polling. A revision and
  // request counter prevent a slow response from repo A from populating repo B.
  createEffect(() => {
    const open = props.open
    const projectPath = props.projectPath
    if (observedProjectPath !== projectPath) {
      observedProjectPath = projectPath
      projectRevision++
      refreshRequest++
      clearProjectState()
    }
    if (!open) {
      projectRevision++
      refreshRequest++
      selectionRequests.invalidate()
      ciRequests.invalidate()
      discardReview()
      setCiLoading(undefined)
      setBusy(undefined)
      return
    }
    void refresh(projectPath)
  })

  const openPr = async (number: number) => {
    const bridge = api()
    const projectPath = props.projectPath
    if (!bridge || !projectPath || reviewRun()) return
    const active = selectionRequests.start()
    const current = () => active() && props.open
    setBusy(`Loading #${number}…`)
    setError(undefined)
    setSelected(undefined)
    setReview(undefined)
    setCheckout(undefined)
    setSeverityFilter("all")
    setPosted(false)
    setConfirmingMerge(false)
    const detail = await bridge.view(projectPath, number).catch((cause: unknown) => {
      if (current()) setError(pullRequestErrorMessage(cause))
      return undefined
    })
    if (!current()) return
    setSelected(detail)
    setBusy(undefined)
  }

  const runReview = async () => {
    const bridge = api()
    const opened = selected()
    const projectPath = props.projectPath
    const request = { path: projectPath, revision: projectRevision }
    if (!bridge || !opened || !projectPath || reviewRun()) return
    const controller = new AbortController()
    // Opening another pull request waits for the review, so the run still being this one means the selection is too.
    const current = () =>
      props.open &&
      pullRequestProjectIsCurrent(request, { path: props.projectPath, revision: projectRevision }) &&
      reviewRun()?.controller === controller
    setReviewRun({ controller, number: opened.number })
    setSeverityFilter("all")
    setBusy("Checking for new commits…")
    setError(undefined)
    setReview(undefined)
    setCheckout(undefined)
    setPosted(false)
    setConfirmingMerge(false)
    // Commits pushed since the pull request was opened are reviewed too, and the review is pinned to the newest one.
    const pr = await bridge.view(projectPath, opened.number).catch((cause: unknown) => {
      if (current()) setError(pullRequestErrorMessage(cause))
      return undefined
    })
    if (pr && current()) {
      setSelected(pr)
      setBusy("Reading the diff…")
    }
    const diff =
      pr && current()
        ? await bridge.diff(projectPath, pr.number, pr.headRefOid).catch((cause: unknown) => {
            if (current()) setError(pullRequestErrorMessage(cause))
            return ""
          })
        : ""
    const outcome =
      pr && diff && !controller.signal.aborted
        ? await props
            .onReview({
              pr: {
                number: pr.number,
                title: pr.title,
                body: pr.body,
                author: pr.author,
                url: pr.url,
                baseRefName: pr.baseRefName,
                headRefName: pr.headRefName,
                headRefOid: pr.headRefOid,
                baseRefOid: pr.baseRefOid,
                isCrossRepository: pr.isCrossRepository,
                comments: pr.comments,
              },
              diff,
              signal: controller.signal,
              confirm: (value) =>
                new Promise<boolean>((resolve) => {
                  if (controller.signal.aborted) return resolve(false)
                  setBusy("Waiting for you to start the review…")
                  setEstimate({
                    value,
                    answer: (go) => {
                      setEstimate(undefined)
                      resolve(go)
                    },
                  })
                }),
              onProgress: (progress) => {
                if (!current() || controller.signal.aborted) return
                if (progress.type === "status") setBusy(progress.text)
                else setCheckout({ mode: progress.checkout.mode, label: progress.label })
              },
            })
            .catch((cause: unknown) => {
              if (current()) setError(pullRequestErrorMessage(cause))
              return undefined
            })
        : undefined
    const active = current()
    if (reviewRun()?.controller === controller) setReviewRun(undefined)
    if (!active) return
    setReview(outcome)
    setBusy(undefined)
  }

  // Stop ends the review early; what the reviewers confirmed so far still comes back.
  const stopReview = () => {
    const run = reviewRun()
    if (!run || run.controller.signal.aborted) return
    run.controller.abort()
    const pending = estimate()
    if (pending) {
      pending.answer(false)
      return
    }
    setBusy("Finishing the review…")
  }

  // Posting is the one step visible to other people, so it only ever happens from these buttons.
  const postReview = async (event: ReviewEvent) => {
    const bridge = api()
    const pr = selected()
    const outcome = review()
    const projectPath = props.projectPath
    const request = { path: projectPath, revision: projectRevision }
    if (!bridge || !pr || !outcome || !projectPath || busy() || !reviewEvents(outcome.selection)[event]) return
    const current = () =>
      props.open &&
      pullRequestProjectIsCurrent(request, { path: props.projectPath, revision: projectRevision }) &&
      selected() === pr &&
      review() === outcome
    setBusy("Posting review…")
    setError(undefined)
    const result = await bridge
      .review({
        cwd: projectPath,
        number: pr.number,
        head: outcome.head,
        body: buildDesktopSummary(outcome, pr.url),
        event,
      })
      .catch((cause: unknown) => {
        if (current()) setError(pullRequestErrorMessage(cause))
        return undefined
      })
    if (!current()) return
    setPosted(Boolean(result?.posted))
    setBusy(undefined)
  }

  const createPr = async (event: SubmitEvent) => {
    event.preventDefault()
    const bridge = api()
    const projectPath = props.projectPath
    const request = { path: projectPath, revision: projectRevision }
    const title = createTitle().trim()
    if (!bridge || !projectPath || !title || busy()) return
    setBusy("Creating pull request…")
    setError(undefined)
    const result = await bridge
      .create(
        buildPullRequestCreateInput({
          cwd: projectPath,
          title,
          body: createBody(),
          base: createBase(),
          draft: createDraft(),
        }),
      )
      .catch((cause: unknown) => {
        if (pullRequestProjectIsCurrent(request, { path: props.projectPath, revision: projectRevision })) {
          setError(pullRequestErrorMessage(cause))
        }
        return undefined
      })
    if (!pullRequestProjectIsCurrent(request, { path: props.projectPath, revision: projectRevision })) return
    if (!result) {
      setBusy(undefined)
      return
    }
    setCreatedUrl(result.url || undefined)
    setCreateOpen(false)
    setCreateTitle("")
    setCreateBody("")
    setCreateBase("")
    setCreateDraft(false)
    await refresh(projectPath)
  }

  const mergePr = async () => {
    const bridge = api()
    const pr = selected()
    const projectPath = props.projectPath
    const request = { path: projectPath, revision: projectRevision }
    if (!bridge || !projectPath || !pr || busy() || reviewRun()) return
    const current = () =>
      props.open &&
      pullRequestProjectIsCurrent(request, { path: props.projectPath, revision: projectRevision }) &&
      selected() === pr
    setBusy(`Merging #${pr.number}…`)
    setError(undefined)
    const result = await bridge
      .merge(
        buildPullRequestMergeInput({
          cwd: projectPath,
          number: pr.number,
          strategy: mergeStrategy(),
          head: pr.headRefOid,
        }),
      )
      .catch((cause: unknown) => {
        if (current()) setError(pullRequestErrorMessage(cause))
        return undefined
      })
    if (!current()) return
    setConfirmingMerge(false)
    if (!result?.merged) {
      setBusy(undefined)
      return
    }
    setSelected(undefined)
    setReview(undefined)
    setCheckout(undefined)
    await refresh(projectPath)
  }

  return (
    <Show when={props.open}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pull Requests"
        class="fixed inset-0 z-[90] flex flex-col bg-[color:var(--vx-canvas)] text-[color:var(--vx-text)]"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return
          // Escape in a field clears or leaves the field; it must not throw away a half-written pull request.
          if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return
          if (confirmingMerge()) {
            setConfirmingMerge(false)
            return
          }
          props.onClose()
        }}
      >
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] px-5">
          <span class="grid size-8 shrink-0 place-items-center rounded-[8px] bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]">
            <Icon name="pull" class="size-4" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-[14px] font-semibold">Pull Requests</div>
            <div class="truncate text-[11.5px] text-[color:var(--vx-text-muted)]">
              {status()?.authenticated
                ? `${repoName() ?? "This repository"} · ${list().length} open`
                : "Create, review with Vectorscope, and merge without leaving Vector"}
            </div>
          </div>
          <Show when={busy() && !reviewing()}>
            <span class="flex min-w-0 shrink items-center gap-2 text-[11.5px] text-[color:var(--vx-text-subtle)]">
              <Spinner />
              <span class="truncate">{busy()}</span>
            </span>
          </Show>
          <Show when={status()?.authenticated}>
            <button
              type="button"
              class={PRIMARY}
              disabled={!props.projectPath || Boolean(busy())}
              aria-expanded={createOpen()}
              aria-controls="pull-request-create-form"
              onClick={() => setCreateOpen((value) => !value)}
            >
              <Icon name="plus" />
              New pull request
            </button>
            <span class="flex shrink-0 items-center gap-2 rounded-full border border-[color:var(--vx-line)] py-0.5 pl-0.5 pr-1">
              <span class="grid size-6 place-items-center rounded-full bg-[color:var(--vx-surface-raised)] text-[11px] font-semibold text-[color:var(--vx-purple-bright)]">
                {initial(status()?.login ?? "GitHub")}
              </span>
              <span class="max-w-[140px] truncate text-[12px] text-[color:var(--vx-text-subtle)]">
                {status()?.login ? `@${status()!.login}` : "GitHub"}
              </span>
              <Show when={status()?.source === "vector"}>
                <button
                  type="button"
                  aria-label="Sign out of GitHub"
                  title="Sign out of GitHub"
                  class="grid size-6 place-items-center rounded-full text-[color:var(--vx-text-muted)] transition hover:bg-[color:var(--vx-control)] hover:text-[color:var(--vx-text)] disabled:opacity-45"
                  disabled={Boolean(busy())}
                  onClick={() =>
                    void githubApi()
                      ?.auth?.logout()
                      .catch(() => undefined)
                      .then(() => refresh(props.projectPath))
                  }
                >
                  <Icon name="logout" />
                </button>
              </Show>
            </span>
          </Show>
          <button
            type="button"
            aria-label="Close Pull Requests"
            class="grid size-8 shrink-0 place-items-center rounded-[6px] text-[color:var(--vx-text-muted)] transition hover:bg-[color:var(--vx-control)] hover:text-[color:var(--vx-text)]"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <Show when={error()}>
          <div
            role="alert"
            class="flex shrink-0 items-start gap-3 border-b border-[color:color-mix(in_srgb,var(--vx-red)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vx-red)_9%,transparent)] px-5 py-2.5 text-[12.5px] text-[color:var(--vx-red)]"
          >
            <span class="min-w-0 flex-1 leading-relaxed">{error()}</span>
            <button
              type="button"
              aria-label="Dismiss"
              class="grid size-5 shrink-0 place-items-center rounded-[4px] hover:bg-[color:color-mix(in_srgb,var(--vx-red)_14%,transparent)]"
              onClick={() => setError(undefined)}
            >
              <Icon name="close" class="size-3" />
            </button>
          </div>
        </Show>

        <Show when={status() && !status()!.authenticated}>
          <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-5 py-8">
            <div class="w-full max-w-[520px]">
              <div class="mb-5 flex flex-col items-center gap-3 text-center">
                <span class="grid size-12 place-items-center rounded-[12px] bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]">
                  <Icon name="scope" class="size-6" />
                </span>
                <div>
                  <h2 class="text-[17px] font-semibold">Review pull requests with Vectorscope</h2>
                  <p class="mt-1.5 text-[12.5px] leading-relaxed text-[color:var(--vx-text-subtle)]">
                    Specialist reviewers read each change and the code around it, every finding is double-checked, and
                    nothing is posted until you choose to.
                  </p>
                </div>
              </div>
              <div class="rounded-[10px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
                <Show
                  when={status()!.configured && githubApi()?.auth}
                  fallback={
                    <p class="p-5 text-[12.5px] leading-relaxed text-[color:var(--vx-text-subtle)]">
                      This build of Vector can't sign in to GitHub. Install the latest Vector to work with pull
                      requests.
                    </p>
                  }
                >
                  <GithubDeviceSignIn
                    intro="Vector works with pull requests through your own GitHub account. Sign in once, and Vector encrypts the token with your system's keychain."
                    closeLabel="Not now"
                    onConnected={() => void refresh(props.projectPath)}
                    onClose={props.onClose}
                  />
                </Show>
              </div>
            </div>
          </div>
        </Show>

        <Show when={status()?.authenticated}>
          <div class="flex min-h-0 flex-1">
            <aside class="flex w-[300px] shrink-0 flex-col border-r border-[color:var(--vx-line)] bg-[color:var(--vx-stage)] lg:w-[340px]">
              <div class="border-b border-[color:var(--vx-line)] p-3">
                <label class="flex items-center gap-2 rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] px-2.5 py-1.5 text-[color:var(--vx-text-muted)] focus-within:border-[color:var(--vx-purple)]">
                  <Icon name="search" />
                  <input
                    type="search"
                    aria-label="Filter pull requests"
                    placeholder="Filter by title, number, author or branch"
                    class="min-w-0 flex-1 bg-transparent text-[12.5px] text-[color:var(--vx-text)] outline-none placeholder:text-[color:var(--vx-text-muted)]"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div class="min-h-0 flex-1 overflow-y-auto p-2">
                <Show
                  when={shown().length}
                  fallback={
                    <div class="px-4 py-10 text-center text-[12.5px] text-[color:var(--vx-text-muted)]">
                      {query().trim()
                        ? "No pull requests match."
                        : busy() === "Loading pull requests…"
                          ? "Loading pull requests…"
                          : "No open pull requests."}
                    </div>
                  }
                >
                  <For each={shown()}>
                    {(pr) => (
                      <button
                        type="button"
                        disabled={Boolean(reviewRun())}
                        aria-current={selected()?.number === pr.number ? "true" : undefined}
                        class="group relative mb-0.5 flex w-full gap-2.5 rounded-[7px] px-2.5 py-2.5 text-left transition disabled:cursor-default"
                        classList={{
                          "bg-[color:var(--vx-surface-raised)]": selected()?.number === pr.number,
                          "hover:bg-[color:var(--vx-surface)]": selected()?.number !== pr.number,
                        }}
                        onClick={() => void openPr(pr.number)}
                      >
                        <Show when={selected()?.number === pr.number}>
                          <span class="absolute inset-y-2 left-0 w-[2px] rounded-full bg-[color:var(--vx-purple)]" />
                        </Show>
                        <span
                          class="mt-px shrink-0"
                          classList={{
                            "text-[color:var(--vx-text-muted)]": pr.isDraft,
                            "text-[color:var(--vx-green)]": !pr.isDraft,
                          }}
                        >
                          <Icon name={pr.isDraft ? "draft" : "pull"} />
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="line-clamp-2 text-[12.5px] font-medium leading-snug text-[color:var(--vx-text)]">
                            {pr.title}
                          </span>
                          <span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--vx-text-muted)]">
                            <span class="font-mono">#{pr.number}</span>
                            <span>{pr.author}</span>
                            <span>{since(pr.updatedAt)}</span>
                            <Show when={pr.isDraft}>
                              <span class="rounded-full bg-[color:var(--vx-control)] px-1.5 text-[10px]">Draft</span>
                            </Show>
                          </span>
                          <span class="mt-1 flex items-center gap-2 text-[11px]">
                            <span class="text-[color:var(--vx-green)]">+{pr.additions}</span>
                            <span class="text-[color:var(--vx-red)]">−{pr.deletions}</span>
                            <Show when={DECISION[pr.reviewDecision ?? ""]}>
                              {(decision) => (
                                <span class="ml-auto inline-flex items-center gap-1 text-[color:var(--vx-text-subtle)]">
                                  <span class="size-1.5 rounded-full" style={{ background: decision().tone }} />
                                  {decision().text}
                                </span>
                              )}
                            </Show>
                          </span>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>

              <section class="max-h-[42%] shrink-0 overflow-y-auto border-t border-[color:var(--vx-line)] p-3">
                <div class="mb-2 flex items-baseline justify-between gap-2">
                  <span class={SECTION_TITLE}>Checks</span>
                  <Show when={ciRuns()[0]}>
                    <span class="truncate font-mono text-[10.5px] text-[color:var(--vx-text-muted)]">
                      {ciRuns()[0]!.branch}
                    </span>
                  </Show>
                </div>
                <Show when={ciNote()}>
                  <p class="mb-2 text-[11.5px] leading-relaxed text-[color:var(--vx-text-muted)]">{ciNote()}</p>
                </Show>
                <Show when={!ciNote() && ciRuns().length === 0}>
                  <p class="text-[11.5px] text-[color:var(--vx-text-muted)]">No workflow runs for this branch.</p>
                </Show>
                <For each={ciRuns()}>
                  {(run) => (
                    <div class="mb-1 overflow-hidden rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)]">
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-[color:var(--vx-surface)]"
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
                          style={{
                            background:
                              run.status !== "completed"
                                ? "var(--vx-amber)"
                                : run.conclusion === "success"
                                  ? "var(--vx-green)"
                                  : run.conclusion === "failure"
                                    ? "var(--vx-red)"
                                    : "var(--vx-text-muted)",
                          }}
                        />
                        <span class="min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--vx-text-subtle)]">
                          {run.workflow} · {run.title}
                        </span>
                        <span class="shrink-0 text-[10.5px] text-[color:var(--vx-text-muted)]">
                          {run.conclusion === "failure"
                            ? ciLoading() === run.id
                              ? "Reading the log…"
                              : ciOpenRun() === run.id
                                ? "Hide"
                                : "Inspect"
                            : run.conclusion || run.status}
                        </span>
                      </button>
                      <Show when={ciOpenRun() === run.id && ciDetail()}>
                        <div class="border-t border-[color:var(--vx-line)] px-2.5 py-2">
                          <For each={ciDetail()!.steps.slice(0, 2)}>
                            {(step) => (
                              <div class="mb-2">
                                <div class="text-[10.5px] text-[color:var(--vx-red)]">
                                  {step.job} › {step.step} · {step.kind}
                                </div>
                                <pre class="mt-1 max-h-28 overflow-auto rounded-[4px] bg-[color:var(--vx-surface)] p-2 font-mono text-[10px] leading-snug text-[color:var(--vx-text-subtle)]">
                                  {step.excerpt}
                                </pre>
                              </div>
                            )}
                          </For>
                          <button
                            type="button"
                            class="rounded-[6px] bg-[color:var(--vx-purple)] px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:brightness-110"
                            onClick={() => {
                              void navigator.clipboard?.writeText(ciDetail()!.prompt)
                              setCiPromptCopied(true)
                              setTimeout(() => setCiPromptCopied(false), 1_500)
                            }}
                          >
                            {ciPromptCopied() ? "Copied, paste it to the agent" : "Copy fix prompt for the agent"}
                          </button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </section>
            </aside>

            <main class="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <Show when={createOpen()}>
                <form
                  id="pull-request-create-form"
                  class="mx-auto mt-6 grid max-w-[760px] gap-3 rounded-[10px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-5"
                  onSubmit={createPr}
                >
                  <div class="flex items-center justify-between gap-3">
                    <h2 class="text-[15px] font-semibold">New pull request</h2>
                    <button type="button" class={GHOST} onClick={() => setCreateOpen(false)}>
                      Cancel
                    </button>
                  </div>
                  <p class="-mt-1 text-[12px] text-[color:var(--vx-text-muted)]">
                    Opens a pull request from this checkout's branch. Push the branch to GitHub first.
                  </p>
                  <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                    <label class="grid gap-1 text-[11.5px] text-[color:var(--vx-text-subtle)]">
                      Title
                      <input
                        required
                        maxlength={256}
                        class={`${FIELD} text-[12.5px]`}
                        value={createTitle()}
                        onInput={(event) => setCreateTitle(event.currentTarget.value)}
                      />
                    </label>
                    <label class="grid gap-1 text-[11.5px] text-[color:var(--vx-text-subtle)]">
                      Base branch (optional)
                      <input
                        maxlength={255}
                        placeholder="Repository default"
                        class={`${FIELD} font-mono text-[12px]`}
                        value={createBase()}
                        onInput={(event) => setCreateBase(event.currentTarget.value)}
                      />
                    </label>
                  </div>
                  <label class="grid gap-1 text-[11.5px] text-[color:var(--vx-text-subtle)]">
                    Description
                    <textarea
                      maxlength={1_000_000}
                      rows={6}
                      class={`${FIELD} resize-y text-[12.5px] leading-relaxed`}
                      value={createBody()}
                      onInput={(event) => setCreateBody(event.currentTarget.value)}
                    />
                  </label>
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <label class="flex items-center gap-2 text-[12px] text-[color:var(--vx-text-subtle)]">
                      <input
                        type="checkbox"
                        class="accent-[color:var(--vx-purple)]"
                        checked={createDraft()}
                        onChange={(event) => setCreateDraft(event.currentTarget.checked)}
                      />
                      Create as draft
                    </label>
                    <button type="submit" disabled={!createTitle().trim() || Boolean(busy())} class={PRIMARY}>
                      Create on GitHub
                    </button>
                  </div>
                </form>
              </Show>

              <Show when={createdUrl()}>
                <div class="mx-auto mt-6 flex max-w-[760px] items-center gap-2 rounded-[8px] border border-[color:color-mix(in_srgb,var(--vx-green)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--vx-green)_8%,transparent)] px-4 py-2.5 text-[12.5px] text-[color:var(--vx-green)]">
                  <Icon name="check" />
                  <span class="flex-1">Pull request created.</span>
                  <a class="underline underline-offset-2" href={createdUrl()} target="_blank" rel="noreferrer">
                    Open on GitHub ↗
                  </a>
                </div>
              </Show>

              <Show
                when={!createOpen() && selected()}
                fallback={
                  <Show when={!createOpen()}>
                    <div class="grid h-full place-items-center px-6 text-center">
                      <div class="flex max-w-[340px] flex-col items-center gap-3">
                        <span class="grid size-11 place-items-center rounded-[12px] bg-[color:var(--vx-surface)] text-[color:var(--vx-text-muted)]">
                          <Icon name="pull" class="size-5" />
                        </span>
                        <p class="text-[13px] font-medium">Select a pull request</p>
                        <p class="text-[12px] leading-relaxed text-[color:var(--vx-text-muted)]">
                          Read what changed, review it with Vectorscope, and post or merge when you're ready.
                        </p>
                      </div>
                    </div>
                  </Show>
                }
              >
                {(pr) => (
                  <div class="mx-auto max-w-[960px] px-6 pb-10 pt-5">
                    <div class="flex items-start gap-4">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 text-[11.5px]">
                          <span
                            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
                            classList={{
                              "bg-[color:var(--vx-control)] text-[color:var(--vx-text-subtle)]": pr().isDraft,
                              "bg-[color:color-mix(in_srgb,var(--vx-green)_14%,transparent)] text-[color:var(--vx-green)]":
                                !pr().isDraft,
                            }}
                          >
                            <Icon name={pr().isDraft ? "draft" : "pull"} class="size-3" />
                            {pr().isDraft ? "Draft" : "Open"}
                          </span>
                          <span class="font-mono text-[color:var(--vx-text-muted)]">#{pr().number}</span>
                        </div>
                        <h2 class="mt-2 text-[19px] font-semibold leading-snug">{pr().title}</h2>
                        <p class="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[color:var(--vx-text-subtle)]">
                          <span class="font-medium text-[color:var(--vx-text)]">{pr().author}</span>
                          <span>wants to merge into</span>
                          <BranchName name={pr().baseRefName} />
                          <span>from</span>
                          <BranchName name={pr().headRefName} />
                          <span class="text-[color:var(--vx-text-muted)]">·</span>
                          <span class="text-[color:var(--vx-green)]">+{pr().additions}</span>
                          <span class="text-[color:var(--vx-red)]">−{pr().deletions}</span>
                          <span class="text-[color:var(--vx-text-muted)]">·</span>
                          <span>
                            {pr().changedFiles} {pr().changedFiles === 1 ? "file" : "files"}
                          </span>
                          <span class="text-[color:var(--vx-text-muted)]">· updated {since(pr().updatedAt)}</span>
                        </p>
                      </div>
                      <a
                        href={pr().url}
                        target="_blank"
                        rel="noreferrer"
                        class={SECONDARY}
                        aria-label={`Open #${pr().number} on GitHub`}
                      >
                        GitHub
                        <Icon name="external" />
                      </a>
                    </div>

                    <section
                      aria-label="Vectorscope"
                      class="mt-5 overflow-hidden rounded-[10px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]"
                    >
                      <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color:var(--vx-line)] px-4 py-3">
                        <span class="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[image:var(--vx-gradient)] text-white">
                          <Icon name="scope" />
                        </span>
                        <div class="min-w-0 flex-1">
                          <div class="text-[13px] font-semibold">Vectorscope</div>
                          <div class="truncate text-[11.5px] text-[color:var(--vx-text-muted)]">
                            {reviewing()
                              ? "Reviewing…"
                              : review()
                                ? `Reviewed ${review()!.head.slice(0, 7)} · ${reviewFooter(review()!)}`
                                : "Not reviewed yet"}
                          </div>
                        </div>
                        <Show
                          when={reviewing()}
                          fallback={
                            <button
                              type="button"
                              disabled={Boolean(busy())}
                              class={review() ? SECONDARY : PRIMARY}
                              onClick={() => void runReview()}
                            >
                              <Icon name={review() ? "refresh" : "scope"} />
                              {review() ? "Review again" : "Review with Vector"}
                            </button>
                          }
                        >
                          <button type="button" class={DANGER} onClick={stopReview}>
                            <Icon name="stop" />
                            Stop review
                          </button>
                        </Show>
                      </header>

                      <Show when={estimate()}>
                        {(pending) => (
                          <div class="flex flex-wrap items-center gap-3 border-b border-[color:var(--vx-line)] bg-[color:var(--vx-purple-soft)] px-4 py-3">
                            <p class="min-w-[240px] flex-1 text-[12.5px] leading-relaxed">
                              {estimateText(pending().value)}
                            </p>
                            <button type="button" class={PRIMARY} onClick={() => pending().answer(true)}>
                              Start review
                            </button>
                            <button type="button" class={GHOST} onClick={() => pending().answer(false)}>
                              Cancel
                            </button>
                          </div>
                        )}
                      </Show>

                      <Show when={reviewing() && !estimate()}>
                        <div class="px-4 py-4">
                          <div class="flex items-center gap-2 text-[12.5px] text-[color:var(--vx-text-subtle)]">
                            <Spinner />
                            {busy() ?? "Reviewing…"}
                          </div>
                          <div class="mt-3 h-1 overflow-hidden rounded-full bg-[color:var(--vx-control)]">
                            <div class="h-full w-1/3 rounded-full bg-[image:var(--vx-gradient)] motion-safe:animate-[vx-indeterminate_1.6s_var(--vx-ease)_infinite]" />
                          </div>
                        </div>
                      </Show>

                      <Show when={checkout()}>
                        {(info) => (
                          <p class="border-b border-[color:var(--vx-line)] px-4 py-2.5 text-[11.5px] leading-relaxed text-[color:var(--vx-text-muted)]">
                            <CodeText text={info().label} />
                            <Show when={info().mode === "rebuilt"}>
                              <span> {REBUILT_HINT}</span>
                            </Show>
                          </p>
                        )}
                      </Show>

                      <Show when={!reviewing() && !review()}>
                        <p class="px-4 py-4 text-[12.5px] leading-relaxed text-[color:var(--vx-text-subtle)]">
                          Specialist reviewers read the diff and the code around it, a verifier checks every finding,
                          and nothing is posted to GitHub until you choose to.
                        </p>
                      </Show>

                      <Show when={!reviewing() && review()}>
                        {(outcome) => (
                          <>
                            <div class="grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_220px]">
                              <div class="min-w-0">
                                <Show
                                  when={outcome().report.summary}
                                  fallback={
                                    <p class="text-[12.5px] text-[color:var(--vx-text-muted)]">
                                      The reviewers returned no summary.
                                    </p>
                                  }
                                >
                                  <p class="text-[13px] leading-relaxed">
                                    <CodeText text={outcome().report.summary} />
                                  </p>
                                </Show>
                                <For each={[...outcome().banners, ...outcome().notes]}>
                                  {(note) => (
                                    <p class="mt-2.5 rounded-[6px] border border-[color:color-mix(in_srgb,var(--vx-amber)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vx-amber)_8%,transparent)] px-3 py-2 text-[12px] leading-relaxed text-[color:var(--vx-amber)]">
                                      <CodeText text={note.replaceAll("**", "")} />
                                    </p>
                                  )}
                                </For>
                              </div>
                              <RiskMeter risk={outcome().selection.risk} counts={counts()} />
                            </div>

                            <Show
                              when={groups().length}
                              fallback={
                                <Show when={outcome().notes.length === 0}>
                                  <div class="mx-4 mb-4 flex items-center gap-2 rounded-[8px] border border-[color:color-mix(in_srgb,var(--vx-green)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vx-green)_8%,transparent)] px-3 py-2.5 text-[12.5px] text-[color:var(--vx-green)]">
                                    <Icon name="check" />
                                    No issues found on the changed lines.
                                  </div>
                                </Show>
                              }
                            >
                              <div class="flex flex-wrap items-center gap-1 border-t border-[color:var(--vx-line)] px-4 py-2.5">
                                <span class={`${SECTION_TITLE} mr-2`}>Findings</span>
                                <div
                                  role="group"
                                  aria-label="Filter findings by severity"
                                  class="flex flex-wrap gap-1 rounded-[7px] bg-[color:var(--vx-canvas)] p-0.5"
                                >
                                  <For each={["all", "blocking", "concern", "nit"] as const}>
                                    {(value) => (
                                      <button
                                        type="button"
                                        aria-pressed={severityFilter() === value}
                                        disabled={value !== "all" && counts()[value] === 0}
                                        class="inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[11.5px] transition disabled:cursor-default disabled:opacity-40"
                                        classList={{
                                          "bg-[color:var(--vx-surface-raised)] text-[color:var(--vx-text)]":
                                            severityFilter() === value,
                                          "text-[color:var(--vx-text-muted)] hover:enabled:text-[color:var(--vx-text)]":
                                            severityFilter() !== value,
                                        }}
                                        onClick={() => setSeverityFilter(value)}
                                      >
                                        <Show when={value !== "all"}>
                                          <span
                                            class="size-1.5 rounded-full"
                                            style={{ background: value === "all" ? undefined : SEVERITY[value].tone }}
                                          />
                                        </Show>
                                        {value === "all" ? "All" : SEVERITY[value].label}
                                        <span class="text-[color:var(--vx-text-muted)]">
                                          {value === "all"
                                            ? counts().blocking + counts().concern + counts().nit
                                            : counts()[value]}
                                        </span>
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </div>
                              <div class="flex flex-col gap-2 px-4 pb-4">
                                <For each={visibleFindings()}>{(finding) => <FindingCard finding={finding} />}</For>
                              </div>
                            </Show>

                            <Show when={outcome().skipped.length}>
                              <p class="px-4 pb-3 text-[11.5px] leading-relaxed text-[color:var(--vx-text-muted)]">
                                Not reviewed: {skippedText(outcome().skipped)}
                              </p>
                            </Show>

                            <footer class="flex flex-wrap items-center gap-2 border-t border-[color:var(--vx-line)] bg-[color:var(--vx-stage)] px-4 py-3">
                              <Show
                                when={!posted()}
                                fallback={
                                  <>
                                    <span class="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--vx-green)]">
                                      <Icon name="check" />
                                      Review posted
                                    </span>
                                    <a
                                      class="ml-auto text-[12px] text-[color:var(--vx-purple-bright)] underline underline-offset-2"
                                      href={pr().url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      See it on GitHub ↗
                                    </a>
                                  </>
                                }
                              >
                                <button
                                  type="button"
                                  disabled={Boolean(busy())}
                                  class={PRIMARY}
                                  onClick={() => void postReview("comment")}
                                >
                                  <Icon name="comment" />
                                  Comment
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(busy())}
                                  class={SECONDARY}
                                  onClick={() => void postReview("request-changes")}
                                >
                                  Request changes
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(busy()) || !events()?.approve}
                                  title={
                                    events()?.approve ? undefined : "Approve is off while a blocking finding stands."
                                  }
                                  class={SECONDARY}
                                  onClick={() => void postReview("approve")}
                                >
                                  <Icon name="check" />
                                  Approve
                                </button>
                                <span class="ml-auto text-[11.5px] text-[color:var(--vx-text-muted)]">
                                  {events()?.approve
                                    ? status()?.login
                                      ? `Posting as @${status()!.login}`
                                      : "Posting with your GitHub sign-in"
                                    : "Approve is off while a blocking finding stands."}
                                </span>
                              </Show>
                            </footer>
                          </>
                        )}
                      </Show>
                    </section>

                    <Show when={pr().body.trim()}>
                      <section class="mt-6">
                        <h3 class={SECTION_TITLE}>Description</h3>
                        <div class="mt-2 max-h-[320px] overflow-y-auto whitespace-pre-wrap rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-4 py-3 text-[12.5px] leading-relaxed text-[color:var(--vx-text-subtle)]">
                          {pr().body.trim()}
                        </div>
                      </section>
                    </Show>

                    <Show when={pr().files.length}>
                      <section class="mt-6">
                        <h3 class={SECTION_TITLE}>
                          Files changed <span class="ml-1 font-normal normal-case">{pr().files.length}</span>
                        </h3>
                        <div class="mt-2 overflow-hidden rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
                          <For each={pr().files.slice(0, FILES_SHOWN)}>
                            {(file) => (
                              <div class="flex items-center gap-3 border-b border-[color:var(--vx-line)] px-4 py-2 last:border-b-0">
                                <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                                  <span class="text-[color:var(--vx-text-muted)]">
                                    {file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : ""}
                                  </span>
                                  <span class="text-[color:var(--vx-text)]">{file.path.split("/").pop()}</span>
                                </span>
                                <span class="shrink-0 text-[11px] text-[color:var(--vx-green)]">+{file.additions}</span>
                                <span class="shrink-0 text-[11px] text-[color:var(--vx-red)]">−{file.deletions}</span>
                              </div>
                            )}
                          </For>
                          <Show when={pr().files.length > FILES_SHOWN}>
                            <a
                              class="block px-4 py-2 text-[11.5px] text-[color:var(--vx-purple-bright)] hover:underline"
                              href={`${pr().url}/files`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {pr().files.length - FILES_SHOWN} more on GitHub ↗
                            </a>
                          </Show>
                        </div>
                      </section>
                    </Show>

                    <Show when={pr().comments.length}>
                      <section class="mt-6">
                        <h3 class={SECTION_TITLE}>
                          Conversation <span class="ml-1 font-normal normal-case">{pr().comments.length}</span>
                        </h3>
                        <div class="mt-2 flex flex-col gap-2">
                          <For each={pr().comments.slice(-COMMENTS_SHOWN)}>
                            {(comment) => (
                              <div class="flex gap-3 rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-4 py-3">
                                <span class="grid size-6 shrink-0 place-items-center rounded-full bg-[color:var(--vx-surface-raised)] text-[11px] font-semibold text-[color:var(--vx-text-subtle)]">
                                  {initial(comment.author)}
                                </span>
                                <div class="min-w-0 flex-1">
                                  <div class="flex items-baseline gap-2 text-[11.5px]">
                                    <span class="font-medium">{comment.author}</span>
                                    <span class="text-[color:var(--vx-text-muted)]">{since(comment.createdAt)}</span>
                                  </div>
                                  <p class="mt-1 line-clamp-6 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--vx-text-subtle)]">
                                    {comment.body}
                                  </p>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </section>
                    </Show>

                    <section class="mt-6 flex flex-wrap items-center gap-3 rounded-[10px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-4 py-3.5">
                      <span class="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[color:var(--vx-control)] text-[color:var(--vx-text-subtle)]">
                        <Icon name="merge" />
                      </span>
                      <div class="min-w-[220px] flex-1">
                        <div class="text-[13px] font-semibold">Merge</div>
                        <p class="text-[11.5px] leading-relaxed text-[color:var(--vx-text-muted)]">
                          Merges only the commits shown here. If anything is pushed first, GitHub refuses the merge.
                        </p>
                      </div>
                      <div
                        role="radiogroup"
                        aria-label="Merge strategy"
                        class="flex rounded-[7px] bg-[color:var(--vx-canvas)] p-0.5"
                      >
                        <For each={MERGE_STRATEGIES}>
                          {(strategy) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={mergeStrategy() === strategy.value}
                              disabled={Boolean(busy())}
                              class="rounded-[5px] px-2.5 py-1 text-[11.5px] transition disabled:opacity-45"
                              classList={{
                                "bg-[color:var(--vx-surface-raised)] text-[color:var(--vx-text)]":
                                  mergeStrategy() === strategy.value,
                                "text-[color:var(--vx-text-muted)] hover:enabled:text-[color:var(--vx-text)]":
                                  mergeStrategy() !== strategy.value,
                              }}
                              onClick={() => {
                                setMergeStrategy(strategy.value)
                                setConfirmingMerge(false)
                              }}
                            >
                              {strategy.label}
                            </button>
                          )}
                        </For>
                      </div>
                      <Show when={confirmingMerge()}>
                        <button type="button" class={GHOST} onClick={() => setConfirmingMerge(false)}>
                          Cancel
                        </button>
                      </Show>
                      <button
                        type="button"
                        disabled={Boolean(busy()) || reviewing()}
                        class={confirmingMerge() ? `${BUTTON} bg-[color:var(--vx-red)] text-white` : DANGER}
                        onClick={() => {
                          if (pullRequestMergeAction(confirmingMerge()) === "confirm") {
                            setConfirmingMerge(true)
                            return
                          }
                          void mergePr()
                        }}
                      >
                        {confirmingMerge() ? `Confirm ${mergeStrategy()} merge` : "Merge…"}
                      </button>
                    </section>
                  </div>
                )}
              </Show>
            </main>
          </div>
        </Show>
      </div>
    </Show>
  )
}
