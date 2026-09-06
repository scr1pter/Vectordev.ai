import { Effect } from "effect"
import { randomBytes } from "crypto"
import open from "open"
import { Flag } from "@opencode-ai/core/flag/flag"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { hasArg, resolveNetworkOptions, withNetworkOptions } from "../network"
import { getNetworkIPs } from "./web"

const GUEST_USERNAME = "guest"

function secret() {
  return randomBytes(18).toString("base64url")
}

// Same shape entry.tsx and the auth middleware consume: ?auth_token=<base64 user:pass>.
function link(host: string, port: number, username: string, password: string) {
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  return `http://${host}:${port}/?auth_token=${encodeURIComponent(token)}`
}

export const InviteCommand = effectCmd({
  command: "invite",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("open", {
      type: "boolean",
      describe: "open your workspace in the browser",
      default: true,
    }),
  describe: "start the server and print an invite link so teammates can join your live workspace",
  // Same as `web`: instances load per request via the x-opencode-directory header.
  instance: false,
  handler: Effect.fn("Cli.invite")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))

    // Two credential pairs: yours (reuse OPENCODE_SERVER_PASSWORD when set) and a
    // fresh one for guests. Server.listen reads both from process.env through a
    // fresh ConfigProvider, and Flag keeps this process's own clients in sync.
    const owner = {
      username: Flag.OPENCODE_SERVER_USERNAME || "opencode",
      password: Flag.OPENCODE_SERVER_PASSWORD || secret(),
    }
    const guest = {
      username: process.env.OPENCODE_SERVER_GUEST_USERNAME || GUEST_USERNAME,
      password: secret(),
    }
    process.env.OPENCODE_SERVER_USERNAME = owner.username
    process.env.OPENCODE_SERVER_PASSWORD = owner.password
    process.env.OPENCODE_SERVER_GUEST_USERNAME = guest.username
    process.env.OPENCODE_SERVER_GUEST_PASSWORD = guest.password
    Flag.OPENCODE_SERVER_USERNAME = owner.username
    Flag.OPENCODE_SERVER_PASSWORD = owner.password

    // Teammates have to reach this machine, so bind every interface unless the
    // caller picked a hostname explicitly.
    const resolved = yield* resolveNetworkOptions(args)
    const opts = hasArg("--hostname") ? resolved : { ...resolved, hostname: "0.0.0.0" }
    const server = yield* Effect.promise(() => Server.listen(opts))

    // localhost only when the server is bound to every interface; an explicit
    // --hostname binds that address alone, so localhost would not answer.
    const ownerHost = opts.hostname === "0.0.0.0" || opts.hostname === "::" ? "localhost" : opts.hostname
    const ownerUrl = link(ownerHost, server.port, owner.username, owner.password)
    const hosts = opts.hostname === "0.0.0.0" ? getNetworkIPs() : [opts.hostname]

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Your workspace:    ", UI.Style.TEXT_NORMAL, ownerUrl)
    if (hosts.length === 0) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "  Invite teammates:  ",
        UI.Style.TEXT_NORMAL,
        link("localhost", server.port, guest.username, guest.password),
      )
      UI.println(UI.Style.TEXT_WARNING + "  No network interface found; replace localhost with a reachable host.")
    }
    for (const host of hosts) {
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + "  Invite teammates:  ",
        UI.Style.TEXT_NORMAL,
        link(host, server.port, guest.username, guest.password),
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
        "  The invite link works for anyone on your network; from elsewhere, expose the port through your own tunnel" +
        ` (tailscale serve ${server.port}, cloudflared tunnel --url http://localhost:${server.port}) and share that host instead.`,
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
