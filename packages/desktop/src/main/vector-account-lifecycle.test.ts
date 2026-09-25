import { expect, test } from "bun:test"
import { createManagedAccountLifecycle } from "./vector-account-lifecycle"

test("managed account cleanup unregisters only its own callback and awaits lifecycle completion", async () => {
  const lifecycle = createManagedAccountLifecycle()
  const events: string[] = []
  const old = lifecycle.register(async () => {
    events.push("old")
  })
  const release = Promise.withResolvers<void>()
  const unregister = lifecycle.register(async (token, synchronize) => {
    events.push(token ?? "logout")
    await release.promise
    await synchronize()
  })
  old()
  const sync = lifecycle.sync("vct_synthetic", async () => {
    events.push("embedded")
  })
  expect(events).toEqual(["vct_synthetic"])
  release.resolve()
  await sync
  expect(events).toEqual(["vct_synthetic", "embedded"])
  unregister()
  await lifecycle.sync(undefined, async () => {
    events.push("fallback")
  })
  expect(events).toEqual(["vct_synthetic", "embedded", "fallback"])
})
