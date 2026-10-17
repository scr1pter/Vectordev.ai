import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

export type VectorAccountStatus = {
  authenticated: boolean
  pending: boolean
  email?: string
  name?: string
  /** The profile photo as a data URL. The desktop downloads it, so the renderer never loads a third-party image. */
  avatar?: string
  expiresAt?: number
  error?: string
}

export type VectorAccountPlatform = {
  status(): Promise<VectorAccountStatus>
  start(): Promise<VectorAccountStatus>
  cancel(): Promise<VectorAccountStatus>
  logout(): Promise<VectorAccountStatus>
  /** Vector Codium plan and balances, read by the desktop main process so the account token stays there. */
  codium?(): Promise<ModelPlanStatus.Status>
  onChange(listener: (status: VectorAccountStatus) => void): () => void
}

/**
 * What the sidebar's account chip shows, as Claude and Codex show it: the photo, else the first letter, beside the
 * name from Google or the account, else the email.
 */
export function accountChip(status: VectorAccountStatus) {
  const label = status.name || status.email || ""
  return {
    label,
    initial: label.trim().charAt(0),
    // Only an inline raster image, so the chip never loads a URL whatever the status carries.
    photo:
      status.avatar && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(status.avatar)
        ? status.avatar
        : undefined,
  }
}
