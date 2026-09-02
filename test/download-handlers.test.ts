import { describe, expect, test } from "bun:test"
import { handleBillingDownload } from "../api/billing/download"
import { handleDownloadChecksums } from "../api/download-checksums"
import { installerFromManifest, parseDownloadManifest, PUBLIC_DOWNLOAD_TARGETS } from "../api/_lib/downloads"
import { ApiError, type ApiRequest, type ApiResponse } from "../api/_lib/http"
import { handleDownload, requireDownloadAccess } from "../api/download"

const version = "1.19.98"
const manifest = parseDownloadManifest({
  schemaVersion: 1,
  version,
  channel: "latest",
  publishedAt: "2026-08-28T12:00:00.000Z",
  targets: Object.fromEntries(
    Object.entries(PUBLIC_DOWNLOAD_TARGETS).map(([target, filename]) => [
      target,
      {
        filename,
        pathname: `releases/vector-v${version}/${filename}`,
        url: `https://vector.public.blob.vercel-storage.com/releases/vector-v${version}/${filename}`,
        size: 123_456,
        sha256: "a".repeat(64),
        verification: "release-workflow",
      },
    ]),
  ),
})

function currentInstaller(target: string | undefined) {
  return Promise.resolve({ manifest, installer: installerFromManifest(manifest, target) })
}

async function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  request: Partial<ApiRequest>,
) {
  return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value)
        return this
      },
      end(value?: string) {
        let body: unknown
        try {
          body = value ? JSON.parse(value) : undefined
        } catch {
          body = value
        }
        resolve({ status: this.statusCode, headers, body })
        return this
      },
    } as unknown as ApiResponse
    void handler(request as ApiRequest, response).catch(reject)
  })
}

describe("public installer handler", () => {
  const authenticate = () => Promise.resolve({ id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb", email: "user@example.com" })

  test("returns the exact immutable installer with release evidence to a signed-in account", async () => {
    const result = await invoke(
      (request, response) => handleDownload(request, response, currentInstaller, authenticate),
      {
        method: "GET",
        query: { target: "mac-arm64" },
        headers: { accept: "application/json" },
      },
    )

    expect(result.status).toBe(200)
    expect(result.headers).toMatchObject({
      "cache-control": "no-store",
      "x-vector-release": version,
      "x-vector-sha256": "a".repeat(64),
    })
    expect(result.body).toMatchObject({
      url: "https://vector.public.blob.vercel-storage.com/releases/vector-v1.19.98/vector-desktop-mac-arm64.dmg",
      version,
    })
  })

  test("requires a verified account before resolving an installer", async () => {
    const result = await invoke(
      (request, response) =>
        handleDownload(request, response, currentInstaller, () =>
          Promise.reject(new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue.")),
        ),
      { method: "GET", headers: { accept: "application/json" } },
    )
    expect(result.status).toBe(401)
    expect(result.body).toEqual({ error: { code: "SIGN_IN_REQUIRED", message: "Sign in to continue." } })
  })

  test("rejects an invalid target before returning a release", async () => {
    const result = await invoke(
      (request, response) => handleDownload(request, response, currentInstaller, authenticate),
      {
        method: "GET",
        query: { target: "mac-m5" },
        headers: {},
      },
    )

    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ error: { code: "DOWNLOAD_NOT_FOUND" } })
  })

  test("fails closed when the release manifest cannot be loaded", async () => {
    const result = await invoke(
      (request, response) =>
        handleDownload(
          request,
          response,
          () => Promise.reject(new ApiError(503, "DOWNLOAD_MANIFEST_MISSING", "No verified release.")),
          authenticate,
        ),
      { method: "GET", query: { target: "linux-x64" }, headers: {} },
    )

    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: { code: "DOWNLOAD_MANIFEST_MISSING", message: "No verified release." } })
  })
})

describe("installer account entitlement", () => {
  test("keeps every confirmed account eligible during free beta", async () => {
    let checkedBilling = false
    const account = await requireDownloadAccess(
      { headers: {} },
      () => Promise.resolve({ id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb", email: "user@example.com" }),
      () => {
        checkedBilling = true
        return Promise.resolve(undefined)
      },
      () => ({ available: false, licenseRequired: false }),
    )

    expect(account.email).toBe("user@example.com")
    expect(checkedBilling).toBe(false)
  })

  test("fails closed when paid access is selected without production billing", async () => {
    await expect(
      requireDownloadAccess(
        { headers: {} },
        () => Promise.resolve({ id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb", email: "user@example.com" }),
        () => Promise.resolve(undefined),
        () => ({ available: false, licenseRequired: true }),
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "PAID_ACCESS_NOT_CONFIGURED" })
  })
})

describe("download checksum handler", () => {
  test("redirects to checksums from the same immutable release", async () => {
    const result = await invoke(
      (request, response) => handleDownloadChecksums(request, response, () => Promise.resolve(manifest)),
      { method: "GET", headers: {} },
    )

    expect(result.status).toBe(307)
    expect(result.headers).toMatchObject({
      location: "https://vector.public.blob.vercel-storage.com/releases/vector-v1.19.98/checksums.txt",
      "cache-control": "no-store",
      "x-vector-release": version,
    })
  })
})

describe("licensed installer handler", () => {
  test("validates entitlement and uses the same public release", async () => {
    let entitlementChecked = false
    const result = await invoke(
      (request, response) =>
        handleBillingDownload(request, response, {
          consumeDownload: async (token, target) => {
            entitlementChecked = token === "license-download" && target === "windows-x64"
            return { file: PUBLIC_DOWNLOAD_TARGETS[target] }
          },
          currentInstaller,
        }),
      { method: "GET", query: { token: "license-download", target: "windows-x64" }, headers: {} },
    )

    expect(entitlementChecked).toBe(true)
    expect(result.status).toBe(307)
    expect(result.headers.location).toEndWith("/releases/vector-v1.19.98/vector-desktop-win-x64.exe")
    expect(result.headers["x-vector-release"]).toBe(version)
  })
})
