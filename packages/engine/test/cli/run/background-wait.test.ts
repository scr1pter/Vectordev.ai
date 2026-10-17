import { expect, test } from "bun:test"
import { nextBackgroundEvent } from "@/cli/cmd/run/background-wait"

test("background wait expires even when an event stream goes silent", async () => {
  const pending = Promise.withResolvers<IteratorResult<string>>()
  expect(await nextBackgroundEvent({ next: () => pending.promise }, 10)).toEqual({ timedOut: true })
  pending.resolve({ value: "late event", done: false })
})

test("an event wins without waiting out the background timeout", async () => {
  const pending = Promise.withResolvers<IteratorResult<string>>()
  const result = nextBackgroundEvent({ next: () => pending.promise }, 10_000)
  pending.resolve({ value: "completed", done: false })
  expect(await result).toEqual({ timedOut: false, event: { value: "completed", done: false } })
})

test("a normal end and unbounded active provider stream preserve their result", async () => {
  expect(await nextBackgroundEvent({ next: async () => ({ value: undefined, done: true }) })).toEqual({
    timedOut: false,
    event: { value: undefined, done: true },
  })
})
