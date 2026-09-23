import type { Hooks, PluginInput } from "@vectordevai/plugin"
import { createServer } from "node:http"
import { gitlabSignInEnabled, providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import { InstallationVersion } from "@vectordevai/core/installation/version"

export async function GitlabAuthPlugin(input: PluginInput): Promise<Hooks> {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID?.trim()
  const enabled = gitlabSignInEnabled()
  const redirect = "http://127.0.0.1:8080/callback"
  const instance = (value?: string) => new URL(value || process.env.GITLAB_INSTANCE_URL || "https://gitlab.com").origin
  const prompts = [
    {
      type: "text" as const,
      key: "instanceUrl",
      message: "GitLab instance URL",
      placeholder: process.env.GITLAB_INSTANCE_URL || "https://gitlab.com",
      validate(value: string) {
        if (!value) return undefined
        const url = URL.parse(value)
        return url && ["https:", "http:"].includes(url.protocol) ? undefined : "Enter an HTTP or HTTPS instance URL"
      },
    },
  ]

  async function token(url: string, body: Record<string, string>) {
    const response = await fetch(`${url}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `vector/${InstallationVersion}` },
      body: new URLSearchParams({ ...body, client_id: clientId! }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GitLab authorization failed (${response.status})`)
    const value: { access_token: string; refresh_token: string; expires_in: number } = await response.json()
    return {
      type: "oauth" as const,
      access: value.access_token,
      refresh: value.refresh_token,
      expires: Date.now() + value.expires_in * 1000,
      enterpriseUrl: url,
      clientId,
    }
  }

  return {
    auth: {
      provider: "gitlab",
      async loader(getAuth) {
        const auth = await getAuth()
        if (!providerCredentialAllowed("gitlab", auth)) return {}
        if (auth.type === "api") return { apiKey: auth.key, instanceUrl: instance(auth.metadata?.instanceUrl) }
        if (auth.type !== "oauth" || !enabled) return {}
        const value =
          auth.expires > Date.now() + 60_000
            ? auth
            : await token(instance(auth.enterpriseUrl), { grant_type: "refresh_token", refresh_token: auth.refresh })
        if (value !== auth) await input.client.auth.set({ path: { id: "gitlab" }, body: value })
        return { apiKey: value.access, instanceUrl: instance(value.enterpriseUrl), clientId }
      },
      methods: (
        [
          {
            type: "oauth",
            label: "GitLab OAuth (configured app)",
            prompts,
            async authorize(inputs) {
              if (!enabled || !clientId) throw new Error("Configure GITLAB_OAUTH_CLIENT_ID before signing in")
              const origin = instance(inputs?.instanceUrl)
              const verifier = crypto.randomUUID() + crypto.randomUUID()
              const challenge = Buffer.from(
                await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
              ).toString("base64url")
              const state = crypto.randomUUID()
              const pending = Promise.withResolvers<string>()
              // Attach a handler immediately: the browser may fail before callback() starts awaiting.
              void pending.promise.catch(() => undefined)
              const server = createServer((request, response) => {
                const url = new URL(request.url || "/", redirect)
                if (url.pathname !== "/callback") {
                  response.writeHead(404).end()
                  return
                }
                if (url.searchParams.get("state") !== state) {
                  response.writeHead(400).end("Invalid authorization state")
                  return
                }
                const code = url.searchParams.get("code")
                if (!code) {
                  pending.reject(new Error("GitLab sign-in did not return an authorization code"))
                  response.writeHead(400).end("GitLab sign-in failed. Return to Vector.")
                  return
                }
                pending.resolve(code)
                response.writeHead(200, { "Content-Type": "text/plain" }).end("Signed in. Return to Vector.")
              })
              await new Promise<void>((resolve, reject) => {
                server.once("error", reject)
                server.listen(8080, "127.0.0.1", resolve)
              })
              const timeout = setTimeout(() => {
                pending.reject(new Error("GitLab sign-in timed out"))
                server.close()
              }, 120_000)
              const url = new URL(`${origin}/oauth/authorize`)
              url.search = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirect,
                response_type: "code",
                scope: "api read_user",
                state,
                code_challenge: challenge,
                code_challenge_method: "S256",
              }).toString()
              return {
                method: "auto" as const,
                url: url.toString(),
                instructions: "Authorize Vector using your configured GitLab application.",
                async callback() {
                  const result = await pending.promise
                    .then((code) =>
                      token(origin, {
                        grant_type: "authorization_code",
                        code,
                        code_verifier: verifier,
                        redirect_uri: redirect,
                      }),
                    )
                    .finally(() => {
                      clearTimeout(timeout)
                      server.close()
                    })
                  return { ...result, type: "success" as const }
                },
              }
            },
          },
          { type: "api", label: "GitLab Personal Access Token", prompts },
        ] satisfies NonNullable<Hooks["auth"]>["methods"]
      ).filter((method) => enabled || method.type !== "oauth"),
    },
  }
}
