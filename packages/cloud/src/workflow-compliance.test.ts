import { describe, expect, test } from "bun:test"

const root = new URL("../../..", import.meta.url).pathname
const read = (path: string) => Bun.file(`${root}/${path}`).text()

describe("release workflow supply-chain policy", () => {
  test("CLI publication requires protected-main ancestry and production approval", async () => {
    const workflow = await read(".github/workflows/vector-cli-release.yml")
    expect(workflow.match(/environment: production-release/g)?.length).toBeGreaterThanOrEqual(2)
    expect(workflow.match(/git merge-base --is-ancestor "\$VECTOR_SOURCE_REVISION" origin\/main/g)?.length).toBe(2)
    expect(workflow).toContain("fetch-depth: 0")
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02")
  })

  test("desktop publication consumes immutable workflow artifacts rather than draft assets", async () => {
    const workflow = await read(".github/workflows/vector-desktop-release.yml")
    expect(workflow).toContain("environment: production-release")
    expect(workflow).toContain('git merge-base --is-ancestor "$source_commit" origin/main')
    expect(workflow).not.toContain("gh release download")
    expect(workflow.match(/id: platform-artifact/g)).toHaveLength(3)
    expect(workflow.match(/artifact_digest:/g)).toHaveLength(3)
    expect(workflow.match(/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/g)?.length).toBeGreaterThanOrEqual(4)
    expect(workflow).toContain('if [ "$RELEASE_UNSIGNED" = "true" ]; then scope=downloads; fi')
    expect(workflow).toContain("Unsigned release $version entered automatic update feed $feed")
    expect(workflow).toContain('gh release edit "$TAG" --draft=false --prerelease=false --latest=false')
  })

  test("release actions and runner images are commit/version pinned", async () => {
    for (const path of [
      ".github/workflows/vector-cli-release.yml",
      ".github/workflows/vector-container-release.yml",
      ".github/workflows/vector-desktop-release.yml",
      ".github/workflows/vector-site-smoke.yml",
      ".github/workflows/vector-standalone-installers.yml",
      ".github/workflows/verify.yml",
    ]) {
      const workflow = await read(path)
      expect(workflow).not.toMatch(/runs-on: (?:ubuntu|macos|windows)-latest/)
      const actions = workflow
        .split("\n")
        .map((line) => line.match(/^\s*uses:\s*([^\s#]+)/)?.[1])
        .filter((value): value is string => typeof value === "string" && !value.startsWith("./"))
      expect(actions.filter((action) => !/@[a-f0-9]{40}$/.test(action))).toEqual([])
    }
  })

  test("cloud deploy verifies an exact Vercel CLI package", async () => {
    const script = await read("script/deploy-cloud.sh")
    expect(script).toContain("VERCEL_VERSION=48.8.0")
    expect(script).toContain("VERCEL_INTEGRITY='sha512-")
    expect(script).toContain('test "$actual_integrity" = "$VERCEL_INTEGRITY"')
    expect(script).not.toMatch(/npx --yes vercel(?:\s|$)/)
  })
})
