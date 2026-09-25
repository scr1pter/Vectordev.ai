export type VectorAccountStatus = {
  authenticated: boolean
  pending: boolean
  email?: string
  expiresAt?: number
  error?: string
}

export type VectorAccountPlatform = {
  status(): Promise<VectorAccountStatus>
  start(): Promise<VectorAccountStatus>
  cancel(): Promise<VectorAccountStatus>
  logout(): Promise<VectorAccountStatus>
  onChange(listener: (status: VectorAccountStatus) => void): () => void
}
