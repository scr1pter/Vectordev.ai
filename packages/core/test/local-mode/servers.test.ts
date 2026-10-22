import { describe, expect, test } from "bun:test"
import type { LocalProbe } from "../../src/local-mode/probe"
import { LlamaCppServer } from "../../src/local-mode/servers/llamacpp"
import { LMStudioServer } from "../../src/local-mode/servers/lmstudio"
import { OllamaServer } from "../../src/local-mode/servers/ollama"
import { OpenAIServer } from "../../src/local-mode/servers/openai"
import { SGLangServer } from "../../src/local-mode/servers/sglang"
import { VLLMServer } from "../../src/local-mode/servers/vllm"
import { LocalServers } from "../fixture/local-servers/serve"
import { NetworkGuard } from "../lib/network-guard"

// Each server's parser against its cassette, read straight from the file: no server and no connection. The strict
// guard proves nothing here reaches out.
const guard = NetworkGuard.use()

async function cassette(kind: LocalServers.Kind) {
  const decoded = await LocalServers.load(kind)
  const interactions = decoded.interactions
  const answer = (at: string, body?: unknown) => {
    const match = interactions.find(
      (item) =>
        new URL(item.request.url).pathname === at &&
        (body === undefined
          ? item.request.method === "GET"
          : item.request.method === "POST" && JSON.stringify(JSON.parse(item.request.body)) === JSON.stringify(body)),
    )
    return match && match.response.status < 400 ? JSON.parse(match.response.body) : undefined
  }
  const read: LocalProbe.Read = async (at, body) => answer(at, body)
  return { decoded, answer, read }
}

describe("server parsers against their cassettes", () => {
  test("every cassette says it was written by hand, not recorded", async () => {
    for (const kind of ["ollama", "lmstudio", "vllm", "llamacpp", "sglang", "openai"] as const) {
      const current = await cassette(kind)
      expect(current.decoded.metadata.recorded).toBe(false)
      expect(current.decoded.metadata.note).toContain("not recorded")
    }
  })

  test("Ollama: tools, vision, the loaded context, the trained context and cloud models", async () => {
    const current = await cassette("ollama")
    const identified = current.answer(OllamaServer.identify)
    expect(OllamaServer.matches(identified)).toBe(true)
    const inspection = await OllamaServer.inspect(current.read, identified)
    expect(inspection.version).toBe("0.12.6")
    expect(inspection.concurrency).toBe(1)
    expect(inspection.forwards).toBe("ollama-cloud")
    const byId = new Map(inspection.models.map((model) => [model.id, model]))
    // Loaded: the context /api/ps reports, which is what requests get, not the 256K it was trained for.
    expect(byId.get("qwen3-coder:30b")).toMatchObject({
      context: 8192,
      trained: 262144,
      tools: true,
      vision: false,
      loaded: true,
      size: 18556700761,
      parameters: "30.5B",
      quantization: "Q4_K_M",
    })
    expect(byId.get("gemma3:12b")).toMatchObject({ tools: false, vision: true, loaded: false, context: undefined })
    // Not loaded, but its Modelfile sets num_ctx.
    expect(byId.get("llama3.3:70b")).toMatchObject({ context: 32768, trained: 131072, loaded: false, tools: true })
    expect(byId.get("gpt-oss:120b-cloud")).toMatchObject({ cloud: true })
    expect(byId.get("gpt-oss:120b-cloud")?.context).toBeUndefined()
    // An embedding model cannot answer a chat, so it is not offered as a model for any role.
    expect(byId.has("nomic-embed-text:latest")).toBe(false)
    expect(inspection.models.map((model) => model.id)).toEqual([
      "qwen3-coder:30b",
      "gemma3:12b",
      "llama3.3:70b",
      "gpt-oss:120b-cloud",
    ])
  })

  test("Ollama keeps every model when the server lists no capabilities", async () => {
    const current = await cassette("ollama")
    const read: LocalProbe.Read = async (at, body) => {
      const answer = await current.read(at, body)
      if (at !== "/api/show" || typeof answer !== "object" || answer === null) return answer
      return Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "capabilities"))
    }
    const inspection = await OllamaServer.inspect(read, current.answer(OllamaServer.identify))
    expect(inspection.models.map((model) => model.id)).toContain("nomic-embed-text:latest")
    expect(inspection.models.find((model) => model.id === "nomic-embed-text:latest")?.tools).toBeUndefined()
  })

  test("Ollama never asks about a cloud model, since the daemon may call ollama.com to answer", async () => {
    const current = await cassette("ollama")
    const asked: string[] = []
    const read: LocalProbe.Read = async (at, body) => {
      asked.push(`${at} ${JSON.stringify(body ?? null)}`)
      return current.answer(at, body)
    }
    await OllamaServer.inspect(read, current.answer(OllamaServer.identify))
    expect(asked.filter((line) => line.includes("cloud"))).toEqual([])
    expect(asked.filter((line) => line.startsWith("/api/show"))).toHaveLength(4)
  })

  test("Ollama cloud names and remote fields", () => {
    expect(OllamaServer.cloud({ name: "gpt-oss:120b-cloud" })).toBe(true)
    expect(OllamaServer.cloud({ name: "kimi-k2:cloud" })).toBe(true)
    expect(OllamaServer.cloud({ name: "deepseek-v3.1:671b", remote_host: "https://ollama.com:443" })).toBe(true)
    expect(OllamaServer.cloud({ name: "qwen3-coder:30b" })).toBe(false)
    expect(OllamaServer.cloud({ name: "cloudy-model:7b" })).toBe(false)
  })

  test("LM Studio: answers every path with 200, so only its model list identifies it", async () => {
    const current = await cassette("lmstudio")
    const fallback = JSON.parse(current.decoded.metadata.fallback!.body)
    // Its "Unexpected endpoint" body is not mistaken for any other server.
    expect(OllamaServer.matches(fallback)).toBe(false)
    expect(VLLMServer.matches(fallback)).toBe(false)
    expect(LlamaCppServer.matches(fallback)).toBe(false)
    expect(SGLangServer.matches(fallback)).toBe(false)
    expect(LMStudioServer.matches(fallback)).toBe(false)
    const identified = current.answer(LMStudioServer.identify)
    expect(LMStudioServer.matches(identified)).toBe(true)
    const inspection = await LMStudioServer.inspect(current.read, identified)
    expect(inspection.version).toBeUndefined()
    expect(inspection.concurrency).toBe(1)
    expect(inspection.models).toEqual([
      {
        id: "qwen2.5-coder-7b-instruct",
        context: 4096,
        trained: 32768,
        tools: true,
        vision: false,
        loaded: true,
        quantization: "Q4_K_M",
        family: "qwen2",
      },
      {
        id: "qwen2-vl-7b-instruct",
        context: undefined,
        trained: 32768,
        tools: undefined,
        vision: true,
        loaded: false,
        quantization: "Q4_K_M",
        family: "qwen2_vl",
      },
    ])
  })

  test("LM Studio: the context a model was loaded with, once it is loaded", async () => {
    const current = await cassette("lmstudio")
    expect(await LMStudioServer.loadedContext(current.read, "qwen2.5-coder-7b-instruct")).toBe(4096)
    // Not loaded yet: LM Studio loads it on the first request, with the context set in the app.
    expect(await LMStudioServer.loadedContext(current.read, "qwen2-vl-7b-instruct")).toBeUndefined()
    expect(await LMStudioServer.loadedContext(current.read, "not-there")).toBeUndefined()
  })

  test("vLLM: its version and the context it serves, with tools unknown until checked", async () => {
    const current = await cassette("vllm")
    const identified = current.answer(VLLMServer.identify)
    expect(VLLMServer.matches(identified)).toBe(true)
    expect(await VLLMServer.inspect(current.read, identified)).toEqual({
      version: "0.11.0",
      models: [{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", context: 65536, loaded: true }],
      concurrency: 4,
    })
  })

  test("llama.cpp: its slots become the concurrency, and each slot's context is the model's", async () => {
    const current = await cassette("llamacpp")
    const identified = current.answer(LlamaCppServer.identify)
    expect(LlamaCppServer.matches(identified)).toBe(true)
    // Another server's /props-shaped answer without slots is not llama.cpp.
    expect(LlamaCppServer.matches({ build_info: "x" })).toBe(false)
    expect(await LlamaCppServer.inspect(current.read, identified)).toEqual({
      version: "b6700-1a2b3c4d",
      models: [{ id: "qwen3-coder-30b-q4_k_m.gguf", context: 16384, trained: 262144, vision: false, loaded: true }],
      concurrency: 2,
    })
  })

  test("SGLang: its version from server info and the context from its model list", async () => {
    const current = await cassette("sglang")
    const identified = current.answer(SGLangServer.identify)
    expect(SGLangServer.matches(identified)).toBe(true)
    expect(await SGLangServer.inspect(current.read)).toEqual({
      version: "0.5.3",
      models: [{ id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", context: 262144, loaded: true }],
      concurrency: 4,
    })
  })

  test("a generic server, recognised as a LiteLLM proxy that forwards", async () => {
    const current = await cassette("openai")
    const identified = current.answer(OpenAIServer.identify)
    expect(OpenAIServer.matches(identified)).toBe(true)
    expect(await OpenAIServer.inspect(current.read, identified)).toEqual({
      version: "1.77.7",
      models: [{ id: "company-coder", context: undefined }],
      forwards: "litellm",
    })
    // Without the readiness answer it is a plain OpenAI-compatible server.
    const plain = await OpenAIServer.inspect(async () => undefined, identified)
    expect(plain.forwards).toBeUndefined()
  })

  test("nothing in these parsers opened a connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
