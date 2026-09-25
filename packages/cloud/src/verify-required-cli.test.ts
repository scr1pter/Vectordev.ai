import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { verifyRequiredCli } from "./verify-required-cli"

test("the desktop gate verifies the required version and every possible Linux artifact", async () => {
  const bytes = new TextEncoder().encode("synthetic archive bytes")
  const manifest = {
    schemaVersion: 1,
    version: "1.2.3",
    channel: "latest",
    publishedAt: "2026-09-25T00:00:00.000Z",
    sourceRevision: "a".repeat(40),
    catalogSha256: "b".repeat(64),
    targets: Object.fromEntries(
      CliRelease.targets.map((target) => [
        target,
        {
          filename: CliRelease.filename(target),
          pathname: CliRelease.archivePath("1.2.3", target),
          url: `https://fixture.public.blob.vercel-storage.com/${CliRelease.archivePath("1.2.3", target)}`,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ]),
    ),
  }
  const state = { mode: "valid", requests: [] as string[], redirects: [] as unknown[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      state.requests.push(new URL(request.url).pathname)
      if (new URL(request.url).pathname === "/api/cli-release") {
        expect(new URL(request.url).searchParams.get("version")).toBe("1.2.3")
        if (state.mode === "unpublished") return new Response(null, { status: 404 })
        if (state.mode === "large-manifest") return new Response(" ".repeat(CliRelease.MAX_MANIFEST_BYTES + 1))
        return Response.json(state.mode === "wrong-version" ? { ...manifest, version: "1.2.4" } : manifest)
      }
      if (state.mode === "missing") return new Response(null, { status: 404 })
      if (state.mode === "corrupt") return new Response(bytes.map((x) => x ^ 1))
      if (state.mode === "truncated") return new Response(bytes.slice(1))
      if (state.mode === "oversized") return new Response(new Uint8Array(bytes.byteLength + 1))
      if (state.mode === "redirect")
        return new Response(null, { status: 302, headers: { location: "https://example.test/forbidden" } })
      return new Response(bytes)
    },
  })
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
      expect(["vectordev.ai", "fixture.public.blob.vercel-storage.com"]).toContain(url.hostname)
      state.redirects.push(init?.redirect)
      return fetch(`${server.url.origin}${url.pathname}${url.search}`, init)
    },
    { preconnect: fetch.preconnect },
  )
  try {
    expect(await verifyRequiredCli("1.2.3", transport)).toEqual({
      version: "1.2.3",
      targets: CliRelease.targets.filter((target) => target.startsWith("linux-")),
    })
    expect(state.requests).toHaveLength(7)
    expect(state.requests.filter((path) => path.includes("vector-linux-"))).toHaveLength(6)
    expect(state.redirects.every((value) => value === "error")).toBe(true)
    for (const mode of [
      "unpublished",
      "large-manifest",
      "wrong-version",
      "missing",
      "corrupt",
      "truncated",
      "oversized",
      "redirect",
    ]) {
      state.mode = mode
      await expect(verifyRequiredCli("1.2.3", transport)).rejects.toThrow()
    }
  } finally {
    server.stop(true)
  }
})
