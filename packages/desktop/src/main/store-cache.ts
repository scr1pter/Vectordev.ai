// electron-store reads and parses its whole file on every get, synchronously on Electron's main thread, and the app
// polls the agent workspace, swarm run and background task lists every 0.5-1.5 s on a task route. A module that is a
// list's only writer keeps what it last read or wrote instead. The copy belongs to one store instance, so a store that
// was removed and opened again is read again.
export function createStoreCache<T>() {
  const cache: { store?: object; items: T[] } = { items: [] }
  return {
    // Callers replace entries in the list they get, so each one gets its own array.
    read(store: object, load: () => T[]) {
      if (cache.store !== store) Object.assign(cache, { store, items: load() })
      return [...cache.items]
    },
    wrote(store: object, items: readonly T[]) {
      Object.assign(cache, { store, items: [...items] })
    },
  }
}
