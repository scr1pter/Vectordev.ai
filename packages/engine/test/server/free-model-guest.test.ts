import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Flag } from "@vectordevai/core/flag/flag"
import { FreeModels } from "@vectordevai/core/free-models"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import {
  FREE_MODEL_TRAINING_CONSENT_REQUIRED,
  FREE_MODEL_TRAINING_GUEST_SESSION,
  FREE_MODEL_TRAINING_OWNER_ONLY,
} from "@vectordevai/core/free-model-choice"
import { Global } from "@vectordevai/core/global"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { testProviderConfig } from "../lib/test-provider"

const laguna = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}
const cohere = FREE_MODEL_FALLBACKS[0]
const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
  "VECTOR_CLI_TOKEN",
] as const

type Outbound = { url: string; model?: string; consent?: string; text: string }

/**
 * The owner has accepted the training notice and is signed in to Vector, the cached catalog lists Cohere (no-training)
 * and Laguna (may-train), and an invited guest may work in the test directory. Model fetches are off in tests, so the
 * engine serves that cached catalog. Every request that would leave this machine is refused here and recorded, so
 * nothing reaches vectordev.ai through the legacy route, and a test can say whether the engine tried to send to Laguna.
 */
async function serve(
  run: (input: Harness) => Promise<void>,
  options: {
    answer?: (request: Request) => Response | undefined | Promise<Response | undefined>
    /** Extra configuration, or a function of the test provider's base URL that returns it. */
    config?: Record<string, unknown> | ((base: string) => Record<string, unknown>)
  } = {},
) {
  // The configured test provider refuses every request at once unless `answer` replies, so a turn on it ends without
  // waiting to retry.
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await options.answer?.(request)) ??
      Response.json({ error: { message: "The test provider answers nothing." } }, { status: 400 }),
  })
  await using tmp = await tmpdir({
    trusted: true,
    config: {
      ...testProviderConfig(`${provider.url.origin}/v1`),
      ...(typeof options.config === "function" ? options.config(`${provider.url.origin}/v1`) : options.config),
    },
  })
  const cache = path.join(Global.Path.cache, "free-models-v2.json")
  await mkdir(path.dirname(cache), { recursive: true })
  await writeFile(cache, JSON.stringify({ enabled: true, updatedAt: Date.now(), models: [cohere, laguna] }))
  const consent = FreeModels.createClient({ consentFile: FreeModels.trainingConsentFile() })
  await consent.setTrainingConsent(true)
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
    // The owner is signed in to Vector, so the engine lists the shared allowance's models.
    VECTOR_CLI_TOKEN: "vct_synthetic-owner.token",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const local = fetch
  const outbound: Outbound[] = []
  // The one stand-in this test needs: the engine's requests to vectordev.ai. Loopback requests, to this server and to
  // the test provider, go through untouched.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (new URL(url).hostname === "127.0.0.1") return local(input, init)
      // The v1 engine sends a string body; the v2 runner's HTTP client sends bytes.
      const text =
        input instanceof Request ? await input.clone().text() : init?.body ? await new Response(init.body).text() : ""
      const body = text ? (JSON.parse(text) as { model?: string }) : {}
      outbound.push({
        url,
        model: body.model,
        consent:
          new Headers(input instanceof Request ? input.headers : init?.headers).get(
            "x-vector-free-model-training-consent",
          ) ?? undefined,
        text,
      })
      // 400, not 503, so the engine does not wait to retry it.
      return Response.json({ error: { message: "This test refuses every outside request." } }, { status: 400 })
    },
    { preconnect: local.preconnect },
  )
  const owner = { authorization: ServerAuth.header({ username: "vector", password: "owner-secret" }) ?? "" }
  const guest = { authorization: ServerAuth.header({ username: "guest", password: "guest-secret" }) ?? "" }
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  const harness: Harness = {
    owner,
    guest,
    outbound,
    get: (route, headers) => local(at(route), { headers, keepalive: false }),
    send: (route, headers, body) =>
      local(at(route), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: false,
      }),
    toLaguna: () => outbound.filter((item) => item.model === laguna.id),
  }
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    await run(harness)
  } finally {
    globalThis.fetch = local
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await consent.setTrainingConsent(false)
    await rm(cache, { force: true })
  }
}

type Harness = {
  owner: Record<string, string>
  guest: Record<string, string>
  outbound: Outbound[]
  get: (route: string, headers: Record<string, string>) => Promise<Response>
  send: (route: string, headers: Record<string, string>, body: unknown) => Promise<Response>
  toLaguna: () => Outbound[]
}

type Message = { info: { role: string; error?: { data?: { message?: string } } }; parts: { type: string }[] }

const messages = async (h: Harness, session: string) =>
  (await (await h.get(`/session/${session}/message`, h.owner)).json()) as Message[]

const newSession = async (h: Harness, headers: Record<string, string>) =>
  ((await (await h.send("/session", headers, {})).json()) as { id: string }).id

test("an invited guest is neither offered nor sent to a free model that may train, though the owner accepted", async () => {
  await serve(async (h) => {
    const listed = async (headers: Record<string, string>) => {
      const body = (await (await h.get("/provider", headers)).json()) as {
        all: { id: string; models: Record<string, unknown> }[]
      }
      return Object.keys(body.all.find((provider) => provider.id === "vector")?.models ?? {})
    }
    // The owner is offered the model and has accepted; the guest is offered no-training models only and has no
    // acceptance of its own.
    expect(await listed(h.owner)).toContain(laguna.id)
    expect(await listed(h.guest)).toEqual([cohere.id])
    expect(await (await h.get("/provider/free-models/consent", h.owner)).json()).toEqual({ training: true })
    expect(await (await h.get("/provider/free-models/consent", h.guest)).json()).toEqual({ training: false })
    expect((await h.send("/provider/free-models/consent", h.guest, { training: true })).status).toBe(403)

    // A guest's prompt naming the model is refused before anything is saved.
    const session = await newSession(h, h.guest)
    const refused = await h.send(`/session/${session}/message`, h.guest, {
      model: { providerID: "vector", modelID: laguna.id },
      parts: [{ type: "text", text: "hello" }],
    })
    expect(refused.ok).toBe(false)
    expect(await messages(h, session)).toEqual([])

    // On the v2 route the prompt runs on the session's model, which the owner set to the may-train one.
    expect(
      (await h.send(`/api/session/${session}/model`, h.owner, { model: { providerID: "vector", id: laguna.id } }))
        .status,
    ).toBe(204)
    const v2 = await h.send(`/api/session/${session}/prompt`, h.guest, { prompt: { text: "hello" }, resume: false })
    expect(v2.status).toBe(403)
    expect(((await v2.json()) as { message: string }).message).toBe(FREE_MODEL_TRAINING_OWNER_ONLY)
    // Nor may the guest switch the session to it.
    const switched = await h.send(`/api/session/${session}/model`, h.guest, {
      model: { providerID: "vector", id: laguna.id },
    })
    expect(switched.status).toBe(403)
    expect(h.toLaguna()).toEqual([])
  })
}, 60_000)

test("a guest's compaction on a may-train model is refused before a compaction is recorded", async () => {
  await serve(async (h) => {
    const session = await newSession(h, h.guest)
    expect(
      (
        await h.send(`/session/${session}/message`, h.guest, {
          model: { providerID: "vector", modelID: cohere.id },
          noReply: true,
          parts: [{ type: "text", text: "guest secret prompt" }],
        })
      ).ok,
    ).toBe(true)
    const summarize = await h.send(`/session/${session}/summarize`, h.guest, {
      providerID: "vector",
      modelID: laguna.id,
    })
    expect(summarize.status).toBe(400)
    expect((await messages(h, session)).map((message) => message.info.role)).toEqual(["user"])
    expect(h.toLaguna()).toEqual([])
  })
}, 60_000)

test("a guest's subtask part naming a may-train model is refused before the prompt is saved", async () => {
  await serve(async (h) => {
    const session = await newSession(h, h.guest)
    const refused = await h.send(`/session/${session}/message`, h.guest, {
      model: { providerID: "lmstudio", modelID: "test-model" },
      parts: [
        {
          type: "subtask",
          prompt: "guest secret subtask",
          description: "probe",
          agent: "general",
          model: { providerID: "vector", modelID: laguna.id },
        },
      ],
    })
    expect(refused.ok).toBe(false)
    expect(await messages(h, session)).toEqual([])
    expect(h.toLaguna()).toEqual([])
  })
}, 60_000)

test("once a guest has worked in a session, no request in it goes to a may-train model, the owner's included", async () => {
  await serve(async (h) => {
    // The owner's prompt, a compaction and a subagent started by a subtask part, each on Laguna. A sent request for
    // each lands in `outbound`.
    const drive = async (session: string) => {
      await h.send(`/session/${session}/message`, h.owner, {
        model: { providerID: "vector", modelID: laguna.id },
        parts: [{ type: "text", text: "owner prompt" }],
      })
      await h.send(`/session/${session}/summarize`, h.owner, { providerID: "vector", modelID: laguna.id })
      await h.send(`/session/${session}/message`, h.owner, {
        model: { providerID: "lmstudio", modelID: "test-model" },
        parts: [
          {
            type: "subtask",
            prompt: "owner subtask",
            description: "probe",
            agent: "general",
            model: { providerID: "vector", modelID: laguna.id },
          },
        ],
      })
    }
    // The control: in a session no guest has touched, all three go out to Laguna with the owner's acceptance.
    await drive(await newSession(h, h.owner))
    expect(h.toLaguna().length).toBeGreaterThanOrEqual(3)
    expect(h.toLaguna().every((item) => item.consent === "accepted")).toBe(true)
    expect(h.toLaguna().some((item) => item.text.includes("owner subtask"))).toBe(true)
    h.outbound.length = 0

    // The guest writes in a session without running anything; its text is now part of that session's history.
    const shared = await newSession(h, h.guest)
    await h.send(`/session/${shared}/message`, h.guest, {
      model: { providerID: "vector", modelID: cohere.id },
      noReply: true,
      parts: [{ type: "text", text: "guest secret prompt" }],
    })
    // The same three requests there are refused where they would be sent.
    await drive(shared)
    expect(h.toLaguna()).toEqual([])
    expect(h.outbound.filter((item) => item.text.includes("guest secret"))).toEqual([])
    const errors = (await messages(h, shared)).flatMap((message) =>
      message.info.error?.data?.message ? [message.info.error.data.message] : [],
    )
    expect(errors.some((message) => message.includes(FREE_MODEL_TRAINING_GUEST_SESSION))).toBe(true)
  })
}, 90_000)

test("a guest's request forwarded from another engine keeps the session off may-train models here", async () => {
  await serve(async (h) => {
    // An engine forwarding its guest's request to this remote workspace authenticates as this engine's owner.
    const session = await newSession(h, h.owner)
    await h.send(
      `/session/${session}/message`,
      { ...h.owner, [GUEST_REQUEST_HEADER]: "1" },
      {
        model: { providerID: "vector", modelID: cohere.id },
        noReply: true,
        parts: [{ type: "text", text: "guest secret prompt" }],
      },
    )
    await h.send(`/session/${session}/message`, h.owner, {
      model: { providerID: "vector", modelID: laguna.id },
      parts: [{ type: "text", text: "owner prompt" }],
    })
    expect(h.toLaguna()).toEqual([])
  })
}, 60_000)

test("a fork of a session a guest worked in keeps it off may-train models", async () => {
  await serve(async (h) => {
    const shared = await newSession(h, h.guest)
    await h.send(`/session/${shared}/message`, h.guest, {
      model: { providerID: "vector", modelID: cohere.id },
      noReply: true,
      parts: [{ type: "text", text: "guest secret prompt" }],
    })
    // The owner forks it; the fork carries the guest's message, so it carries the guest's mark too.
    const fork = ((await (await h.send(`/session/${shared}/fork`, h.owner, {})).json()) as { id: string }).id
    expect(fork).not.toBe(shared)
    await h.send(`/session/${fork}/message`, h.owner, {
      model: { providerID: "vector", modelID: laguna.id },
      parts: [{ type: "text", text: "owner prompt in the fork" }],
    })
    expect(h.toLaguna()).toEqual([])
  })
}, 60_000)

test("a title request for a guest's session never goes to a may-train model", async () => {
  // The test provider answers every prompt, so the session gets a title, and the title agent runs on Laguna.
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const answer = () =>
    new Response(chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  await serve(
    async (h) => {
      // The title request starts once the main request is answered, and runs on beside the rest of the turn.
      const titled = async (session: string) => {
        await h.send(`/session/${session}/message`, session === own ? h.owner : h.guest, {
          model: { providerID: "lmstudio", modelID: "test-model" },
          parts: [{ type: "text", text: `first prompt of ${session}` }],
        })
        for (let attempt = 0; attempt < 100; attempt++) {
          if (h.outbound.some((item) => item.text.includes(`first prompt of ${session}`))) return
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      // The control: the owner's own session sends its title request to Laguna.
      const own = await newSession(h, h.owner)
      await titled(own)
      expect(h.toLaguna().filter((item) => item.text.includes(`first prompt of ${own}`)).length).toBe(1)
      // The guest's session is refused it where it would be sent, and so has no model-written title.
      const guest = await newSession(h, h.guest)
      await titled(guest)
      expect(h.toLaguna().filter((item) => item.text.includes(`first prompt of ${guest}`))).toEqual([])
    },
    { answer, config: { agent: { title: { model: `vector/${laguna.id}` } } } },
  )
}, 60_000)

// A guest answers here, or on another engine that forwards the answer to this remote workspace as its owner.
for (const replier of ["guest", "forwarded guest"] as const)
  test(`a ${replier}'s answer to a question keeps the session's later requests off may-train models`, async () => {
    // The test provider's first answer asks one question through the question tool; every later request is refused.
    const asked = { count: 0 }
    const question = () => {
      if (asked.count++ > 0) return undefined
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      const call = {
        index: 0,
        id: "call_question",
        type: "function",
        function: {
          name: "question",
          arguments: JSON.stringify({
            questions: [{ question: "Go on?", header: "Go on", options: [{ label: "Yes", description: "Go on" }] }],
          }),
        },
      }
      return new Response(
        chunk({ role: "assistant", tool_calls: [call] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    await serve(
      async (h) => {
        // The owner's session in the guest's workspace asks a question, which the guest answers.
        const session = await newSession(h, h.owner)
        await h.send(`/session/${session}/prompt_async`, h.owner, {
          model: { providerID: "lmstudio", modelID: "test-model" },
          parts: [{ type: "text", text: "owner prompt" }],
        })
        const pending = async () => {
          for (let attempt = 0; attempt < 300; attempt++) {
            const listed = (await (await h.get("/question", h.guest)).json()) as { id: string; sessionID: string }[]
            const found = listed.find((item) => item.sessionID === session)
            if (found) return found.id
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          throw new Error("The question was never asked")
        }
        const answerer = replier === "guest" ? h.guest : { ...h.owner, [GUEST_REQUEST_HEADER]: "1" }
        expect((await h.send(`/question/${await pending()}/reply`, answerer, { answers: [["Yes"]] })).ok).toBe(true)
        // The answer went to the model as a tool result, so the owner's next prompt there may not go to Laguna.
        await h.send(`/session/${session}/abort`, h.owner, {})
        await h.send(`/session/${session}/message`, h.owner, {
          model: { providerID: "vector", modelID: laguna.id },
          parts: [{ type: "text", text: "owner prompt on laguna" }],
        })
        expect(h.toLaguna()).toEqual([])
        const errors = (await messages(h, session)).flatMap((message) =>
          message.info.error?.data?.message ? [message.info.error.data.message] : [],
        )
        expect(errors.some((message) => message.includes(FREE_MODEL_TRAINING_GUEST_SESSION))).toBe(true)
      },
      { answer: question },
    )
  }, 60_000)

test("the v2 runner sends nothing to a may-train model in a session a guest has worked in", async () => {
  await serve(async (h) => {
    // The v2 runner drains a prompt in the background; a step's end or failure is recorded in the session's history.
    // A new location loads its catalog first, which can take a while on a busy machine.
    const step = async (session: string) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const history = (await (await h.get(`/api/session/${session}/history`, h.owner)).json()) as {
          data: { type: string; data: { error?: { message?: string } } }[]
        }
        const done = history.data.find((event) => /^session\.next\.step\.(failed|ended)$/.test(event.type))
        if (done) return done.data.error?.message ?? ""
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("The v2 runner did not finish a step")
    }
    // Without the owner's acceptance nothing goes out on either session, so this test never reaches the network: the
    // v2 runner's HTTP client may hold the fetch it found before this file replaced it. The guest rule is checked
    // first, so the guest's session names the guest, and the owner's own session names the missing acceptance.
    await FreeModels.createClient({ consentFile: FreeModels.trainingConsentFile() }).setTrainingConsent(false)
    const own = await newSession(h, h.owner)
    await h.send(`/api/session/${own}/model`, h.owner, { model: { providerID: "vector", id: laguna.id } })
    await h.send(`/api/session/${own}/prompt`, h.owner, { prompt: { text: "owner only" } })
    expect(await step(own)).toContain(FREE_MODEL_TRAINING_CONSENT_REQUIRED)

    const session = await newSession(h, h.guest)
    // The guest only switches the model, to a no-training one; the owner then switches it to Laguna and prompts.
    expect(
      (await h.send(`/api/session/${session}/model`, h.guest, { model: { providerID: "vector", id: cohere.id } }))
        .status,
    ).toBe(204)
    expect(
      (await h.send(`/api/session/${session}/model`, h.owner, { model: { providerID: "vector", id: laguna.id } }))
        .status,
    ).toBe(204)
    expect((await h.send(`/api/session/${session}/prompt`, h.owner, { prompt: { text: "owner prompt" } })).ok).toBe(
      true,
    )
    expect(await step(session)).toContain(FREE_MODEL_TRAINING_GUEST_SESSION)
    expect(h.toLaguna()).toEqual([])
  })
}, 120_000)

test("no one is offered or sent OpenRouter's free router or a zero-price stealth model on the owner's OpenRouter key", async () => {
  // The owner's own OpenRouter provider points at the test provider, which records every request it receives.
  const reached: string[] = []
  const paid = "deepseek/deepseek-chat-v3.1"
  const free = ["openrouter/free", "openrouter/owl-alpha", "openrouter/elephant-alpha"]
  await serve(
    async (h) => {
      const offered = async (headers: Record<string, string>) => {
        const body = (await (await h.get("/provider", headers)).json()) as {
          all: { id: string; models: Record<string, unknown> }[]
        }
        return Object.keys(body.all.find((provider) => provider.id === "openrouter")?.models ?? {})
      }
      for (const headers of [h.owner, h.guest]) {
        const listed = await offered(headers)
        expect(listed).toContain(paid)
        for (const modelID of free) expect(listed).not.toContain(modelID)
      }
      // The control: the owner's prompt on a paid OpenRouter model reaches the owner's OpenRouter provider.
      const own = await newSession(h, h.owner)
      await h.send(`/session/${own}/message`, h.owner, {
        model: { providerID: "openrouter", modelID: paid },
        parts: [{ type: "text", text: "owner prompt on a paid model" }],
      })
      expect(reached.some((text) => text.includes("owner prompt on a paid model"))).toBe(true)
      // Neither the guest nor the owner can send a prompt to a free router or a stealth model that way.
      for (const [who, headers] of [
        ["guest", h.guest],
        ["owner", h.owner],
      ] as const) {
        const session = await newSession(h, headers)
        for (const modelID of free)
          await h.send(`/session/${session}/message`, headers, {
            model: { providerID: "openrouter", modelID },
            parts: [{ type: "text", text: `${who} secret via ${modelID}` }],
          })
      }
      expect(reached.filter((text) => text.includes("secret via"))).toEqual([])
      expect(h.outbound.filter((item) => item.text.includes("secret via"))).toEqual([])
    },
    {
      answer: async (request) => {
        reached.push(await request.text())
        return undefined
      },
      config: (base) => ({
        provider: {
          ...testProviderConfig(base).provider,
          openrouter: { options: { apiKey: "sk-or-synthetic-not-a-key", baseURL: base } },
        },
      }),
    },
  )
}, 90_000)

test("a free OpenRouter model configured under another name, or under a provider pointed at OpenRouter, is never offered or sent", async () => {
  // The verifier's medium of 17 October 2026: every check judged the catalog name, never the ID sent, so a repository
  // alias reached the owner's OpenRouter key with a guest's text, the owner's acceptance and no provider block.
  const reached: string[] = []
  const aliases = {
    openrouter: ["alias-laguna", "alias-router"],
    "or-proxy": ["poolside/laguna-xs-2.1:free", "renamed"],
  }
  await serve(
    async (h) => {
      for (const headers of [h.owner, h.guest]) {
        const body = (await (await h.get("/provider", headers)).json()) as {
          all: { id: string; models: Record<string, unknown> }[]
        }
        for (const [providerID, modelIDs] of Object.entries(aliases)) {
          const listed = Object.keys(body.all.find((provider) => provider.id === providerID)?.models ?? {})
          for (const modelID of modelIDs) expect(listed).not.toContain(modelID)
        }
      }
      for (const [who, headers] of [
        ["guest", h.guest],
        ["owner", h.owner],
      ] as const) {
        const session = await newSession(h, headers)
        for (const [providerID, modelIDs] of Object.entries(aliases))
          for (const modelID of modelIDs)
            await h.send(`/session/${session}/message`, headers, {
              model: { providerID, modelID },
              parts: [{ type: "text", text: `${who} secret via ${providerID}/${modelID}` }],
            })
      }
      expect(reached.filter((text) => text.includes("secret via"))).toEqual([])
      expect(h.outbound.filter((item) => item.text.includes("secret via"))).toEqual([])
    },
    {
      answer: async (request) => {
        reached.push(await request.text())
        return undefined
      },
      config: (base) => ({
        provider: {
          ...testProviderConfig(base).provider,
          openrouter: {
            options: { apiKey: "sk-or-synthetic-not-a-key", baseURL: base },
            models: {
              "alias-laguna": { id: "poolside/laguna-s-2.1:free", name: "Alias" },
              "alias-router": { id: "openrouter/free", name: "Alias router" },
            },
          },
          // A provider of another name sending to openrouter.ai, which this test refuses and records.
          "or-proxy": {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "sk-or-synthetic-not-a-key", baseURL: "https://openrouter.ai/api/v1" },
            models: {
              "poolside/laguna-xs-2.1:free": { name: "Laguna XS" },
              renamed: { id: "thinkingmachines/inkling:free", name: "Renamed" },
            },
          },
        },
      }),
    },
  )
}, 90_000)

test("a session warped here from an engine where a guest worked in it stays off may-train models", async () => {
  await serve(async (h) => {
    // This engine is the remote workspace. The engine warping the session in replays its history, then steals it
    // with the owner's credentials, saying an invited guest worked in it there.
    const session = await newSession(h, h.owner)
    const stolen = await h.send("/sync/steal", { ...h.owner, [GUEST_REQUEST_HEADER]: "1" }, { sessionID: session })
    expect(stolen.status).toBe(200)
    await h.send(`/session/${session}/message`, h.owner, {
      model: { providerID: "vector", modelID: laguna.id },
      parts: [{ type: "text", text: "owner prompt after the warp" }],
    })
    expect(h.toLaguna()).toEqual([])
    const errors = (await messages(h, session)).flatMap((message) =>
      message.info.error?.data?.message ? [message.info.error.data.message] : [],
    )
    expect(errors.some((message) => message.includes(FREE_MODEL_TRAINING_GUEST_SESSION))).toBe(true)
  })
}, 60_000)
