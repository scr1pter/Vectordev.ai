import { expect, test } from "bun:test"
import type { UpdaterState } from "@vectordevai/app/updater"
import { subscribeUpdater } from "./updater-state"

test("the window starts on the state the desktop pushes when it subscribes, not on a placeholder", async () => {
  const updater = subscribeUpdater(async (callback) => callback({ status: "ready", version: "1.99.110" }))
  expect(await updater.settled).toEqual({ status: "ready", version: "1.99.110" })
  expect(updater.state()).toEqual({ status: "ready", version: "1.99.110" })
})

test("later pushes still reach the window", async () => {
  let push: (state: UpdaterState) => void = () => undefined
  const updater = subscribeUpdater(async (callback) => {
    push = callback
    callback({ status: "idle" })
  })
  await updater.settled
  push({ status: "downloading", version: "1.99.110" })
  expect(updater.state()).toEqual({ status: "downloading", version: "1.99.110" })
})

test("a bridge that never answers, or fails, does not hold the window back", async () => {
  const silent = subscribeUpdater(() => new Promise(() => undefined), 20)
  expect(await silent.settled).toEqual({ status: "disabled" })
  const failing = subscribeUpdater(() => Promise.reject(new Error("No handler registered for 'updater-subscribe'")))
  expect(await failing.settled).toEqual({ status: "disabled" })
})
