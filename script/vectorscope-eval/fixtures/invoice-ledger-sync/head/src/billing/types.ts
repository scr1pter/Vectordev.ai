export interface Invoice {
  id: string
  customerId: string
  totalCents: number
  currency: string
  finalizedAt: Date
  syncedAt?: Date // set once the invoice is posted to the ledger
}

export interface LedgerEntry {
  externalId: string
  customerId: string
  amountCents: number
  taxCents: number
  currency: string
  postedAt: string
}

export interface LedgerClient {
  post(entry: LedgerEntry): Promise<{ id: string }>
}

export interface InvoiceStore {
  markSynced(invoiceId: string, at: Date): Promise<void>
}

export interface TaxService {
  quote(input: { customerId: string; amountCents: number; currency: string }): Promise<{ amountCents: number }>
}
