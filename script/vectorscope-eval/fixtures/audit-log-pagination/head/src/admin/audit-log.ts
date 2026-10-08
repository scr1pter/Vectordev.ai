import type { Database } from "../db"

export interface AuditEntry {
  id: string
  actorId: string
  action: string
  target: string
  createdAt: Date
}

export interface AuditFilter {
  actorId?: string
  action?: string
  since?: Date
}

export interface AuditPage {
  entries: AuditEntry[]
  page: number
  pageSize: number
  totalPages: number
  totalEntries: number
}

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

export async function listAuditEntries(db: Database, orgId: string, filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const rows = await db.auditEntries.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } })
  return rows.filter((row) => matches(row, filter))
}

// `page` is 1-based: it is the number the admin console shows under the table. The filters already run in memory
// (orgs keep 90 days of entries), so paging does too.
export async function pageAuditEntries(
  db: Database,
  orgId: string,
  filter: AuditFilter,
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<AuditPage> {
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`page must be a positive integer, got ${page}`)
  const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE)
  const entries = await listAuditEntries(db, orgId, filter)
  const totalPages = Math.max(1, Math.ceil(entries.length / size))
  const start = page * size
  return {
    entries: entries.slice(start, start + size),
    page,
    pageSize: size,
    totalPages,
    totalEntries: entries.length,
  }
}

export function describeEntry(entry: AuditEntry): string {
  return `${entry.actorId} ${entry.action} ${entry.target}`
}

function matches(entry: AuditEntry, filter: AuditFilter) {
  if (filter.actorId && entry.actorId !== filter.actorId) return false
  if (filter.action && entry.action !== filter.action) return false
  if (filter.since && entry.createdAt < filter.since) return false
  return true
}
