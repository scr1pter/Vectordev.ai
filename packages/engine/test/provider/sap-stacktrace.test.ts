import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { types } from "node:util"

test("SAP redirect errors remain native Errors after TUI stack formatting is installed", async () => {
  await import("../../src/config/tui")
  const sdk = createRequire(import.meta.resolve("@jerome-benoit/sap-ai-provider"))
  const orchestration = createRequire(sdk.resolve("@sap-ai-sdk/orchestration"))
  const client = createRequire(orchestration.resolve("@sap-cloud-sdk/http-client"))
  const axios = createRequire(client.resolve("axios"))
  const redirects = axios("follow-redirects") as { http: typeof import("node:http") }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response(null, { status: 302, headers: { location: request.url } }),
  })
  const cause = new Error("fixture redirect rejected")
  try {
    for (const beforeRedirect of [
      undefined,
      () => {
        throw cause
      },
    ]) {
      const options = { method: "GET", maxRedirects: 1, beforeRedirect, timeout: 1_000 }
      const error = await new Promise<Error>((resolve, reject) => {
        const request = redirects.http.get(server.url, options, (response) => {
          response.resume()
          reject(new Error("Expected redirect failure"))
        })
        request.once("error", resolve)
        request.once("timeout", () => request.destroy(new Error("Fixture request timed out")))
      })
      expect(error).toBeInstanceOf(Error)
      expect(types.isNativeError(error)).toBe(true)
      expect(error).toMatchObject({
        code: beforeRedirect ? "ERR_FR_REDIRECTION_FAILURE" : "ERR_FR_TOO_MANY_REDIRECTS",
        name: beforeRedirect ? "Error [ERR_FR_REDIRECTION_FAILURE]" : "Error [ERR_FR_TOO_MANY_REDIRECTS]",
        message: beforeRedirect
          ? "Redirected request failed: fixture redirect rejected"
          : "Maximum number of redirects exceeded",
      })
      expect(error.stack).toContain(error.message)
      expect(Object.getOwnPropertyDescriptor(error, "stack")?.enumerable).toBe(false)
      expect(Object.getOwnPropertyDescriptor(error, "code")).toMatchObject({
        enumerable: true,
        writable: true,
        configurable: true,
      })
      if (beforeRedirect) {
        expect(error.cause).toBe(cause)
        expect(Object.getOwnPropertyDescriptor(error, "cause")).toEqual({
          value: cause,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    const invalid = (() => {
      try {
        redirects.http.get({ hostname: "[invalid]" })
      } catch (error) {
        return error
      }
    })()
    expect(invalid).toBeInstanceOf(TypeError)
    expect(types.isNativeError(invalid)).toBe(true)
    expect(invalid).toMatchObject({
      name: "Error [ERR_INVALID_URL]",
      code: "ERR_INVALID_URL",
      message: "Invalid URL",
      input: { hostname: "[invalid]" },
    })
  } finally {
    await server.stop(true)
  }
})
