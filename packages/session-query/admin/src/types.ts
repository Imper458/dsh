/** Owner-only DeepSeek administration records. Amounts are estimated in the price version's currency. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Identifies one immutable index and price revision. */
export type AdminSnapshotId = Branded<'AdminSnapshotId'>
/** Identifies one append-only model price version. */
export type AdminPriceId = Branded<'AdminPriceId'>
/** Indexed lifecycle of a conversation. */
export type AdminSessionState = 'running' | 'completed' | 'failed' | 'interrupted' | 'idle'
/** Shared selection; timestamps are inclusive start and exclusive end in epoch milliseconds. */
export interface AdminFilter {
  query?: string
  from?: number
  to?: number
  model?: string
  state?: AdminSessionState
  sessionId?: SessionId
  descendants?: boolean
}
/** Page selection against one revision; omit snapshot to select the latest. */
export interface AdminPageRequest {
  filter?: AdminFilter
  offset?: number
  limit?: number
  snapshot?: AdminSnapshotId
  sort?: 'newest' | 'oldest'
}
/** Bounded rows sharing an index revision. */
export interface AdminPage<T> {
  items: T[]
  total: number
  snapshot: AdminSnapshotId
  indexedAt: number | null
}
/** A conversation row counts only the work owned by that conversation. */
export interface AdminSessionRow {
  id: SessionId
  parentId: SessionId | null
  title: string
  workspace: string | null
  costs: AdminCostTotal[]
  missingPrice: number
  createdAt: number
  updatedAt: number
  state: AdminSessionState
  models: string[]
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  calls: number
  tools: number
  missingUsage: number
}
/** Detail identity and the precise observed journal watermark. */
export interface AdminSessionDetail {
  session: AdminSessionRow
  snapshot: AdminSnapshotId
  throughSeq: number
  inheritedEventCount: number
}
/** Bounded event row; messagesOnly reads leave data empty and dedicate their budget to readable text. */
export interface AdminEventRow {
  seq: SessionSeq
  time: number
  type: string
  data: string
  text: string | null
  role: 'user' | 'assistant' | null
  truncated: boolean
  inherited: boolean
}
/** Explicit event-page read of one observed conversation. */
export interface AdminEventsRequest {
  messagesOnly?: boolean
  sessionId: SessionId
  offset?: number
  limit?: number
  snapshot?: AdminSnapshotId
}
/** One top-level tool execution; repeated results do not add calls. */
export interface AdminToolRow {
  sessionId: SessionId
  seq: SessionSeq
  name: string
  nested: boolean
  time: number
  durationMs: number | null
  status: 'running' | 'success' | 'error' | 'interrupted'
}
/** Tool detail expands only the selected call and result. */
export interface AdminToolDetail {
  tool: AdminToolRow
  arguments: string
  result: string | null
  truncated: boolean
  snapshot: AdminSnapshotId
}
/** Model-call source, including observable calls without a usage settlement. */
export type AdminUsageKind = 'conversation' | 'compaction' | 'title'
/** Recorded usage for one call; null preserves missing counters or rates. */
export interface AdminUsageRow {
  sessionId: SessionId
  seq: SessionSeq
  time: number
  kind: AdminUsageKind
  model: string | null
  inputTokens: number | null
  cacheReadTokens: number | null
  outputTokens: number | null
  coverage: 'priced' | 'missing-usage' | 'missing-price' | 'unsupported'
  amount: number | null
  currency: string | null
  priceId: AdminPriceId | null
}
/** A per-currency subtotal never merges different currencies. */
export interface AdminCostTotal { currency: string; amount: number }
/** Asia/Shanghai calendar-day totals over the complete filtered call set. */
export interface AdminUsageDay {
  date: string
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  costs: AdminCostTotal[]
}
/** Per-model totals over the complete filtered call set. */
export interface AdminModelUsage { model: string | null; calls: number; costs: AdminCostTotal[] }
/** Totals and coverage use the identical selection as the detail table. */
export interface AdminUsageSummary {
  daily: AdminUsageDay[]
  models: AdminModelUsage[]
  sessions: { running: number; failed: number; total: number }
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  pricedCalls: number
  missingUsage: number
  missingPrice: number
  unsupportedCalls: number
  costs: AdminCostTotal[]
  snapshot: AdminSnapshotId
  indexedAt: number | null
}
/** DeepSeek prices per one million tokens, represented as decimal strings. */
export interface AdminPriceInput {
  model: string
  currency: string
  effectiveFrom: number
  inputPerMillion: string
  cacheReadPerMillion: string
  outputPerMillion: string
  /** Optional official Beijing peak/off-peak schedule; the three rates above are peak rates. */
  deepseekSchedule?: {
    /** Exclusive end of the verified holiday calendar, in epoch milliseconds. */
    validUntil: number
    /** Published holiday dates in Beijing, formatted YYYY-MM-DD; weekends are always off-peak. */
    holidays: string[]
  } | undefined
}
/** An immutable administrator-entered price version. */
export interface AdminPriceVersion extends AdminPriceInput { id: AdminPriceId; createdAt: number }
/** Historical pricing is a separate explicit operation. */
export interface AdminHistoricalPriceRequest { price: AdminPriceInput }
/** Readiness and visible indexing failures; errors never imply an empty corpus. */
export interface AdminIndexStatus {
  state: 'idle' | 'indexing' | 'ready' | 'error'
  indexedSessions: number
  totalSessions: number
  indexedAt: number | null
  snapshot: AdminSnapshotId
  failedSessions: number
  error: string | null
}
/** CSV export uses exactly the selected page revision and filters. */
export interface AdminExportRequest {
  kind: 'sessions' | 'tools' | 'usage'
  filter?: AdminFilter
  snapshot: AdminSnapshotId
}
/** A bounded UTF-8 CSV document, ready for a browser download. */
export interface AdminExportResult { filename: string; csv: string; snapshot: AdminSnapshotId }

/** Stable administrator failures, rendered by the receiving locale dictionary. */
export type AdminFailure = 'denied' | 'stale-snapshot' | 'invalid-request' | 'not-found' | 'index-unavailable' | 'export-too-large'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'admin/error': { reason: AdminFailure } }
}
