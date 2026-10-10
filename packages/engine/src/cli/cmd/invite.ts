import { Effect } from "effect"
import { randomBytes } from "crypto"
import { realpathSync } from "node:fs"
import open from "open"
import { Flag } from "@vectordevai/core/flag/flag"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { UI } from "../ui"
import { CliError, effectCmd } from "../effect-cmd"
import { resolveNetworkOptions, withNetworkOptions } from "../network"
import { getNetworkIPs } from "./web"

const GUEST_USERNAME = "guest"

function secret() {
  return randomBytes(18).toString("base64url")
}

export function inviteLink(base: string | URL, username: string, password: string) {
  const url = new URL(base)
  url.hash = new URLSearchParams({ auth_token: Buffer.from(`${username}:${password}`).toString("base64") }).toString()
  return url.toString()
}

export function publicInviteURL(input: string | undefined) {
  if (!input) return
  const url = new URL(input)
  if (url.protocol !== "https:") throw new Error("--public-url must use HTTPS")
  if (url.username || url.password || url.search || url.hash)
    throw new Error("--public-url must not contain credentials, a query, or a fragment")
  if (url.pathname !== "/") throw new Error("--public-url must be an origin without a path")
  return url
}

export function configureInviteAccess(
  owner: { username: string; password: string },
  guest: { username: string; password: string },
) {
  const workspaceID = Flag.VECTOR_WORKSPACE_ID ? WorkspaceV2.ID.make(Flag.VECTOR_WORKSPACE_ID) : WorkspaceV2.ID.create()
  process.env.VECTOR_SERVER_USERNAME = owner.username
  process.env.VECTOR_SERVER_PASSWORD = owner.password
  process.env.VECTOR_SERVER_GUEST_USERNAME = guest.username
  process.env.VECTOR_SERVER_GUEST_PASSWORD = guest.password
  process.env.VECTOR_SERVER_GUEST_WORKSPACES = workspaceID
  process.env.VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES = JSON.stringify({ [workspaceID]: realpathSync(process.cwd()) })
  delete process.env.VECTOR_SERVER_GUEST_SESSIONS
  process.env.VECTOR_WORKSPACE_ID = workspaceID
  Flag.VECTOR_SERVER_USERNAME = owner.username
  Flag.VECTOR_SERVER_PASSWORD = owner.password
  Flag.VECTOR_WORKSPACE_ID = workspaceID
  return workspaceID
}

export const InviteCommand = effectCmd({
  command: "invite",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("open", {
        type: "boolean",
        describe: "open your workspace in the browser",
        default: true,
      })
      .option("public-url", {
        type: "string",
        describe: "HTTPS origin of a tunnel or reverse proxy teammates can reach",
      }),
  describe: "start the server and print an invite link so teammates can join your live workspace",
  // Same as `web`: instances load per request via the x-vector-directory header.
  instance: false,
  handler: Effect.fn("Cli.invite")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const publicUrl = yield* Effect.try({
      try: () => publicInviteURL(args["public-url"]),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : "Invalid --public-url" }),
    })

    // Two credential pairs: yours (reuse VECTOR_SERVER_PASSWORD when set) and a
    // fresh one for guests. Server.listen reads both from process.env through a
    // fresh ConfigProvider, and Flag keeps this process's own clients in sync.
    const owner = {
      username: Flag.VECTOR_SERVER_USERNAME || "vector",
      password: Flag.VECTOR_SERVER_PASSWORD || secret(),
    }
    const guest = {
      username: process.env.VECTOR_SERVER_GUEST_USERNAME || GUEST_USERNAME,
      password: secret(),
    }
    configureInviteAccess(owner, guest)

    // Password listeners stay loopback by default. Remote sharing terminates TLS
    // at the explicitly configured public tunnel or reverse proxy, and a network
    // bind needs --trusted-network, since plain HTTP carries the password.
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    // A wildcard bind answers on localhost for you and on this machine's addresses for teammates.
    const wildcard = opts.hostname === "0.0.0.0" || opts.hostname === "::"
    const local = wildcard ? new URL(`http://localhost:${server.port}`) : server.url
    const network = wildcard && !publicUrl ? getNetworkIPs().map((ip) => new URL(`http://${ip}:${server.port}`)) : []
    const guestBases = publicUrl ? [publicUrl] : network.length ? network : [local]
    const ownerUrl = inviteLink(local, owner.username, owner.password)

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Your workspace:    ", UI.Style.TEXT_NORMAL, ownerUrl)
    for (const base of guestBases) {
      UI.println(
        (publicUrl || network.length ? UI.Style.TEXT_SUCCESS_BOLD : UI.Style.TEXT_WARNING_BOLD) +
          "  Invite teammates:  ",
        UI.Style.TEXT_NORMAL,
        inviteLink(base, guest.username, guest.password),
      )
    }
    if (opts.mdns) {
      UI.println(
        UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
        UI.Style.TEXT_NORMAL,
        `${opts.mdnsDomain}:${server.port}`,
      )
    }
    UI.empty()
    UI.println(
      UI.Style.TEXT_DIM +
        (publicUrl
          ? "  The invite uses your HTTPS public URL while the password listener remains local."
          : network.length
            ? "  The invite works for teammates on this network, which you marked trusted: it carries the password over plain HTTP." +
              " From elsewhere, use a TLS tunnel and --public-url instead."
            : "  This link is local only. To invite teammates on a network you trust, rerun with --hostname 0.0.0.0 --trusted-network;" +
              ` from elsewhere, expose the listener through a TLS tunnel (tailscale serve ${server.port}, cloudflared tunnel --url ${local.origin}) and rerun with --public-url https://your-host.`),
    )
    UI.println(
      UI.Style.TEXT_DIM +
        `  Teammates appear as "${guest.username}". The link carries their password, so share it only with people you trust. Ctrl+C ends the session for everyone.`,
    )
    UI.empty()

    if (args.open) open(ownerUrl).catch(() => {})

    yield* Effect.never
  }),
})
