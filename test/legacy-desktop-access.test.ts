import { expect, test } from "bun:test"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import handler from "../api/legacy-desktop-access"

async function invoke(method: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {
        return this
      },
      end(value?: string) {
        resolve({ status: this.statusCode, body: value ? JSON.parse(value) : undefined })
        return this
      },
    } as unknown as ApiResponse
    void handler({ method } as ApiRequest, response).catch(reject)
  })
}

test("builds before 1.99.99 are told no licence is required", async () => {
  // 1.19.x and 1.99.x read `available`; 1.99.8 reads `licenseRequired` first.
  expect(await invoke("GET")).toEqual({ status: 200, body: { available: false, licenseRequired: false } })
})

test("builds that activated a key keep access", async () => {
  const result = await invoke("POST")
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ access: true, state: "beta" })
})

test("other methods are refused", async () => {
  expect((await invoke("PUT")).status).toBe(405)
})

test("the paths older builds call are routed to the handler", async () => {
  const config = await Bun.file(new URL("../vercel.json", import.meta.url)).json()
  for (const source of ["/api/billing/config", "/api/billing/status"])
    expect(config.rewrites).toContainEqual({ source, destination: "/api/legacy-desktop-access" })
})
