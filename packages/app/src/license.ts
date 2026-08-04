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
  cancelAtPeriodEnd?: boolean
  deviceName?: string
  devicePlatform?: string
  lastFour?: string
  offlineGraceDays?: number
  lastValidatedAt?: string
}
export type VectorLicensePlatform = {
  status(): Promise<VectorLicenseStatus>
  activate(licenseKey: string): Promise<VectorLicenseStatus>
  deactivate(): Promise<VectorLicenseStatus>
  setCancellation(cancel: boolean): Promise<VectorLicenseStatus>
  openBillingPortal(): Promise<string>
}
