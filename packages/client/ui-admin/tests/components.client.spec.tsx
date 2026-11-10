// @vitest-environment jsdom
/** Visible administration states with a shared immutable query snapshot. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { AdminSnapshotId, AdminSessionRow, AdminUsageSummary, AdminToolDetail } from '@deepseek-ai/dsh-admin/types'
import type { AdminPriceId } from '@deepseek-ai/dsh-admin/types'
import { AdminPage, type AdminPageProps } from '../src/client/AdminPage.tsx'
import { createAdminViewStore } from '../src/client/view-store.ts'
import type { AdminData } from '../src/client/resources.ts'
import { en } from '../src/client/locales.ts'

const id = 'session-example' as SessionId
const revision = 'revision-1' as AdminSnapshotId
const time = new Date('2026-11-06T08:00:00Z').getTime()
const row: AdminSessionRow = {
  id, parentId: null, title: 'Investigate the checkout failure', workspace: '/projects/example', createdAt: time, updatedAt: time,
  state: 'completed', models: ['deepseek-chat'], inputTokens: 120, cacheReadTokens: 20, outputTokens: 30,
  calls: 1, tools: 1, missingUsage: 0, missingPrice: 1, costs: [],
}
const summary: AdminUsageSummary = {
  calls: 1, inputTokens: 120, cacheReadTokens: 20, outputTokens: 30, pricedCalls: 0, missingUsage: 0, missingPrice: 1,
  unsupportedCalls: 0, costs: [], snapshot: revision, indexedAt: time,
  daily: [{ date: '2026-11-06', calls: 1, inputTokens: 120, cacheReadTokens: 20, outputTokens: 30, costs: [] }],
  models: [{ model: 'deepseek-chat', calls: 1, costs: [] }], sessions: { total: 1, running: 0, failed: 0 },
}
const index: AdminData['index'] = { state: 'ready', indexedSessions: 1, totalSessions: 1, indexedAt: time, snapshot: revision, failedSessions: 0, error: null }
const translate = ((key: keyof typeof en, params?: Record<string, string>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), en[key])) as AdminPageProps['t']

afterEach(cleanup)

it('identifies official peak rates and the verified calendar expiry in the price table', () => {
  const { props } = fixture({ index, prices: [{ id: 'official' as AdminPriceId, createdAt: time, effectiveFrom: time,
    model: 'deepseek-flash', currency: 'CNY', inputPerMillion: '2', cacheReadPerMillion: '0.04', outputPerMillion: '8',
    deepseekSchedule: { validUntil: Date.parse('2028-01-01T00:00:00+08:00'), holidays: [] } }] })
  render(<AdminPage {...props} />)
  expect(screen.getByText(/Peak rates; off-peak half price/).textContent).toContain('2028')
})

function fixture(
  initial: AdminData = { index, sessions: { items: [row], total: 1, snapshot: revision, indexedAt: time }, summary },
  tool?: AdminToolDetail,
  children?: AdminData['sessions'],
  messages?: AdminData['events'],
) {
  const navigation = createAdminViewStore().create()
  const source = createSnapshotStore<ResourceSnapshot<AdminData>>({ status: 'live', value: initial, failure: undefined })
  const useData = bindSnapshotSelector(source)
  const unused = (): never => { throw new Error('Unused administration fixture hook') }
  const exportCsv = vi.fn<AdminPageProps['exportCsv']>().mockResolvedValue({ ok: true, value: undefined })
  const savePrice = vi.fn<AdminPageProps['savePrice']>()
  const addresses: string[] = []
  const props: AdminPageProps = {
    ...allowAllAccess, useContextMenu: contextMenuHook(), usePanelInfo: unused, useWorkspaces: unused, useSessions: unused,
    useSessionStatus: unused, useSessionRetainInfo: unused,
    useResource: ((address: string) => {
      addresses.push(address)
      if (address.startsWith('dsh-resource://admin/?')) return useData(value => value)
      if (address.startsWith('dsh-resource://admintool/') && tool) return { status: 'live', value: tool, failure: undefined }
      if (address.startsWith('dsh-resource://adminchildren/') && children) return { status: 'live', value: children, failure: undefined }
      if (address.startsWith('dsh-resource://adminmessage/') && messages) return { status: 'live', value: messages, failure: undefined }
      return { status: 'none', value: undefined, failure: undefined }
    }) as AdminPageProps['useResource'],
    useStore: bindSnapshotSelector(navigation), actions: navigation.actions, t: translate, pageSize: 50,
    exportCsv, savePrice, rebuild: vi.fn(async () => ({ ok: true as const, value: undefined })),
  }
  return { navigation, source, props, exportCsv, savePrice, addresses }
}

it('opens a conversation from the table and exports the displayed snapshot', async () => {
  const { props, navigation, exportCsv } = fixture()
  render(<AdminPage {...props} />)
  expect(screen.getByRole('tab', { name: en.sessions }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  expect(exportCsv).toHaveBeenCalledWith({ kind: 'sessions', filter: {}, snapshot: revision })
  fireEvent.click(screen.getByRole('button', { name: row.title }))
  expect(navigation.getSnapshot().sessionId).toBe(id)
})

it('keeps rows visible after a failed refresh and requires a new snapshot after a stale export', async () => {
  const { props, source, exportCsv, navigation } = fixture()
  exportCsv.mockResolvedValue({ ok: false, error: new RemoteError('admin/error', 'Changed', { reason: 'stale-snapshot' }) })
  render(<AdminPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.export }))
  await screen.findByText(en.stale)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(navigation.getSnapshot().revision).toBe(1)
  act(() => { source.set({ ...source.getSnapshot(), status: 'failed', failure: new RemoteError('gateway/internal', 'Offline', {}) }) })
  expect(screen.getByRole('button', { name: row.title })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.export }).hasAttribute('disabled')).toBe(true)
})

it('applies search and inclusive calendar dates, then clears filters', () => {
  const { props, navigation } = fixture()
  render(<AdminPage {...props} />)
  fireEvent.change(screen.getByLabelText(en.search), { target: { value: 'checkout' } })
  fireEvent.change(screen.getByLabelText(en.from), { target: { value: '2026-11-01' } })
  fireEvent.change(screen.getByLabelText(en.to), { target: { value: '2026-11-06' } })
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  expect(navigation.getSnapshot().filter).toEqual({ query: 'checkout', from: new Date('2026-11-01T00:00:00+08:00').getTime(), to: new Date('2026-11-07T00:00:00+08:00').getTime() })
  fireEvent.click(screen.getByRole('button', { name: en.clear }))
  expect(navigation.getSnapshot().filter).toEqual({})
})

it('shows readable chat text, inherited history and the parent link', () => {
  const parent = 'parent-example' as SessionId
  const { props, navigation } = fixture({
    index, detail: { session: { ...row, parentId: parent }, snapshot: revision, throughSeq: 3, inheritedEventCount: 1 }, events: {
      items: [{ seq: 1 as SessionSeq, time, type: 'user/message', data: '{}', text: 'Check the failing checkout', role: 'user', truncated: false, inherited: true }],
      total: 1, snapshot: revision, indexedAt: time,
    } })
  navigation.actions.session(id)
  render(<AdminPage {...props} />)
  expect(screen.getByText('Check the failing checkout')).toBeTruthy()
  expect(screen.getByText(en.inherited)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.parent }))
  expect(navigation.getSnapshot().sessionId).toBe(parent)
})

it('separates historical repricing from future price creation', async () => {
  const { props, navigation, savePrice } = fixture({
    index, usage: { items: [], total: 0, snapshot: revision, indexedAt: time }, summary, prices: [],
  })
  navigation.actions.tab('costs')
  savePrice.mockResolvedValue({ ok: false, error: new RemoteError('admin/error', 'Invalid', { reason: 'invalid-request' }) })
  render(<AdminPage {...props} />)
  expect(screen.getByRole('heading', { name: en.costByModel })).toBeTruthy()
  expect(screen.getByRole('heading', { name: en.costByDate })).toBeTruthy()
  fireEvent.click(screen.getByText(en.prices))
  const form = document.querySelector<HTMLFormElement>('[data-admin-price-form]')!
  for (const [name, value] of Object.entries({ model: 'deepseek-chat', currency: 'CNY', effectiveFrom: '2026-11-01T00:00', inputPerMillion: '2', cacheReadPerMillion: '0.2', outputPerMillion: '3' })) {
    fireEvent.change(form.elements.namedItem(name) as HTMLInputElement, { target: { value } })
  }
  fireEvent.click(within(form).getByRole('checkbox'))
  expect(within(form).getByText(en.historicalHelp)).toBeTruthy()
  fireEvent.submit(form)
  await screen.findByText(en.operationFailed)
  expect(savePrice).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-chat', currency: 'CNY', inputPerMillion: '2' }), true)
})

it('expands a truncated message from its page offset and preserves the response-limit notice', () => {
  const event = {
    seq: 70 as SessionSeq, time, type: 'assistant/message', data: '', text: 'Short excerpt', role: 'assistant' as const,
    truncated: true, inherited: false,
  }
  const events = { items: [event], total: 51, snapshot: revision, indexedAt: time }
  const { props, navigation, addresses } = fixture({
    index, detail: { session: row, snapshot: revision, throughSeq: 70, inheritedEventCount: 0 }, events,
  }, undefined, undefined, { ...events, items: [{ ...event, text: 'The longer message text' }] })
  navigation.actions.session(id)
  navigation.actions.page(50)
  render(<AdminPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.expandMessage }))
  expect(screen.getByText('The longer message text')).toBeTruthy()
  expect(screen.getByText(en.messageLimit)).toBeTruthy()
  const address = new URL(addresses.find(value => value.startsWith('dsh-resource://adminmessage/'))!)
  expect(address.searchParams.get('offset')).toBe('50')
  expect(address.searchParams.get('snapshot')).toBe(revision)
  fireEvent.click(screen.getByRole('button', { name: en.collapse }))
  expect(screen.getByText('Short excerpt')).toBeTruthy()
})

it('opens a child conversation without showing the selected parent as its own child', () => {
  const child = { ...row, id: 'child-example' as SessionId, parentId: id, title: 'Investigate payment retry' }
  const { props, navigation } = fixture({
    index, detail: { session: row, snapshot: revision, throughSeq: 3, inheritedEventCount: 0 },
  }, undefined, { items: [row, child], total: 2, snapshot: revision, indexedAt: time })
  navigation.actions.session(id)
  render(<AdminPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.children }))
  const list = document.querySelector<HTMLElement>('[data-admin-children]')!
  expect(within(list).queryByText(row.title)).toBeNull()
  fireEvent.click(within(list).getByRole('button', { name: child.title }))
  expect(navigation.getSnapshot().sessionId).toBe(child.id)
})


it('loads selected tool arguments and result without changing its conversation', () => {
  const tool: AdminToolDetail = { tool: { sessionId: id, seq: 5 as SessionSeq, name: 'bash', time, durationMs: 180, status: 'success', nested: false }, arguments: '{"command":"git status"}', result: 'working tree clean', truncated: false, snapshot: revision }
  const { props, navigation } = fixture({
    index, tools: { items: [tool.tool], total: 1, snapshot: revision, indexedAt: time }, summary,
  }, tool)
  navigation.actions.tab('tools')
  render(<AdminPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.details }))
  expect(screen.getByText(tool.arguments)).toBeTruthy()
  expect(screen.getByText('working tree clean')).toBeTruthy()
  expect(navigation.getSnapshot().sessionId).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByText('working tree clean')).toBeNull()
})

it('presents loading, an empty page, and the complete daily overview', () => {
  const { props, source, navigation } = fixture()
  source.set({ status: 'loading', value: undefined, failure: undefined })
  render(<AdminPage {...props} />)
  expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
  act(() => { source.set({ status: 'live', value: { index, sessions: { items: [], total: 0, snapshot: revision, indexedAt: time } }, failure: undefined }) })
  expect(screen.getByText(en.empty)).toBeTruthy()
  act(() => { navigation.actions.tab('overview'); source.set({ status: 'live', value: { index, summary }, failure: undefined }) })
  expect(screen.getByText(en.dailyTokens)).toBeTruthy()
  expect(screen.getByText('2026-11-06')).toBeTruthy()
  expect(screen.getByRole('list').textContent).toContain('150')
})
