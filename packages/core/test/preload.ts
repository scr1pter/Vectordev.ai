import path from "path"

process.env.VECTOR_AGENT_DB = ":memory:"
process.env.VECTOR_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "model-catalog.json")
process.env.VECTOR_DISABLE_MODELS_FETCH = "true"
// The local search model is never downloaded in tests; a test serves the fixture model from 127.0.0.1 or a folder.
process.env.VECTOR_BRAIN_EMBED = "off"
// Experimental features stay off unless a test turns one on, so tool lists are stable.
delete process.env["VECTOR_EXPERIMENTAL"]
