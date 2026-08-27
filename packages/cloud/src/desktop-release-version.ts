export function desktopReleaseVersion(input: string | undefined) {
  const version = input?.replace(/^v/, "")
  if (!version) throw new Error("VECTOR_RELEASE_VERSION is required")
  if (version === "1.2" || version.startsWith("1.2.")) {
    throw new Error("The 1.2 release line is reserved and cannot be published.")
  }
  return version
}
