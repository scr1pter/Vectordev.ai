import { LoadAPIKeyError } from "@ai-sdk/provider"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ProviderSDK } from "../provider-sdk"

export async function watsonxFactory(): Promise<ProviderSDK.Factory> {
  const { createWatsonx } = await import("watsonx-ai-provider")
  return (options) => {
    const sdk = createWatsonx(options)
    return {
      languageModel(id) {
        const model = sdk.languageModel(id)
        return {
          specificationVersion: model.specificationVersion,
          provider: model.provider,
          modelId: model.modelId,
          supportedUrls: model.supportedUrls,
          doGenerate: (call) => invoke(() => model.doGenerate(call), call.abortSignal),
          doStream: (call) => invoke(() => model.doStream(call), call.abortSignal),
        } satisfies LanguageModelV3
      },
    }
  }
}

// The SDK owns a shared per-key IAM request with a 15s transport deadline. A
// cancelled caller must stop waiting without aborting another caller's exchange.
// IAM response bodies can echo credentials and must never enter Vector's errors.
function invoke<T>(call: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    signal?.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(call)
      .then(resolve, (error: unknown) => {
        reject(
          LoadAPIKeyError.isInstance(error)
            ? new Error("IBM IAM authentication failed; check your watsonx API key")
            : error,
        )
      })
      .finally(() => signal?.removeEventListener("abort", abort))
  })
}
