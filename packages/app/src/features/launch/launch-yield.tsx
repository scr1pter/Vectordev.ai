import type { LaunchYieldReason } from "./launch-state"
import { yieldLaunchScreen } from "./launch-bridge"

export { yieldLaunchScreen }

// Render inside a screen the user must see or act on. It yields while the
// component is created, not on mount, so nothing it renders can delay it.
export function LaunchYield(props: { reason: LaunchYieldReason }) {
  yieldLaunchScreen(props.reason)
  return null
}
