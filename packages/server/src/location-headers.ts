export function outdatedDirectoryHeader(headers: Readonly<Record<string, string | undefined>>) {
  return Object.keys(headers).find(
    (name) => /^x-[a-z0-9-]+-directory$/i.test(name) && name.toLowerCase() !== "x-vector-directory",
  )
}

export const OUTDATED_CLIENT_MESSAGE =
  "This client uses an older directory-routing protocol. Update Vector before accessing this workspace."
