import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Flag } from "@vectordevai/core/flag/flag"
import { FreeModels } from "@vectordevai/core/free-models"
import { FREE_MODEL_TRAINING_GUEST_SESSION, FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
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
 * engine serves that cached catalog. Every request that would leave this machine is refused here and recorded, so nothing reaches vectordev.ai, and a test can say whether the engine tried to send to Laguna.
 */
async function serve(run: (input: Harness) => Promise<void>, answer?: (request: Request) => Response | undefined) {
  // The configured test provider refuses every request at once unless `answer` replies, so a turn on it ends without
  // waiting to retry.
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      answer?.(request) ?? Response.json({ error: { message: "The test provider answers nothing." } }, { status: 400 }),
  })
  await using tmp = await tmpdir({ trusted: true, config: testProviderConfig(`${provider.url.origin}/v1`) })
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

test("a guest's answer to a question keeps the session's later requests off may-train models", async () => {
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
  await serve(async (h) => {
    // The owner's session in the guest's workspace asks a question, which the guest answers.
    const session = await newSession(h, h.owner)
    await h.send(`/session/${session}/prompt_async`, h.owner, {
      model: { providerID: "lmstudio", modelID: "test-model" },
      parts: [{ type: "text", text: "owner prompt" }],
    })
    const pending = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const listed = (await (await h.get("/question", h.guest)).json()) as { id: string; sessionID: string }[]
        const found = listed.find((item) => item.sessionID === session)
        if (found) return found.id
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("The question was never asked")
    }
    expect((await h.send(`/question/${await pending()}/reply`, h.guest, { answers: [["Yes"]] })).ok).toBe(true)
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
  }, question)
}, 60_000)

test("the v2 runner sends nothing to a may-train model in a session a guest has worked in", async () => {
  await serve(async (h) => {
    // The v2 runner drains a prompt in the background; a step's end or failure is recorded in the session's history.
    const step = async (session: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const history = (await (await h.get(`/api/session/${session}/history`, h.owner)).json()) as {
          data: { type: string; data: { error?: { message?: string } } }[]
        }
        const done = history.data.find((event) => /^session\.next\.step\.(failed|ended)$/.test(event.type))
        if (done) return done.data.error?.message ?? ""
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("The v2 runner did not finish a step")
    }
    // The control: the owner's own v2 session sends to Laguna with the acceptance.
    const own = await newSession(h, h.owner)
    await h.send(`/api/session/${own}/model`, h.owner, { model: { providerID: "vector", id: laguna.id } })
    await h.send(`/api/session/${own}/prompt`, h.owner, { prompt: { text: "owner only" } })
    await step(own)
    expect(h.toLaguna().map((item) => item.consent)).toContain("accepted")
    h.outbound.length = 0

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
}, 60_000)
