import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@vectordevai/core/installation/version"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade vector to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["npm", "pnpm", "bun", "standalone", "homebrew", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const method = (args.method as Installation.Method | undefined) ?? (await Installation.method())
    if (method === "unknown") {
      prompts.log.error(`vector is installed to ${process.execPath} and may be managed by a package manager`)
      prompts.log.info(
        "Use the original installer or package manager. Vector will only replace an installation it can identify.",
      )
      process.exitCode = 1
      return
    }
    prompts.log.info("Using method: " + method)
    const target = args.target
      ? args.target.replace(/^v/, "")
      : await Installation.latest(method).catch(() => {
          prompts.log.error(
            ["npm", "pnpm", "bun"].includes(method)
              ? "Could not reach the configured npm registry. Check your registry configuration and connection, then retry."
              : "Could not read this installation channel. Check your connection and package-manager configuration, then retry.",
          )
          process.exitCode = 1
          return undefined
        })
    if (!target) return

    if (InstallationVersion === target) {
      prompts.log.warn(`vector upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const outcome = await Installation.upgrade(method, target).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    if ("error" in outcome) {
      const err = outcome.error
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        prompts.log.error(err.stderr)
      } else if (err instanceof Error) prompts.log.error(err.message)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    if (outcome.result.status === "scheduled") {
      spinner.stop("Verified update scheduled after this Vector process exits")
      prompts.log.info(`Completion status: ${outcome.result.statusFile}`)
      prompts.outro("Restart Vector after the status reports complete")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
