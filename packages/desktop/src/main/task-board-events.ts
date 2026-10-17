const listeners = new Set<() => void>()

export function onTaskBoardChange(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function taskBoardChanged() {
  listeners.forEach((listener) => listener())
}
