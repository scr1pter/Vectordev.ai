import { isFreeModel } from "@vectordevai/schema/free-model"
import { providerUsable } from "@vectordevai/schema/provider-policy"
import { measureUsage } from "../economics/token-usage"
// Vector code review in the desktop Pull Requests panel (section 6, D1). It runs the same core as the GitHub Action
// and `vector review`: the same prompts, output schema, filters and summary. The engine instance always stays on the
// user's own project, so another person's code never loads its config, plugins or language servers. Everything but
// the injected client is pure, so each step is testable without a model.

import {
  parseReviewConfig,
  parseReviewRules,
  REVIEW_CONFIG_PATH,
  REVIEW_RULES_PATHS,
  rulesForPaths,
} from "@vectordevai/core/review/config"
import {
  anchorText,
  applyPatch,
  budgetDiff,
  buildAnchorIndex,
  lookupFile,
  matchPostImage,
  parseUnifiedDiff,
  renderPatch,
  resolveAnchor,
  type AnchorIndex,
  type DiffFile,
} from "@vectordevai/core/review/diff"
import { fingerprint, normalizeCode, normalizeTitle } from "@vectordevai/core/review/fingerprint"
import {
  buildSummaryBody,
  costWording,
  formatDuration,
  formatUsd,
  noteNothingToReview,
  sanitizeModelMarkdown,
  type RepoRef,
} from "@vectordevai/core/review/format"
import { classifyFiles, classifyPath, isSensitivePath, parseGitAttributes } from "@vectordevai/core/review/ignore"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { redactSecrets } from "@vectordevai/core/review/redact"
import {
  contextRefusal,
  diffBudgetChars,
  estimateCostUsd,
  planSpecialists,
  type ReviewPrice,
  type Specialist,
} from "@vectordevai/core/review/plan"
import {
  buildFinalizePrompt,
  buildReviewPrompt,
  buildSecurityPrompt,
  type HeadFile,
  type PromptInput,
} from "@vectordevai/core/review/prompt"
import { decodeReport, REVIEW_REPORT_JSON_SCHEMA } from "@vectordevai/core/review/schema"
import { selectFindings } from "@vectordevai/core/review/select"
import {
  SEVERITIES,
  type CostKind,
  type Finding,
  type ModelFinding,
  type ModelReport,
  type ReviewCost,
  type Risk,
  type Selection,
  type Severity,
  type SkippedFile,
  type Trust,
} from "@vectordevai/core/review/types"

// No dollar cap here, because the user is watching: a Stop button and this cap end a review instead.
export const REVIEW_TIMEOUT_MS = 10 * 60_000
// Pull requests with more files than this show the cost estimate before a review starts.
export const ESTIMATE_FILES = 50
export const REBUILT_HINT = "For the most accurate review, switch to the base branch."

const FINALIZE_MS = 90_000
// After an abort the prompt call returns once the engine has stopped the step; never wait on it for long.
const ABORT_GRACE_MS = 15_000
// The same per-file cap CI uses for head files; larger files are reviewed from their hunks.
const HEAD_FILE_CHARS = 40_000
const READ_CONCURRENCY = 8
const MAX_UNKNOWN_PATHS = 30
// Used for the diff budget when the model's context size is not listed.
const DEFAULT_CONTEXT = 128_000
const CHARS_PER_TOKEN = 3.5
const RISKS: Risk[] = ["low", "medium", "high"]
const FORMAT = { type: "json_schema" as const, schema: REVIEW_REPORT_JSON_SCHEMA, retryCount: 0 }

type PermissionRule = ReturnType<typeof reviewPermissionRules>[number]

// The finalize step may only answer: every tool is removed again and StructuredOutput re-allowed last.
const FINALIZE_RULES: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "StructuredOutput", pattern: "*", action: "allow" },
]

const SKIP_REASON: Record<SkippedFile["reason"], string> = {
  ignored: "ignored",
  lockfile: "lockfile",
  generated: "generated",
  vendored: "vendored",
  "build-output": "build output",
  binary: "binary",
  deleted: "deleted",
  "size-limit": "too large",
}

// What the panel knows about a pull request, from GitHub's API.
export type ReviewPullRequest = {
  number: number
  title: string
  body: string
  author: string
  url: string
  baseRefName: string
  headRefName: string
  headRefOid?: string
  baseRefOid?: string
  isCrossRepository?: boolean
  comments?: { author: string; body: string }[]
}

// A model the review can run on, from the connected providers.
export type ReviewModel = {
  providerID: string
  modelID: string
  context?: number
  price?: ReviewPrice // only when priced
  costKind: CostKind
}

// in-place: every changed file in the checkout already is the pull request's version. rebuilt: the pull request's
// version of each changed file is rebuilt from the diff and placed in the prompt, as for a fork in CI.
export type ReviewCheckout = {
  mode: "in-place" | "rebuilt"
  trust: Trust
  headFiles: HeadFile[]
  fromDiff: string[] // files reviewed from their hunks only
}

export type ReviewEstimate = {
  files: number
  model?: string
  costKind?: CostKind
  low?: number
  high?: number
}

export type ReviewProgress =
  | { type: "status"; text: string }
  | { type: "checkout"; checkout: ReviewCheckout; label: string }

export type SpecialistRun = {
  name: Specialist
  status: "ok" | "stopped" | "timeout" | "failed"
  sessionID?: string
  detail?: string
}

export type ReviewOutcomeLite = {
  pr: number
  head: string
  baseRef: string
  checkout: ReviewCheckout
  label: string
  report: ModelReport
  selection: Selection
  skipped: SkippedFile[]
  files: { path: string; additions: number; deletions: number }[] // the reviewed files
  anchored: Record<string, string> // finding id → the code at its anchor, for showing fixes as diffs
  cost?: ReviewCost
  durationMs: number
  specialists: SpecialistRun[]
  sessions: string[]
  banners: string[]
  notes: string[]
}

// What the panel passes to onReview. The layout adds the directory, the models and the client.
export type ReviewRequest = {
  pr: ReviewPullRequest
  diff: string // `gh pr diff`
  signal?: AbortSignal // the Stop button
  confirm?: (estimate: ReviewEstimate) => Promise<boolean>
  onProgress?: (progress: ReviewProgress) => void
}

export type ReviewRunInput = ReviewRequest & {
  directory: string
  catalog?: readonly ReviewModel[]
  preferredModels?: readonly (string | undefined)[] // the review agent's model, then the configured default
  timeoutMs?: number
  now?: () => number
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export type ReviewMessage = {
  info: {
    role: string
    providerID?: string
    modelID?: string
    cost?: number
    unpriced?: boolean
    forked?: boolean
    tokens?: Tokens
    structured?: unknown
    error?: unknown
  }
  parts: { type: string; text?: string }[]
}

type Result<T> = Promise<{ data?: T }>

// The part of the SDK client a review uses.
export interface ReviewClient {
  session: {
    create(input: { directory?: string; title?: string; permission?: PermissionRule[] }): Result<{ id: string }>
    prompt(input: {
      sessionID: string
      directory?: string
      agent?: string
      model?: { providerID: string; modelID: string }
      format?: { type: "json_schema"; schema: { [key: string]: unknown }; retryCount?: number }
      parts?: { type: "text"; text: string }[]
    }): Result<ReviewMessage>
    update(input: { sessionID: string; directory?: string; permission?: PermissionRule[] }): Result<unknown>
    abort(input: { sessionID: string; directory?: string }): Result<unknown>
    messages(input: { sessionID: string; directory?: string }): Result<ReviewMessage[]>
  }
  file: {
    read(input: { directory?: string; path: string }): Result<{ type: string; content: string }>
  }
  vcs?: {
    get(input: { directory?: string }): Result<{ branch?: string }>
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Models

export function modelName(model: Pick<ReviewModel, "providerID" | "modelID">) {
  return `${model.providerID}/${model.modelID}`
}

// Section 5.5 from what the desktop can see. The engine knows the sign-in type; here a provider signed in through
// Vector ("api") with no listed price stands for a subscription sign-in.
export function costKindOf(
  provider: { id: string; source?: string },
  cost?: { input: number; output: number },
  modelID = "",
) {
  if (isFreeModel({ providerID: provider.id, id: modelID, cost })) return "free" satisfies CostKind
  const listed = !!cost && (cost.input > 0 || cost.output > 0)
  if (listed) return "priced" satisfies CostKind
  return (provider.source === "api" ? "plan" : "unknown") satisfies CostKind
}

type CatalogProvider = {
  id: string
  source?: string
  models: Record<
    string,
    {
      id: string
      cost?: { input: number; output: number; cache?: { read: number; write: number } }
      limit?: { context: number }
    }
  >
}

export function reviewCatalog(providers: readonly CatalogProvider[]): ReviewModel[] {
  return providers
    .filter((provider) => providerUsable(provider.id, provider))
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => {
        const costKind: CostKind = costKindOf(provider, model.cost, model.id)
        const cost = model.cost
        const price: ReviewPrice | undefined =
          costKind === "priced" && cost
            ? {
                input: cost.input,
                output: cost.output,
                ...(cost.cache && cost.cache.read > 0 ? { cacheRead: cost.cache.read } : {}),
                ...(cost.cache && cost.cache.write > 0 ? { cacheWrite: cost.cache.write } : {}),
              }
            : undefined
        return {
          providerID: provider.id,
          modelID: model.id,
          ...(model.limit?.context ? { context: model.limit.context } : {}),
          ...(price ? { price } : {}),
          costKind,
        }
      }),
    )
}

// The first candidate that is a connected, supported provider model.
export function pickReviewModel(candidates: readonly (string | undefined)[], catalog: readonly ReviewModel[]) {
  for (const name of candidates) {
    const found = name?.trim() && catalog.find((model) => modelName(model) === name.trim())
    if (found) return found
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// The checkout

// Reviews in place when every changed file already matches the pull request. Otherwise each file's head version is
// rebuilt from the diff: exactly when the local text is the base (or already the head), from its hunks otherwise.
export async function chooseCheckout(
  files: readonly DiffFile[],
  read: (path: string) => Promise<string | undefined>,
): Promise<ReviewCheckout> {
  const local = await mapLimit(files, READ_CONCURRENCY, async (file) => ({
    file,
    text: (await read(file.path)) ?? "",
    // A renamed file's base text sits at its old path.
    base: file.oldPath && file.oldPath !== file.path ? ((await read(file.oldPath)) ?? "") : undefined,
  }))
  // A missing file reads back empty, so a rename whose old path still has its text is not the head yet.
  const isHead = (entry: (typeof local)[number]) =>
    matchPostImage(entry.text, entry.file) && !(entry.base && !entry.text)
  if (local.every(isHead)) return { mode: "in-place", trust: "trusted", headFiles: [], fromDiff: [] }

  const headFiles: HeadFile[] = []
  const fromDiff: string[] = []
  for (const entry of local) {
    if (entry.file.status === "deleted") continue
    const rebuilt = isHead(entry) ? entry.text : applyPatch(entry.base ?? entry.text, entry.file)
    if (rebuilt !== undefined && rebuilt.length <= HEAD_FILE_CHARS) {
      headFiles.push({ path: entry.file.path, text: rebuilt, exact: true })
      continue
    }
    fromDiff.push(entry.file.path)
    headFiles.push({ path: entry.file.path, text: renderPatch([entry.file]), exact: false })
  }
  return { mode: "rebuilt", trust: "untrusted", headFiles, fromDiff }
}

export function checkoutLabel(checkout: ReviewCheckout, context: { branch?: string; baseRef: string }) {
  if (checkout.mode === "in-place") return "Reviewing your checkout"
  const where = context.branch
    ? `Your checkout is on \`${context.branch}\`, not this pull request.`
    : "Your checkout is not this pull request."
  const count = checkout.fromDiff.length
  const tail = count ? ` ${count} ${count === 1 ? "file is" : "files are"} reviewed from the diff only.` : ""
  return `${where} Vector rebuilt the pull request's version of each changed file from its diff and reads other files from your checkout, which may differ from \`${context.baseRef}\`.${tail}`
}

// Exact files first, then the hunks of files the diff budget left out, until the budget is used. The hunks of an
// inlined file are already in the diff.
function promptHeadFiles(files: readonly HeadFile[], inlined: ReadonlySet<string>, maxChars: number) {
  const out: HeadFile[] = []
  let used = 0
  for (const file of [
    ...files.filter((item) => item.exact),
    ...files.filter((item) => !item.exact && !inlined.has(item.path)),
  ]) {
    if (used + file.text.length > maxChars) continue
    out.push(file)
    used += file.text.length
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// The review

type StopReason = "user" | "timeout"

type Usage = {
  messages: ReviewMessage["info"][]
  complete: boolean
}

const NO_USAGE: Usage = { messages: [], complete: true }

type SpecialistResult = SpecialistRun & { report?: ModelReport; usage: Usage }

export async function runPullRequestReview(
  input: ReviewRunInput,
  client: ReviewClient,
): Promise<ReviewOutcomeLite | undefined> {
  const now = input.now ?? Date.now
  const started = now()
  const { directory, pr } = input
  const status = (text: string) => input.onProgress?.({ type: "status", text })
  const files = parseUnifiedDiff(input.diff)
  if (!files.length) throw new Error(`Pull request #${pr.number} has no changes to review.`)
  const read = async (path: string) => {
    const result = await client.file.read({ directory, path }).catch(() => undefined)
    return result?.data?.type === "text" ? result.data.content : undefined
  }

  // Settings come from the user's checkout, as for `vector review`, unless this pull request changes them: a pull
  // request never sets the rules it is reviewed under. Compared without case, for case-insensitive file systems.
  const changed = new Set(
    files.flatMap((file) => [file.path, file.oldPath ?? file.path].map((path) => path.toLowerCase())),
  )
  const setting = (path: string) => (changed.has(path.toLowerCase()) ? Promise.resolve(undefined) : read(path))
  const [json, attributesText, ...rulesTexts] = await Promise.all([
    setting(REVIEW_CONFIG_PATH),
    setting(".gitattributes"),
    ...REVIEW_RULES_PATHS.map(setting),
  ])
  const { config } = parseReviewConfig({ json: json?.trim() ? json : undefined, trigger: "desktop" })
  const attributes = attributesText ? parseGitAttributes(attributesText) : undefined
  const { review, skipped } = classifyFiles(files, { config, attributes })
  const head = pr.headRefOid || pr.headRefName
  const summary = {
    pr: pr.number,
    head,
    baseRef: pr.baseRefName,
    skipped,
    files: review.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
  }
  if (!review.length)
    return {
      ...summary,
      checkout: { mode: "in-place", trust: "trusted", headFiles: [], fromDiff: [] },
      label: "",
      report: { summary: "", risk: "low", files: [], findings: [] },
      selection: emptySelection(),
      anchored: {},
      durationMs: now() - started,
      specialists: [],
      sessions: [],
      banners: [],
      notes: [noteNothingToReview()],
    }

  status("Reading your checkout…")
  const checkout = await chooseCheckout(review, read)
  const branch =
    checkout.mode === "rebuilt" && client.vcs
      ? await client.vcs.get({ directory }).then(
          (result) => result.data?.branch,
          () => undefined,
        )
      : undefined
  const label = checkoutLabel(checkout, { branch, baseRef: pr.baseRefName })
  input.onProgress?.({ type: "checkout", checkout, label })
  if (input.signal?.aborted) return undefined

  // Use review.json, then the review agent's model and the configured default.
  // The resolved model is passed explicitly to every prompt.
  const catalog = input.catalog ?? []
  const model =
    pickReviewModel([config.model, ...(input.preferredModels ?? [])], catalog) ??
    catalog.find((item) => item.costKind === "free") ??
    catalog[0]
  if (!model)
    throw new Error(
      "Connect a provider in Settings → Providers, or configure a local provider and set model in .vector/review.json.",
    )
  const refusal = model?.context ? contextRefusal(modelName(model), model.context) : undefined
  if (refusal) throw new Error(refusal)

  const budget = diffBudgetChars(model?.context ?? DEFAULT_CONTEXT, config.maxDiffChars)
  const { inline, notInlined } = budgetDiff(review, budget)
  const rulesText = rulesTexts.find((text) => text?.trim())
  const prompt: PromptInput = {
    mode: "full",
    trust: checkout.trust,
    base: pr.baseRefOid || pr.baseRefName,
    head,
    baseRef: pr.baseRefName,
    pr: { number: pr.number, title: pr.title, body: pr.body, author: pr.author },
    diff: renderPatch(inline),
    notInlined: notInlined.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    headFiles:
      checkout.trust === "untrusted"
        ? promptHeadFiles(checkout.headFiles, new Set(inline.map((file) => file.path)), budget)
        : undefined,
    rules: rulesForPaths(
      parseReviewRules(rulesText ?? ""),
      review.map((file) => file.path),
      config.paths,
    ),
    rulesSource: "working tree",
    humanComments: (pr.comments ?? []).map((comment) => ({ author: comment.author, body: comment.body })),
    maxComments: config.maxComments,
  }
  const plan = planSpecialists(review, config)
  const texts: Record<Specialist, string> = { review: buildReviewPrompt(prompt), security: buildSecurityPrompt(prompt) }

  if (review.length > ESTIMATE_FILES && input.confirm) {
    const estimate = estimateReview({
      files: review.length,
      model,
      plan,
      promptChars: texts.review.length,
      maxSteps: config.maxSteps,
    })
    const go = await input.confirm(estimate)
    if (!go || input.signal?.aborted) return undefined
  }

  status("Vector is reviewing…")
  const rules = reviewPermissionRules({})
  const timeoutMs = input.timeoutMs ?? REVIEW_TIMEOUT_MS
  const stop = stopWhen(input.signal, timeoutMs)
  const runs = await Promise.all(
    plan.map((name) =>
      runSpecialist({
        client,
        directory,
        name,
        title: `Vectorscope review · #${pr.number} · ${name}`,
        text: texts[name],
        model,
        rules,
        stop: stop.promise,
      }),
    ),
  ).finally(stop.dispose)

  const reports = runs.flatMap((run) => (run.report ? [{ source: run.name, report: run.report }] : []))
  if (!reports.length)
    throw new Error(
      `Vector could not finish this review: ${runs.find((run) => run.detail)?.detail ?? "no reviewer answered"}.`,
    )

  const index = buildAnchorIndex(files)
  const findings = reports.flatMap(({ source, report }) =>
    report.findings.map((finding) => toFinding(finding, source, index)),
  )
  const report: ModelReport = {
    summary: (reports.find((entry) => entry.source === "review") ?? reports[0]!).report.summary,
    risk: RISKS[Math.max(...reports.map((entry) => RISKS.indexOf(entry.report.risk)))] ?? "low",
    files: reports
      .flatMap((entry) => entry.report.files)
      .filter((file, position, all) => all.findIndex((other) => other.path === file.path) === position),
    findings: reports.flatMap((entry) => entry.report.findings),
  }

  // Paths outside the diff are kept only when the checkout has them; a missing file reads back empty.
  const unknown = [
    ...new Set(findings.map((finding) => finding.path.trim()).filter((path) => path && !lookupFile(index, path))),
  ].slice(0, MAX_UNKNOWN_PATHS)
  const known = new Set<string>()
  await mapLimit(unknown, READ_CONCURRENCY, async (path) => {
    if (await read(path)) known.add(path)
  })

  const selection = selectFindings({
    findings,
    anchors: files,
    head,
    trust: checkout.trust,
    mode: "full",
    config,
    ignored: (path) => classifyPath(path, { config, attributes }) !== undefined,
    knownPath: (path) => known.has(path.trim()),
    modelRisk: report.risk,
    sensitiveChanged: review.some((file) => isSensitivePath(file.path)),
    changedLines: review.reduce((total, file) => total + file.additions + file.deletions, 0),
  })
  const anchored: Record<string, string> = {}
  for (const finding of [...selection.inline, ...selection.overflow, ...selection.nits]) {
    const resolved = resolveAnchor(index, finding)
    if (resolved.ok) anchored[finding.id] = anchorText(index, resolved.anchor)
  }

  const usage = measureUsage(runs.flatMap((run) => run.usage.messages))
  const used = usage
    ? usage.provider && usage.model
      ? `${usage.provider}/${usage.model}`
      : "Multiple models"
    : modelName(model)
  const kind: CostKind =
    !usage || usage.costUsd === undefined || runs.some((run) => !run.usage.complete)
      ? "unknown"
      : (catalog.find((entry) => modelName(entry) === used)?.costKind ?? (usage.costUsd > 0 ? "priced" : "unknown"))
  return {
    ...summary,
    checkout,
    label,
    report,
    selection,
    anchored,
    cost: used
      ? {
          costUsd: usage?.costUsd ?? 0,
          input: usage?.usage.input ?? 0,
          output: usage?.usage.output ?? 0,
          reasoning: usage?.usage.reasoning ?? 0,
          cacheRead: usage?.usage.cacheRead ?? 0,
          cacheWrite: usage?.usage.cacheWrite ?? 0,
          ...(!usage ? { usageMissing: true } : {}),
          kind,
          model: used,
        }
      : undefined,
    durationMs: now() - started,
    specialists: runs.map(({ name, status, sessionID, detail }) => ({ name, status, sessionID, detail })),
    sessions: runs.flatMap((run) => (run.sessionID ? [run.sessionID] : [])),
    banners: partialBanners(runs, timeoutMs),
    notes: [],
  }
}

async function runSpecialist(input: {
  client: ReviewClient
  directory: string
  name: Specialist
  title: string
  text: string
  model?: ReviewModel
  rules: PermissionRule[]
  stop: Promise<StopReason>
}): Promise<SpecialistResult> {
  const { client, directory, name } = input
  let failure: string | undefined
  const created = await client.session
    .create({ directory, title: input.title, permission: input.rules })
    .catch((cause: unknown) => {
      failure = errorText(cause)
      return undefined
    })
  const sessionID = created?.data?.id
  if (!sessionID)
    return { name, status: "failed", detail: failure ?? "Vector could not create a review session.", usage: NO_USAGE }

  const ask = (text: string) =>
    client.session
      .prompt({
        sessionID,
        directory,
        agent: name,
        ...(input.model ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } } : {}),
        format: FORMAT,
        parts: [{ type: "text", text }],
      })
      .then(
        (result) => {
          failure = errorText(result.data?.info.error) ?? failure
          return result.data
        },
        (cause: unknown) => {
          failure = errorText(cause) ?? failure
          return undefined
        },
      )

  let status: SpecialistRun["status"] = "ok"
  const first = ask(input.text)
  const raced = await Promise.race([first.then((message) => ({ message })), input.stop.then((reason) => ({ reason }))])
  let message = "message" in raced ? raced.message : undefined
  if ("reason" in raced) {
    status = raced.reason === "user" ? "stopped" : "timeout"
    await client.session.abort({ sessionID, directory }).catch(() => undefined)
    message = await within(first, ABORT_GRACE_MS)
  }

  // A stopped session, or one that answered without a report, gets the finalize prompt in the same session: its
  // findings exist only in its own context.
  let report = reportOf(message)
  if (!report) {
    const restrictionFailure = await client.session
      .update({ sessionID, directory, permission: [...input.rules, ...FINALIZE_RULES] })
      .then(
        (result) => (result.data ? undefined : "Vector could not confirm review permissions. Try the review again."),
        (cause: unknown) => errorText(cause) ?? "Vector could not restrict the review session's tools.",
      )
    // Finalizing may only return a summary; a failed permission update must never launch another tool-enabled turn.
    if (restrictionFailure)
      return {
        name,
        status: "failed",
        sessionID,
        detail: restrictionFailure,
        usage: await usageOf(client, sessionID, directory),
      }
    const answer = await within(ask(buildFinalizePrompt()), FINALIZE_MS)
    if (!answer) await client.session.abort({ sessionID, directory }).catch(() => undefined)
    report = reportOf(answer)
  }
  const usage = await usageOf(client, sessionID, directory)
  if (report) return { name, status, sessionID, report, usage }
  return { name, status: "failed", sessionID, detail: failure ?? "No review came back.", usage }
}

function reportOf(message: ReviewMessage | undefined): ModelReport | undefined {
  if (!message) return undefined
  const text = message.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
  return decodeReport(message.info.structured) ?? (text ? decodeReport(text) : undefined)
}

// The id is computed from the anchored code, as in the engine, so the same finding keeps its id across surfaces.
function toFinding(finding: ModelFinding, source: Specialist, index: AnchorIndex): Finding {
  const side = finding.side ?? "RIGHT"
  const resolved = resolveAnchor(index, { ...finding, side })
  const path = resolved.ok ? resolved.anchor.path : finding.path
  const code = resolved.ok ? anchorText(index, resolved.anchor) : ""
  return {
    ...finding,
    side,
    source,
    id: fingerprint(path, finding.category, normalizeTitle(finding.title), normalizeCode(code)),
  }
}

// Section 5.2 for each planned session, with its step cap: review maxSteps, security two thirds of it.
function estimateReview(input: {
  files: number
  model?: ReviewModel
  plan: Specialist[]
  promptChars: number
  maxSteps: number
}): ReviewEstimate {
  const estimate: ReviewEstimate = {
    files: input.files,
    ...(input.model ? { model: modelName(input.model), costKind: input.model.costKind } : {}),
  }
  const price = input.model?.price
  if (!price) return estimate
  const promptTokens = Math.ceil(input.promptChars / CHARS_PER_TOKEN)
  const ranges = input.plan.map((name) =>
    estimateCostUsd({
      promptTokens,
      maxSteps: name === "security" ? Math.ceil((input.maxSteps * 2) / 3) : input.maxSteps,
      price,
    }),
  )
  return {
    ...estimate,
    low: ranges.reduce((total, range) => total + range.low, 0),
    high: ranges.reduce((total, range) => total + range.high, 0),
  }
}

// Every assistant step of the session, so the cost includes the finalize step.
async function usageOf(client: ReviewClient, sessionID: string, directory: string): Promise<Usage> {
  return client.session.messages({ sessionID, directory }).then(
    (result) => ({ messages: (result.data ?? []).map((message) => message.info), complete: result.data !== undefined }),
    () => ({ messages: [], complete: false }),
  )
}

function partialBanners(runs: readonly SpecialistResult[], timeoutMs: number): string[] {
  const out: string[] = []
  const kept = "the findings below are the ones Vector had confirmed by then."
  if (runs.some((run) => run.status === "timeout"))
    out.push(`**Partial review.** Stopped at the ${Math.round(timeoutMs / 60_000)}-minute time limit; ${kept}`)
  else if (runs.some((run) => run.status === "stopped"))
    out.push(`**Partial review.** Stopped before it finished; ${kept}`)
  for (const run of runs)
    if (run.status === "failed") {
      // Engine and provider errors are not Vector's own text, so they are sanitized like model text.
      const detail = sanitizeModelMarkdown((run.detail ?? "no answer").replace(/\s+/g, " ").slice(0, 200))
      out.push(`**Partial review.** The ${run.name} reviewer could not finish: ${detail.replace(/[.\s]+$/, "")}.`)
    }
  return out
}

function emptySelection(): Selection {
  return {
    inline: [],
    outsideDiff: [],
    elsewhere: [],
    nits: [],
    overflow: [],
    stillOpen: [],
    fixed: [],
    dismissed: [],
    reappeared: [],
    raised: [],
    dropped: [],
    risk: "low",
  }
}

function stopWhen(signal: AbortSignal | undefined, ms: number) {
  let dispose = () => {}
  const promise = new Promise<StopReason>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms)
    const abort = () => resolve("user")
    signal?.addEventListener("abort", abort, { once: true })
    dispose = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    if (signal?.aborted) abort()
  })
  return { promise, dispose }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const position = next++
      out[position] = await fn(items[position]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function errorText(value: unknown): string | undefined {
  if (!value) return undefined
  if (value instanceof Error) return value.message || undefined
  if (typeof value === "string") return value || undefined
  if (typeof value !== "object") return undefined
  const record = value as { message?: unknown; name?: unknown; data?: { message?: unknown } }
  const text = record.data?.message ?? record.message ?? record.name
  return typeof text === "string" && text ? text : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Showing and posting results

export type ReviewFindingView = {
  id: string
  severity: Severity
  category: string
  path: string
  line: number
  title: string
  body: string
  place: "changed" | "outside" | "elsewhere"
  fix?: { removed: string[]; added: string[] }
}

// Every finding, grouped by severity (blocking first), with its fix as a diff against the code at its anchor.
export function findingGroups(outcome: Pick<ReviewOutcomeLite, "selection" | "anchored">) {
  const { selection } = outcome
  const view = (finding: Finding, place: ReviewFindingView["place"], path = finding.path, line = finding.line) => {
    const current = outcome.anchored[finding.id]
    const item: ReviewFindingView = {
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      path,
      line,
      title: finding.title,
      body: finding.body,
      place,
    }
    if (finding.suggestion)
      item.fix = {
        removed: current ? current.split("\n") : [],
        added: finding.suggestion.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"),
      }
    return item
  }
  const all = [
    ...selection.inline.map((finding) => view(finding, "changed", finding.anchor.path, finding.anchor.line)),
    ...selection.overflow.map((finding) => view(finding, "changed")),
    ...selection.outsideDiff.map((finding) => view(finding, "outside")),
    ...selection.elsewhere.map((finding) => view(finding, "elsewhere")),
    ...selection.nits.map((finding) => view(finding, "changed")),
  ]
  return SEVERITIES.map((severity) => ({
    severity,
    findings: all.filter((item) => item.severity === severity),
  })).filter((group) => group.findings.length > 0)
}

export function countBySeverity(groups: readonly { severity: Severity; findings: readonly unknown[] }[]) {
  const count = (severity: Severity) => groups.find((group) => group.severity === severity)?.findings.length ?? 0
  return { blocking: count("blocking"), concern: count("concern"), nit: count("nit") }
}

export type ReviewEvent = "comment" | "approve" | "request-changes"

// Vector never approves on its own. The user may, but not while a blocking finding stands.
export function reviewEvents(selection: Selection): Record<ReviewEvent, boolean> {
  const blocking = [...selection.inline, ...selection.overflow, ...selection.outsideDiff, ...selection.elsewhere].some(
    (finding) => finding.severity === "blocking",
  )
  return { comment: true, approve: !blocking, "request-changes": true }
}

export function repoOf(url: string): RepoRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url)
  return match ? { owner: match[1]!, repo: match[2]! } : undefined
}

// The summary's desktop form: no state marker and no commands, every finding listed with its fix as a diff. It is
// posted to someone else's pull request, and the review ran in the user's own engine, so any token shape the model
// read goes out redacted.
export function buildDesktopSummary(outcome: ReviewOutcomeLite, url?: string) {
  return redactSecrets(desktopSummaryBody(outcome, url), [])
}

function desktopSummaryBody(outcome: ReviewOutcomeLite, url?: string) {
  return buildSummaryBody({
    form: "desktop",
    repo: url ? repoOf(url) : undefined,
    pr: outcome.pr,
    head: outcome.head,
    baseRef: outcome.baseRef,
    mode: "full",
    report: outcome.report,
    selection: outcome.selection,
    files: outcome.files,
    skipped: outcome.skipped,
    banners: outcome.banners,
    notes: outcome.notes,
    cost: outcome.cost,
    durationMs: outcome.durationMs,
  })
}

// The model and what the review cost, in the 1.2 wording, then how long it took.
export function reviewFooter(outcome: Pick<ReviewOutcomeLite, "cost" | "durationMs">) {
  return [outcome.cost ? costWording(outcome.cost) : undefined, formatDuration(outcome.durationMs)]
    .filter(Boolean)
    .join(" · ")
}

export function skippedText(skipped: readonly SkippedFile[]) {
  return skipped.map((file) => `${file.path} (${SKIP_REASON[file.reason]})`).join(" · ")
}

export function estimateText(estimate: ReviewEstimate) {
  const size = `This pull request changes ${estimate.files.toLocaleString("en-US")} files.`
  const model = estimate.model ?? "your default model"
  if (estimate.low !== undefined && estimate.high !== undefined)
    return `${size} With ${model} a review costs about ${formatUsd(estimate.low)}–${formatUsd(estimate.high)}.`
  if (estimate.costKind === "free")
    return `${size} It runs on ${model.replace(/:free$/, "")} through OpenRouter at no charge.`
  if (estimate.costKind === "plan")
    return `${size} It runs on ${model} through your subscription sign-in, with no per-token price.`
  return `${size} No price is listed for ${model}, so Vector cannot estimate what it costs.`
}
