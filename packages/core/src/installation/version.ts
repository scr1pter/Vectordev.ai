declare global {
  const VECTOR_VERSION: string
  const VECTOR_CHANNEL: string
}

export const InstallationVersion = typeof VECTOR_VERSION === "string" ? VECTOR_VERSION : "local"
export const InstallationChannel = typeof VECTOR_CHANNEL === "string" ? VECTOR_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
