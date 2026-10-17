import { describe, expect, test } from "bun:test"
import { projectTrustAnswer, projectTrustPrompt, projectTrustRecord } from "./project-trust-policy"

const ignored = { ignored: true, settings: true }

describe("projectTrustPrompt", () => {
  test("asks the first time a project's own settings are ignored", () => {
    expect(projectTrustPrompt(ignored, undefined)).toBe("ask")
  })

  test("never asks again after Not now", () => {
    expect(projectTrustPrompt(ignored, "dismissed")).toBeUndefined()
  })

  test("asks again when a trusted project's settings changed", () => {
    expect(projectTrustPrompt(ignored, "trusted")).toBe("changed")
  })

  test("never asks for a project with no Vector settings of its own", () => {
    // `ignored` alone means only the user's own language servers, formatters and MCP servers are held back.
    expect(projectTrustPrompt({ ignored: true, settings: false }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ignored: false, settings: false }, undefined)).toBeUndefined()
  })

  test("never asks for a trusted project", () => {
    expect(projectTrustPrompt({ ignored: false, settings: true }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ignored: false, settings: true }, "trusted")).toBeUndefined()
  })

  test("never asks while the status is unknown", () => {
    expect(projectTrustPrompt(undefined, undefined)).toBeUndefined()
  })
})

describe("projectTrustRecord", () => {
  test("remembers a project the engine trusts, replacing an earlier Not now", () => {
    expect(projectTrustRecord({ trusted: true }, undefined)).toBe("trusted")
    expect(projectTrustRecord({ trusted: true }, "dismissed")).toBe("trusted")
  })

  test("keeps the answer while the project is not trusted", () => {
    expect(projectTrustRecord({ trusted: false }, undefined)).toBeUndefined()
    expect(projectTrustRecord({ trusted: false }, "dismissed")).toBe("dismissed")
    expect(projectTrustRecord({ trusted: false }, "trusted")).toBe("trusted")
  })

  test("a Not now followed by trust from Settings asks again once the settings change", () => {
    const answer = projectTrustRecord({ trusted: true }, "dismissed")
    expect(projectTrustPrompt(ignored, answer)).toBe("changed")
  })
})

describe("projectTrustAnswer", () => {
  test("reads only the answers the app writes", () => {
    expect(projectTrustAnswer("trusted")).toBe("trusted")
    expect(projectTrustAnswer("dismissed")).toBe("dismissed")
    expect(projectTrustAnswer("yes")).toBeUndefined()
    expect(projectTrustAnswer(true)).toBeUndefined()
    expect(projectTrustAnswer(undefined)).toBeUndefined()
  })
})
