import type { GithubAuth } from "./github.auth"

type Run = (args: string[], env?: Record<string, string>) => Promise<{ exitCode: number; text(): string }>

/** App credentials are available only to the infrastructure's Git subprocesses, never model tools. */
export async function prepareGithubGit(input: {
  auth: GithubAuth
  run: Run
  mask: (value: string) => void
  identity?: boolean
}) {
  if (input.auth.source === "app" && !input.auth.botId)
    throw new Error("Repository-scoped Git requires verified App identity.")
  const root = `https://github.com/${input.auth.repository}`
  const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.auth.token}`).toString("base64")}`
  input.mask(authorization)
  const config = [
    ["credential.helper", ""],
    ["credential.useHttpPath", "true"],
    ["http.extraheader", ""],
    ["http.https://github.com/.extraheader", ""],
    [`http.${root}.extraheader`, ""],
    [`http.${root}.extraheader`, authorization],
    [`http.${root}.git.extraheader`, ""],
    [`http.${root}.git.extraheader`, authorization],
    ["http.followRedirects", "false"],
    ["http.sslVerify", "true"],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fetch.recurseSubmodules", "false"],
    ["push.recurseSubmodules", "no"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
  ]
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSL_NO_VERIFY: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_PARAMETERS: "",
    GIT_TRACE: "0",
    GIT_TRACE_CURL: "0",
    GIT_CURL_VERBOSE: "0",
    GIT_TRACE_PACKET: "0",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
  const verify = async () => {
    for (const args of [
      ["remote", "get-url", "--all", "origin"],
      ["remote", "get-url", "--push", "--all", "origin"],
    ]) {
      const result = await input.run(args, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
      })
      const urls = result.text().trim().split("\n")
      if (result.exitCode !== 0 || urls.length !== 1 || ![root, `${root}.git`].includes(urls[0]))
        throw new Error("Vector App Git operations require origin to be the exact verified HTTPS repository.")
    }
  }
  await verify()
  if (input.identity === false) return { env, verify, dispose: async () => {} }
  const previous = await Promise.all(
    ["user.name", "user.email"].map(async (key) => {
      const result = await input.run(["config", "--local", "--get-all", key])
      if (![0, 1].includes(result.exitCode)) throw new Error("Could not read the repository's Git identity.")
      return { key, values: result.exitCode === 0 ? result.text().trimEnd().split("\n") : [] }
    }),
  )
  const dispose = async () => {
    for (const item of previous) {
      const cleared = await input.run(["config", "--local", "--unset-all", item.key])
      if (![0, 5].includes(cleared.exitCode)) throw new Error("Could not restore the repository's Git identity.")
      for (const value of item.values) {
        if ((await input.run(["config", "--local", "--add", item.key, value])).exitCode !== 0)
          throw new Error("Could not restore the repository's Git identity.")
      }
    }
  }
  try {
    for (const [key, value] of [
      ["user.name", input.auth.botLogin],
      ["user.email", `${input.auth.botId ?? 41898282}+${input.auth.botLogin}@users.noreply.github.com`],
    ]) {
      if ((await input.run(["config", "--local", "--replace-all", key, value])).exitCode !== 0)
        throw new Error("Could not configure the Vector App's repository Git identity.")
    }
  } catch (error) {
    await dispose()
    throw error
  }
  return { env, verify, dispose }
}
