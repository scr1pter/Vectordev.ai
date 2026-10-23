import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { LocalProbe } from "../../src/local-mode/probe"
import { Egress } from "../../src/local-mode/egress"
import { LocalPolicy } from "../../src/local-mode/policy"
import { OllamaServer } from "../../src/local-mode/servers/ollama"
import { BashTool } from "../../src/tool/bash"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { QuestionTool } from "../../src/tool/question"
import { TodoWriteTool } from "../../src/tool/todowrite"
import { WebFetchTool } from "../../src/tool/webfetch"
import { WriteTool } from "../../src/tool/write"
import { LocalServers } from "../fixture/local-servers/serve"
import { NetworkGuard } from "../lib/network-guard"

// Every server here is a fake on 127.0.0.1 answering from its cassette, and the strict guard refuses anything else.
const guard = NetworkGuard.use()

const fakes: LocalServers.Fake[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function fake(kind: LocalServers.Kind, routes: Record<string, LocalServers.Route> = {}) {
  const server = await LocalServers.serve(kind, { routes })
  fakes.push(server)
  return server
}

const GB = 1024 ** 3

// The role's tools as a model sees them: Vector's own tool inputs as JSON schemas, the way the tool registry turns
// them into definitions, including nested ones (todowrite's list of todos, question's list of questions with options).
function tool(name: string, input: Schema.Top): LocalProbe.Tool {
  const document = Schema.toJsonSchemaDocument(input)
  const parameters =
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions }
  return { name, description: `The ${name} tool.`, parameters }
}

const TOOLS = [
  tool(EditTool.name, EditTool.Input),
  tool(WriteTool.name, WriteTool.Input),
  tool(GlobTool.name, GlobTool.Input),
  tool(GrepTool.name, GrepTool.Input),
  tool(BashTool.name, BashTool.Input),
  tool(TodoWriteTool.name, TodoWriteTool.Input),
  tool(QuestionTool.name, QuestionTool.Input),
  tool(WebFetchTool.name, WebFetchTool.Input),
]

describe("locate", () => {
  test("splits a typed address into origin, root and the OpenAI-compatible base", () => {
    expect(LocalProbe.locate("http://127.0.0.1:11434")).toEqual({
      origin: "http://127.0.0.1:11434",
      root: "http://127.0.0.1:11434",
      baseURL: "http://127.0.0.1:11434/v1",
    })
    expect(LocalProbe.locate(" https://ml.corp.example.com/qwen/v1/ ")).toEqual({
      origin: "https://ml.corp.example.com",
      root: "https://ml.corp.example.com/qwen",
      baseURL: "https://ml.corp.example.com/qwen/v1",
    })
    expect(LocalProbe.locate("http://LOCALHOST:8000/v1?x=1#y")?.origin).toBe("http://localhost:8000")
  })

  test("refuses addresses that are not plain http or https, and addresses with credentials", () => {
    expect(LocalProbe.locate("ftp://127.0.0.1/")).toBeUndefined()
    expect(LocalProbe.locate("file:///etc/passwd")).toBeUndefined()
    expect(LocalProbe.locate("not a url")).toBeUndefined()
    expect(LocalProbe.locate("http://user:secret@127.0.0.1:8000/v1")).toBeUndefined()
  })
})

describe("probe a typed address", () => {
  test.each([
    ["ollama", "Ollama", "0.12.6", 1],
    ["lmstudio", "LM Studio", undefined, 1],
    ["vllm", "vLLM", "0.11.0", 4],
    ["llamacpp", "llama.cpp", "b6700-1a2b3c4d", 2],
    ["sglang", "SGLang", "0.5.3", 4],
    ["openai", "OpenAI-compatible server", "1.77.7", undefined],
  ] as const)("recognises %s", async (kind, name, version, concurrency) => {
    const server = await fake(kind)
    const found = await LocalProbe.probe(`${server.origin}/v1`)
    expect(found).toMatchObject({
      kind,
      name,
      origin: server.origin,
      baseURL: `${server.origin}/v1`,
      version,
      class: "this-computer",
      encrypted: false,
      concurrency,
    })
    expect(found?.pin).toEqual({
      kind,
      version,
      models: LocalProbe.modelSet(found!.models),
      spki: null,
    })
    // Models come sorted, each with the reply limit Vector writes for its context.
    expect(found!.models.map((model) => model.id)).toEqual(found!.models.map((model) => model.id).toSorted())
    found!.models
      .filter((model) => model.context)
      .forEach((model) => expect(model.output).toBe(Math.min(8192, Math.floor(model.context! / 4))))
  })

  test("labels Ollama's cloud models and a LiteLLM proxy as servers that forward", async () => {
    const ollama = await LocalProbe.probe((await fake("ollama")).origin)
    expect(ollama?.forwards).toBe("ollama-cloud")
    expect(ollama?.models.find((model) => model.id === "gpt-oss:120b-cloud")?.cloud).toBe(true)
    const litellm = await LocalProbe.probe((await fake("openai")).origin)
    expect(litellm?.forwards).toBe("litellm")
  })

  test("an address where nothing answers, or something Vector does not recognise, is not a server", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const port = closed.port
    await closed.stop(true)
    expect(await LocalProbe.probe(`http://127.0.0.1:${port}`)).toBeUndefined()
    const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>dev server</html>") })
    expect(await LocalProbe.probe(`http://127.0.0.1:${web.port}`)).toBeUndefined()
    await web.stop(true)
  })

  test("never follows a redirect a server sends", async () => {
    const elsewhere = await fake("vllm")
    const redirecting = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => Response.redirect(`${elsewhere.origin}${new URL(request.url).pathname}`, 302),
    })
    expect(await LocalProbe.probe(`http://127.0.0.1:${redirecting.port}`)).toBeUndefined()
    expect(elsewhere.hits()).toEqual([])
    await redirecting.stop(true)
  })
})

describe("identity pins", () => {
  test("a changed version or model list holds the server's requests until the user confirms", async () => {
    const server = await fake("vllm")
    const added = (await LocalProbe.probe(server.origin))!
    const holds = LocalProbe.makeHolds()
    expect(await LocalProbe.verify({ origin: server.origin, pin: added.pin, holds })).toMatchObject({ status: "same" })
    expect(() => holds.gate(`${server.origin}/v1/chat/completions`)).not.toThrow()

    // Something else now answers on the port.
    server.route("GET /version", () => Response.json({ version: "0.12.0" }))
    server.route("GET /v1/models", () =>
      Response.json({ object: "list", data: [{ id: "other/model", max_model_len: 8192 }] }),
    )
    const verified = await LocalProbe.verify({ origin: server.origin, pin: added.pin, holds })
    expect(verified.status).toBe("changed")
    if (verified.status !== "changed") return
    expect(verified.changes).toEqual(["version", "models"])
    expect(verified.message).toBe(
      `${new URL(server.origin).host} now answers as a different server. Check it before sending prompts.`,
    )
    expect(holds.held(server.origin)).toBe(verified.message)
    expect(() => holds.gate(`${server.origin}/v1/chat/completions`)).toThrow(LocalProbe.IdentityChanged)
    expect(() => holds.gate(`${server.origin}/v1/chat/completions`)).toThrow(verified.message)

    // A later check that matches does not release it; only the user's confirmation does.
    await LocalProbe.verify({ origin: server.origin, pin: verified.server.pin, holds })
    expect(holds.held(server.origin)).toBe(verified.message)
    holds.confirm(server.origin)
    expect(() => holds.gate(`${server.origin}/v1/chat/completions`)).not.toThrow()
  })

  test("a different kind of server is a change, and an unreachable one is not", async () => {
    const server = await fake("vllm")
    const pin: LocalProbe.Pin = { kind: "ollama", version: "0.12.6", models: "sha256:x", spki: null }
    const verified = await LocalProbe.verify({ origin: server.origin, pin })
    expect(verified.status === "changed" && verified.changes).toEqual(["kind", "version", "models"])
    await server.close()
    expect(await LocalProbe.verify({ origin: server.origin, pin })).toEqual({ status: "unreachable" })
  })

  test.skipIf(!Bun.which("openssl"))("reads an https server's public key pin", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vector-spki-"))
    const key = path.join(dir, "key.pem")
    const cert = path.join(dir, "cert.pem")
    const made = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
    ])
    expect(made.exitCode).toBe(0)
    const tls = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: Bun.file(cert), key: Bun.file(key) },
      fetch: () => new Response("ok"),
    })
    // The expected pin, worked out by openssl itself: SHA-256 of the DER public key, base64.
    const der = Bun.spawnSync(["openssl", "x509", "-in", cert, "-pubkey", "-noout"]).stdout
    const spki = Bun.spawnSync(["openssl", "pkey", "-pubin", "-outform", "der"], { stdin: der }).stdout
    const expected = new Bun.CryptoHasher("sha256").update(spki).digest("base64")
    expect(await LocalProbe.spki(`https://127.0.0.1:${tls.port}`)).toBe(expected)
    await tls.stop(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("a server that does not speak TLS gives no key", async () => {
    const plain = await fake("vllm")
    expect(await LocalProbe.spki(plain.origin.replace("http:", "https:"), 1_000)).toBeNull()
  })
})

describe("checking a listed server before its first model call", () => {
  afterEach(async () => {
    Egress.configure(LocalPolicy.OFF)
    await Egress.erase()
  })
  const policy = (origin: string, pin?: LocalProbe.Pin) =>
    LocalPolicy.resolve({
      global: { enabled: true, endpoints: [origin], ...(pin ? { pins: { [`${origin}/`]: pin } } : {}) },
    })

  test("reads a pinned server once per policy, and holds it when it answers as a different one", async () => {
    const server = await fake("vllm")
    const added = (await LocalProbe.probe(server.origin))!
    const holds = LocalProbe.makeHolds()
    const first = policy(server.origin, added.pin)
    Egress.configure(first)
    // The pin is read by origin, whatever form the config wrote it in.
    expect(first.pins).toEqual({ [server.origin]: added.pin })
    const before = server.hits().length
    await Promise.all([holds.check(`${server.origin}/v1/chat/completions`, first), holds.check(server.origin, first)])
    const read = server.hits().length - before
    expect(read).toBeGreaterThan(0)
    expect(holds.held(server.origin)).toBeUndefined()
    // Every model call after the first waits on the same check.
    await holds.check(`${server.origin}/v1/chat/completions`, first)
    expect(server.hits().length - before).toBe(read)
    // The reads are the server check's, decided and logged as such.
    expect(Egress.events().filter((event) => event.source === LocalProbe.SERVER_CHECK).length).toBe(read)

    // Something else now answers on the port; a new policy checks again and holds the server.
    server.route("GET /v1/models", () => Response.json({ object: "list", data: [{ id: "other/model" }] }))
    const next = policy(server.origin, added.pin)
    Egress.configure(next)
    await holds.check(server.origin, next)
    expect(holds.held(server.origin)).toBe(LocalProbe.changedMessage(server.origin))
    expect(() => holds.gate(`${server.origin}/v1/chat/completions`)).toThrow(LocalProbe.IdentityChanged)
  })

  test("reads nothing for a server with no pin, one not on the list, or with Vector Local off", async () => {
    const server = await fake("vllm")
    const added = (await LocalProbe.probe(server.origin))!
    const holds = LocalProbe.makeHolds()
    const before = server.hits().length
    await holds.check(server.origin, policy(server.origin))
    await holds.check(server.origin, policy("http://127.0.0.1:9", added.pin))
    await holds.check(server.origin, { ...policy(server.origin, added.pin), enabled: false })
    expect(server.hits().length).toBe(before)
  })

  test("learns which models an Ollama server passes on, whatever their names", async () => {
    // A copy of a cloud model made with `ollama cp` keeps the remote fields but loses the -cloud name.
    const server = await fake("ollama", {
      "GET /api/tags": () =>
        Response.json({
          models: [
            { name: "qwen3-coder:30b", size: 1 },
            { name: "mymodel:latest", size: 1 },
          ],
        }),
      "POST /api/show": async (_request, body) =>
        JSON.parse(body).model === "mymodel:latest"
          ? Response.json({ remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b" })
          : Response.json({ capabilities: ["completion", "tools"] }),
    })
    const added = (await LocalProbe.probe(server.origin))!
    const holds = LocalProbe.makeHolds()
    const listed = policy(server.origin, added.pin)
    Egress.configure(listed)
    expect(holds.forwards(server.origin, "mymodel:latest")).toBe(false)
    await holds.check(server.origin, listed)
    expect(holds.forwards(`${server.origin}/v1/chat/completions`, "mymodel:latest")).toBe(true)
    expect(holds.forwards(server.origin, "qwen3-coder:30b")).toBe(false)
  })

  test("decides each read with Vector Local on: a server elsewhere is not reached until it is listed", async () => {
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    // An address on the user's network, which the strict guard would refuse to reach.
    expect(await LocalProbe.probe("http://10.20.30.40:8000")).toBeUndefined()
    const refused = Egress.events().filter((event) => event.source === LocalProbe.SERVER_CHECK)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.every((event) => event.decision === "block" && event.origin === "http://10.20.30.40:8000")).toBe(
      true,
    )
  })
})

describe("Check models", () => {
  test("runs the role's tools over three requests: a simple call, the most nested call and a tool result", async () => {
    const server = await fake("vllm", { "POST /v1/chat/completions": LocalServers.chat() })
    const found = (await LocalProbe.probe(server.origin))!
    const checked = await LocalProbe.check({
      server: found,
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      tools: TOOLS,
      required: 19_000,
    })
    expect(checked).toMatchObject({ result: "works", requests: 3, context: 65536, server_version: "0.11.0" })
    expect(checked.ttft_ms).toBeGreaterThanOrEqual(0)
    const bodies = server
      .hits()
      .filter((hit) => hit.path === "/v1/chat/completions")
      .map((hit) => JSON.parse(hit.body) as LocalServers.ChatBody)
    expect(bodies).toHaveLength(3)
    // Every request carries the role's whole tool list, as the agent would send it.
    bodies.forEach((body) =>
      expect(body.tools?.map((tool) => tool.function.name)).toEqual(TOOLS.map((tool) => tool.name)),
    )
    const asked = bodies.map((body) => String(body.messages.findLast((message) => message.role === "user")?.content))
    // The flattest tool first, then the one with the deepest parameters.
    expect(asked[0]).toStartWith("Call the glob tool")
    expect(asked[1]).toMatch(/^Call the (todowrite|question) tool/)
    expect(LocalProbe.depth(TOOLS.find((item) => asked[1].includes(`the ${item.name} tool`))!.parameters)).toBe(
      Math.max(...TOOLS.map((tool) => LocalProbe.depth(tool.parameters))),
    )
    // The third request answers the first call with a tool result.
    expect(bodies[2].messages.at(-1)).toMatchObject({ role: "tool", content: "Done." })
  })

  test("a model that answers without a tool call cannot run the agent", async () => {
    const server = await fake("vllm", {
      "POST /v1/chat/completions": LocalServers.chat(() =>
        LocalServers.sse([{ choices: [{ index: 0, delta: { content: "Sure, I would call glob." } }] }]),
      ),
    })
    const checked = await LocalProbe.check({
      server: (await LocalProbe.probe(server.origin))!,
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      tools: TOOLS,
    })
    expect(checked.result).toBe("no-tools")
    expect(checked.requests).toBe(1)
    expect(checked.message).toContain("answered without calling a tool")
  })

  test("arguments that do not fit the tool's parameters fail the check", async () => {
    const server = await fake("vllm", {
      "POST /v1/chat/completions": LocalServers.chat((input) =>
        input.tool
          ? LocalServers.sse([
              {
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, id: "c", function: { name: input.tool, arguments: "{}" } }] },
                  },
                ],
              },
            ])
          : undefined,
      ),
    })
    const checked = await LocalProbe.check({
      server: (await LocalProbe.probe(server.origin))!,
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      tools: TOOLS,
    })
    expect(checked.result).toBe("failed")
    expect(checked.message).toContain("do not match the glob tool's parameters")
  })

  test("a server that refuses tools gets Vector's fix, not only its own words", async () => {
    const server = await fake("ollama", {
      "POST /v1/chat/completions": () =>
        Response.json(
          { error: { message: "registry.ollama.ai/library/gemma3:12b does not support tools", type: "api_error" } },
          { status: 400 },
        ),
    })
    const checked = await LocalProbe.check({
      server: (await LocalProbe.probe(server.origin))!,
      model: "gemma3:12b",
      tools: TOOLS,
    })
    expect(checked.result).toBe("no-tools")
    expect(checked.message).toBe(
      "gemma3:12b cannot call tools, and Vector's agent works through tools. Pick a model that supports tool calling.",
    )
  })

  test("maps a schema rejection to what to update, with the server's text as plain text", async () => {
    const server = await fake("llamacpp", {
      "POST /v1/chat/completions": () =>
        Response.json(
          {
            error: {
              code: 500,
              message: 'JSON schema conversion failed:\n<b>Unrecognized schema:</b> {"$ref":"#/$defs/Todo"}\u001b[31m',
              type: "server_error",
            },
          },
          { status: 500 },
        ),
    })
    const checked = await LocalProbe.check({
      server: (await LocalProbe.probe(server.origin))!,
      model: "qwen3-coder-30b-q4_k_m.gguf",
      tools: TOOLS,
    })
    expect(checked.result).toBe("schema-rejected")
    expect(checked.message).toStartWith("llama.cpp could not read the parameters of Vector's tools. Update llama.cpp")
    expect(checked.message).not.toContain("<b>")
    expect(checked.message).not.toContain("\u001b")
    expect(checked.message).toContain("Unrecognized schema:")
  })

  test.each([
    [
      "ollama",
      "json: cannot unmarshal array into Go struct field .tools.function.parameters.properties.type of type string",
    ],
    ["vllm", "The provided JSON schema is not supported by xgrammar"],
    ["openai", "Invalid schema for function 'todowrite'"],
  ] as const)("recognises %s's schema rejection", (kind, text) => {
    expect(LocalProbe.rejection({ kind, name: kind }, text, { name: "todowrite" })).toContain(
      "could not read the todowrite tool's parameters",
    )
  })

  test("leaves other errors to the server's own words", () => {
    expect(LocalProbe.rejection({ kind: "vllm", name: "vLLM" }, "CUDA out of memory")).toBeUndefined()
  })

  test("asks before loading a model bigger than this computer's free memory, and runs once the user agrees", async () => {
    const server = await fake("ollama", { "POST /v1/chat/completions": LocalServers.chat() })
    const found = (await LocalProbe.probe(server.origin))!
    const asked = await LocalProbe.check({ server: found, model: "llama3.3:70b", tools: TOOLS, free: 11 * GB })
    expect(asked).toMatchObject({ result: "ask", requests: 0 })
    expect(asked.message).toBe(
      "Loading this model needs about 44 GB; this computer has 11 GB free. It may slow the computer down.",
    )
    expect(server.hits().filter((hit) => hit.path.startsWith("/v1/chat"))).toEqual([])

    const agreed = await LocalProbe.check({
      server: found,
      model: "llama3.3:70b",
      tools: TOOLS,
      free: 11 * GB,
      confirmed: true,
    })
    expect(agreed.result).toBe("works")
    // A model already loaded, or one that fits, never asks.
    const fits = await LocalProbe.check({ server: found, model: "llama3.3:70b", tools: TOOLS, free: 64 * GB })
    expect(fits.result).toBe("works")
  })

  test("never asks about memory for a server on another computer", async () => {
    const server = await fake("ollama", { "POST /v1/chat/completions": LocalServers.chat() })
    const found = { ...(await LocalProbe.probe(server.origin))!, class: "your-network" as const }
    const checked = await LocalProbe.check({ server: found, model: "llama3.3:70b", tools: TOOLS, free: 1 * GB })
    expect(checked.result).toBe("works")
  })

  test("offers an Ollama copy with a larger context and never makes it itself", async () => {
    const server = await fake("ollama", { "POST /v1/chat/completions": LocalServers.chat() })
    const found = (await LocalProbe.probe(server.origin))!
    // qwen3-coder:30b is loaded with 8,192 tokens of context.
    const checked = await LocalProbe.check({ server: found, model: "qwen3-coder:30b", tools: TOOLS, required: 19_000 })
    expect(checked).toMatchObject({ result: "context-too-small", requests: 0 })
    expect(checked.message).toBe(
      "qwen3-coder:30b has a 8,192-token context. Vector's agent needs about 19,000. Raise the context size or pick another model.",
    )
    expect(checked.offer).toEqual({
      from: "qwen3-coder:30b",
      model: "qwen3-coder:30b-32k",
      context: 32768,
      guidance:
        "Or set OLLAMA_CONTEXT_LENGTH=32768 where the Ollama server runs and restart it, which raises the context for every model.",
    })
    expect(server.hits().filter((hit) => hit.path === "/api/create")).toEqual([])

    // Only the user's click creates it.
    server.route("POST /api/create", () => Response.json({ status: "success" }))
    expect(await OllamaServer.create(server.origin, checked.offer!)).toEqual({ created: "qwen3-coder:30b-32k" })
    const created = server.hits().filter((hit) => hit.path === "/api/create")
    expect(created.map((hit) => JSON.parse(hit.body))).toEqual([
      { model: "qwen3-coder:30b-32k", from: "qwen3-coder:30b", parameters: { num_ctx: 32768 }, stream: false },
    ])
  })

  test("reads the context Ollama loaded a model with after the first request", async () => {
    const server = await fake("ollama", { "POST /v1/chat/completions": LocalServers.chat() })
    const found = (await LocalProbe.probe(server.origin))!
    // gemma3:12b has no num_ctx, so its context is unknown until it loads; then it loads with 4,096.
    server.route("GET /api/ps", () => Response.json({ models: [{ name: "gemma3:12b", context_length: 4096 }] }))
    const checked = await LocalProbe.check({ server: found, model: "gemma3:12b", tools: TOOLS, required: 19_000 })
    expect(checked).toMatchObject({ result: "context-too-small", requests: 1, context: 4096 })
    expect(checked.offer?.model).toBe("gemma3:12b-32k")
  })

  test("does not check a cloud model, whose prompts Ollama sends to ollama.com", async () => {
    const server = await fake("ollama", { "POST /v1/chat/completions": LocalServers.chat() })
    const checked = await LocalProbe.check({
      server: (await LocalProbe.probe(server.origin))!,
      model: "gpt-oss:120b-cloud",
      tools: TOOLS,
    })
    expect(checked).toMatchObject({ result: "failed", requests: 0 })
    expect(server.hits().filter((hit) => hit.path.startsWith("/v1/chat"))).toEqual([])
  })
})

describe("example arguments and their check", () => {
  test("every tool's example fits its own parameters", () => {
    TOOLS.forEach((tool) => expect(LocalProbe.fits(tool.parameters, LocalProbe.example(tool.parameters))).toBe(true))
  })

  test("missing required fields and wrong types do not fit", () => {
    const todo = TOOLS.find((tool) => tool.name === "todowrite")!.parameters
    expect(LocalProbe.fits(todo, {})).toBe(false)
    expect(LocalProbe.fits(todo, { todos: "not a list" })).toBe(false)
    expect(LocalProbe.fits(todo, { todos: [{}] })).toBe(false)
  })
})

describe("what Check models writes", () => {
  test("global config only: the provider's concurrency and per-model facts, and Vector Local's pin, list and results", async () => {
    const found = (await LocalProbe.probe((await fake("ollama")).origin))!
    const patch = LocalProbe.patch({
      providerID: "ollama",
      server: found,
      current: {
        endpoints: ["http://10.0.0.5:8000"],
        pins: { "http://10.0.0.5:8000": { kind: "vllm", version: "0.11.0", models: "sha256:a", spki: null } },
      },
      checks: [
        {
          model: "qwen3-coder:30b",
          result: "works",
          requests: 3,
          checked_at: 1,
          ttft_ms: 40,
          context: 32768,
          server_version: "0.12.6",
        },
        { model: "llama3.3:70b", result: "ask", requests: 0, checked_at: 2 },
        { model: "gemma3:12b", result: "no-tools", requests: 1, checked_at: 3, message: "No tools." },
      ],
    })
    expect(Object.keys(patch)).toEqual(["provider", "local"])
    expect(patch.provider).toEqual({
      ollama: {
        options: { concurrency: 1 },
        models: {
          "gemma3:12b": { tool_call: false, modalities: { input: ["text", "image"], output: ["text"] } },
          "llama3.3:70b": {
            tool_call: true,
            limit: { context: 32768, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
          "qwen3-coder:30b": {
            tool_call: true,
            limit: { context: 32768, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    })
    expect(patch.local).toEqual({
      endpoints: ["http://10.0.0.5:8000", found.origin],
      pins: {
        "http://10.0.0.5:8000": { kind: "vllm", version: "0.11.0", models: "sha256:a", spki: null },
        [found.origin]: found.pin,
      },
      checked: {
        "ollama/qwen3-coder:30b": {
          server_version: "0.12.6",
          checked_at: 1,
          result: "works",
          message: undefined,
          ttft_ms: 40,
        },
        "ollama/gemma3:12b": {
          server_version: undefined,
          checked_at: 3,
          result: "no-tools",
          message: "No tools.",
          ttft_ms: undefined,
        },
      },
    })
  })

  test("a server already listed is not listed twice, and an internet endpoint gets the long first-load wait", async () => {
    const found = (await LocalProbe.probe((await fake("vllm")).origin))!
    const listed = LocalProbe.patch({ providerID: "gpu", server: found, current: { endpoints: [found.origin] } })
    expect(listed.local.endpoints).toBeUndefined()
    const company = LocalProbe.patch({
      providerID: "company",
      server: { ...found, origin: "https://ml.corp.example.com", class: "internet" },
    })
    expect(company.provider["company"]?.options).toEqual({ concurrency: 4, headerTimeout: 600_000 })
    expect(LocalProbe.patch({ providerID: "x", server: found, list: false }).local.endpoints).toBeUndefined()
  })

  test("a LiteLLM proxy is recorded as a server that forwards, so its steps never count as local", async () => {
    const litellm = (await LocalProbe.probe((await fake("openai")).origin))!
    expect(LocalProbe.patch({ providerID: "proxy", server: litellm }).provider["proxy"]?.options).toEqual({
      forwards: true,
    })
    // Ollama forwards only its cloud models, which are left out of what it records and told apart by name.
    const ollama = (await LocalProbe.probe((await fake("ollama")).origin))!
    expect(LocalProbe.patch({ providerID: "ollama", server: ollama }).provider["ollama"]?.options).toEqual({
      concurrency: 1,
    })
  })

  test("the strict guard saw only this computer", () => {
    expect(guard.outside()).toEqual([])
    expect(guard.attempts().length).toBeGreaterThan(0)
  })
})
