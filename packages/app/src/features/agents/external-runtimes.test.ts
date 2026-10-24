import { describe, expect, test } from "bun:test"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import {
  EXTERNAL_RUNTIME_IDS,
  EXTERNAL_RUNTIMES,
  externalRuntimeReady,
  externalRuntimeSetup,
  isExternalRuntime,
} from "./external-runtimes"

describe("external runtimes", () => {
  test("covers the catalog's chat agents, in its order, and no terminal-only one", () => {
    const chat = ExternalAgent.catalog.filter((agent) => agent.tier === "chat").map((agent) => agent.id)
    expect(EXTERNAL_RUNTIME_IDS).toEqual(chat)
    expect(Object.keys(EXTERNAL_RUNTIMES).sort()).toEqual([...chat].sort())
    expect(EXTERNAL_RUNTIME_IDS).toEqual(expect.arrayContaining(["claude-code", "codex", "cursor"]))
    for (const agent of ExternalAgent.catalog.filter((entry) => entry.tier === "terminal"))
      expect(isExternalRuntime(agent.id)).toBe(false)
  })

  test("each runtime is labelled with the catalog's name", () => {
    for (const id of EXTERNAL_RUNTIME_IDS) expect(EXTERNAL_RUNTIMES[id].label).toBe(ExternalAgent.find(id)!.name)
  })

  test("isExternalRuntime accepts the chat agents, never vector", () => {
    expect(isExternalRuntime("codex")).toBe(true)
    expect(isExternalRuntime("vector")).toBe(false)
    expect(isExternalRuntime("nonsense")).toBe(false)
  })

  test("externalRuntimeSetup returns undefined for vector", () => {
    expect(externalRuntimeSetup("vector")).toBeUndefined()
    expect(externalRuntimeSetup("cursor")?.label).toBe("Cursor CLI")
  })

  test("an installed but explicitly signed-out runtime is not ready", () => {
    expect(externalRuntimeReady({ installed: true, signedIn: true })).toBe(true)
    expect(externalRuntimeReady({ installed: true })).toBe(true)
    expect(externalRuntimeReady({ installed: true, signedIn: false })).toBe(false)
    expect(externalRuntimeReady({ installed: false, signedIn: true })).toBe(false)
    expect(externalRuntimeReady(undefined)).toBe(false)
  })
})
