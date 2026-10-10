import { Flag } from "@vectordevai/core/flag/flag"
import type { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type TrustAction = "status" | "approve"

const pureApprovalError = "Cannot approve workspace trust while --pure is active. Rerun without --pure."

export function trustDecision(action: TrustAction, pure: boolean) {
  if (action === "status") return { approve: false } as const
  if (pure) return { approve: false, error: pureApprovalError } as const
  return { approve: true } as const
}

export function formatTrustStatus(status: WorkspaceTrust.Status, approved: boolean, pure: boolean) {
  return [
    `Workspace: ${status.workspace}`,
    `Fingerprint: ${status.fingerprint}`,
    `Status: ${status.trusted ? "trusted" : "untrusted"}`,
    ...(pure ? ["Executable project config: disabled by --pure"] : []),
    ...(approved
      ? ["Trust approved. Rerun the command or restart Vector to load trusted executable project config."]
      : []),
  ].join("\n")
}

export const TrustCommand = effectCmd({
  command: "trust <action>",
  describe: "inspect or approve trust for the current workspace",
  builder: (yargs) =>
    yargs.positional("action", {
      describe: "trust operation",
      choices: ["status", "approve"] as const,
      demandOption: true,
    }),
  handler: Effect.fn("Cli.trust")(function* (args: { action: TrustAction }) {
    const decision = trustDecision(args.action, Flag.VECTOR_PURE)
    if ("error" in decision && decision.error) return yield* fail(decision.error)

    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service
    if (!config.trust) return yield* fail("Workspace trust is unavailable in this Vector instance.")
    if (decision.approve) {
      if (!config.approve) return yield* fail("Workspace trust approval is unavailable in this Vector instance.")
      yield* config.approve()
    }

    UI.println(formatTrustStatus(yield* config.trust(), decision.approve, Flag.VECTOR_PURE))
  }),
})
