import { describe, expect, test } from "bun:test"
import { formatTrustStatus, trustDecision } from "@/cli/cmd/trust"

describe("vector trust", () => {
  test("only the explicit approve action requests approval", () => {
    expect(trustDecision("status", false)).toEqual({ approve: false })
    expect(trustDecision("approve", false)).toEqual({ approve: true })
  })

  test("pure mode rejects approval", () => {
    expect(trustDecision("approve", true)).toEqual({
      approve: false,
      error: "Cannot approve workspace trust while --pure is active. Rerun without --pure.",
    })
  })

  test("formats canonical workspace, fingerprint, status, and reload guidance", () => {
    expect(
      formatTrustStatus(
        { workspace: "/canonical/workspace", fingerprint: "abc123", trusted: true },
        true,
        false,
      ),
    ).toBe(
      [
        "Workspace: /canonical/workspace",
        "Fingerprint: abc123",
        "Status: trusted",
        "Trust approved. Rerun the command or restart Vector to load trusted executable repository config.",
      ].join("\n"),
    )
  })

  test("shows when pure mode disables executable repository config", () => {
    expect(
      formatTrustStatus({ workspace: "/workspace", fingerprint: "def456", trusted: false }, false, true),
    ).toContain("Executable repository config: disabled by --pure")
  })
})
