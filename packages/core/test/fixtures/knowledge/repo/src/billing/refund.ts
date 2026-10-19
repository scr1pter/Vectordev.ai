export const REFUND_WINDOW_DAYS = 30

export function issueRefund(invoice: number, amountCents: number) {
  return { invoice, amountCents: -amountCents }
}
