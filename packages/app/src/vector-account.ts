import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

export type VectorAccountStatus = {
  authenticated: boolean
  pending: boolean
  email?: string
  name?: string
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
