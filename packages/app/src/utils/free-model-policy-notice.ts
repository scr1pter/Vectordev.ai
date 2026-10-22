import {
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODEL_TRAINING_SCOPE,
  freeModelMayTrain,
  freeModelTrainingRefusal,
  type FreeModelChoice,
} from "@vectordevai/core/free-model-choice"
import type { VectorClient } from "@vectordevai/sdk/v2/client"

/**
 * The one-time question before the first prompt to a free model whose provider may train on prompts. It is the one place
 * that explains the label; every list and notice shows the label alone. The free router and unreviewed models are asked
 * about the same way, since the acceptance covers every labelled model.
 */
export const FREE_MODEL_TRAINING_QUESTION = {
  title: FREE_MODEL_TRAINING_LABEL,
  description: `${FREE_MODEL_TRAINING_DISCLAIMER} ${FREE_MODEL_TRAINING_SCOPE}`,
  accept: "Accept and send",
  cancel: "Don't send",
}

/**
 * Whether a prompt to `model` may be sent. A model that may train needs the acceptance the engine keeps; without it the
 * user is asked, and only an answer the engine recorded lets the prompt go. Any failure keeps the prompt unsent.
 */
export async function freeModelTrainingGate(input: {
  model: Pick<FreeModelChoice, "freeModel">
  consent: () => Promise<boolean>
  ask: () => Promise<boolean>
  accept: () => Promise<boolean>
}) {
  if (!freeModelMayTrain(input.model)) return true
  if (await input.consent().catch(() => false)) return true
  if (!(await input.ask())) return false
  return input.accept().catch(() => false)
}

/**
 * Records the acceptance through the engine, and says why when it is not recorded: an invited guest (403) is told that
 * only the workspace owner can accept, since trying again never helps; any other refusal, or no answer, asks to try
 * again. The app's client throws on an error status, which would lose the status, so this asks for the response.
 */
export async function acceptFreeModelTraining(
  freeModels: Pick<VectorClient["provider"]["freeModels"], "setConsent">,
  refused: (description: string) => void,
) {
  const result = await freeModels
    .setConsent({ freeModelConsent: { training: true } }, { throwOnError: false })
    .catch(() => undefined)
  if (result?.data?.training === true) return true
  refused(freeModelTrainingRefusal(result?.response?.status))
  return false
}
