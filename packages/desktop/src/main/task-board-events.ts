const listeners = new Set<() => void>()

export function onTaskBoardChange(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function taskBoardChanged() {
  // A detached renderer must not fail a completed durable write or starve the
  // engine relay of the same change notification.
  listeners.forEach((listener) => {
    try {
      listener()
    } catch (error) {
      console.warn("Task observer failed", error instanceof Error ? error.message : "unknown observer error")
    }
  })
}
