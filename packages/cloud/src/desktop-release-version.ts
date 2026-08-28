export function desktopReleaseVersion(input: string | undefined) {
  if (!input) throw new Error("VECTOR_RELEASE_VERSION is required")
  const version = input.replace(/^v/, "")
  if (/^1\.2(?:[.+-]|$)/.test(version)) {
    throw new Error("The 1.2 release line is reserved and cannot be published.")
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/.test(version)) {
    throw new Error("VECTOR_RELEASE_VERSION must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-beta.NUMBER")
  }
  return version
}
