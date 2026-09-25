import path from "path"

process.env.VECTOR_AGENT_DB = ":memory:"
process.env.VECTOR_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "model-catalog.json")
process.env.VECTOR_DISABLE_MODELS_FETCH = "true"
