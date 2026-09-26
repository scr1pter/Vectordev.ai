import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  activateOAuthApproval,
  activeOAuthApproval,
  approvalFile,
  approvalValid,
  borrowedOAuthPlugin,
  confirmOAuthPluginLoad,
  inspectOAuthPlugin,
  inspectOAuthPluginForLoad,
  pluginCredentialMetadata,
  readOAuthApprovals,
  requirePluginAuthorization,
  requirePluginDestination,
  revokeOAuthApproval,
  writeOAuthApproval,
} from "../../src/plugin/oauth-approval"
import {
  COPILOT_SIGN_IN,
  providerCredentialAllowed,
  providerEnabled,
  providerEnvironmentAllowed,
  providerUsable,
} from "../../src/provider-policy"

const directories: string[] = []
const releases: (() => void)[] = []
afterEach(() => {
  releases.splice(0).forEach((release) => release())
  readOAuthApprovals().forEach((value) => revokeOAuthApproval(value.id))
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vector-plugin-consent-"))
  directories.push(root)
  const entry = path.join(root, "index.js")
  writeFileSync(entry, "export default {}\n")
  writeFileSync(path.join(root, "helper.js"), "export const value = 1\n")
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@example/owned-auth",
      version: "1.2.3",
      type: "module",
      vectorOAuth: [
        {
          provider: "github-copilot",
          clientId: "example-owned-client",
          issuer: "https://identity.example",
          apiOrigins: ["https://inference.example"],
        },
      ],
      ...overrides,
    }),
  )
  return { root, entry, approval: () => inspectOAuthPlugin(entry)[0] }
}
test("exact package content, entry, client and provider require separate explicit global consent", () => {
  const value = fixture()
  const approval = value.approval()
  expect(approvalValid(approval)).toBe(false)
  expect(providerEnabled("github-copilot")).toBe(false)
  expect(providerUsable("github-copilot", { options: { vectorOAuthPlugin: "f".repeat(64) } })).toBe(false)
  writeOAuthApproval(approval)
  expect(readOAuthApprovals()).toEqual([approval])
  expect(statSync(approvalFile()).mode & 0o777).toBe(0o600)
  expect(providerEnabled("github-copilot")).toBe(false)
  releases.push(activateOAuthApproval(approval))
  expect(providerEnabled("github-copilot")).toBe(true)
  expect(COPILOT_SIGN_IN).toBe(false)
  expect(providerEnvironmentAllowed("github-copilot")).toBe(false)
  const credential = { type: "oauth", metadata: pluginCredentialMetadata(approval) }
  expect(providerCredentialAllowed("github-copilot", credential)).toBe(true)
  expect(providerCredentialAllowed("github-copilot", { type: "oauth" })).toBe(false)
  expect(providerCredentialAllowed("github-copilot", { type: "api" })).toBe(false)
  expect(providerCredentialAllowed("xai", credential)).toBe(false)
  expect(
    providerCredentialAllowed("github-copilot", {
      ...credential,
      metadata: { ...credential.metadata, oauth_client_id: "other-client" },
    }),
  ).toBe(false)
  writeFileSync(path.join(value.root, "helper.js"), "export const value = 2\n")
  expect(approvalValid(value.approval())).toBe(false)
  expect(() => writeOAuthApproval(approval)).toThrow("content changed")
  revokeOAuthApproval(approval.id)
  expect(providerCredentialAllowed("github-copilot", credential)).toBe(false)
  expect(activeOAuthApproval("github-copilot")).toBeUndefined()
})
test("reusing a loaded entry for changed plugin content requires a restart", () => {
  const value = fixture()
  const before = inspectOAuthPluginForLoad(value.entry)
  writeFileSync(value.entry, "export default { changed: true }\n")
  expect(() => confirmOAuthPluginLoad(before)).toThrow("content changed while loading")
  expect(() => inspectOAuthPluginForLoad(value.entry)).toThrow("Restart Vector")
})
test("rejects known borrowed names in package manifests even through a renamed path", () => {
  for (const name of ["example-openai-codex-auth", "@example/custom-copilot-auth", "EXAMPLE-COPILOT-AUTH"]) {
    expect(borrowedOAuthPlugin(name)).toBe(true)
    expect(borrowedOAuthPlugin(`${name}@1.2.3`)).toBe(true)
    expect(() => fixture({ name }).approval()).toThrow("borrowed-client")
  }
  expect(borrowedOAuthPlugin("@example/owned-auth")).toBe(false)
})
test("declarations reject ambiguous, non-HTTPS, credential-bearing and duplicate provider origins", () => {
  for (const patch of [
    { issuer: "http://identity.example" },
    { issuer: "https://identity.example/path" },
    { issuer: "https://name:pass@identity.example" },
    { apiOrigins: ["https://inference.example/"] },
    { clientId: "short" },
    { provider: "invalid/provider" },
  ]) {
    expect(() =>
      fixture({
        vectorOAuth: [
          {
            provider: "xai",
            clientId: "example-client",
            issuer: "https://identity.example",
            apiOrigins: ["https://inference.example"],
            ...patch,
          },
        ],
      }).approval(),
    ).toThrow()
  }
  const declaration = fixture().approval().declaration
  expect(() => fixture({ vectorOAuth: [declaration, declaration] }).approval()).toThrow("only one")
})
test("enforces declared issuer, client, API origins and immediate revocation", () => {
  const approval = fixture().approval()
  writeOAuthApproval(approval)
  expect(() =>
    requirePluginAuthorization(approval, { url: "https://identity.example/authorize?client_id=example-owned-client" }),
  ).not.toThrow()
  for (const url of [
    "https://elsewhere.example/authorize",
    "https://identity.example/authorize?client_id=other",
    "https://identity.example/authorize?client_id=example-owned-client&client_id=other",
    "https://name:pass@identity.example/authorize",
  ])
    expect(() => requirePluginAuthorization(approval, { url })).toThrow()
  expect(() => requirePluginDestination(approval, "https://inference.example/v1/chat")).not.toThrow()
  for (const url of [
    "http://inference.example/v1/chat",
    "https://elsewhere.example/v1/chat",
    "https://name:pass@inference.example/v1/chat",
  ])
    expect(() => requirePluginDestination(approval, url)).toThrow()
  revokeOAuthApproval(approval.id)
  expect(() => requirePluginDestination(approval, "https://inference.example/v1/chat")).toThrow("revoked")
})
test("refuses symlinked plugin content, replaced manifests and non-private approval stores", () => {
  const value = fixture()
  const approval = value.approval()
  symlinkSync(value.entry, path.join(value.root, "linked.js"))
  expect(() => value.approval()).toThrow("symlinks")
  rmSync(path.join(value.root, "linked.js"))
  writeOAuthApproval(approval)
  const text = readFileSync(approvalFile(), "utf8")
  chmodSync(approvalFile(), 0o644)
  expect(readOAuthApprovals()).toEqual([])
  chmodSync(approvalFile(), 0o600)
  expect(readOAuthApprovals()).toHaveLength(1)
  rmSync(approvalFile())
  const target = path.join(value.root, "approvals.json")
  writeFileSync(target, text, { mode: 0o600 })
  symlinkSync(target, approvalFile())
  expect(readOAuthApprovals()).toEqual([])
  expect(() => writeOAuthApproval(value.approval())).toThrow("non-regular")
  rmSync(approvalFile())
})
