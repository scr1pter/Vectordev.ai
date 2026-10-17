// A timer must race the next event: a disconnected stream may never emit another heartbeat.
export function nextBackgroundEvent<T>(iterator: AsyncIterator<T>, timeout?: number) {
  const next = iterator.next().then((event) => ({ timedOut: false as const, event }))
  if (timeout === undefined) return next
  const expired = Promise.withResolvers<{ timedOut: true }>()
  const timer = setTimeout(() => expired.resolve({ timedOut: true }), Math.max(0, timeout))
  return Promise.race([next, expired.promise]).finally(() => clearTimeout(timer))
}
