import { describe, expect, test } from "bun:test"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSettings } from "../../src/config/local-settings"

// The parts of a Vector Local change that need no config files: the user's block after a change, and why a change
// cannot apply under the policy in effect (a company lock, an address that is not a model server's, a service
// Vector Local never lets through). The Local API test covers writing, confirming and holding.

const NOW = 1_760_900_000_000
const on = (local: Parameters<typeof LocalPolicy.resolve>[0]["managed"] = {}) =>
  LocalPolicy.resolve({ managed: { enabled: true, ...local } })

describe("LocalSettings.block", () => {
  test("adds each item once, removes what it names, and keeps what the change leaves out", () => {
    const next = LocalSettings.block(
      {
        enabled: true,
        endpoints: ["http://127.0.0.1:11434"],
        web_domains: { deny: ["ads.example.com"] },
        checked: { "ollama/qwen": { checked_at: 1, result: "works" } },
      },
      {
        endpoints: { add: ["http://127.0.0.1:11434/v1", " http://10.0.0.5:8000/v1/chat/completions "] },
        web_domains: { allow: { add: ["docs.example.com"] }, deny: { remove: ["ads.example.com"] } },
      },
      "cli",
      NOW,
    )
    expect(next).toEqual({
      enabled: true,
      endpoints: ["http://127.0.0.1:11434", "http://10.0.0.5:8000"],
      web_domains: { allow: ["docs.example.com"], deny: [] },
      checked: { "ollama/qwen": { checked_at: 1, result: "works" } },
    })
  })

  test("stamps an allow entry, replaces an earlier one for the same source, and removes one by its source", () => {
    const first = LocalSettings.block(
      undefined,
      { allow: { add: [{ source: "github", hosts: [" GitHub.com "], reason: " Pull requests " }] } },
      "cli",
      NOW,
    )
    expect(first.allow).toEqual([
      { source: "github", hosts: ["github.com"], reason: "Pull requests", added_at: NOW, added_by: "cli" },
    ])
    const again = LocalSettings.block(
      first,
      { allow: { add: [{ source: "github", reason: "Reviews too" }] } },
      "app",
      NOW + 1,
    )
    expect(again.allow).toEqual([{ source: "github", reason: "Reviews too", added_at: NOW + 1, added_by: "app" }])
    expect(LocalSettings.block(again, { allow: { remove: ["github"] } }, "app", NOW).allow).toEqual([])
  })

  test("records a pin by origin and removes one set to null", () => {
    const pin = { kind: "ollama", version: "0.12.6", models: "sha256:abc" }
    const pinned = LocalSettings.block(undefined, { pins: { "http://127.0.0.1:11434/v1": pin } }, "app", NOW)
    expect(pinned.pins).toEqual({ "http://127.0.0.1:11434": pin })
    // The config writer drops a pin set to undefined.
    const unpinned = LocalSettings.block(pinned, { pins: { "http://127.0.0.1:11434": null } }, "app", NOW)
    expect(Object.entries(unpinned.pins ?? {}).filter(([, value]) => value !== undefined)).toEqual([])
    expect(Object.keys(unpinned.pins ?? {})).toEqual(["http://127.0.0.1:11434"])
  })
})

describe("LocalSettings.validate", () => {
  test("under a company lock, a key the company keeps does not change, but the user may remove and tighten", () => {
    const policy = on({ lock: true, user_may: ["web"], web: "ask" })
    expect(LocalSettings.locked(policy)).toEqual(["enabled", "endpoints", "allow", "web_domains"])
    for (const change of [
      { enabled: false },
      { endpoints: { add: ["http://127.0.0.1:11434"] } },
      { allow: { add: [{ source: "github", reason: "PRs" }] } },
      { web_domains: { allow: { add: ["docs.example.com"] } } },
    ])
      expect(LocalSettings.validate(policy, change)).toMatchObject({ type: "refused", reason: "locked" })
    expect(LocalSettings.validate(policy, { web: "none" })).toBeUndefined()
    expect(LocalSettings.validate(on({ lock: true, user_may: ["web"], web: "network" }), { web: "ask" })).toMatchObject(
      { reason: "locked", message: expect.stringContaining("stricter only") },
    )
    // Web access the company keeps cannot be set at all, even stricter: the policy would not read it.
    expect(LocalSettings.validate(on({ lock: true }), { web: "none" })).toMatchObject({ reason: "locked" })
    expect(LocalSettings.validate(policy, { endpoints: { remove: ["http://127.0.0.1:11434"] } })).toBeUndefined()
  })

  test("under a lock with endpoint patterns, a user's server must match one", () => {
    const policy = on({ lock: true, user_may: ["endpoints"], endpoint_domains: ["*.ml.corp.example.com"] })
    expect(LocalSettings.validate(policy, { endpoints: { add: ["https://gpu.ml.corp.example.com"] } })).toBeUndefined()
    expect(LocalSettings.validate(policy, { endpoints: { add: ["https://gpu.example.org"] } })).toMatchObject({
      reason: "invalid",
    })
  })

  test("refuses services Vector Local never lets through and requests it does not make", () => {
    const policy = on()
    expect(
      LocalSettings.validate(policy, { allow: { add: [{ source: "vector-free-models", reason: "Cheaper" }] } }),
    ).toMatchObject({
      reason: "invalid",
      message: expect.stringContaining("keeps it off"),
    })
    expect(
      LocalSettings.validate(policy, { allow: { add: [{ source: "agent-programs", reason: "x" }] } }),
    ).toMatchObject({
      reason: "invalid",
    })
    expect(
      LocalSettings.validate(policy, {
        allow: { add: [{ source: "github", hosts: ["https://github.com"], reason: "PRs" }] },
      }),
    ).toMatchObject({ reason: "invalid", message: expect.stringContaining("is not a host name") })
    expect(LocalSettings.validate(policy, { allow: { add: [{ source: "github", reason: "PRs" }] } })).toBeUndefined()
  })
})

describe("LocalSettings.freeID", () => {
  test("names a server's provider after its kind, numbered when that name is taken or is a catalog provider's", () => {
    expect(LocalSettings.freeID("ollama", [])).toBe("ollama")
    expect(LocalSettings.freeID("ollama", ["ollama", "ollama-2"])).toBe("ollama-3")
    // lmstudio is the catalog's own LM Studio provider, so a server added by hand never merges into it.
    expect(LocalSettings.freeID("lmstudio", [])).toBe("lmstudio-2")
  })
})
