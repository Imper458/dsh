/** Query-backed resources keep administration records outside view stores. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-admin/remote'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AdminEventRow, AdminFilter, AdminIndexStatus, AdminPage, AdminPriceVersion, AdminSessionDetail,
  AdminSessionRow, AdminToolDetail, AdminToolRow, AdminUsageRow, AdminUsageSummary,
} from '@deepseek-ai/dsh-admin/types'
import type { AdminView } from './view-store.ts'

/** One consistent index revision and the records required by the current page. */
export interface AdminData {
  index: AdminIndexStatus
  sessions?: AdminPage<AdminSessionRow>
  tools?: AdminPage<AdminToolRow>
  usage?: AdminPage<AdminUsageRow>
  events?: AdminPage<AdminEventRow>
  detail?: AdminSessionDetail
  summary?: AdminUsageSummary
  prices?: AdminPriceVersion[]
}
/** Resource query selected by the view. */
export interface AdminQuery {
  section: 'overview' | 'sessions' | 'tools' | 'costs' | 'chat' | 'usage'
  filter: AdminFilter
  offset: number
  limit: number
  sessionId: SessionId | null
  sort: 'newest' | 'oldest'
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Current administration page from one observed index revision. */
    admin: AdminData
    /** Expanded tool arguments and result. */
    admintool: AdminToolDetail
    /** Bounded descendant conversation navigation. */
    adminchildren: AdminPage<AdminSessionRow>
    /** A single message fetched with the larger per-message response allowance. */
    adminmessage: AdminPage<AdminEventRow>
  }
}

/**
 * Address the records for one view without retaining its server response.
 * @param view - navigation and filter selection.
 * @param limit - configured maximum visible rows.
 * @returns resource URL whose revision changes on explicit refresh.
 */
export function adminAddress(view: AdminView, limit: number): string {
  const params = new URLSearchParams({
    section: view.sessionId === null ? view.tab : view.detailTab,
    offset: String(view.offset), limit: String(limit), revision: String(view.revision), sort: view.sort,
  })
  for (const key of view.sessionId === null ? ['query', 'model', 'from', 'to', 'state'] as const : []) {
    const value = view.filter[key]
    if (value !== undefined) params.set(key, String(value))
  }
  if (view.sessionId !== null) {
    params.set('sessionId', view.sessionId)
    params.set('descendants', String(view.descendants))
  }
  return `dsh-resource://admin/?${params}`
}

/**
 * Decode a resource address and reject malformed page selections.
 * @param address - address produced by the administration page.
 * @returns validated query parameters.
 */
export function parseAdminAddress(address: string): AdminQuery {
  const params = new URL(address).searchParams
  const section = params.get('section')
  if (section !== 'overview' && section !== 'sessions' && section !== 'tools' && section !== 'costs' && section !== 'chat' && section !== 'usage') throw new Error('Invalid administration section')
  const offset = Number(params.get('offset')), limit = Number(params.get('limit'))
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid administration page')
  const filter: AdminFilter = {}
  for (const key of ['query', 'model'] as const) {
    const value = params.get(key)
    if (value !== null) filter[key] = value
  }
  for (const key of ['from', 'to'] as const) {
    const value = params.get(key)
    if (value !== null) {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error('Invalid administration date')
      filter[key] = number
    }
  }
  const state = params.get('state')
  if (state !== null) {
    if (state !== 'running' && state !== 'completed' && state !== 'failed' && state !== 'interrupted' && state !== 'idle') throw new Error('Invalid administration state')
    filter.state = state
  }
  const sessionId = params.get('sessionId') as SessionId | null
  if (sessionId !== null) { filter.sessionId = sessionId; filter.descendants = params.get('descendants') === 'true' }
  const sort = params.get('sort')
  if (sort !== 'newest' && sort !== 'oldest') throw new Error('Invalid administration order')
  return { section, offset, limit, filter, sessionId, sort }
}

/**
 * Read one page with its summary against the same server snapshot.
 * @param remote - generated administration namespace.
 * @param query - current selection.
 * @param signal - resource lifetime; prevents dependent reads after release.
 * @returns a complete page or the first refused read.
 */
export async function readAdmin(remote: ClientRemote['admin'], query: AdminQuery, signal: AbortSignal): Promise<RemoteResult<AdminData>> {
  const index = settled(await remote.indexStatus(), signal)
  if (!index.ok) return index
  const data: AdminData = { index: index.value }
  if (index.value.indexedAt === null) return { ok: true, value: data }
  const request = { filter: query.filter, offset: query.offset, limit: query.limit, snapshot: index.value.snapshot, sort: query.sort }
  if (query.sessionId !== null) {
    const detail = settled(await remote.getSession(query.sessionId, index.value.snapshot), signal)
    if (!detail.ok) return detail
    data.detail = detail.value
  }
  if (query.section === 'sessions') {
    const rows = settled(await remote.listSessions(request), signal)
    if (!rows.ok) return rows
    data.sessions = rows.value
  } else if (query.section === 'tools') {
    const rows = settled(await remote.listTools(request), signal)
    if (!rows.ok) return rows
    data.tools = rows.value
  } else if (query.section === 'chat' && query.sessionId !== null) {
    const rows = settled(await remote.listEvents({
      sessionId: query.sessionId, offset: query.offset, limit: query.limit, messagesOnly: true, snapshot: index.value.snapshot,
    }), signal)
    if (!rows.ok) return rows
    data.events = rows.value
  } else if (query.section === 'usage' || query.section === 'costs') {
    const rows = settled(await remote.listUsage(request), signal)
    if (!rows.ok) return rows
    data.usage = rows.value
  }
  if (query.section !== 'chat') {
    const summary = settled(await remote.usageSummary(request), signal)
    if (!summary.ok) return summary
    data.summary = summary.value
  }
  if (query.section === 'costs') {
    const prices = settled(await remote.listPrices(), signal)
    if (!prices.ok) return prices
    data.prices = prices.value
  }
  return { ok: true, value: data }
}

function settled<T>(result: RemoteResult<T>, signal: AbortSignal): RemoteResult<T> {
  return signal.aborted ? { ok: false, error: new RemoteError('gateway/cancelled', 'Administration query was released', {}) } : result
}

/**
 * Wait between query refreshes and remove the timer on resource release.
 * @param signal - resource lifetime.
 * @param milliseconds - configured refresh delay.
 * @returns when refresh is due or the resource is released.
 */
export function waitForRefresh(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}
