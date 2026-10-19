export const SEARCH_PAGE_SIZE = 20

export async function reindexAll(load: () => Promise<readonly string[]>) {
  queueMicrotask(() => void load())
}

export function hideArchived<T extends { archived: boolean }>(results: readonly T[]) {
  return results.filter((result) => !result.archived)
}
