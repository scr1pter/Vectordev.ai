import * as billing from "../billing/invoice"

export function checkout(lines: readonly number[]) {
  return billing.createInvoice(lines.reduce((sum, line) => sum + line, 0))
}
