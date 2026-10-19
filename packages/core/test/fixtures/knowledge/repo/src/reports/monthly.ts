import * as tax from "../billing/tax"

export function monthly(totals: readonly number[]) {
  return totals.map((total) => tax.computeTax(total, 0.2))
}
