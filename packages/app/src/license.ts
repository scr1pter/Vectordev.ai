export type VectorLicenseState =
  | "development"
  | "beta"
  | "active"
  | "canceling"
  | "grace"
  | "activation_required"
  | "expired"
  | "past_due"
  | "offline"

export type VectorLicenseStatus = {
  access: boolean
  state: VectorLicenseState
  message?: string
  email?: string
  expiresAt?: string
  graceEndsAt?: string
  cancelAtPeriodEnd?: boolean
  plan?: "annual" | "monthly"
  interval?: "year" | "month"
  priceUsd?: number
  deviceName?: string
  devicePlatform?: string
  lastFour?: string
  offlineGraceDays?: number
  lastValidatedAt?: string
  // Set on an "offline" status when the wall must hold even without a stored
  // activation: licensing answered with an error, or this machine has already
  // seen that a license is required.
  enforced?: boolean
}
export type VectorLicensePlatform = {
  status(): Promise<VectorLicenseStatus>
  activate(licenseKey: string): Promise<VectorLicenseStatus>
  deactivate(): Promise<VectorLicenseStatus>
  setCancellation(cancel: boolean): Promise<VectorLicenseStatus>
  openBillingPortal(): Promise<string>
}
