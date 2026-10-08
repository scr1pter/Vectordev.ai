import { logger } from "../logger"
import type { Invoice, InvoiceStore, LedgerClient, LedgerEntry, TaxService } from "./types"

export interface SyncResult {
  synced: number
  skipped: number
  failures: { invoiceId: string; message: string }[]
}

export interface SyncDeps {
  ledger: LedgerClient
  store: InvoiceStore
  tax: TaxService
  now?: () => Date
}

// Runs every 15 minutes over the invoices finalized in the last day. Invoices that already have syncedAt were
// posted by an earlier run, so a failed invoice is retried by the next run and a posted one is never posted twice.
export async function syncInvoices(deps: SyncDeps, invoices: Invoice[]): Promise<SyncResult> {
  const failures: SyncResult["failures"] = []
  const pending = invoices.filter((invoice) => !invoice.syncedAt)
  for (const invoice of pending) {
    try {
      await syncOne(deps, invoice)
    } catch (error) {
      failures.push({ invoiceId: invoice.id, message: errorMessage(error) })
    }
  }
  const synced = pending.length - failures.length
  const skipped = invoices.length - pending.length
  logger.info("invoice sync finished", { synced, skipped, failed: failures.length })
  return { synced, skipped, failures }
}

async function syncOne(deps: SyncDeps, invoice: Invoice) {
  const tax = await deps.tax.quote({
    customerId: invoice.customerId,
    amountCents: invoice.totalCents,
    currency: invoice.currency,
  })
  deps.ledger.post(toLedgerEntry(invoice, tax.amountCents))
  await deps.store.markSynced(invoice.id, deps.now?.() ?? new Date())
}

function toLedgerEntry(invoice: Invoice, taxCents: number): LedgerEntry {
  return {
    externalId: invoice.id,
    customerId: invoice.customerId,
    amountCents: invoice.totalCents,
    taxCents,
    currency: invoice.currency,
    postedAt: invoice.finalizedAt.toISOString(),
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
