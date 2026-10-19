export const DIGEST_HOUR_UTC = 7

export function buildDigest(events: readonly { account: string; text: string }[]) {
  const byAccount = new Map<string, string[]>()
  for (const event of events) byAccount.set(event.account, [...(byAccount.get(event.account) ?? []), event.text])
  return byAccount
}
