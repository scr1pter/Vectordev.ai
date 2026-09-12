// Preserve accurate upstream provider names while normalizing casing and fallbacks.

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
}

export function brandProviderName(id: string, name?: string | null): string {
  const value = (name ?? "").trim()
  if (value) return value
  return PROVIDER_LABELS[id] ?? id
}

export function brandProviderDescription(id: string): string | undefined {
  if (id === "opencode" || id === "opencode-zen")
    return "Free starter models — chat instantly, no API key or signup required."
  if (id === "opencode-go") return "OpenCode Go models, available inside Vector."
  return undefined
}

/* ---- Model picker ------------------------------------------------------------
   Pure helpers behind the model picker (components/dialog-select-model.tsx). They
   live in this module, not the component, so bun can unit-test them: importing the
   .tsx pulls in Solid's client-only build.

   Never read, return or log provider.key here. /provider ships stored API keys to
   the renderer, and the picker must not surface them. The only option read is
   provider.options.apiKey, compared against the known markers below. */

/** Vector's own gateway. Its zero-cost catalogue models are free for every user. */
const VECTOR_GATEWAY_IDS: ReadonlySet<string> = new Set(["opencode", "opencode-zen"])
export const isVectorGateway = (providerID: string) => VECTOR_GATEWAY_IDS.has(providerID)

/** The key the gateway runs on with no sign-in and no Zen key, when only its zero-cost
    models load (opencode/src/provider/provider.ts). */
const GATEWAY_PUBLIC_KEY = "public"

/** The placeholder key opencode's sign-in plugins (Codex, xAI, Snowflake Cortex) put in
    provider.options.apiKey: OAUTH_DUMMY_KEY in opencode/src/auth/index.ts. */
const SIGN_IN_MARKER = "opencode-oauth-dummy-key"

/** Copilot's sign-in loader sets provider.options.apiKey to "", and only under OAuth
    (opencode/src/plugin/github-copilot/copilot.ts). */
const COPILOT_SIGN_IN_KEY = ""

/** Providers whose sign-in is a known subscription, by plan name. Only these can read as a
    plan. xAI's and Snowflake Cortex's sign-ins set the same marker, but they keep per-token
    or credit billing and prove no particular plan, so they claim nothing. */
const SIGN_IN_PLANS: Record<string, string> = {
  openai: "ChatGPT",
  "github-copilot": "Copilot",
}

/** The fields the picker reads. Structural, so tests can pass plain objects. */
export type PickerModel = {
  id: string
  name: string
  release_date?: string
  capabilities?: {
    reasoning?: boolean
    toolcall?: boolean
    output?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean }
  }
  /** Config-shaped fallbacks, read only where `capabilities` lacks the field. */
  tool_call?: boolean
  modalities?: { output?: readonly string[] }
  limit?: { context?: number }
  cost?: unknown
  provider: {
    id: string
    name?: string
    source?: string
    /** Env var names the provider reads. A single one is its key. */
    env?: readonly string[]
    options?: Record<string, unknown>
  }
}

/** Whether a model can hold a coding conversation: it calls tools, answers in text, and
    isn't a voice model. An API key also connects image models (gpt-image-2) and realtime
    voice models (gpt-realtime-2.1), which can't. Audio output alone doesn't make a voice
    model, since some coding models list it too (Azure's gpt-5.1-codex), so voice is read
    from the model id.
    A missing field never hides a model. `capabilities` is read first, the config shape
    (tool_call, modalities.output) fills a gap, and with neither the model stays. The server
    reports every output flag false when a catalogue entry has no modalities
    (opencode/src/provider/provider.ts), so an output record with nothing set counts as
    missing too. */
const VOICE_MODEL = /realtime|audio|tts|transcribe|(^|[-_.])live([-_.]|$)/i

export function isCodingModel(model: PickerModel) {
  const toolcall = model.capabilities?.toolcall ?? model.tool_call
  if (toolcall === false) return false
  const output = model.capabilities?.output
  if (output && Object.values(output).some((value) => value === true))
    return output.text !== false && !(output.audio === true && VOICE_MODEL.test(model.id))
  const listed = model.modalities?.output
  if (listed && listed.length > 0)
    return listed.includes("text") && !(listed.includes("audio") && VOICE_MODEL.test(model.id))
  return true
}

export type AccessKind = "free" | "plan" | "key" | "none"

export type ModelAccess = {
  kind: AccessKind
  /** Caption for a row or section label; "" when there is nothing honest to claim. */
  label: string
  /** Full sentence for the title attribute. */
  title: string
  /** Lower-case phrase for the row's aria-label. */
  spoken: string
}

const FREE_ACCESS: ModelAccess = {
  kind: "free",
  label: "Free",
  title: "Included with Vector at no cost",
  spoken: "free, included with Vector",
}

const NO_ACCESS: ModelAccess = { kind: "none", label: "", title: "", spoken: "" }

export const costInput = (cost: unknown): number | undefined => {
  if (Array.isArray(cost)) {
    const values = cost.map((item) => costInput(item)).filter((value): value is number => value !== undefined)
    return values.length > 0 ? Math.max(0, ...values) : undefined
  }
  if (!cost || typeof cost !== "object" || !("input" in cost)) return undefined
  const value = (cost as { input?: unknown }).input
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Zero cost from the gateway means free only for its catalogue models, which carry a
    release date, or when it runs keyless. A model defined only in config defaults to zero
    cost, and on a Zen key it bills the Zen balance. */
function gatewayFree(model: PickerModel, cost: number | undefined) {
  if (!isVectorGateway(model.provider.id) || cost !== 0) return false
  return Boolean(model.release_date) || model.provider.options?.apiKey === GATEWAY_PUBLIC_KEY
}

function signInPlan(model: PickerModel, cost: number | undefined) {
  const provider = model.provider
  const plan = SIGN_IN_PLANS[provider.id]
  if (!plan) return undefined
  // A GITHUB_TOKEN env var connects Copilot too, with no sign-in, so the provider alone
  // proves nothing: only the sign-in loader's empty key does.
  if (provider.id === "github-copilot") return provider.options?.apiKey === COPILOT_SIGN_IN_KEY ? plan : undefined
  if (provider.options?.apiKey === SIGN_IN_MARKER) return plan
  // If the server ever stops sending options, zero cost still identifies a ChatGPT
  // sign-in: Codex zeroes OpenAI prices only under OAuth (opencode/src/plugin/openai/codex.ts).
  // Config-defined OpenAI models also default to zero, so this applies only when
  // options are missing entirely.
  if (provider.id === "openai" && provider.options === undefined && cost === 0) return plan
  return undefined
}

/** How a model is paid for. Decided from provider id, key markers, key source and cost,
    never from cost alone:
    1. Zero cost from Vector's gateway is free, for its catalogue models or when it runs
       keyless (gatewayFree).
    2. Known sign-in plans come next, before any cost rule, so a plan's zeroed price never
       reads as free and its priced catalogue entry never reads as billed. Copilot without
       its sign-in claims nothing: a GitHub token isn't a per-token API key.
    3. Any other zero or unknown cost claims nothing. Config and local providers default
       cost to zero (opencode/src/provider/provider.ts), so zero alone proves nothing.
    4. A priced model on a key the user supplied (auth.json or an env var) uses that key.
       Whether the key is billed per token or covers a flat subscription (OpenCode Go,
       "-plan" providers) can't be told from here, so the label says only that. */
export function modelAccess(model: PickerModel): ModelAccess {
  const provider = model.provider
  const cost = costInput(model.cost)
  if (gatewayFree(model, cost)) return FREE_ACCESS
  const plan = signInPlan(model, cost)
  if (plan)
    return {
      kind: "plan",
      label: `${plan} plan`,
      title: `Uses your ${plan} plan`,
      spoken: `uses your ${plan} plan`,
    }
  if (provider.id === "github-copilot") return NO_ACCESS
  // Any other sign-in (xAI, Snowflake Cortex) is neither a known plan nor a key the user
  // pasted, even when a key env var is also set.
  if (provider.options?.apiKey === SIGN_IN_MARKER) return NO_ACCESS
  if (cost === undefined || cost <= 0) return NO_ACCESS
  // An env var is the key only when it's the provider's single var, the server's own rule.
  // Vertex and Bedrock also connect from project, region and credential-file vars.
  if (provider.source === "api" || (provider.source === "env" && provider.env?.length === 1))
    return {
      kind: "key",
      label: "API key",
      title: `Uses your ${brandProviderName(provider.id, provider.name)} API key`,
      spoken: "uses your API key",
    }
  return NO_ACCESS
}

/** The section Vector's free models share, in the picker and in Manage models. */
export const INCLUDED_WITH_VECTOR = "Included with Vector"
export const isIncludedWithVector = (model: PickerModel) => modelAccess(model).kind === "free"

/** Row captions only earn their place where rows are paid for in more than one way. A
    section of nothing but free models doesn't need "Free" on every row. */
export function showRowAccess(models: readonly PickerModel[]) {
  return new Set(models.map((model) => modelAccess(model).kind)).size > 1
}

/** Free catalogue names often end in "Free"; the access caption already says so. */
export function modelDisplayName(model: PickerModel) {
  if (modelAccess(model).kind !== "free") return model.name
  return model.name.replace(/\s*\(?\bfree\)?$/i, "").trim() || model.name
}

/** "400K", "262K", "1M", "1.5M". Millions round down to one decimal, so the caption never
    overstates the window (1,050,000 reads "1M"); the title carries the exact figure. */
export function contextLabel(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return ""
  const thousands = Math.round(tokens / 1000)
  if (thousands < 1000) return `${Math.max(1, thousands)}K`
  const millions = Math.floor(thousands / 100) / 10
  return `${millions >= 10 ? Math.floor(millions) : millions}M`
}

export function contextTitle(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return ""
  return `${tokens.toLocaleString("en-US")}-token context window`
}

export const NEW_RELEASE_DAYS = 60
const DAY_MS = 86_400_000

/** release_date is an ISO date ("2026-09-04"), which Date.parse reads as UTC midnight. */
export function releaseTime(model: Pick<PickerModel, "release_date">): number | undefined {
  if (!model.release_date) return undefined
  const time = Date.parse(model.release_date)
  return Number.isFinite(time) ? time : undefined
}

/** Released in the last 60 days. Callers capture `now` once per open so the flag can't
    flip while the picker is showing; a day of slack absorbs clock and time-zone skew. */
export function isNewRelease(model: Pick<PickerModel, "release_date">, now: number) {
  const time = releaseTime(model)
  if (time === undefined) return false
  return time >= now - NEW_RELEASE_DAYS * DAY_MS && time <= now + DAY_MS
}

// UTC, because the date is UTC midnight: local time would show the day before in the Americas.
const RELEASE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

export function releaseTitle(model: Pick<PickerModel, "release_date">) {
  const time = releaseTime(model)
  return time === undefined ? "" : `Released ${RELEASE_FORMAT.format(time)}`
}

const WORD_BREAK = /[\s\-_.]+/

/** What a model can be found by besides its name: "free", "chatgpt", "reasoning", "1m"... */
function specWords(model: PickerModel, now: number) {
  const words: string[] = []
  const access = modelAccess(model)
  if (access.kind === "free") words.push("free", "included", "vector")
  if (access.kind === "plan") words.push(...access.label.toLowerCase().split(" "))
  if (access.kind === "key") words.push("api", "key")
  if (model.capabilities?.reasoning) words.push("reasoning")
  if (isNewRelease(model, now)) words.push("new")
  const context = contextLabel(model.limit?.context).toLowerCase()
  if (context) words.push(context)
  return words
}

/** Lower is better; undefined means no match. `term` must be trimmed and lower-cased.
    0: the name starts with it. 1: a word of the name does. 2: the name or id contains it.
    3: the provider name contains it, or (2+ characters) a spec word starts with it. */
export function matchRank(model: PickerModel, term: string, now: number): number | undefined {
  if (!term) return 0
  const name = model.name.toLowerCase()
  if (name.startsWith(term)) return 0
  if (name.split(WORD_BREAK).some((word) => word.startsWith(term))) return 1
  if (name.includes(term) || model.id.toLowerCase().includes(term)) return 2
  if (brandProviderName(model.provider.id, model.provider.name).toLowerCase().includes(term)) return 3
  if (term.length >= 2 && specWords(model, now).some((word) => word.startsWith(term))) return 3
  return undefined
}

export const pickerModelKey = (model: { id: string; provider: { id: string } }) => `${model.provider.id}:${model.id}`

/** "GPT-6 Astra, OpenAI, 1M context, reasoning, new, included with your ChatGPT plan" */
export function modelAriaLabel(model: PickerModel, now: number) {
  const access = modelAccess(model)
  const context = contextLabel(model.limit?.context)
  return [
    modelDisplayName(model),
    access.kind === "free" ? "" : brandProviderName(model.provider.id, model.provider.name),
    context ? `${context} context` : "",
    model.capabilities?.reasoning ? "reasoning" : "",
    isNewRelease(model, now) ? "new" : "",
    access.spoken,
  ]
    .filter(Boolean)
    .join(", ")
}

/** The row's hover tooltip, one fact per line, with the details and exact figures the
    row itself leaves out or rounds:
    "GPT-6 Astra\nOpenAI · Reasoning\n1,050,000-token context window\nReleased Sep 4, 2026\nUses your ChatGPT plan" */
export function modelTitle(model: PickerModel) {
  const access = modelAccess(model)
  const about = [
    access.kind === "free" ? "" : brandProviderName(model.provider.id, model.provider.name),
    model.capabilities?.reasoning ? "Reasoning" : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return [model.name, about, contextTitle(model.limit?.context), releaseTitle(model), access.title]
    .filter(Boolean)
    .join("\n")
}

export type PickerSectionKind = "recent" | "provider" | "included"

export type PickerSection<T extends PickerModel = PickerModel> = {
  id: string
  kind: PickerSectionKind
  label: string
  /** The provider whose mark sits on the label row (provider sections only). */
  providerID?: string
  /** How every row in the section is paid for, shown once on the label row. */
  access?: ModelAccess
  /** Rows carry their own access caption: the section has no shared one and mixes ways of paying. */
  rowAccess: boolean
  items: T[]
}

export const RECENT_SECTION_LIMIT = 3

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

/** Newest first, undated last, then by name with numbers compared as numbers. */
function byRelease(a: PickerModel, b: PickerModel) {
  const at = releaseTime(a)
  const bt = releaseTime(b)
  if (at !== bt) {
    if (at === undefined) return 1
    if (bt === undefined) return -1
    return bt - at
  }
  return collator.compare(a.name, b.name)
}

function sharedAccess(items: readonly PickerModel[]) {
  const first = modelAccess(items[0])
  if (!first.label) return undefined
  return items.every((item) => modelAccess(item).label === first.label) ? first : undefined
}

function pickerSection<T extends PickerModel>(section: Omit<PickerSection<T>, "rowAccess">): PickerSection<T> {
  return { ...section, rowAccess: !section.access && showRowAccess(section.items) }
}

/** The picker's sections, in render order. Every model lands in at most one section, so
    keys are unique and the flattened keys are exactly the order rows are drawn in. Models
    that can't hold a coding conversation (isCodingModel) are left out everywhere.
    - No search: the top section (the current model, then up to two recent ones), one
      section per provider with its newest models first, and last "Included with Vector"
      (the gateway's free models). The top section reads "Recently used" once one of its
      rows comes from recent history, "Current model" before that: a new user's current
      model is a default they never picked, and Parallel Workspaces passes no history.
    - Searching: only the provider sections and "Included with Vector", rows by match rank
      then release date, and sections by their best match, so the first row (the one Enter
      picks) is the best match in the list.
    Provider sections follow `popular` (Vector's own gateway ids excluded), then the rest
    A to Z, then "Included with Vector"; while searching, that order breaks ties. Empty
    sections are dropped. */
export function buildModelSections<T extends PickerModel>(input: {
  models: readonly T[]
  term?: string
  currentKey?: string
  recentKeys?: readonly string[]
  now: number
  popular?: readonly string[]
}): PickerSection<T>[] {
  const term = (input.term ?? "").trim().toLowerCase()
  const models = input.models.filter(isCodingModel)
  const sections: PickerSection<T>[] = []
  const taken = new Set<string>()

  if (!term) {
    const byKey = new Map(models.map((model) => [pickerModelKey(model), model]))
    const history = new Set(input.recentKeys)
    const recent: T[] = []
    for (const key of [input.currentKey, ...(input.recentKeys ?? [])]) {
      if (recent.length >= RECENT_SECTION_LIMIT) break
      if (!key || taken.has(key)) continue
      const model = byKey.get(key)
      if (!model) continue
      recent.push(model)
      taken.add(key)
    }
    if (recent.length > 0)
      sections.push(
        pickerSection({
          id: "recent",
          kind: "recent",
          label: recent.some((model) => history.has(pickerModelKey(model))) ? "Recently used" : "Current model",
          items: recent,
        }),
      )
  }

  const ranks = new Map<T, number>()
  const included: T[] = []
  const groups = new Map<string, T[]>()
  for (const model of models) {
    const key = pickerModelKey(model)
    if (taken.has(key)) continue
    const rank = matchRank(model, term, input.now)
    if (rank === undefined) continue
    taken.add(key)
    ranks.set(model, rank)
    if (isIncludedWithVector(model)) {
      included.push(model)
      continue
    }
    const group = groups.get(model.provider.id)
    if (group) group.push(model)
    else groups.set(model.provider.id, [model])
  }
  const rank = (model: T) => ranks.get(model) ?? 0
  const order = (a: T, b: T) => rank(a) - rank(b) || byRelease(a, b)

  const popular = (input.popular ?? []).filter((id) => !id.startsWith("opencode"))
  const popularity = (id: string) => {
    const index = popular.indexOf(id)
    return index === -1 ? popular.length : index
  }
  const providers = Array.from(groups, ([id, items]) => ({
    id,
    items: items.sort(order),
    label: brandProviderName(id, items[0].provider.name),
  })).sort((a, b) => popularity(a.id) - popularity(b.id) || collator.compare(a.label, b.label))
  const listed = providers.map((provider) =>
    pickerSection({
      id: `provider:${provider.id}`,
      kind: "provider",
      label: provider.label,
      providerID: provider.id,
      access: sharedAccess(provider.items),
      items: provider.items,
    }),
  )
  if (included.length > 0)
    listed.push(
      pickerSection({
        id: "included",
        kind: "included",
        label: INCLUDED_WITH_VECTOR,
        access: FREE_ACCESS,
        items: included.sort(order),
      }),
    )
  // Each section's first row is its best match. The sort is stable, so equally good
  // sections keep the order above.
  if (term) listed.sort((a, b) => rank(a.items[0]) - rank(b.items[0]))

  return [...sections, ...listed]
}

/** Keyboard order: every row, in render order. */
export function pickerKeys(sections: readonly PickerSection[]) {
  return sections.flatMap((section) => section.items.map(pickerModelKey))
}
