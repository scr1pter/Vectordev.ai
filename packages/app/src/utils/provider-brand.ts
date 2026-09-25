import {
  FREE_MODELS_TITLE,
  freeModelName,
  freeModelSource,
  preferOwnFreeModels,
} from "@vectordevai/core/free-model-choice"
import { providerAllowed, providerUsable } from "@vectordevai/schema/provider-policy"

export const isHiddenProvider = (id: string, provider?: Parameters<typeof providerUsable>[1]) =>
  !providerUsable(id, provider)

export function brandProviderName(id: string, name?: string | null): string {
  return name?.trim() || id
}

/* ---- Model picker ------------------------------------------------------------
   Pure helpers behind the model picker (components/dialog-select-model.tsx). They
   live in this module, not the component, so bun can unit-test them: importing the
   .tsx pulls in Solid's client-only build.

   The provider response removes credentials. The picker only reads the harmless
   sign-in placeholder in provider.options.apiKey. */

/** The fields the picker reads. Structural, so tests can pass plain objects. */
export type PickerModel = {
  id: string
  name: string
  freeModel?: { source: "shared" | "openrouter" }
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
    (engine/src/provider/provider.ts), so an output record with nothing set counts as
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

export type AccessKind = "key" | "none"

export type ModelAccess = {
  kind: AccessKind
  /** Caption for a row or section label; "" when there is nothing honest to claim. */
  label: string
  /** Full sentence for the title attribute. */
  title: string
  /** Lower-case phrase for the row's aria-label. */
  spoken: string
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

/** Describe verified user credentials; price alone never means Vector includes a model. */
export function modelAccess(model: PickerModel): ModelAccess {
  const provider = model.provider
  if (isHiddenProvider(provider.id, provider)) return NO_ACCESS
  // An OAuth loader placeholder is not evidence that an API key pays for this model.
  if (provider.options?.apiKey === "vector-oauth-dummy-key") return NO_ACCESS
  const cost = costInput(model.cost)
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

/** Row captions only earn their place where rows are paid for in more than one way. A
    section with a single access method does not need that label on every row. */
export function showRowAccess(models: readonly PickerModel[]) {
  return new Set(models.map((model) => modelAccess(model).kind)).size > 1
}

export function modelDisplayName(model: PickerModel) {
  return freeModelName(model)
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

/** Search provider details and model capabilities as well as the model name. */
function specWords(model: PickerModel, now: number) {
  const words: string[] = []
  const access = modelAccess(model)
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

/** "GPT-6 Astra, OpenAI, 1M context, reasoning, new" */
export function modelAriaLabel(model: PickerModel, now: number) {
  const access = modelAccess(model)
  const context = contextLabel(model.limit?.context)
  return [
    modelDisplayName(model),
    brandProviderName(model.provider.id, model.provider.name),
    context ? `${context} context` : "",
    model.capabilities?.reasoning ? "reasoning" : "",
    isNewRelease(model, now) ? "new" : "",
    freeModelSource(model) ?? access.spoken,
  ]
    .filter(Boolean)
    .join(", ")
}

/** The row's hover tooltip, one fact per line, with the details and exact figures the
    row itself leaves out or rounds:
    "GPT-6 Astra\nOpenAI · Reasoning\n1,050,000-token context window\nReleased Sep 4, 2026" */
export function modelTitle(model: PickerModel) {
  const access = modelAccess(model)
  const about = [
    brandProviderName(model.provider.id, model.provider.name),
    model.capabilities?.reasoning ? "Reasoning" : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return [
    modelDisplayName(model),
    about,
    contextTitle(model.limit?.context),
    releaseTitle(model),
    freeModelSource(model) ?? access.title,
  ]
    .filter(Boolean)
    .join("\n")
}

export type PickerSectionKind = "recent" | "provider" | "free"

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

/** Group connected coding models by provider, with recent choices first when not searching. */
export function buildModelSections<T extends PickerModel>(input: {
  models: readonly T[]
  term?: string
  currentKey?: string
  recentKeys?: readonly string[]
  now: number
  popular?: readonly string[]
}): PickerSection<T>[] {
  const term = (input.term ?? "").trim().toLowerCase()
  const models = preferOwnFreeModels(
    input.models.filter((model) => !isHiddenProvider(model.provider.id, model.provider) && isCodingModel(model)),
  )
  const sections: PickerSection<T>[] = []
  const taken = new Set<string>()
  const free = models.filter((model) => model.freeModel && matchRank(model, term, input.now) !== undefined)
  if (free.length) {
    sections.push(pickerSection({ id: "free", kind: "free", label: FREE_MODELS_TITLE, items: free.sort(byRelease) }))
    free.forEach((model) => taken.add(pickerModelKey(model)))
  }

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
  const groups = new Map<string, T[]>()
  for (const model of models) {
    const key = pickerModelKey(model)
    if (taken.has(key)) continue
    const rank = matchRank(model, term, input.now)
    if (rank === undefined) continue
    taken.add(key)
    ranks.set(model, rank)
    const group = groups.get(model.provider.id)
    if (group) group.push(model)
    else groups.set(model.provider.id, [model])
  }
  const rank = (model: T) => ranks.get(model) ?? 0
  const order = (a: T, b: T) => rank(a) - rank(b) || byRelease(a, b)

  const popular = (input.popular ?? []).filter(providerAllowed)
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
  // Each section's first row is its best match. The sort is stable, so equally good
  // sections keep the order above.
  if (term) listed.sort((a, b) => rank(a.items[0]) - rank(b.items[0]))

  return [...sections, ...listed]
}

/** Keyboard order: every row, in render order. */
export function pickerKeys(sections: readonly PickerSection[]) {
  return sections.flatMap((section) => section.items.map(pickerModelKey))
}
