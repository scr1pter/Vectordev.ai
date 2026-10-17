// A timer must race the next event: a disconnected stream may never emit another heartbeat.
export function nextBackgroundEvent<T>(iterator: AsyncIterator<T>, timeout?: number, unfinished = false) {
  const next = iterator
    .next()
    .then((event) =>
      event.done && unfinished
        ? { timedOut: false as const, disconnected: true as const }
        : { timedOut: false as const, disconnected: false as const, event },
    )
  if (timeout === undefined) return next
  const expired = Promise.withResolvers<{ timedOut: true }>()
  const timer = setTimeout(() => expired.resolve({ timedOut: true }), Math.max(0, timeout))
  return Promise.race([next, expired.promise]).finally(() => clearTimeout(timer))
}
