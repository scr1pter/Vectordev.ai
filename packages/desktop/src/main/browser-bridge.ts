import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"

import { runBrowserAgent } from "./browser-agent"
import { parseBrowserAgentInput } from "./browser-bridge-input"

const MAX_BODY_BYTES = 256 * 1024

let bridgeServer: Server | undefined
let bridgeUrl = ""
let bridgeToken = ""

export async function startBrowserBridge() {
  if (bridgeServer) return { url: bridgeUrl, token: bridgeToken }

  bridgeToken = randomUUID()
  bridgeServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8")
    if (request.method !== "POST" || request.url !== "/command") {
      response.statusCode = 404
      response.end(JSON.stringify({ error: "Not found" }))
      return
    }
    if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
      response.statusCode = 401
      response.end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_BODY_BYTES) {
        response.statusCode = 413
        response.end(JSON.stringify({ error: "Request too large" }))
        request.destroy()
        return
      }
      chunks.push(buffer)
    }

    try {
      const input = parseBrowserAgentInput(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      const result = await runBrowserAgent(undefined, input)
      response.statusCode = result.ok ? 200 : 409
      response.end(JSON.stringify(result))
    } catch (error) {
      response.statusCode = 400
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    bridgeServer!.once("error", reject)
    bridgeServer!.listen(0, "127.0.0.1", () => resolve())
  })
  const address = bridgeServer.address()
  if (!address || typeof address === "string") throw new Error("Controlled browser bridge failed to bind")
  bridgeUrl = `http://127.0.0.1:${address.port}`
  return { url: bridgeUrl, token: bridgeToken }
}

export async function stopBrowserBridge() {
  const current = bridgeServer
  bridgeServer = undefined
  bridgeUrl = ""
  bridgeToken = ""
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}
