type ManagedSync = (token: string | undefined, synchronize: () => Promise<void>) => Promise<void>

/** Main-only hook; account tokens never cross a renderer boundary. */
export function createManagedAccountLifecycle() {
  let managed: ManagedSync | undefined
  return {
    register(sync: ManagedSync) {
      managed = sync
      return () => {
        if (managed === sync) managed = undefined
      }
    },
    async sync(token: string | undefined, synchronize: () => Promise<void>) {
      if (managed) return managed(token, synchronize)
      await synchronize()
    },
  }
}
