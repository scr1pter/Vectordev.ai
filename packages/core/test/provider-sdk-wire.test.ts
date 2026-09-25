import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import path from "node:path"
import os from "node:os"

test("actual watsonx IAM and SAP OAuth SDK flows isolate credentials and bound cancellation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-provider-wire-"))
  const certificate = path.join(home, "cert.pem")
  const key = path.join(home, "key.pem")
  const hosts = ["iam.cloud.ibm.com", "watsonx.fixture.test", "sap-auth.fixture.test", "sap.fixture.test"]
  const openssl = Bun.which("openssl")
  expect(openssl).toBeDefined()
  const ca = Bun.spawn(
    [
      openssl!,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=Vector provider fixture",
      "-addext",
      `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  expect(await ca.exited, await new Response(ca.stderr).text()).toBe(0)
  const calls: { host: string; path: string; auth: string | null; body: string }[] = []
  const denied: string[] = []
  let unauthorized = false
  const answer = {
    id: "fixture",
    object: "chat.completion",
    created: 1,
    model: "fixture",
    model_id: "fixture",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "fixture answer",
          tool_calls: [
            { id: "call-fixture", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.text()
      calls.push({ host: url.hostname, path: url.pathname, auth: request.headers.get("authorization"), body })
      if (url.hostname === "iam.cloud.ibm.com" && url.pathname === "/identity/token") {
        const params = new URLSearchParams(body)
        const apiKey = params.get("apikey")
        if (apiKey === "fixture-denied") return new Response("fixture-private-secret", { status: 401 })
        if (apiKey === "fixture-delayed") await Bun.sleep(250)
        return Response.json({ access_token: `iam-${apiKey}`, expires_in: 3600 })
      }
      if (
        url.hostname === "watsonx.fixture.test" &&
        ["/ml/v1/text/chat", "/ml/v1/text/chat_stream"].includes(url.pathname)
      ) {
        if (!unauthorized) {
          unauthorized = true
          return Response.json({ errors: [{ code: "expired", message: "fixture retry" }] }, { status: 401 })
        }
        return url.pathname.endsWith("chat_stream") ? streamReply(false) : Response.json(answer)
      }
      if (url.hostname === "sap-auth.fixture.test" && url.pathname === "/oauth/token") {
        const basic = Buffer.from((request.headers.get("authorization") ?? "").slice(6), "base64").toString()
        if (basic.startsWith("fixture-denied:")) return new Response("fixture-private-secret", { status: 401 })
        return Response.json({ access_token: `sap-${basic.split(":")[0]}`, expires_in: 1 })
      }
      if (url.hostname === "sap.fixture.test") {
        if (request.method === "GET" && url.pathname.includes("/deployments/"))
          return Response.json({ deploymentUrl: "https://sap.fixture.test/inference" })
        if (request.method === "POST" && url.pathname.startsWith("/v2/inference/"))
          return JSON.parse(body).config?.stream?.enabled === true
            ? streamReply(true)
            : Response.json({ request_id: "fixture-request", final_result: answer })
      }
      denied.push(url.href)
      return new Response("Unexpected fixture endpoint", { status: 403 })
    },
  })
  const proxy = createServer((_request, response) => response.writeHead(403).end())
  proxy.on("connect", (request, client, head) => {
    if (!hosts.some((host) => request.url === `${host}:443`)) {
      denied.push(request.url ?? "")
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    const socket = connect(upstream.port!, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) socket.write(head)
      client.pipe(socket)
      socket.pipe(client)
    })
    socket.on("error", () => client.destroy())
    client.on("error", () => socket.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  expect(address && typeof address !== "string").toBe(true)
  const proxyURL = `http://127.0.0.1:${(address as { port: number }).port}`
  try {
    const child = Bun.spawn(
      process.env.VECTOR_TEST_PROVIDER_BINARY
        ? [path.resolve(process.env.VECTOR_TEST_PROVIDER_BINARY)]
        : [process.execPath, path.join(import.meta.dir, "fixture/provider-sdk-wire.ts")],
      {
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          HTTPS_PROXY: proxyURL,
          HTTP_PROXY: proxyURL,
          https_proxy: proxyURL,
          http_proxy: proxyURL,
          NODE_EXTRA_CA_CERTS: certificate,
          SSL_CERT_FILE: certificate,
          SAP_CLOUD_SDK_LOG_LEVEL: "error",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${stderr}\n${stdout}\npaths=${JSON.stringify(calls.map(({ host, path }) => ({ host, path })))}`).toBe(
      0,
    )
    expect(stdout).toContain("provider-sdk-wire: PASS")
    expect(denied).toEqual([])
    const iam = calls.filter((call) => call.host === "iam.cloud.ibm.com")
    expect(iam.filter((call) => new URLSearchParams(call.body).get("apikey") === "fixture-a")).toHaveLength(2)
    expect(iam.filter((call) => new URLSearchParams(call.body).get("apikey") === "fixture-b")).toHaveLength(1)
    const inference = calls.filter((call) => call.host === "watsonx.fixture.test")
    expect(inference.map((call) => call.auth)).toEqual([
      "Bearer iam-fixture-a",
      "Bearer iam-fixture-a",
      "Bearer iam-fixture-a",
      "Bearer iam-fixture-b",
      "Bearer iam-fixture-a",
    ])
    expect(inference.every((call) => JSON.parse(call.body).project_id === "fixture-project")).toBe(true)
    const sap = calls.filter((call) => call.host === "sap.fixture.test" && call.path.startsWith("/v2/inference/"))
    expect(sap.map((call) => call.auth)).toEqual([
      "Bearer sap-fixture-a",
      "Bearer sap-fixture-a",
      "Bearer sap-fixture-b",
      "Bearer sap-fixture-a",
    ])
    expect(calls.filter((call) => call.host === "sap-auth.fixture.test")).toHaveLength(5)
  } finally {
    proxy.closeAllConnections()
    proxy.close()
    upstream.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

function streamReply(sap: boolean) {
  const chunks = [
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      model_id: "fixture",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-fixture",
                type: "function",
                function: { name: "read", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      model_id: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    },
  ]
  return new Response(
    chunks
      .map((part) => `data: ${JSON.stringify(sap ? { request_id: "fixture-request", final_result: part } : part)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
