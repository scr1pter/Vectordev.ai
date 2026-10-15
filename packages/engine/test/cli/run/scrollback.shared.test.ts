import { expect, test } from "bun:test"
import { entryLook } from "@/cli/cmd/run/scrollback.shared"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"

test("a spend guard stop uses the warning colour and other errors keep the error colour", () => {
  const error = { kind: "error", text: "boom", phase: "start", source: "system" } as const
  expect(entryLook({ ...error, text: "Stopped: Step limit reached.", stopped: true }, RUN_THEME_FALLBACK.entry).fg).toBe(
    RUN_THEME_FALLBACK.entry.warning.body,
  )
  expect(entryLook(error, RUN_THEME_FALLBACK.entry).fg).toBe(RUN_THEME_FALLBACK.entry.error.body)
})
