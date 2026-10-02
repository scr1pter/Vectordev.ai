import path from "path"

process.env.VECTOR_AGENT_DB = ":memory:"
process.env.VECTOR_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "model-catalog.json")
process.env.VECTOR_DISABLE_MODELS_FETCH = "true"
// Web search registers whenever a search key or flag is in the environment; clear them so tool lists are stable.
for (const name of [
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "VECTOR_WEBSEARCH_PROVIDER",
  "VECTOR_EXPERIMENTAL",
  "VECTOR_ENABLE_EXA",
  "VECTOR_EXPERIMENTAL_EXA",
  "VECTOR_ENABLE_PARALLEL",
  "VECTOR_EXPERIMENTAL_PARALLEL",
])
  delete process.env[name]
