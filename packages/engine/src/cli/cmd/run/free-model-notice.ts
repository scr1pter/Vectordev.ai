import {
  FREE_MODELS_TITLE,
  freeModelName,
  freeModelTrainingNotice,
  type FreeModelChoice,
} from "@vectordevai/core/free-model-choice"
import { EOL } from "os"

/**
 * What `vector run` says once when a free model labelled "May train on your prompts" runs: its name, source and label,
 * then the disclaimer. Nothing for a no-training, unknown or paid model, so no one on another model is warned.
 */
export function freeModelRunNotice(
  providers: readonly { id: string; models: Record<string, FreeModelChoice> }[],
  model: { providerID: string; modelID: string } | undefined,
) {
  const found = model && providers.find((provider) => provider.id === model.providerID)?.models[model.modelID]
  const notice = found && freeModelTrainingNotice(found)
  if (!found || !notice) return
  return `${FREE_MODELS_TITLE}: ${freeModelName(found)} · ${notice.summary}${EOL}${notice.disclaimer}`
}
