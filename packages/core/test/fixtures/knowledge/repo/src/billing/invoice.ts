export class InvoiceNumberer {
  private last = 0
  next() {
    this.last += 1
    return this.last
  }
}

const numbers = new InvoiceNumberer()

export function createInvoice(amountCents: number) {
  return { number: numbers.next(), amountCents: Math.round(amountCents) }
}
