import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLicenseService } from "./license-service"

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vector-license-"))
  roots.push(root)
  return root
}

async function licensingServer(input: { available: boolean; fail?: boolean; edge?: boolean }) {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    // A CDN or firewall answering instead of the API, like Vercel's Security Checkpoint.
    if (input.edge) {
      response.statusCode = 403
      response.setHeader("content-type", "text/html; charset=utf-8")
      response.end("<!doctype html><title>Vercel Security Checkpoint</title>")
      return
    }
    if (input.fail) {
      response.statusCode = 503
      response.end(JSON.stringify({ error: { code: "OFFLINE", message: "Licensing unavailable." } }))
      return
    }
    if (request.url === "/config") {
      response.end(JSON.stringify({ available: input.available }))
      return
    }
    if (request.url === "/activate") {
      response.end(
        JSON.stringify({
          activationToken: "VAT1.test.activation",
          status: {
            access: true,
            state: "active",
            email: "buyer@example.com",
            expiresAt: "2027-08-04T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            deviceName: "Test computer",
            lastFour: "ABCD",
            offlineGraceDays: 7,
          },
        }),
      )
      return
    }
    if (request.url === "/status") {
      response.end(
        JSON.stringify({
          access: true,
          state: "active",
          email: "buyer@example.com",
          expiresAt: "2027-08-04T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          deviceName: "Test computer",
          lastFour: "ABCD",
          offlineGraceDays: 7,
        }),
      )
      return
    }
    if (request.url === "/deactivate") {
      response.end(JSON.stringify({ deactivated: true }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test licensing server did not start.")
  return `http://127.0.0.1:${address.port}`
}

describe("desktop license service", () => {
  test("keeps development builds accessible without a purchase", async () => {
    const service = createLicenseService({
      userDataPath: await temporaryRoot(),
      version: "1.17.29",
      packaged: false,
      channel: "dev",
      apiUrl: "http://127.0.0.1:1",
    })

    expect(await service.status()).toMatchObject({ access: true, state: "development" })
  })

  test("keeps packaged builds in public beta until paid launch is configured", async () => {
    const service = createLicenseService({
      userDataPath: await temporaryRoot(),
      version: "1.17.29",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: false }),
    })

    expect(await service.status()).toMatchObject({ access: true, state: "beta" })
  })

  test("fails closed when licensing should be available but cannot be verified", async () => {
    const service = createLicenseService({
      userDataPath: await temporaryRoot(),
      version: "1.17.29",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: true, fail: true }),
    })

    expect(await service.status()).toMatchObject({ access: false, state: "offline" })
  })

  test("stores activation locally with owner-only permissions and removes it on deactivation", async () => {
    const root = await temporaryRoot()
    const service = createLicenseService({
      userDataPath: root,
      version: "1.17.29",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: true }),
    })

    expect(await service.activate("VEC1.test.ABCD")).toMatchObject({ access: true, state: "active" })
    const file = join(root, "vector-license.json")
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ activationToken: "VAT1.test.activation" })
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    expect(await service.deactivate()).toMatchObject({ access: false, state: "activation_required" })
    expect(await stat(file).catch(() => undefined)).toBeUndefined()
  })

  test("treats a CDN or firewall page as unreachable, so a new computer is not walled", async () => {
    const service = createLicenseService({
      userDataPath: await temporaryRoot(),
      version: "1.99.8",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: true, edge: true }),
    })

    const status = await service.status()
    expect(status).toMatchObject({ access: false, state: "offline" })
    expect(status.enforced).toBeUndefined()
    expect(status.message).toContain("could not reach licensing")
  })

  test("does not wall a computer that last heard free public beta when the API errors", async () => {
    const root = await temporaryRoot()
    const free = createLicenseService({
      userDataPath: root,
      version: "1.99.8",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: false }),
    })
    expect(await free.status()).toMatchObject({ access: true, state: "beta" })

    const failing = createLicenseService({
      userDataPath: root,
      version: "1.99.8",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: true, fail: true }),
    })
    const status = await failing.status()
    expect(status).toMatchObject({ access: false, state: "offline" })
    expect(status.enforced).toBeUndefined()
  })

  test("an activated computer behind a firewall page keeps its offline grace instead of asking to activate", async () => {
    const root = await temporaryRoot()
    const online = createLicenseService({
      userDataPath: root,
      version: "1.99.8",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: true }),
    })
    await online.activate("VEC1.test.ABCD")

    const blocked = createLicenseService({
      userDataPath: root,
      version: "1.99.8",
      packaged: true,
      channel: "prod",
      apiUrl: await licensingServer({ available: true, edge: true }),
    })
    expect(await blocked.status()).toMatchObject({ access: true, state: "grace" })
  })
})
