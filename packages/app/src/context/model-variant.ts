type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

type VariantInput = {
  variants: string[]
  selected: string | null | undefined
  configured: string | undefined
}

const VARIANT_COPY: Record<string, { label: string; description: string }> = {
  default: {
    label: "Default",
    description: "Uses the model provider's recommended effort level.",
  },
  none: {
    label: "Default",
    description: "Uses the model provider's recommended effort level.",
  },
  minimal: {
    label: "Light",
    description: "Prioritizes speed and lower cost for small, well-scoped tasks.",
  },
  low: {
    label: "Light",
    description: "Prioritizes speed and lower cost for small, well-scoped tasks.",
  },
  medium: {
    label: "Balanced",
    description: "Balances response speed with careful reasoning for everyday engineering work.",
  },
  high: {
    label: "Extra",
    description: "Spends more effort on multi-file changes, debugging, and complex decisions.",
  },
  xhigh: {
    label: "Max",
    description: "Uses maximum effort for difficult, high-impact engineering tasks.",
  },
  max: {
    label: "Max",
    description: "Uses the strongest reasoning level exposed by this provider.",
  },
  ultra: {
    label: "Max",
    description: "Uses maximum effort for difficult, high-impact engineering tasks.",
  },
}

const EFFORT_GROUPS = [
  ["low", "minimal"],
  ["medium"],
  ["high"],
  ["max", "xhigh", "ultra"],
] as const

const EFFORT_VALUES = new Set(["default", "none", ...EFFORT_GROUPS.flat()])

function humanizeVariant(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function modelVariantLabel(value: string | null | undefined) {
  if (!value) return VARIANT_COPY.default.label
  return VARIANT_COPY[value.toLowerCase()]?.label ?? humanizeVariant(value)
}

export function modelVariantDescription(value: string | null | undefined) {
  if (!value) return VARIANT_COPY.default.description
  return (
    VARIANT_COPY[value.toLowerCase()]?.description ??
    `${modelVariantLabel(value)} uses the effort level supplied by the active model provider.`
  )
}

export function visibleModelVariants(values: string[]) {
  const available = new Map(values.map((value) => [value.toLowerCase(), value]))
  const isEffortSelector = values.some((value) => EFFORT_VALUES.has(value.toLowerCase()))
  if (!isEffortSelector) return [...new Set(values)]

  return EFFORT_GROUPS.flatMap((group) => {
    const value = group.map((key) => available.get(key)).find(Boolean)
    return value ? [value] : []
  })
}

export function normalizeModelVariant(value: string | null | undefined, variants: string[]) {
  if (!value) return undefined
  const key = value.toLowerCase()
  if (key === "default" || key === "none") return undefined

  const available = new Map(variants.map((variant) => [variant.toLowerCase(), variant]))
  const exact = available.get(key)
  if (exact) return exact

  const group = EFFORT_GROUPS.find((items) => items.some((item) => item === key))
  if (!group) return undefined
  return group.map((item) => available.get(item)).find(Boolean)
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined
  if (!input.agent.model) return undefined
  if (!input.model?.variants) return undefined
  if (input.agent.model.providerID !== input.model.providerID) return undefined
  if (input.agent.model.modelID !== input.model.modelID) return undefined
  if (!(input.agent.variant in input.model.variants)) return undefined
  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected === null || input.selected === "default" || input.selected === "none") return undefined
  if (input.selected) return normalizeModelVariant(input.selected, input.variants)
  return normalizeModelVariant(input.configured, input.variants)
}

export function cycleModelVariant(input: VariantInput) {
  if (input.variants.length === 0) return undefined
  if (input.selected === null || input.selected === "default" || input.selected === "none") return input.variants[0]
  const selected = normalizeModelVariant(input.selected, input.variants)
  if (selected) {
    const index = input.variants.indexOf(selected)
    if (index === input.variants.length - 1) return undefined
    return input.variants[index + 1]
  }
  const configured = normalizeModelVariant(input.configured, input.variants)
  if (configured) {
    const index = input.variants.indexOf(configured)
    if (index === input.variants.length - 1) return input.variants[0]
    return input.variants[index + 1]
  }
  return input.variants[0]
}
