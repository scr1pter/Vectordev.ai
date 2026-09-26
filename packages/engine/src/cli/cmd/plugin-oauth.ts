import path from "node:path"
import { cmd } from "./cmd"
import {
  inspectOAuthPlugin,
  readOAuthApprovals,
  revokeOAuthApproval,
  warning,
  writeOAuthApproval,
} from "@vectordevai/core/plugin/oauth-approval"

export const PluginOAuthCommand = cmd({
  command: "plugin",
  describe: "manage explicit OAuth consent for owned-client plugins",
  builder: (yargs) =>
    yargs
      .command(
        cmd({
          command: "approve <entry>",
          describe: "inspect and approve the exact installed plugin content",
          builder: (yargs) =>
            yargs
              .positional("entry", {
                type: "string",
                demandOption: true,
                describe: "installed plugin entrypoint path (its directory must contain package.json)",
              })
              .option("provider", {
                type: "string",
                demandOption: true,
                describe: "provider ID declared in vectorOAuth",
              })
              .option("accept-risk", {
                type: "boolean",
                default: false,
                describe: "explicitly trust this exact plugin and its declared owned client",
              }),
          async handler(args) {
            const value = inspectOAuthPlugin(path.resolve(args.entry)).find(
              (value) => value.declaration.provider === args.provider,
            )
            if (!value) throw new Error("This installed plugin does not declare the requested provider's OAuth client.")
            process.stdout.write(JSON.stringify(value, null, 2) + "\n")
            process.stderr.write(warning + "\n")
            if (!args.acceptRisk) {
              process.stderr.write(
                "Review the registration and digest above, then rerun with --accept-risk to opt in.\n",
              )
              process.exitCode = 1
              return
            }
            writeOAuthApproval(value)
            process.stdout.write(
              `Approved ${value.plugin}@${value.version} for ${value.declaration.provider}. Restart Vector to load the approved plugin.\n`,
            )
          },
        }),
      )
      .command(
        cmd({
          command: "revoke <id>",
          describe: "revoke a plugin OAuth approval immediately",
          builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
          async handler(args) {
            revokeOAuthApproval(args.id)
            process.stdout.write("Plugin OAuth approval revoked.\n")
          },
        }),
      )
      .command(
        cmd({
          command: "list",
          describe: "list explicitly approved plugin OAuth registrations",
          async handler() {
            process.stdout.write(JSON.stringify(readOAuthApprovals(), null, 2) + "\n")
          },
        }),
      )
      .demandCommand(),
  async handler() {},
})
