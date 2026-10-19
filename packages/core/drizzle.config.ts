import { defineConfig } from "drizzle-kit"
import path from "node:path"
import os from "node:os"

export default defineConfig({
  dialect: "sqlite",
  // brain/sql.ts is brain.db's schema, which runs its own migrations; it is not part of vector.db. drizzle-kit has no
  // ignore option, so the brain is left out with an extglob.
  schema: ["./src/**/*.sql.ts", "./src/!(brain)/**/sql.ts"],
  out: "./migration",
  dbCredentials: {
    url: process.env.VECTOR_DRIZZLE_DB ?? path.join(os.tmpdir(), "vector-drizzle.db"),
  },
})
