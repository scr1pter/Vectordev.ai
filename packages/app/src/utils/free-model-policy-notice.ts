import {
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_DATA_POLICY,
  FREE_MODELS_TITLE,
  freeModelMayTrain,
  freeModelTrainingDisclaimer,
  type FreeModelChoice,
} from "@vectordevai/core/free-model-choice"

const STORAGE_KEY = "vector.notice.free-model-policy.v2"

// Through 1.99.106 these models ran only on zero-data-retention providers, and through 1.99.108 only on no-training
// ones. People who choose one are told once, the first time they send to one, how the providers treat their data.
export const FREE_MODEL_POLICY_NOTICE = {
  title: `How ${FREE_MODELS_TITLE} handle your data`,
  description: `${FREE_MODELS_DATA_POLICY} Models labelled "${FREE_MODEL_TRAINING_LABEL}" ask before your first prompt to one.`,
}

/** True the first time on this device. Storage that refuses reads or writes shows the notice again rather than never. */
export function firstFreeModelPolicyNotice(
  storage: () => Pick<Storage, "getItem" | "setItem"> | undefined = () => globalThis.localStorage,
) {
  try {
    if (storage()?.getItem(STORAGE_KEY)) return false
    storage()?.setItem(STORAGE_KEY, "1")
  } catch {
    return true
  }
  return true
}

/** The one-time question before the first prompt to a free model whose provider may train on prompts. */
export function freeModelTrainingNotice(model: Pick<FreeModelChoice, "freeModel">) {
  return {
    title: FREE_MODEL_TRAINING_LABEL,
    description: freeModelTrainingDisclaimer(model) ?? FREE_MODEL_TRAINING_DISCLAIMER,
    accept: "Accept and send",
    cancel: "Don't send",
  }
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
