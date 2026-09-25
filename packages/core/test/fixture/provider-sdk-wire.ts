import type { LanguageModelV3 } from "@ai-sdk/provider"
import assert from "node:assert/strict"
import { ProviderSDK } from "../../src/provider-sdk"
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }]
const tools = [{ type: "function" as const, name: "read", inputSchema: { type: "object" as const } }]
for (const [pkg, options] of [
  ["ai-gateway-provider", { accountId: "fixture", gatewayId: "fixture", apiKey: "fixture" }],
  ["@aihubmix/ai-sdk-provider", { apiKey: "fixture" }],
  ["merge-gateway-ai-sdk-provider", { apiKey: "fixture" }],
  ["@qvac/ai-sdk-provider", { baseURL: "http://127.0.0.1:11435/v1" }],
] as const) {
  const create = await ProviderSDK.load(pkg)
  assert.equal(create(options).languageModel("fixture").specificationVersion, "v3")
}
const watsonx = await ProviderSDK.load("watsonx-ai-provider")
const a = watsonx({
  apiKey: "fixture-a",
  projectId: "fixture-project",
  baseURL: "https://watsonx.fixture.test",
}).languageModel("fixture")
const b = watsonx({
  apiKey: "fixture-b",
  projectId: "fixture-project",
  baseURL: "https://watsonx.fixture.test",
}).languageModel("fixture")
for (const model of [a, a, b]) {
  const response = await model.doGenerate({ prompt, tools })
  assert.equal(response.finishReason.unified, "tool-calls")
  assert(response.content.some((part) => part.type === "tool-call" && part.toolName === "read"))
}
await verifyStream(a)
const denied = watsonx({ apiKey: "fixture-denied", projectId: "fixture-project" }).languageModel("fixture")
await assert.rejects(
  Promise.resolve(denied.doGenerate({ prompt })),
  (error: unknown) =>
    error instanceof Error &&
    error.message.includes("IBM IAM authentication failed") &&
    !String(error).includes("fixture-private-secret"),
)
const abort = new AbortController()
const delayed = watsonx({ apiKey: "fixture-delayed", projectId: "fixture-project" }).languageModel("fixture")
const start = Date.now()
const stopped = Promise.resolve(delayed.doGenerate({ prompt, abortSignal: abort.signal }))
setTimeout(() => abort.abort(), 40)
await assert.rejects(stopped)
assert(Date.now() - start < 1000, "Watsonx caller cancellation must not wait for the shared IAM deadline")

const sap = await ProviderSDK.load("@jerome-benoit/sap-ai-provider")
const before = process.env.AICORE_SERVICE_KEY
const sapModels = ["a", "b"].map((id) =>
  sap({
    serviceKey: JSON.stringify({
      clientid: `fixture-${id}`,
      clientsecret: `fixture-secret-${id}`,
      url: "https://sap-auth.fixture.test",
      serviceurls: { AI_API_URL: "https://sap.fixture.test" },
    }),
    deploymentId: `fixture-${id}`,
    resourceGroup: "fixture-resource",
  }).languageModel("gpt-4o"),
)
for (const model of [sapModels[0], sapModels[0], sapModels[1]]) {
  const response = await model.doGenerate({ prompt, tools })
  assert.equal(response.finishReason.unified, "tool-calls")
  assert(response.content.some((part) => part.type === "tool-call" && part.toolName === "read"))
  assert.equal(process.env.AICORE_SERVICE_KEY, before)
}
await verifyStream(sapModels[0])
const sapDenied = sap({
  serviceKey: JSON.stringify({
    clientid: "fixture-denied",
    clientsecret: "fixture-private-secret",
    url: "https://sap-auth.fixture.test",
    serviceurls: { AI_API_URL: "https://sap.fixture.test" },
  }),
}).languageModel("gpt-4o")
await assert.rejects(
  Promise.resolve(sapDenied.doGenerate({ prompt })),
  (error: unknown) =>
    error instanceof Error && error.message.includes("HTTP 401") && !String(error).includes("fixture-private-secret"),
)
console.log("provider-sdk-wire: PASS")

async function verifyStream(model: LanguageModelV3) {
  const result = await model.doStream({ prompt, tools })
  const reader = result.stream.getReader()
  let tool = false
  let finish = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (next.value.type === "tool-call" && next.value.toolName === "read") tool = true
    if (next.value.type === "finish" && next.value.finishReason.unified === "tool-calls") finish = true
  }
  assert(tool, `${model.provider} streamed tool call`)
  assert(finish, `${model.provider} streamed finish`)
}
