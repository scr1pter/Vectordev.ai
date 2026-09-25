import { expect, test } from "bun:test"
import { z } from "zod"
import {
  createJsonResponseHandler,
  createJsonErrorResponseHandler,
  createStatusCodeErrorResponseHandler,
  DEFAULT_MAX_DOWNLOAD_SIZE,
} from "@ai-sdk/provider-utils"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import path from "node:path"
import { fileURLToPath } from "node:url"

test("every reviewed SDK resolves the patched provider-utils family on disk", async () => {
  for (const pkg of ModelCatalog.BUNDLED_PROVIDER_PACKAGES) {
    if (
      pkg === "@ai-sdk/github-copilot" ||
      pkg === "@ai-sdk/amazon-bedrock/mantle" ||
      pkg === "@ai-sdk/google-vertex/anthropic" ||
      pkg === "@qvac/ai-sdk-provider"
    )
      continue
    const entry = import.meta.resolve(pkg, path.resolve(import.meta.dir, "../src/provider-sdk.ts"))
    const utils = fileURLToPath(import.meta.resolve("@ai-sdk/provider-utils", entry))
    const metadata = await Bun.file(path.resolve(path.dirname(utils), "../package.json")).json()
    expect(metadata.version, pkg).toBe("4.0.52")
  }
})

for (const [name, handler] of [
  ["JSON success", createJsonResponseHandler(z.object({}))],
  [
    "JSON error",
    createJsonErrorResponseHandler({
      errorSchema: z.object({ message: z.string() }),
      errorToMessage: (value) => value.message,
    }),
  ],
  ["status error", createStatusCodeErrorResponseHandler()],
] as const) {
  test(`${name} rejects and cancels an oversized response before buffering it`, async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status: 500,
        headers: { "Content-Length": String(DEFAULT_MAX_DOWNLOAD_SIZE + 1), "Content-Type": "application/json" },
      },
    )
    await expect(handler({ response, url: "https://provider.fixture.test", requestBodyValues: {} })).rejects.toThrow(
      "exceeded maximum size",
    )
    expect(cancelled).toBe(true)
  })
}
