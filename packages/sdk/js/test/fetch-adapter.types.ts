// Public adapters need only handle the Request the SDK passes; they are not global fetch objects.
function adapter(request: Request) {
  return Promise.resolve(Response.json({ method: request.method, url: request.url }))
}

export const v1: import("../src/client.js").VectorClientConfig = { fetch: adapter }
export const v2: import("../src/v2/client.js").VectorClientConfig = { fetch: adapter }
export const streamV1: import("../src/gen/core/serverSentEvents.gen.js").ServerSentEventsOptions = {
  url: "https://example.invalid/events",
  fetch: adapter,
}
export const streamV2: import("../src/v2/gen/core/serverSentEvents.gen.js").ServerSentEventsOptions = {
  url: "https://example.invalid/events",
  fetch: adapter,
}

export const invalid: import("../src/client.js").VectorClientConfig = {
  // @ts-expect-error The client passes a Request, not a URL string.
  fetch: (_url: string) => Promise.resolve(Response.json({})),
}
