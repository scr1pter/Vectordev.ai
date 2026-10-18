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
  /**
   * Deleting the account: Vector is waiting for the fresh sign-in in the browser (confirming), or holds the
   * confirmation it gave and can delete (confirmed). The confirmation itself never leaves the desktop main process.
   */
  deletion?: "confirming" | "confirmed"
}

/** What Vector can open in its Codium billing window: a checkout, a top-up, or Stripe's customer portal. */
export type VectorBillingRequest =
  | { kind: "checkout"; plan: string }
  | { kind: "topup"; pack: string }
  | { kind: "portal"; flow?: "change" | "cancel" }

/**
 * How the billing window ended: Stripe finished (completed), the person went back from checkout (cancelled) or closed
 * the window (closed). An older vectordev.ai, or a sign-in from before Vector 1.99.109 asking for the billing portal,
 * makes Vector open the website instead (website). A request made while a billing window is already open brings that
 * window forward and does nothing else (busy).
 */
export type VectorBillingResult =
  | { outcome: "completed" | "cancelled" | "closed" | "website" | "busy" }
  | { outcome: "failed"; message: string }

export type VectorDeletionResult = { deleted: true } | { deleted: false; message: string }

export type VectorAccountPlatform = {
  status(): Promise<VectorAccountStatus>
  start(): Promise<VectorAccountStatus>
  cancel(): Promise<VectorAccountStatus>
  logout(): Promise<VectorAccountStatus>
  /** Vector Codium plan and balances, read by the desktop main process so the account token stays there. */
  codium?(): Promise<ModelPlanStatus.Status>
  /** Codium plans and top-ups on sale, by name and price only. */
  offers?(): Promise<ModelPlanStatus.Offers | undefined>
  /** Opens checkout or the billing portal in a Vector window, and resolves once that window is done. */
  billing?(request: VectorBillingRequest): Promise<VectorBillingResult>
  /** Starts the fresh sign-in in the browser that confirms deleting this account. */
  confirmDeletion?(): Promise<VectorAccountStatus>
  /** Drops a deletion confirmation, whether still in the browser or already given. */
  cancelDeletion?(): Promise<VectorAccountStatus>
  /** Deletes the account with the confirmation the desktop holds; `email` is what the person typed. */
  deleteAccount?(email: string): Promise<VectorDeletionResult>
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
