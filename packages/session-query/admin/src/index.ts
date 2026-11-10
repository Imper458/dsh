/** Owner-only administration over replayed Session facts and durable prices. */
import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { adminFactsDefinition, adminFactsSchema, usageSchema, toolSchema, type AdminFacts, type ToolFact } from './facts.ts'
import { AdminStorage, adminError, priceUsage } from './storage.ts'
import type { AdminPage, AdminPageRequest, AdminSessionRow, AdminSessionDetail, AdminEventsRequest, AdminEventRow, AdminToolRow, AdminToolDetail, AdminUsageRow, AdminUsageSummary, AdminPriceVersion, AdminPriceInput, AdminHistoricalPriceRequest, AdminIndexStatus, AdminExportRequest, AdminExportResult, AdminSnapshotId, AdminFilter } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { admin: Admin } }

/** Deployment-owned database path and bounds; no prices are silently supplied. */
export interface Config {
  /** Required absolute path to the SQLite database containing metadata and durable prices. */
  path: string
  /** Background corpus reconciliation interval in milliseconds; defaults to 5000. */
  refreshIntervalMs?: number
  /** Maximum interactive page size in rows; defaults to 100. */
  pageSizeMax?: number
  /** Maximum serialized event or tool detail response in UTF-8 bytes; defaults to 65536. */
  detailBytesMax?: number
  /** Maximum matching rows in one CSV export; defaults to 10000. */
  exportRowsMax?: number
  /** Maximum UTF-8 bytes in one CSV export; defaults to 16777216. */
  exportBytesMax?: number
}
const configSchema = z.object({
  path: z.string().min(1),
  refreshIntervalMs: z.number().int().positive().max(2_147_483_647).default(5000),
  pageSizeMax: z.number().int().positive().max(1000).default(100),
  detailBytesMax: z.number().int().positive().default(65536),
  exportRowsMax: z.number().int().positive().default(10000),
  exportBytesMax: z.number().int().positive().default(16 * 1024 * 1024),
}).strict()
const filterSchema = z.object({
  query: z.string().max(500).optional(), from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(), model: z.string().max(200).optional(),
  state: z.enum(['running', 'completed', 'failed', 'interrupted', 'idle']).optional(),
  sessionId: z.string().transform(SessionId).optional(), descendants: z.boolean().optional(),
}).strict()

/** Internal administration service; every Remote operation requires the owner principal. */
export class Admin extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessionProjections', 'sessions', 'sessionPersistence']
  private readonly config: z.infer<typeof configSchema>
  private storage!: AdminStorage
  private handle!: ProjectionHandle<AdminFacts>
  private readonly abort = new AbortController()
  private indexing: Promise<void> | undefined
  private queued = false
  private readonly dirty = new Set<SessionId>()
  private status: Omit<AdminIndexStatus, 'snapshot' | 'indexedSessions' | 'indexedAt'> = {
    state: 'idle', totalSessions: 0, failedSessions: 0, error: null,
  }

  /**
   * @param ctx - profile-owned services.
   * @param config - dedicated database path and query bounds.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'admin')
    this.config = configSchema.parse(config)
    if (!isAbsolute(this.config.path)) {
      throw new Error('admin: path must be an absolute database path')
    }
  }
  /** Register the private fold before starting background indexing. */
  async [Service.init](): Promise<void> {
    this.handle = await this.ctx.sessionProjections.register(adminFactsDefinition)
    await this.ctx.effect(async () => {
      this.storage = await AdminStorage.open(this.config.path)
      return async () => {
        this.abort.abort()
        await this.indexing
        this.storage.close()
        await this.handle.dispose()
      }
    })
    this.ctx.on('session/event', (session) => {
      this.dirty.add(session.id)
      this.schedule()
    })
    this.ctx.effect(() => {
      const timer = setInterval(() => { this.schedule() }, this.config.refreshIntervalMs)
      return () => { clearInterval(timer) }
    })
    this.schedule()
  }
  private owner(): void {
    // PrincipalMap is merge-extensible: the current compilation may declare only owner.
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw adminError('denied', 'Administration requires the instance owner.')
  }
  private checkSnapshot(snapshot?: AdminSnapshotId): void {
    if (snapshot !== undefined && snapshot !== this.storage.snapshot()) {
      throw adminError('stale-snapshot', 'The administration data changed; refresh the current view before continuing.')
    }
  }
  private page(request: AdminPageRequest): { filter: AdminFilter; offset: number; limit: number; sort: 'newest' | 'oldest' } {
    this.checkSnapshot(request.snapshot)
    const parsed = filterSchema.safeParse(request.filter ?? {})
    const offset = request.offset ?? 0
    const limit = request.limit ?? this.config.pageSizeMax
    const sort = z.enum(['newest', 'oldest']).safeParse(request.sort ?? 'newest')
    if (!parsed.success || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > this.config.pageSizeMax || !sort.success) {
      throw adminError('invalid-request', 'Use a valid filter and bounded pagination values.')
    }
    if (parsed.data.from !== undefined && parsed.data.to !== undefined && parsed.data.from >= parsed.data.to) {
      throw adminError('invalid-request', 'The start time must precede the end time.')
    }
    return { filter: parsed.data as AdminFilter, offset, limit, sort: sort.data }
  }
  private wrap<T>(items: T[], total: number): AdminPage<T> {
    return { items, total, snapshot: this.storage.snapshot(), indexedAt: this.storage.indexedAt() }
  }
  private facts(id: SessionId): AdminFacts {
    const facts = this.storage.session(id)
    if (facts === undefined) throw adminError('not-found', 'This conversation is not indexed; refresh the index and try again.')
    return facts
  }
  private row(facts: AdminFacts, prices: readonly AdminPriceVersion[]): AdminSessionRow {
    const usage = Object.values(facts.usage).map(fact => priceUsage(facts.id, fact, prices))
    const summary = summarize(usage)
    return { id: facts.id, parentId: facts.parentId, title: facts.title, workspace: facts.workspace,
      createdAt: facts.createdAt, updatedAt: facts.updatedAt, state: facts.state,
      models: [...new Set(usage.flatMap(item => item.model === null ? [] : [item.model]))],
      inputTokens: summary.inputTokens, cacheReadTokens: summary.cacheReadTokens, outputTokens: summary.outputTokens,
      calls: usage.length, tools: Object.keys(facts.tools).length, missingUsage: summary.missingUsage,
      missingPrice: summary.missingPrice, costs: summary.costs }
  }
  private checkSource(facts: AdminFacts, observation: SessionObservation): void {
    const source = this.storage.source(facts.id)
    if (observation.cursor < facts.throughSeq
      || (observation.revision !== undefined && source?.revision !== null && source?.revision !== observation.revision)) {
      throw adminError('stale-snapshot', 'The source journal changed; refresh the index before reading its details.')
    }
  }
  private checkDetailSize(value: object): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.config.detailBytesMax) {
      throw adminError('invalid-request', 'The detail response exceeds the configured limit; request fewer events or raise detailBytesMax.')
    }
  }
  private schedule(): void {
    if (this.abort.signal.aborted || this.queued) return
    this.queued = true
    void setImmediate().then(() => {
      this.queued = false
      if (this.abort.signal.aborted || this.indexing !== undefined) return
      this.indexing = this.refresh().finally(() => { this.indexing = undefined; if (this.dirty.size > 0) this.schedule() })
    })
  }
  private async refresh(): Promise<void> {
    this.status = { ...this.status, state: 'indexing', failedSessions: 0, error: null }
    try {
      const records = await this.ctx.sessionQuery.listSessions(this.abort.signal)
      this.status.totalSessions = records.length
      const ids = new Set(records.map(record => record.header.id))
      this.storage.removeAbsent(ids)
      for (const id of this.dirty) if (!ids.has(id)) this.dirty.delete(id)
      for (const record of records) {
        this.abort.signal.throwIfAborted()
        const id = record.header.id
        this.dirty.delete(id)
        try {
          const existing = this.storage.source(id)
          const live = this.ctx.sessions.get(id)
          if (live !== undefined && existing?.cursor === live.seq - 1) continue
          if (live === undefined && existing?.revision !== null && existing !== undefined) {
            const persisted = await this.ctx.sessionPersistence.stat(id, { signal: this.abort.signal })
            if (persisted?.revision === existing.revision) continue
          }
          const { observation, state } = await this.ctx.sessionQuery.observeState(id,
            (session: Session) => this.handle.stateOf(session), { signal: this.abort.signal, projectionMode: 'none' })
          try {
            this.abort.signal.throwIfAborted()
            // The source cursor also includes events that do not affect administration facts.
            this.storage.put({ ...state, throughSeq: observation.cursor }, observation.revision ?? null)
          } finally { observation[Symbol.dispose]() }
        } catch (error) {
          if (this.abort.signal.aborted) throw error
          this.status.failedSessions += 1
          this.status.error = 'Some conversations could not be indexed. Their previous indexed values may be stale; rebuild after repairing the source.'
        }
        await setImmediate()
      }
      this.storage.complete(Date.now())
      this.status.state = this.status.failedSessions === 0 ? 'ready' : 'error'
    } catch (error) {
      if (this.abort.signal.aborted) return
      this.status.state = 'error'
      this.status.error = 'The administration index could not refresh. Check the configured storage and rebuild the index.'
      this.ctx.logger.error('admin index refresh failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * List indexed conversations without activating their agents.
   * @param request - shared filter, pagination and optional revision.
   * @returns one bounded page with coverage counters.
   */
  @Remote
  listSessions(request: AdminPageRequest): AdminPage<AdminSessionRow> {
    this.owner()
    const page = this.page(request)
    const selected = this.storage.select('sessions', page.filter, page.offset, page.limit, page.sort)
    const prices = this.storage.listPrices()
    return this.wrap(selected.rows.map(row => this.row(adminFactsSchema.parse(JSON.parse(row.data)), prices)), selected.total)
  }
  /**
   * Read one indexed conversation's identity and watermark.
   * @param sessionId - conversation to inspect.
   * @param snapshot - optional selected revision.
   * @returns metadata covering the indexed journal cut.
   */
  @Remote
  getSession(sessionId: SessionId, snapshot?: AdminSnapshotId): AdminSessionDetail {
    this.owner(); this.checkSnapshot(snapshot)
    const facts = this.facts(sessionId)
    return { session: this.row(facts, this.storage.listPrices()), throughSeq: facts.throughSeq,
      inheritedEventCount: facts.inherited, snapshot: this.storage.snapshot() }
  }
  /**
   * Read a bounded event page through the prepared observation API.
   * @param request - indexed conversation, pagination and optional revision.
   * @returns bounded serialized events, with readable chat text separate from raw payloads.
   */
  @Remote
  async listEvents(request: AdminEventsRequest): Promise<AdminPage<AdminEventRow>> {
    this.owner()
    const page = this.page(request)
    const facts = this.facts(request.sessionId)
    const snapshot = this.storage.snapshot()
    const observation = await this.ctx.sessionQuery.observeSession(request.sessionId, { projectionMode: 'none', signal: this.abort.signal })
    try {
      this.checkSnapshot(snapshot)
      this.checkSource(facts, observation)
      const source = observation.events.slice(0, facts.throughSeq + 1)
      const matching = request.messagesOnly === true ? source.filter(event => event.type === 'user/message' || event.type === 'assistant/message') : source
      const events = matching.slice(page.offset, page.offset + page.limit)
      const entries = events.map((event) => {
        const message = event.type === 'assistant/message' ? event.data.message : event.type === 'user/message' ? event.data : null
        const row: AdminEventRow = { seq: event.seq, time: event.time, type: event.type, data: '', truncated: false,
          inherited: event.seq < facts.inherited, text: message === null ? null : '',
          role: event.type === 'assistant/message' ? 'assistant' : event.type === 'user/message' ? 'user' : null }
        return { row, payload: { raw: request.messagesOnly === true ? '' : JSON.stringify(event.data),
          text: message === null ? null : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') } }
      })
      const result = this.wrap(entries.map(entry => entry.row), matching.length)
      const available = Math.max(0, this.config.detailBytesMax - Buffer.byteLength(JSON.stringify(result), 'utf8'))
      const perRow = Math.floor(available / Math.max(1, events.length))
      for (const { row, payload } of entries) {
        const perField = payload.text === null || request.messagesOnly === true ? perRow : Math.floor(perRow / 2)
        const raw = boundedJsonText(payload.raw, perField)
        const text = payload.text === null ? null : boundedJsonText(payload.text, perField)
        row.data = raw.text
        row.text = text?.text ?? null
        row.truncated = raw.truncated || text?.truncated === true
      }
      this.checkDetailSize(result)
      return result
    } finally { observation[Symbol.dispose]() }
  }
  /**
   * List top-level and nested tool calls, each with its own duration.
   * @param request - shared selection and page.
   * @returns indexed tool metadata without arguments or result payloads.
   */
  @Remote
  listTools(request: AdminPageRequest): AdminPage<AdminToolRow> {
    this.owner(); const page = this.page(request)
    const selected = this.storage.select('tools', page.filter, page.offset, page.limit, page.sort)
    return this.wrap(selected.rows.map(row => toolRow(SessionId(row.sessionId), toolSchema.parse(JSON.parse(row.data)))), selected.total)
  }
  /**
   * Read only the selected tool's payload from its source observation.
   * @param sessionId - owning conversation.
   * @param seq - indexed tool-call event.
   * @param snapshot - optional selected revision.
   * @returns bounded arguments and result, preserving missing outcomes.
   */
  @Remote
  async getTool(sessionId: SessionId, seq: SessionSeq, snapshot?: AdminSnapshotId): Promise<AdminToolDetail> {
    this.owner(); this.checkSnapshot(snapshot)
    const facts = this.facts(sessionId)
    const call = Object.values(facts.tools).find(item => item.seq === seq)
    if (call === undefined) throw adminError('not-found', 'The selected tool call is not indexed.')
    const current = this.storage.snapshot()
    const observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: this.abort.signal })
    try {
      this.checkSnapshot(current)
      this.checkSource(facts, observation)
      const start = observation.events[call.seq]
      const result = call.resultSeq === null ? undefined : observation.events[call.resultSeq]
      if (start === undefined || (start.type !== 'tool/call' && start.type !== 'tool/ptc-dispatch-start' && start.type !== 'tool/ptc-dispatch')
        || (call.resultSeq !== null && result?.type !== 'tool/result' && result?.type !== 'tool/ptc-dispatch')) {
        throw adminError('stale-snapshot', 'The selected tool events changed; rebuild the index.')
      }
      const args = start.type === 'tool/call' ? start.data.arguments
        : start.type === 'tool/ptc-dispatch-start' ? JSON.stringify(start.data.arguments)
          : result?.type === 'tool/ptc-dispatch' ? JSON.stringify(result.data.arguments) : ''
      const payload = result?.type === 'tool/result' ? JSON.stringify(result.data.message.content)
        : result?.type === 'tool/ptc-dispatch' ? JSON.stringify(result.data.content) : null
      const a = bounded(args, Math.floor(this.config.detailBytesMax / 4))
      const b = payload === null ? null : bounded(payload, Math.floor(this.config.detailBytesMax / 4))
      const detail = { tool: toolRow(sessionId, call), arguments: a.text, result: b?.text ?? null,
        truncated: a.truncated || b?.truncated === true, snapshot: current }
      this.checkDetailSize(detail)
      return detail
    } finally { observation[Symbol.dispose]() }
  }
  /**
   * List DeepSeek estimates and explicit uncovered calls.
   * @param request - shared selection and page.
   * @returns call-level token counters and matched immutable rates.
   */
  @Remote
  listUsage(request: AdminPageRequest): AdminPage<AdminUsageRow> {
    this.owner(); const page = this.page(request)
    const selected = this.storage.select('usage', page.filter, page.offset, page.limit, page.sort)
    const prices = this.storage.listPrices()
    const items = selected.rows.map(row => priceUsage(SessionId(row.sessionId), usageSchema.parse(JSON.parse(row.data)), prices))
    return this.wrap(items, selected.total)
  }
  /**
   * Aggregate the full filtered call set, independently of the visible page.
   * @param request - shared selection and optional revision.
   * @returns currency-separated subtotals and coverage counts.
   */
  @Remote
  usageSummary(request: AdminPageRequest): AdminUsageSummary {
    this.owner(); const page = this.page(request)
    const prices = this.storage.listPrices()
    const rows = this.storage.select('usage', page.filter, 0, -1, page.sort).rows
    const calls = rows.map(row => priceUsage(SessionId(row.sessionId), usageSchema.parse(JSON.parse(row.data)), prices))
    const sessions = [...new Set(calls.map(call => call.sessionId))].map(id => this.facts(id))
    return { ...summarize(calls), daily: dailyUsage(calls), models: modelUsage(calls),
      sessions: { total: sessions.length,
        running: sessions.filter(session => session.state === 'running').length,
        failed: sessions.filter(session => session.state === 'failed').length },
      snapshot: this.storage.snapshot(), indexedAt: this.storage.indexedAt() }
  }
  /** List configured prices without supplying implicit rates.
   * @returns immutable configured prices; absence means costs are unavailable.
   */
  @Remote
  listPrices(): AdminPriceVersion[] { this.owner(); return this.storage.listPrices() }
  /**
   * Append a future-effective DeepSeek price version.
   * @param price - all three disjoint usage rates and activation time.
   * @returns committed version; existing versions are never overwritten.
   */
  @Remote
  addPrice(price: AdminPriceInput): AdminPriceVersion { this.owner(); return this.storage.addPrice(price, false) }
  /**
   * Explicitly add a historical version and recompute subsequent estimates from it.
   * @param request - backdated rates; the next effective version bounds their interval.
   * @returns committed immutable version; prior exports retain their original revision.
   */
  @Remote
  repriceHistory(request: AdminHistoricalPriceRequest): AdminPriceVersion {
    this.owner()
    return this.storage.addPrice(request.price, true)
  }
  /** Read the current background index progress.
   * @returns background progress and any persistent indexing failure.
   */
  @Remote
  indexStatus(): AdminIndexStatus {
    this.owner()
    return { ...this.status, indexedSessions: this.storage.count(), indexedAt: this.storage.indexedAt(), snapshot: this.storage.snapshot() }
  }
  /** Request a rebuild of derived metadata while preserving durable prices.
   * @returns current rebuild progress; a running pass is left intact.
   */
  @Remote
  rebuildIndex(): AdminIndexStatus {
    this.owner()
    if (this.indexing === undefined) { this.storage.clear(); this.status.state = 'indexing'; this.schedule() }
    return { ...this.status, indexedSessions: this.storage.count(), indexedAt: this.storage.indexedAt(), snapshot: this.storage.snapshot() }
  }
  /**
   * Export the exact selected revision without silently refreshing it.
   * @param request - resource kind, shared filters, and required revision.
   * @returns a bounded CSV with formula-safe text cells and revision metadata.
   */
  @Remote
  exportCsv(request: AdminExportRequest): AdminExportResult {
    this.owner(); this.checkSnapshot(request.snapshot)
    const page = this.page({ ...request.filter === undefined ? {} : { filter: request.filter }, snapshot: request.snapshot })
    const selected = this.storage.select(request.kind, page.filter, 0, this.config.exportRowsMax + 1, 'newest')
    if (selected.total > this.config.exportRowsMax) throw adminError('export-too-large', 'Narrow the filters before exporting this many rows.')
    const prices = this.storage.listPrices()
    const items = selected.rows.map(row => request.kind === 'sessions'
      ? this.row(adminFactsSchema.parse(JSON.parse(row.data)), prices)
      : request.kind === 'tools' ? toolRow(SessionId(row.sessionId), toolSchema.parse(JSON.parse(row.data)))
        : priceUsage(SessionId(row.sessionId), usageSchema.parse(JSON.parse(row.data)), prices))
    const first = items[0]
    const columns = first === undefined ? ['snapshot', 'indexedAt'] : ['snapshot', 'indexedAt', ...Object.keys(first)]
    const csv = '\uFEFF' + [columns, ...items.map((item) => {
      const values: unknown[] = Object.values(item)
      return [request.snapshot, this.storage.indexedAt(), ...values]
    })]
      .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
    if (Buffer.byteLength(csv, 'utf8') > this.config.exportBytesMax) throw adminError('export-too-large', 'Narrow the filters to produce a smaller export.')
    return { filename: `admin-${request.kind}.csv`, csv, snapshot: request.snapshot }
  }
}
export default Admin

function toolRow(sessionId: SessionId, fact: ToolFact): AdminToolRow {
  return { sessionId, seq: fact.seq, name: fact.name, time: fact.time, nested: fact.nested,
    durationMs: fact.durationMs, status: fact.status }
}
function summarize(rows: readonly AdminUsageRow[]): Omit<AdminUsageSummary, 'snapshot' | 'indexedAt' | 'daily' | 'models' | 'sessions'> {
  const costs = new Map<string, number>()
  for (const row of rows) {
    if (row.currency !== null && row.amount !== null) costs.set(row.currency, (costs.get(row.currency) ?? 0) + row.amount)
  }
  return { calls: rows.length, inputTokens: rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0),
    cacheReadTokens: rows.reduce((total, row) => total + (row.cacheReadTokens ?? 0), 0),
    outputTokens: rows.reduce((total, row) => total + (row.outputTokens ?? 0), 0),
    pricedCalls: rows.filter(row => row.coverage === 'priced').length,
    missingUsage: rows.filter(row => row.coverage === 'missing-usage').length,
    missingPrice: rows.filter(row => row.coverage === 'missing-price').length,
    unsupportedCalls: rows.filter(row => row.coverage === 'unsupported').length,
    costs: [...costs].map(([currency, amount]) => ({ currency, amount })) }
}
function bounded(text: string, bytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8')
  return encoded.length <= bytes ? { text, truncated: false }
    : { text: new TextDecoder().decode(encoded.subarray(0, bytes), { stream: true }), truncated: true }
}
function boundedJsonText(text: string, bytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(text), 'utf8') - 2 <= bytes) return { text, truncated: false }
  let lower = 0
  let upper = text.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle)), 'utf8') - 2 <= bytes) lower = middle
    else upper = middle - 1
  }
  if (lower > 0 && /[\uD800-\uDBFF]/.test(text.slice(lower - 1, lower))) lower -= 1
  return { text: text.slice(0, lower), truncated: true }
}
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  const safe = typeof value === 'string' && /^\s*[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

function dailyUsage(rows: readonly AdminUsageRow[]): AdminUsageSummary['daily'] {
  const days = new Map<string, AdminUsageRow[]>()
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  for (const row of rows) {
    const day = dateFormat.format(row.time)
    const group = days.get(day) ?? []
    group.push(row)
    days.set(day, group)
  }
  return [...days].sort(([left], [right]) => left.localeCompare(right)).map(([date, group]) => {
    const totals = summarize(group)
    return { date, calls: totals.calls, inputTokens: totals.inputTokens,
      cacheReadTokens: totals.cacheReadTokens, outputTokens: totals.outputTokens, costs: totals.costs }
  })
}
function modelUsage(rows: readonly AdminUsageRow[]): AdminUsageSummary['models'] {
  const models = new Map<string | null, AdminUsageRow[]>()
  for (const row of rows) {
    const group = models.get(row.model) ?? []
    group.push(row)
    models.set(row.model, group)
  }
  return [...models].map(([model, group]) => ({ model, calls: group.length, costs: summarize(group).costs }))
}
