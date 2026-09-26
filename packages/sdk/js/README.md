# Vector JavaScript SDK

A typed client for a Vector server, plus helpers to start and stop the local `vector` process. The package contains compiled ESM and TypeScript declarations; it does not include an agent executable or provider credentials. Node.js 22 or newer is required.

The first public npm publication is pending owner approval. After publication, install the matching release with `npm install @vectordevai/sdk`. Install the Vector CLI separately and sign in with `vector login` when the CLI requires an account.

Start a server in the repository you want to work on:

```sh
vector serve --hostname 127.0.0.1 --port 4096
```

Connect to it:

```ts
import { createVectorClient } from "@vectordevai/sdk/v2/client"

const client = createVectorClient({
  baseUrl: "http://127.0.0.1:4096",
  directory: process.cwd(),
  throwOnError: true,
})
const health = await client.global.health()
console.log(health.data)
const session = await client.session.create({ title: "SDK example" })
console.log(session.data?.id)
```

`@vectordevai/sdk/client` retains the grouped v1 parameter shape (`{ path, body, query }`). The `/v2/client` entry uses flat parameters. Its namespace describes the client API shape; it is not a promise that every server route uses the experimental session engine. Generate and release the client against the corresponding server version.

To manage a local server process:

```ts
import { createVectorServer } from "@vectordevai/sdk/v2/server"

const controller = new AbortController()
const server = await createVectorServer({ port: 0, signal: controller.signal })
try {
  console.log(server.url)
} finally {
  server.close()
}
```

The launcher resolves `vector` from PATH, inherits your environment, and passes explicit configuration using `VECTOR_CONFIG_CONTENT`. It never installs the CLI or signs in on your behalf. An AbortSignal or `close()` stops the child. Use `/v2/client` alone in browsers; server launchers require Node process APIs.

For an authenticated server, pass an `Authorization` header through the client `headers` option using the credentials configured with `VECTOR_SERVER_USERNAME` and `VECTOR_SERVER_PASSWORD`. Keep those credentials on your trusted server or application process. Bind to loopback unless you have deliberately configured authenticated network access; the API can operate on files and run tools. Do not expose it as a public unauthenticated API.

All public export paths ship their JavaScript and declarations. `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `DEPENDENCY_NOTICES.md` describe the applicable rights. Publication does not change the license of Vector-owned materials.
