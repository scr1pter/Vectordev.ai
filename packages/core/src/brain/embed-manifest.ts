export * as BrainEmbedManifest from "./embed-manifest"

// The local models Vector can search documents by meaning with: what each one is, where its files come from, and what
// they must be, byte for byte. Nothing is downloaded until the user asks, and a file is used only when its size and
// sha256 are the ones pinned here (two files of the Code-aware preview are pinned by size until their hashes are).

export type File = {
  /** The file's path in the model's repository at the pinned revision, and in Vector's model folder. */
  readonly name: string
  readonly bytes: number
  /** Absent only for a small file of a preview model, which then comes only from its pinned revision. */
  readonly sha256?: string
}

export type Model = {
  readonly id: ModelID
  /** What Settings and the CLI call it. */
  readonly label: string
  /** One line on what it is for. */
  readonly description: string
  readonly license: "Apache-2.0"
  /** Who made it. */
  readonly owner: string
  /** Hugging Face repository and the commit its files are pinned to. */
  readonly repo: string
  readonly revision: string
  readonly dims: number
  readonly pooling: "cls" | "mean"
  /** Wordpieces a passage is cut to (title or breadcrumb plus body). */
  readonly maxTokens: number
  /** Wordpieces a request is cut to: its head and its tail. */
  readonly queryTokens: number
  /** What a request is prefixed with, as the model was trained to see queries. */
  readonly query: string
  /**
   * The least centred cosine (BrainVector: the cosine less the mean every text shares) a match by meaning needs; the
   * gate also wants it within 0.08 of the best. Set on the knowledge eval, where it is the least that lets none of
   * the unrelated requests through, with room to spare.
   */
  readonly floor: number
  /** The int8 graph and the files it reads. Only int8 MatMulInteger graphs are used, never q4 MatMulNBits. */
  readonly files: {
    readonly model: File
    /** The graph's weights, for a model that keeps them in a second file. */
    readonly data?: File
    readonly tokenizer: File
    readonly config: File
  }
  /** The full-precision graph Settings offers when the int8 one fails its check on this computer. */
  readonly fallback?: File
  /** A preview is offered only when asked for, and says it is one. */
  readonly preview?: string
}

export type ModelID = "arctic-embed-xs-q8" | "granite-small-r2-q8"

/** Which graph of a model is in use: the int8 one, or the full-precision fallback. */
export type Variant = "int8" | "fp32"

export const MODELS: Readonly<Record<ModelID, Model>> = {
  "arctic-embed-xs-q8": {
    id: "arctic-embed-xs-q8",
    label: "Search by meaning",
    description: "Snowflake Arctic Embed XS, int8: finds passages that say what a request means in other words.",
    license: "Apache-2.0",
    owner: "Snowflake",
    repo: "Snowflake/snowflake-arctic-embed-xs",
    revision: "d8c86521100d3556476a063fc2342036d45c106f",
    dims: 384,
    pooling: "cls",
    maxTokens: 320,
    queryTokens: 64,
    query: "Represent this sentence for searching relevant passages: ",
    floor: 0.2,
    files: {
      model: {
        name: "onnx/model_quantized.onnx",
        bytes: 22_972_992,
        sha256: "e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1",
      },
      tokenizer: {
        name: "tokenizer.json",
        bytes: 711_649,
        sha256: "91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854",
      },
      config: {
        name: "tokenizer_config.json",
        bytes: 1_433,
        sha256: "9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810",
      },
    },
    fallback: {
      name: "onnx/model.onnx",
      bytes: 90_387_631,
      sha256: "cf2698d30ff05da02c70a088313bad56e5c2f401d734cb24a8390d446111936c",
    },
  },
  "granite-small-r2-q8": {
    id: "granite-small-r2-q8",
    label: "Code-aware",
    description: "IBM Granite Embedding Small English R2, int8: a larger model trained on code as well as prose.",
    license: "Apache-2.0",
    owner: "IBM (ONNX conversion by onnx-community)",
    repo: "onnx-community/granite-embedding-small-english-r2-ONNX",
    revision: "1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8",
    dims: 384,
    pooling: "cls",
    maxTokens: 320,
    queryTokens: 64,
    query: "",
    floor: 0.45,
    files: {
      model: {
        name: "onnx/model_quantized.onnx",
        bytes: 598_902,
        sha256: "a3fad524afc3f060216a8ddbb1ac89c9b6498fba8995b5718bde879076a2e9ba",
      },
      data: {
        name: "onnx/model_quantized.onnx_data",
        bytes: 51_885_568,
        sha256: "1f4cf47e4adec7f7ae09db03d071ba8667e07f9a4203142c7efa8d37fe453597",
      },
      tokenizer: { name: "tokenizer.json", bytes: 2_128_614 },
      config: { name: "tokenizer_config.json", bytes: 20_839 },
    },
    preview:
      "Preview: its check vectors are not pinned in this build, so it is checked by how it ranks three test sentences.",
  },
}

export const DEFAULT: ModelID = "arctic-embed-xs-q8"

/**
 * Sentences every load embeds and compares with the vectors the pinned model gave them (embed-golden.json): a request
 * and two passages, the first of which answers it. A runtime that computes the int8 graph wrongly here gives other
 * vectors, and the model is not used.
 */
export const CANARIES = [
  { text: "how long do sessions last", role: "query" },
  { text: "Refresh tokens expire after 14 days, after which the user signs in again.", role: "passage" },
  { text: "Clients MUST wait Retry-After seconds after a 429 response and retry at most 3 times.", role: "passage" },
] as const satisfies readonly { readonly text: string; readonly role: "query" | "passage" }[]

/**
 * Everyday sentences on every kind of subject, whose mean vector (pinned beside the canaries) is the direction a
 * model gives every text. Search by meaning scores passages less that mean, blended with the repository's own, so a
 * greeting or a question about cooking does not look near a spec just because all text looks a little alike.
 */
export const BACKGROUND = [
  "It rained all morning, so the picnic moved indoors.",
  "Add two cups of flour and stir until the dough is smooth.",
  "The striker scored twice in the second half.",
  "Our flight was delayed by three hours at the gate.",
  "She planted tomatoes and basil along the fence.",
  "The museum is closed on Mondays.",
  "Interest rates rose again this quarter.",
  "He practised the piano every evening before dinner.",
  "The train to the coast leaves at seven.",
  "Wash the dark clothes in cold water.",
  "The novel follows two sisters across forty years.",
  "A small bakery opened on the corner last week.",
  "The cat slept in a patch of sunlight on the floor.",
  "Remember to water the plants while I am away.",
  "The concert sold out within an hour.",
  "Mountain roads are icy in the winter months.",
  "The recipe calls for fresh lemon juice.",
  "Our team meets on Thursday afternoons.",
  "The hospital added a new wing for children.",
  "He forgot his umbrella on the bus.",
  "The river flooded the fields after the storm.",
  "Please bring a dish to share at the party.",
  "The library extended its opening hours.",
  "She ran her first marathon in the spring.",
  "The old bridge was painted bright red.",
  "Coffee prices went up this year.",
  "The children built a sandcastle by the shore.",
  "Thank you so much for your help yesterday.",
  "What time does the pharmacy open tomorrow?",
  "The garden is full of bees in July.",
  "Turn left at the second traffic light.",
  "The play opens next Friday at the town theatre.",
  "He collects stamps from countries he has visited.",
  "The soup needs a little more salt.",
  "Snow is expected over the weekend.",
  "The shop on the high street sells handmade candles.",
  "My grandmother tells the best stories.",
  "The bus was crowded on the way home.",
  "The election results will be announced tonight.",
  "Use a soft brush to clean the shoes.",
  "The hotel has a view of the harbour.",
  "We watched the sunset from the hill.",
  "The orchestra tuned their instruments before the show.",
  "Fresh bread smells wonderful in the morning.",
  "The dog loves chasing the ball in the park.",
  "Her paintings hang in a gallery downtown.",
  "Please close the window, it is getting cold.",
  "The farmers market is busiest on Saturdays.",
  "He fixed the bicycle chain with a small wrench.",
  "The puzzle has a thousand pieces.",
  "Tea is served with milk and honey.",
  "The beach was quiet early in the day.",
  "She learned to speak Italian before the trip.",
  "The kitchen tap has been dripping all week.",
  "A rainbow appeared after the shower.",
  "The football match was postponed because of fog.",
  "He wrote a letter to his old teacher.",
  "The festival lights up the whole town.",
  "Hi, how are you today?",
  "Okay, sounds good to me.",
  "Can you tell me a joke?",
  "The movie was longer than I expected.",
  "Birds gather on the wire at dusk.",
  "The neighbours are repainting their fence.",
] as const

/** How many repository rows the background mean counts as when it is blended with theirs. */
export const BACKGROUND_WEIGHT = 64

/** The least cosine each canary needs against vectors pinned for the same graph. */
export const CHECK = 0.995

/**
 * The least cosine for the full-precision graph against the int8 graph's pinned vectors, which is how it is checked
 * until vectors of its own are pinned (the int8 graph approximates it, so they differ a little).
 */
export const CHECK_FALLBACK = 0.97

/**
 * The owner-controlled copy of the pinned files, tried before Hugging Face: assets of one GitHub release, each named
 * `<model id>-<file name without folders>`, and used only when its sha256 is the one pinned here.
 */
export const MIRROR = {
  tag: "knowledge-pack-1",
  base: "https://github.com/scr1pter/Vectordev.ai/releases/download/knowledge-pack-1/",
  hosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
} as const

/** Hugging Face serves small files itself and large ones from its CDN. */
export const HUGGING_FACE = {
  base: "https://huggingface.co/",
  hosts: ["huggingface.co", "*.hf.co"],
} as const

/** The files a model of a variant needs, in the order they are fetched. */
export function files(model: Model, variant: Variant = "int8"): readonly File[] {
  const graph = variant === "fp32" && model.fallback ? model.fallback : model.files.model
  return [
    graph,
    ...(variant === "int8" && model.files.data ? [model.files.data] : []),
    model.files.tokenizer,
    model.files.config,
  ]
}

/** What a file is called among the mirror's release assets. */
export function asset(model: Model, file: File) {
  return `${model.id}-${file.name.split("/").at(-1)}`
}

/** Where Hugging Face serves a file at the model's pinned revision. */
export function huggingFace(model: Model, file: File) {
  return `${HUGGING_FACE.base}${model.repo}/resolve/${model.revision}/${file.name}`
}

/** Bytes a model of a variant takes on disk. */
export function size(model: Model, variant: Variant = "int8") {
  return files(model, variant).reduce((total, file) => total + file.bytes, 0)
}

/**
 * The name vectors are stored under: a vector from one model, revision or graph is never compared with one from
 * another, so changing any of them embeds everything again.
 */
export function key(model: Model, variant: Variant) {
  return `${model.id}@${model.revision.slice(0, 12)}:${variant}`
}

/** "24 MB", as the download is described before it starts. */
export function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function isModel(id: string): id is ModelID {
  return id in MODELS
}
