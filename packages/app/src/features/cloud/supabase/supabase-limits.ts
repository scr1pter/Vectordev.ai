// The Storage screen edits a bucket's size limit in MB while Supabase stores
// bytes. Only an empty field clears the limit; anything else that is not a
// positive number is refused, and an untouched field keeps the exact bytes it
// came with instead of the rounded MB it shows.

export function sizeLimitText(bytes?: number) {
  return bytes ? String(Number((bytes / 1024 / 1024).toFixed(2))) : ""
}

/** undefined leaves the limit as it is, null clears it, a number sets it in bytes. */
export function sizeLimitBytes(text: string, original?: number) {
  const entered = text.trim()
  if (entered === sizeLimitText(original)) return { ok: true as const, value: undefined }
  if (!entered) return { ok: true as const, value: null }
  const megabytes = Number(entered)
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    return {
      ok: false as const,
      error: `"${entered}" is not a size limit. Enter it in MB, such as 5 or 0.5, or leave it empty for no limit.`,
    }
  }
  return { ok: true as const, value: Math.max(1, Math.round(megabytes * 1024 * 1024)) }
}
