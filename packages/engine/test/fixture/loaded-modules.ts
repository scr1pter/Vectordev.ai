// Preloaded into a CLI process by tests: on exit, writes every loaded module path to VECTOR_TEST_MODULES_OUT.
import { writeFileSync } from "node:fs"

const out = process.env.VECTOR_TEST_MODULES_OUT
if (out) process.on("exit", () => writeFileSync(out, JSON.stringify(Object.keys(require.cache))))
