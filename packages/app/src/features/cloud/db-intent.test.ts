import { describe, expect, test } from "bun:test"
import { DATABASE_SETUP_PROMPT, deployRepairPrompt } from "./cloud-handoff"
import { detectDatabaseIntent } from "./db-intent"

describe("database intent", () => {
  test("proposes a database for auth and data work", () => {
    expect(detectDatabaseIntent("add sign up and login with email")).toEqual({ matched: true, reason: "auth" })
    expect(detectDatabaseIntent("store the user profiles in Supabase")).toEqual({ matched: true, reason: "database" })
    expect(detectDatabaseIntent("make the header sticky")).toEqual({ matched: false })
  })

  test("stays quiet for prompts that already send the agent to Vector Cloud", () => {
    expect(detectDatabaseIntent(DATABASE_SETUP_PROMPT)).toEqual({ matched: false })
    expect(
      detectDatabaseIntent(
        deployRepairPrompt({
          project: "shop",
          error: "Supabase client failed to load.",
          checks: [
            { label: "Production build", status: "failed", output: "Cannot find module '@supabase/supabase-js'" },
          ],
        }),
      ),
    ).toEqual({ matched: false })
  })
})
