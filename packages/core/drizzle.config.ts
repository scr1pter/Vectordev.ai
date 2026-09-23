import { defineConfig } from "drizzle-kit"
import path from "node:path"
import { Global } from "./src/global"

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration",
  dbCredentials: {
    url: path.join(Global.Path.data, "vector.db"),
  },
})
