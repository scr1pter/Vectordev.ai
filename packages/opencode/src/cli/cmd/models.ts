import { EOL } from "os"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { providerEndpointAllowed } from "@opencode-ai/core/provider-policy"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the model catalog from the configured mirror",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      const enabled =
        Flag.OPENCODE_MODELS_URL &&
        providerEndpointAllowed(Flag.OPENCODE_MODELS_URL) &&
        !Flag.OPENCODE_DISABLE_MODELS_FETCH
      if (enabled) yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(
        enabled
          ? "Model catalog refresh attempted; the last available catalog remains usable if the mirror is offline."
          : "Using the bundled model catalog. Set VECTOR_MODELS_URL to a Vector-hosted mirror to enable refresh.",
      )
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => a.localeCompare(b))

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})
