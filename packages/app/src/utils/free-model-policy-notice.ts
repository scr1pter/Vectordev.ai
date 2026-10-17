import { FREE_MODELS_DATA_POLICY } from "@vectordevai/core/free-model-choice"

const STORAGE_KEY = "vector.notice.free-model-policy.v1"

// Through 1.99.106 Models included with Vector ran only on zero-data-retention providers. People who chose them under
// that rule are told once, the first time they send to one, that the no-training allowlist replaced it.
export const FREE_MODEL_POLICY_NOTICE = {
  title: "How Models included with Vector handle your data",
  description: `From 1.99.108 they run on providers on Vector's no-training allowlist rather than only on zero-data-retention providers. ${FREE_MODELS_DATA_POLICY}`,
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
