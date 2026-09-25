import {
  FREE_MODELS_TITLE,
  freeModelName,
  freeModelSource,
  preferOwnFreeModels,
} from "@vectordevai/core/free-model-choice"
import { EOL } from "os"
import { Effect } from "effect"
import { Flag } from "@vectordevai/core/flag/flag"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@vectordevai/core/provider"

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
        Flag.VECTOR_MODELS_URL && ModelCatalog.mirrorURL(Flag.VECTOR_MODELS_URL) && !Flag.VECTOR_DISABLE_MODELS_FETCH
      if (enabled) yield* ModelCatalog.Service.use((s) => s.refresh(true))
      UI.println(
        enabled
          ? "Model catalog refresh attempted; the last available catalog remains usable if the mirror is offline."
          : "Using the bundled model catalog. Set VECTOR_MODELS_URL to a Vector-hosted mirror to enable refresh.",
      )
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const free = preferOwnFreeModels(
      Object.values(providers).flatMap((provider) => Object.values(provider.models)),
    ).filter((model) => model.freeModel && (!args.provider || model.providerID === args.provider))
    const hidden = new Set(
      Object.values(providers)
        .flatMap((provider) => Object.values(provider.models))
        .filter((model) => model.freeModel && !free.includes(model))
        .map((model) => `${model.providerID}/${model.id}`),
    )
    // Human guidance goes to stderr; stdout keeps copyable, script-friendly model selectors.
    if (free.length) {
      UI.println(FREE_MODELS_TITLE)
      free.forEach((model) =>
        UI.println(`  ${freeModelName(model)} — ${freeModelSource(model)} (${model.providerID}/${model.id})`),
      )
    }

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        if (hidden.has(`${providerID}/${modelID}`)) continue
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
