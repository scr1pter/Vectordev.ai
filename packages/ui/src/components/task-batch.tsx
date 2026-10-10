function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// A batch has one real tool part. Indexes identify its children even when updates
// arrive out of order or the original input has been trimmed from history.
export function taskBatchEntries(input: unknown, metadata: unknown) {
  const args = record(input)
  const meta = record(metadata)
  if (!Array.isArray(args?.tasks) && meta?.taskBatch !== 1) return undefined
  const inputs: unknown[] = Array.isArray(args?.tasks) ? args.tasks : []
  const rows: unknown[] = meta?.taskBatch === 1 && Array.isArray(meta.tasks) ? meta.tasks : []
  const indexed = new Map<number, Record<string, unknown>>()
  const ambiguous = new Set<number>()
  for (const row of rows) {
    const value = record(row)
    const index = value?.index
    if (!value || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue
    if (indexed.has(index)) ambiguous.add(index)
    indexed.set(index, value)
  }
  return [...new Set([...inputs.keys(), ...indexed.keys()])]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      input: record(inputs[index]) ?? {},
      metadata: ambiguous.has(index) ? {} : (indexed.get(index) ?? {}),
    }))
}

export function taskItemState(status: unknown, parent: unknown) {
  if (status === "completed") return "completed"
  if (status === "error" || status === "cancelled") return "error"
  if (status === "running") return "running"
  if (parent === "error") return "error"
  // A completed parent call does not prove an unobserved child succeeded.
  return "pending"
}

export function taskItemLabel(status: unknown, parent: unknown) {
  if (status === "completed") return "Completed"
  if (status === "error") return "Failed"
  if (status === "cancelled") return "Stopped"
  if (status === "running") return "Running"
  if (status === "queued") return "Queued"
  if (status === "pending") return "Pending"
  return parent === "error" ? "Interrupted" : "Awaiting status"
}
