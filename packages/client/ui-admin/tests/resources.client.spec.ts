/** Queries retain one revision and release dependent work after cancellation. */
import { expect, it, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-admin/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AdminSnapshotId, AdminIndexStatus, AdminUsageSummary } from '@deepseek-ai/dsh-admin/types'
import { adminAddress, parseAdminAddress, readAdmin, waitForRefresh, type AdminQuery } from '../src/client/resources.ts'
import { createAdminViewStore } from '../src/client/view-store.ts'
import { beijingTimestamp, calendarDate, initialCalendarFilter } from '../src/client/dates.ts'

const snapshot = 'index-1' as AdminSnapshotId
const index: AdminIndexStatus = { state: 'ready', indexedSessions: 0, totalSessions: 0, indexedAt: 1, snapshot, failedSessions: 0, error: null }
const summary: AdminUsageSummary = {
  calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, pricedCalls: 0, missingUsage: 0, missingPrice: 0, unsupportedCalls: 0,
  costs: [], snapshot, indexedAt: 1, daily: [], models: [], sessions: { total: 0, running: 0, failed: 0 },
}
const query: AdminQuery = { section: 'sessions', filter: { query: 'invoice' }, offset: 50, limit: 50, sessionId: null, sort: 'oldest' }

function remoteFixture() {
  const page = { items: [], total: 0, snapshot, indexedAt: 1 }
  return {
    indexStatus: vi.fn<ClientRemote['admin']['indexStatus']>(async () => ({ ok: true, value: index })),
    listSessions: vi.fn<ClientRemote['admin']['listSessions']>(async () => ({ ok: true, value: page })),
    listTools: vi.fn<ClientRemote['admin']['listTools']>(async () => ({ ok: true, value: page })),
    listEvents: vi.fn<ClientRemote['admin']['listEvents']>(async () => ({ ok: true, value: page })),
    listUsage: vi.fn<ClientRemote['admin']['listUsage']>(async () => ({ ok: true, value: page })),
    usageSummary: vi.fn<ClientRemote['admin']['usageSummary']>(async () => ({ ok: true, value: summary })),
    listPrices: vi.fn<ClientRemote['admin']['listPrices']>(async () => ({ ok: true, value: [] })),
    getSession: vi.fn<ClientRemote['admin']['getSession']>(),
    getTool: vi.fn<ClientRemote['admin']['getTool']>(),
    addPrice: vi.fn<ClientRemote['admin']['addPrice']>(),
    repriceHistory: vi.fn<ClientRemote['admin']['repriceHistory']>(),
    rebuildIndex: vi.fn<ClientRemote['admin']['rebuildIndex']>(),
    exportCsv: vi.fn<ClientRemote['admin']['exportCsv']>(),
  }
}

it('uses the identical filters, order and revision for a table and its summary', async () => {
  const remote = remoteFixture()
  const result = await readAdmin(remote, query, new AbortController().signal)
  expect(result.ok).toBe(true)
  const request = { filter: query.filter, offset: 50, limit: 50, snapshot, sort: 'oldest' }
  expect(remote.listSessions).toHaveBeenCalledWith(request)
  expect(remote.usageSummary).toHaveBeenCalledWith(request)
})

it('does not publish mixed revisions when the second read refuses a stale snapshot', async () => {
  const remote = remoteFixture()
  remote.usageSummary.mockResolvedValue({ ok: false, error: new RemoteError('admin/error', 'Changed', { reason: 'stale-snapshot' }) })
  const result = await readAdmin(remote, query, new AbortController().signal)
  expect(result).toMatchObject({ ok: false, error: { code: 'admin/error', details: { reason: 'stale-snapshot' } } })
})

it('does not issue a dependent summary after the resource is released during a table read', async () => {
  const remote = remoteFixture()
  const signal = new AbortController()
  remote.listSessions.mockImplementation(async () => {
    signal.abort(); return { ok: true, value: { items: [], total: 0, snapshot, indexedAt: 1 } }
  })
  const result = await readAdmin(remote, query, signal.signal)
  expect(result).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
  expect(remote.usageSummary).not.toHaveBeenCalled()
})

it('shows index preparation without converting it into an empty result table', async () => {
  const remote = remoteFixture()
  remote.indexStatus.mockResolvedValue({ ok: true, value: { ...index, state: 'indexing', indexedAt: null } })
  const result = await readAdmin(remote, query, new AbortController().signal)
  expect(result).toMatchObject({ ok: true, value: { index: { state: 'indexing' } } })
  expect(remote.listSessions).not.toHaveBeenCalled()
})

it('round-trips filters but scopes a selected conversation independently of the list', () => {
  const navigation = createAdminViewStore().create()
  navigation.actions.filter({ query: 'invoice', from: 123, to: 456, model: 'deepseek-chat', state: 'failed' })
  const parsed = parseAdminAddress(adminAddress(navigation.getSnapshot(), 25))
  expect(parsed.filter).toEqual(navigation.getSnapshot().filter)
  navigation.actions.page(50)
  navigation.actions.session('child' as SessionId)
  navigation.actions.descendants(true)
  expect(parseAdminAddress(adminAddress(navigation.getSnapshot(), 25))).toMatchObject({ section: 'chat', offset: 0, sessionId: 'child', filter: { sessionId: 'child', descendants: true } })
})

it('rejects malformed resource dates, statuses, sections and offsets', () => {
  const base = adminAddress(createAdminViewStore().create().getSnapshot(), 50)
  for (const [key, value] of [['section', 'broken'], ['offset', '-1'], ['from', 'tomorrow'], ['state', 'unknown'], ['sort', 'random']]) {
    const address = new URL(base); address.searchParams.set(key!, value!)
    expect(() => parseAdminAddress(address.href)).toThrow()
  }
})

it('releases an outstanding refresh delay as soon as its resource aborts', async () => {
  const controller = new AbortController()
  const wait = waitForRefresh(controller.signal, 10000)
  controller.abort()
  await wait
  await waitForRefresh(controller.signal, 10000)
})

it('uses Beijing calendar boundaries even across UTC midnight', () => {
  const now = Date.parse('2026-11-06T16:30:00Z')
  expect(calendarDate(now)).toBe('2026-11-07')
  expect(initialCalendarFilter(now, 7)).toEqual({ from: Date.parse('2026-10-31T16:00:00Z'), to: Date.parse('2026-11-07T16:00:00Z') })
  expect(beijingTimestamp('2026-11-07T12:30')).toBe(Date.parse('2026-11-07T04:30:00Z'))
})

it('defaults only overview and costs to the calendar range and preserves explicit filters', () => {
  const range = { from: 100, to: 200 }
  const navigation = createAdminViewStore(range).create()
  expect(navigation.getSnapshot().filter).toEqual({})
  navigation.actions.tab('overview')
  expect(navigation.getSnapshot().filter).toEqual(range)
  navigation.actions.tab('tools')
  expect(navigation.getSnapshot().filter).toEqual({})
  navigation.actions.tab('costs')
  expect(navigation.getSnapshot().filter).toEqual(range)
  navigation.actions.filter({ query: 'checkout' })
  navigation.actions.tab('sessions')
  expect(navigation.getSnapshot().filter).toEqual({ query: 'checkout' })
})
