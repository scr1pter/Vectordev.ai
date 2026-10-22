import { freeModelTrainingLabel, type FreeModelChoice } from "@vectordevai/core/free-model-choice"
import type { PromptMode } from "./traits"

/**
 * What stays under the prompt, in the warning colour, while a free model labelled "May train on your prompts" is
 * selected: that label alone, with no disclaimer. The one-time acceptance question is the one place that explains it.
 * Shell mode, a no-training or paid model, and a model not listed yet show nothing.
 */
export function promptTrainingLabel(input: {
  mode: PromptMode
  providers: readonly { id: string; models: Record<string, Pick<FreeModelChoice, "freeModel">> }[]
  current: { providerID: string; modelID: string } | undefined
}) {
  const current = input.current
  if (input.mode !== "normal" || !current) return undefined
  const model = input.providers.find((provider) => provider.id === current.providerID)?.models[current.modelID]
  return model ? freeModelTrainingLabel(model) : undefined
}
