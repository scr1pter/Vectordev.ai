import * as refunds from "../billing/refund"

export function undoPurchase(invoice: number, cents: number) {
  return refunds.issueRefund(invoice, cents)
}
