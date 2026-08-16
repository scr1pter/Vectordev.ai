import { describe, expect, test } from "bun:test"
import { EXTERNAL_RUNTIMES, externalRuntimeSetup, isExternalRuntime, setupSteps } from "./external-runtimes"

describe("external runtimes", () => {
  test("covers exactly the three runtimes Vector can drive", () => {
    expect(Object.keys(EXTERNAL_RUNTIMES).sort()).toEqual(["claude-code", "codex", "cursor"])
  })

  test("every runtime has a real install command and docs link", () => {
    for (const setup of Object.values(EXTERNAL_RUNTIMES)) {
      expect(setup.installCommand.length).toBeGreaterThan(5)
      expect(setup.docsUrl.startsWith("https://")).toBe(true)
      expect(setup.cli).toBeTruthy()
    }
  })

  test("the cli name matches what the desktop detector probes for", () => {
    // These strings must stay in step with CANDIDATES in main/external-agents.ts,
    // otherwise the picker reports "Setup needed" for an installed runtime.
    expect(EXTERNAL_RUNTIMES["claude-code"].cli).toBe("claude")
    expect(EXTERNAL_RUNTIMES.codex.cli).toBe("codex")
    expect(EXTERNAL_RUNTIMES.cursor.cli).toBe("cursor-agent")
  })

  test("isExternalRuntime accepts only the three, never vector", () => {
    expect(isExternalRuntime("codex")).toBe(true)
    expect(isExternalRuntime("vector")).toBe(false)
    expect(isExternalRuntime("nonsense")).toBe(false)
  })

  test("externalRuntimeSetup returns undefined for vector", () => {
    expect(externalRuntimeSetup("vector")).toBeUndefined()
    expect(externalRuntimeSetup("cursor")?.label).toBe("Cursor Agent")
  })

  test("setup steps lead with install and include sign-in", () => {
    const steps = setupSteps("claude-code")
    expect(steps[0]!.label).toBe("Install")
    expect(steps.map((step) => step.label)).toContain("Sign in")
  })
})
