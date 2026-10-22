import {
  FREE_MODELS_TITLE,
  freeModelName,
  freeModelTrainingLabel,
  type FreeModelChoice,
} from "@vectordevai/core/free-model-choice"

/**
 * What `vector run` says once when a free model labelled "May train on your prompts" runs: its name and that label, and
 * nothing more. Nothing for a no-training, unknown or paid model, so no one on another model is warned.
 */
export function freeModelRunNotice(
  providers: readonly { id: string; models: Record<string, FreeModelChoice> }[],
  model: { providerID: string; modelID: string } | undefined,
) {
  const found = model && providers.find((provider) => provider.id === model.providerID)?.models[model.modelID]
  const label = found && freeModelTrainingLabel(found)
  if (!found || !label) return
  return `${FREE_MODELS_TITLE}: ${freeModelName(found)} · ${label}`
}
