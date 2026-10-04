import { expect, test } from "bun:test"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { readRawBody, type ApiRequest, type ApiResponse } from "../api/_lib/http"
import handler from "../api/legacy-desktop-access"
import {
  legacyAccessProblem,
  oldClientHeaders,
  verifyLegacyDesktopAccess,
} from "../script/verify-legacy-desktop-access"

async function invoke(method: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {
        return this
      },
      end(value?: string) {
        resolve({ status: response.statusCode, body: value ? JSON.parse(value) : undefined })
        return this
      },
    } as unknown as ApiResponse
    void handler({ method } as ApiRequest, response).catch(reject)
  })
}

// Serves the real handler over HTTP. With a redirect status, every request is first sent elsewhere with it, the way
// an apex-to-www or trailing-slash redirect would be. Each request that reaches the handler is recorded under the path
// old builds call.
async function serveHandler(redirect?: number) {
  const received = new Map<string, { method?: string; headers: IncomingHttpHeaders; body: string }>()
  const server = createServer(async (request, response) => {
    if (redirect && !request.url?.startsWith("/moved/")) {
      response.writeHead(redirect, { location: `/moved${request.url}` })
      response.end()
      return
    }
    received.set(request.url?.replace(/^\/moved/, "") ?? "", {
      method: request.method,
      headers: request.headers,
      body: (await readRawBody(request)).toString("utf8"),
    })
    void handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, received, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

function answer(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } })
}

test("builds before 1.99.99 are told no licence is required", async () => {
  // 1.17.29 to 1.19.98 read only `available`; 1.99.2 and 1.99.8 read `licenseRequired ?? available`.
  expect(await invoke("GET")).toEqual({ status: 200, body: { available: false, licenseRequired: false } })
})

test("builds that activated a key keep access, including their offline grace", async () => {
  const result = await invoke("POST")
  expect(result.status).toBe(200)
  // They store this answer and keep their 7-day offline grace only while expiresAt is still ahead.
  expect(result.body).toMatchObject({ access: true, state: "beta", expiresAt: "2100-01-01T00:00:00.000Z" })
})

test("other methods are refused", async () => {
  expect((await invoke("PUT")).status).toBe(405)
})

test("the paths older builds call are routed to the handler", async () => {
  const config = await Bun.file(new URL("../vercel.json", import.meta.url)).json()
  for (const source of ["/api/billing/config", "/api/billing/status"])
    expect(config.rewrites).toContainEqual({ source, destination: "/api/legacy-desktop-access" })
})

test("the production check passes the handler's answers, also behind a redirect that keeps the method", async () => {
  // What every old build's fetch (undici) sends on both routes. An edge bot filter most likely keys on the user-agent,
  // so the check must send theirs. Over plain http undici offers no br.
  const headers = {
    accept: "*/*",
    "accept-encoding": "gzip, deflate",
    "accept-language": "*",
    "content-type": "application/json",
    "sec-fetch-mode": "cors",
    "user-agent": "node",
    "x-vector-version": expect.stringMatching(/^\d+\.\d+\.\d+$/),
  }
  for (const redirect of [undefined, 308]) {
    const served = await serveHandler(redirect)
    try {
      expect(await verifyLegacyDesktopAccess(served.origin)).toMatchObject([
        { path: "/api/billing/config", status: 200 },
        { path: "/api/billing/status", status: 200 },
      ])
      expect(served.received.get("/api/billing/config")).toMatchObject({ method: "GET", headers, body: "" })
      expect(served.received.get("/api/billing/status")).toMatchObject({ method: "POST", headers })
      // Activated builds send their stored token and device ID.
      expect(JSON.parse(served.received.get("/api/billing/status")?.body ?? "")).toEqual({
        activationToken: expect.any(String),
        deviceId: expect.any(String),
      })
    } finally {
      served.server.close()
    }
  }
})

test("the production check offers br only over https, as old builds' fetch does", () => {
  expect(oldClientHeaders("https://vectordev.ai")["accept-encoding"]).toBe("br, gzip, deflate")
  expect(oldClientHeaders("http://127.0.0.1:3000")["accept-encoding"]).toBe("gzip, deflate")
})

test("the production check fails when a redirect turns the status POST into a GET", async () => {
  // Old builds follow a 302 as a GET and read the config answer, which has no `access`.
  const served = await serveHandler(302)
  try {
    await expect(verifyLegacyDesktopAccess(served.origin)).rejects.toThrow("/api/billing/status")
  } finally {
    served.server.close()
  }
})

test("the production check accepts answers that open old builds", async () => {
  expect(await legacyAccessProblem("config", answer({ available: false, licenseRequired: false }))).toBeUndefined()
  expect(await legacyAccessProblem("config", answer({ available: false }))).toBeUndefined()
  expect(
    await legacyAccessProblem("status", answer({ access: true, state: "beta", expiresAt: "2100-01-01T00:00:00.000Z" })),
  ).toBeUndefined()
})

test("the production check fails answers that would wall old builds", async () => {
  // 1.17.29 to 1.19.98 read only `available`, so licenseRequired:false does not open them.
  expect(await legacyAccessProblem("config", answer({ available: true, licenseRequired: false }))).toContain("licence")
  expect(await legacyAccessProblem("config", answer({ licenseRequired: true }))).toContain("licence")
  expect(await legacyAccessProblem("config", answer(null))).toContain("JSON object")
  expect(await legacyAccessProblem("status", answer({ access: false, state: "expired" }))).toContain("licence")
  expect(await legacyAccessProblem("status", answer({ available: false, licenseRequired: false }))).toContain("licence")
  // Online this opens them, but an activated copy that later starts offline gets no grace.
  expect(await legacyAccessProblem("status", answer({ access: true, state: "beta" }))).toContain("expiresAt")
  expect(
    await legacyAccessProblem(
      "config",
      new Response("<html>Vercel Security Checkpoint</html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      }),
    ),
  ).toContain("429")
  expect(
    await legacyAccessProblem(
      "status",
      new Response("<!doctype html><title>Vector</title>", { headers: { "content-type": "text/html" } }),
    ),
  ).toContain("text/html")
})
