export * from "./client.js"
export * from "./server.js"

import { createVectorClient } from "./client.js"
import { createVectorServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createVector(options?: ServerOptions) {
  const server = await createVectorServer({
    ...options,
  })

  const client = createVectorClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
