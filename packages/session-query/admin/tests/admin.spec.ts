/** Real Loader, JSONL persistence and SQLite composition for administration queries. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import Admin from '../src/index.ts'
import { adminFactsDefinition } from '../src/facts.ts'
import { AdminStorage, priceUsage } from '../src/storage.ts'
import type { AdminPriceVersion, AdminPriceId } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'admin-test-guest': { kind: 'admin-test-guest' } } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function caller(ctx: Context, principal: Principal): Admin {
  const invocation: RemoteInvocation = {
    request: { namespace: 'admin', method: 'indexStatus', args: {} }, service: 'admin',
    peer: { id: 'admin-owner' as PeerId, ctx, principal, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return ctx.extend({ invocation }).admin
}
async function boot(): Promise<{ ctx: Context; api: Admin; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admin-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, sessions: SessionStore, projections: SessionProjectionRegistry,
    persistence: Jsonl, query: Query, admin: Admin })
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:sessions' }, { name: 'cordis:projections' },
    { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: 'cordis:query', config: { path: join(root, 'search.db'), openAt: 'never' } },
    { name: 'cordis:admin', config: { path: join(root, 'admin.db'), refreshIntervalMs: 60000 } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const api = caller(ctx, { kind: 'owner' })
  await vi.waitFor(() => { expect(api.indexStatus().state).toBe('ready') })
  return { ctx, api, root }
}
function journal(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, [], { id: sessionId, createdAt: 100, version: SESSION_FORMAT_VERSION, isSeeded: false, cwd: '/work' })
}
function turn(session: Session, turnNumber = 1): void {
  session.append('turn/start', { turn: turnNumber })
  session.append('step/start', { turn: turnNumber, step: 1 })
  session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } }, reason: 'initial' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect this task' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: turnNumber, step: 1, stream: [], usage: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 20 },
    message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Task inspected' }, { type: 'tool-call', id: ToolCallId(`call-${turnNumber}`), name: 'read', arguments: '{"path":"readme"}' }] }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: turnNumber, step: 1, callId: ToolCallId(`call-${turnNumber}`), name: 'read', arguments: '{"path":"readme"}' })
  session.append('tool/result', { turn: turnNumber, step: 1, message: createMessage({ role: 'tool', toolCallId: ToolCallId(`call-${turnNumber}`), isError: false, source: { kind: 'tool', callId: ToolCallId(`call-${turnNumber}`), name: 'read' }, content: [{ type: 'text', text: 'File content' }] }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: turnNumber, step: 1 })
  session.append('turn/end', { turn: turnNumber, reason: { kind: 'completed' } })
}
async function persist(ctx: Context, session: Session): Promise<void> {
  const handle = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  try { await handle.append(session.snapshotEvents()) } finally { await handle.close() }
}
async function rebuild(api: Admin): Promise<void> {
  api.rebuildIndex()
  await vi.waitFor(() => { expect(api.indexStatus().state).toBe('ready') })
}
const historical = { model: 'deepseek-chat', currency: 'CNY', effectiveFrom: 0, inputPerMillion: '2', cacheReadPerMillion: '0.2', outputPerMillion: '3' }

describe('owner administration', () => {
  it('backfills persisted conversations without activation, preserves prices across rebuild and exports the selected revision', async () => {
    const { ctx, api } = await boot()
    const session = journal('stored')
    turn(session)
    await persist(ctx, session)
    const observed = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    observed[Symbol.dispose]()
    await rebuild(api)
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    expect(api.listSessions({}).items).toMatchObject([{ id: 'stored', calls: 1, inputTokens: 100, tools: 1 }])
    expect(api.usageSummary({})).toMatchObject({ calls: 1, missingPrice: 1, pricedCalls: 0 })
    const price = api.repriceHistory({ price: historical })
    const summary = api.usageSummary({})
    expect(summary).toMatchObject({ pricedCalls: 1, costs: [{ currency: 'CNY', amount: 0.00027 }] })
    const events = await api.listEvents({ sessionId: session.id, snapshot: summary.snapshot })
    expect(events.items.find(event => event.role === 'assistant')?.text).toBe('Task inspected')
    const tool = api.listTools({}).items[0]!
    expect(await api.getTool(session.id, tool.seq)).toMatchObject({ arguments: '{"path":"readme"}', truncated: false })
    const csv = api.exportCsv({ kind: 'usage', snapshot: summary.snapshot })
    expect(csv.csv).toContain(price.id)
    expect(csv.csv).toContain('0.00027')
    await rebuild(api)
    expect(api.listPrices()).toEqual([price])
    expect(api.usageSummary({}).costs).toEqual(summary.costs)
    expect(() => api.exportCsv({ kind: 'usage', snapshot: summary.snapshot })).toThrow(expect.objectContaining({ details: { reason: 'stale-snapshot' } }))
    expect(ctx.sessions.get(session.id)).toBeUndefined()
  })

  it('rejects every non-owner operation, including detail and export paths', async () => {
    const { ctx, api } = await boot()
    const snapshot = api.indexStatus().snapshot
    const guest = caller(ctx, { kind: 'admin-test-guest' })
    for (const operation of [() => guest.listSessions({}), () => guest.listTools({}), () => guest.listUsage({}),
      () => guest.usageSummary({}), () => guest.listPrices(), () => guest.addPrice(historical),
      () => guest.repriceHistory({ price: historical }), () => guest.indexStatus(), () => guest.rebuildIndex(),
      () => guest.getSession(SessionId('private')),
      () => guest.exportCsv({ kind: 'usage', snapshot })]) {
      expect(operation).toThrow(expect.objectContaining({ details: { reason: 'denied' } }))
    }
    await expect(guest.getTool(SessionId('private'), SessionSeq(0))).rejects.toMatchObject({ details: { reason: 'denied' } })
    await expect(guest.listEvents({ sessionId: SessionId('private') })).rejects.toMatchObject({ details: { reason: 'denied' } })
  })

  it('expands long chat messages within the serialized response budget without duplicating raw payloads', async () => {
    const { ctx, api } = await boot()
    const session = journal('long-chat')
    const text = '中文记录'.repeat(2000)
    const bodies = [text, '\u0001'.repeat(20000), text]
    for (const body of bodies) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    await persist(ctx, session)
    await rebuild(api)
    const page = await api.listEvents({ sessionId: session.id, messagesOnly: true, limit: 50 })
    expect(page.items.every(row => row.data === '')).toBe(true)
    expect(page.items[0]?.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(65536)
    const expanded = await api.listEvents({ sessionId: session.id, messagesOnly: true, limit: 1, offset: 0, snapshot: page.snapshot })
    expect(expanded.items[0]).toMatchObject({ text, truncated: false })
    const escaped = await api.listEvents({ sessionId: session.id, messagesOnly: true, limit: 1, offset: 1 })
    expect(escaped.items[0]?.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(escaped), 'utf8')).toBeLessThanOrEqual(65536)
    const lastPage = await api.listEvents({ sessionId: session.id, messagesOnly: true, limit: 50, offset: 2 })
    expect(lastPage.items[0]).toMatchObject({ text, truncated: false })
  })

  it('excludes inherited usage and preserves one priced call per owner when descendants are included', async () => {
    const { ctx, api } = await boot()
    const parent = journal('parent')
    turn(parent)
    await persist(ctx, parent)
    const prefix = parent.snapshotEvents()
    const childId = SessionId('child')
    const child = Session.create(childId, prefix,
      { ...parent.header, id: childId, isSeeded: true, parentSession: parent.id }, SessionLogOffset(prefix.length))
    turn(child, 2)
    await persist(ctx, child)
    await rebuild(api)
    api.repriceHistory({ price: historical })
    expect(api.usageSummary({ filter: { sessionId: parent.id, descendants: true } }))
      .toMatchObject({ calls: 2, inputTokens: 200, pricedCalls: 2 })
    expect(api.listSessions({}).items.every(row => row.calls === 1)).toBe(true)
  })

  it('groups dates in Shanghai and counts old conversations with calls inside the selected range', async () => {
    const { ctx, api } = await boot()
    const source = journal('old-active')
    turn(source)
    const time = Date.parse('2026-11-05T16:30:00Z')
    const session = Session.create(source.id, source.snapshotEvents().map(event => ({ ...event, time })), source.header)
    await persist(ctx, session)
    await rebuild(api)
    const summary = api.usageSummary({ filter: { from: Date.parse('2026-11-05T16:00:00Z'), to: Date.parse('2026-11-06T16:00:00Z') } })
    expect(summary.daily).toMatchObject([{ date: '2026-11-06', calls: 1 }])
    expect(summary.sessions).toEqual({ total: 1, running: 0, failed: 0 })
  })

  it('reports cold interrupted tools without inventing successful outcomes', async () => {
    const { ctx, api } = await boot()
    const original = journal('crashed')
    turn(original)
    const events = original.snapshotEvents()
    const resultIndex = events.findIndex(event => event.type === 'tool/result')
    const crashed = Session.create(original.id, events.slice(0, resultIndex), original.header)
    await persist(ctx, crashed)
    await rebuild(api)
    expect(api.listSessions({}).items[0]?.state).toBe('interrupted')
    expect(api.listTools({}).items[0]).toMatchObject({ status: 'interrupted', durationMs: null })
    expect(ctx.sessions.get(original.id)).toBeUndefined()
  })

  it('refuses detail reads after the indexed source journal is truncated', async () => {
    const { ctx, api } = await boot()
    const session = journal('truncated')
    turn(session)
    await persist(ctx, session)
    await rebuild(api)
    const tool = api.listTools({}).items[0]!
    const snapshot = await ctx.sessionPersistence.stat(session.id)
    const path = snapshot?.location?.path
    if (path === undefined) throw new Error('JSONL fixture has no persisted path')
    const header = (await readFile(path, 'utf8')).split('\n')[0]!
    await writeFile(path, `${header}\n`)
    await expect(api.getTool(session.id, tool.seq)).rejects.toMatchObject({ details: { reason: 'stale-snapshot' } })
    await expect(api.listEvents({ sessionId: session.id })).rejects.toMatchObject({ details: { reason: 'stale-snapshot' } })
  })

  it('indexes live commits asynchronously and keeps unchanged snapshot revisions stable', async () => {
    const { ctx, api } = await boot()
    const session = ctx.sessions.create(SessionId('live'))
    turn(session)
    await vi.waitFor(() => { expect(api.listSessions({}).items).toHaveLength(1) })
    expect(api.indexStatus().state).toBe('ready')
    const snapshot = api.indexStatus().snapshot
    expect(api.indexStatus().snapshot).toBe(snapshot)
    const observation = await ctx.sessionQuery.observeState(session.id, value => value.seq, { projectionMode: 'none' })
    expect(observation.state).toBe(observation.observation.cursor + 1)
    observation.observation[Symbol.dispose]()
    expect(() => observation.observation.retain()).toThrow('disposed')
  })
})

describe('price and private projection semantics', () => {
  it('uses official Beijing peak hours, holidays and half-price off-peak rates without double-counting cache', () => {
    const session = journal('official-prices')
    turn(session)
    const facts = session.snapshotEvents().reduce((state, event) => adminFactsDefinition.apply(state, event),
      adminFactsDefinition.init(session.header, SessionLogOffset(0)))
    const fact = { ...Object.values(facts.usage)[0]!, inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }
    const price: AdminPriceVersion = { id: 'official' as AdminPriceId, createdAt: 0, model: fact.model!, currency: 'CNY',
      effectiveFrom: Date.parse('2026-11-09T00:00:00+08:00'), inputPerMillion: '2', cacheReadPerMillion: '0.04', outputPerMillion: '8',
      deepseekSchedule: { validUntil: Date.parse('2028-01-01T00:00:00+08:00'), holidays: ['2027-02-05'] } }
    for (const [date, amount] of [
      ['2026-11-09T08:59:59', 5.02], ['2026-11-09T09:00:00', 10.04],
      ['2026-11-09T11:59:59', 10.04], ['2026-11-09T12:00:00', 5.02],
      ['2026-11-09T13:59:59', 5.02], ['2026-11-09T14:00:00', 10.04],
      ['2026-11-09T17:59:59', 10.04], ['2026-11-09T18:00:00', 5.02],
      ['2026-11-14T10:00:00', 5.02], ['2027-02-05T10:00:00', 5.02],
      ['2027-02-14T10:00:00', 5.02],
    ] as const) expect(priceUsage(session.id, { ...fact, time: Date.parse(`${date}+08:00`) }, [price])).toMatchObject({ amount, coverage: 'priced' })
    expect(priceUsage(session.id, { ...fact, time: price.deepseekSchedule!.validUntil }, [price])).toMatchObject({ coverage: 'missing-price', amount: null })
    expect(priceUsage(session.id, { ...fact, time: price.effectiveFrom - 1 }, [price]).coverage).toBe('missing-price')
    expect(priceUsage(session.id, { ...fact, time: price.effectiveFrom, cacheReadTokens: null }, [price]).coverage).toBe('missing-usage')
    const zero = { ...fact, time: price.effectiveFrom, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    expect(priceUsage(session.id, zero, [price]).amount).toBe(0)
  })
  it('counts retry attempts, summary calls and title settlements without counting usage updates twice', () => {
    const session = journal('attempts')
    const usage = { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } }, reason: 'initial' })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }] })
    session.append('llm/retry-started', { turn: 1, step: 1, retry: 1, retryId: RetryId('retry') })
    session.append('assistant/message', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 2, chunk: { type: 'usage', usage } }], usage,
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' }, content: [] }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const compactionId = CompactionId('summary')
    session.append('compaction/start', { compactionId, turn: 1 })
    session.append('compaction/summary', { compactionId, summary: [], shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) }, shadowedSeqs: [], shadowedTokenCount: 0,
      provider: 'deepseek-official', model: 'deepseek-chat', usage, rawOutput: [], llmStreamCall: true })
    const request = session.append('session/title-llm-request', { titleProvider: SessionTitleProviderId('title'), messageSeqs: [], route: { provider: 'deepseek-official', model: 'deepseek-chat' }, system: '', messages: [], maxTokens: 10 })
    session.append('session/title-llm-result', { requestSeq: request.seq, status: 'completed', usage })
    const facts = session.snapshotEvents().reduce((state, event) => adminFactsDefinition.apply(state, event),
      adminFactsDefinition.init(session.header, SessionLogOffset(0)))
    const rows = Object.values(facts.usage)
    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.kind)).toEqual(['conversation', 'conversation', 'compaction', 'title'])
    expect(rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0)).toBe(40)
    const checkpoint: unknown = JSON.parse(JSON.stringify(facts))
    expect(adminFactsDefinition.stateSchema.parse(checkpoint)).toEqual(facts)
  })

  it('does not count steps that fail before a model attempt is dispatched', () => {
    const session = journal('undispatched')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const facts = session.snapshotEvents().reduce((state, event) => adminFactsDefinition.apply(state, event),
      adminFactsDefinition.init(session.header, SessionLogOffset(0)))
    expect(Object.values(facts.usage)).toEqual([])
  })

  it('retains unknown cache counts and refuses unsupported cache writes', () => {
    const session = journal('unknown')
    turn(session)
    const state = session.snapshotEvents().reduce((state, event) => adminFactsDefinition.apply(state, event),
      adminFactsDefinition.init(session.header, SessionLogOffset(0)))
    const fact = Object.values(state.usage)[0]!
    expect(priceUsage(session.id, { ...fact, cacheReadTokens: null }, [])).toMatchObject({ coverage: 'missing-usage', amount: null })
    expect(priceUsage(session.id, { ...fact, unsupported: true }, [])).toMatchObject({ coverage: 'unsupported', amount: null })
  })

  it('does not overwrite rates and preserves price rows when the shared database index is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-admin-prices-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const storage = await AdminStorage.open(join(root, 'admin.db'))
    cleanups.push(async () => { storage.close() })
    const first = storage.addPrice(historical, true)
    expect(() => storage.addPrice(historical, true)).toThrow(expect.objectContaining({ details: { reason: 'invalid-request' } }))
    expect(() => storage.addPrice(historical, false)).toThrow(expect.objectContaining({ details: { reason: 'invalid-request' } }))
    storage.clear()
    expect(storage.listPrices()).toEqual([first])
  })
})
