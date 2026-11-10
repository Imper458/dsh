/** One SQLite database owns durable prices and rebuildable administration metadata. */
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { adminFactsSchema, type AdminFacts, type UsageFact } from './facts.ts'
import type { AdminFailure, AdminFilter, AdminPriceId, AdminPriceInput, AdminPriceVersion, AdminUsageRow, AdminSnapshotId } from './types.ts'

/**
 * Construct the domain's typed failure.
 * @param reason - stable handling discriminant.
 * @param message - actionable diagnostic without journal payloads.
 * @returns the failure for the operation owner to throw.
 */
export function adminError(reason: AdminFailure, message: string): RemoteError<'admin/error'> {
  return new RemoteError('admin/error', message, { reason })
}

const priceSchema = z.object({
  model: z.string().trim().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/),
  effectiveFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  inputPerMillion: z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/),
  cacheReadPerMillion: z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/),
  outputPerMillion: z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/),
  deepseekSchedule: z.object({
    validUntil: z.number().int().nonnegative().max(8_640_000_000_000_000),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const time = Date.parse(`${value}T00:00:00Z`)
      return Number.isFinite(time) && new Date(time).toISOString().startsWith(value)
    })).max(3660),
  }).strict().optional(),
}).strict()
const storedPriceSchema = priceSchema.extend({
  id: z.string().transform(value => value as AdminPriceId), createdAt: z.number().int().nonnegative(),
})
const APPLICATION_ID = 0x44534841
const SCHEMA_VERSION = 3

async function openDatabase(path: string): Promise<DatabaseSync> {
  if (path !== ':memory:') {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      const file = await open(path, 'wx', 0o600)
      await file.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    const app = db.prepare('PRAGMA application_id').get()?.application_id
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    const count = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.count
    if ((app !== 0 && app !== APPLICATION_ID) || (app === 0 && count !== 0)
      || (version !== 0 && version !== SCHEMA_VERSION)) {
      throw adminError('index-unavailable', 'The configured database is not a supported unified administration database; migrate split index and price files before opening them.')
    }
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON`)
    return db
  } catch (error) { db.close(); throw error }
}

/** One indexed source watermark used to skip unchanged journals. */
export interface IndexedSource { revision: string | null; cursor: number }
/** Private SQLite owner; callers serialize writes and close after indexing settles. */
export class AdminStorage {
  private constructor(readonly db: DatabaseSync) {}
  /**
   * Open the shared database without resetting prices or indexed records.
   * @param path - absolute administration database location, or `:memory:` for tests.
   * @returns an initialized owner of the database handle.
   */
  static async open(path: string): Promise<AdminStorage> {
    const db = await openDatabase(path)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, indexed_at INTEGER, identity TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, workspace TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, state TEXT NOT NULL, revision TEXT, cursor INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created,id);
        CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent);
        CREATE TABLE IF NOT EXISTS usage (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, time INTEGER NOT NULL, model TEXT, data TEXT NOT NULL, PRIMARY KEY(session_id,seq)) STRICT;
        CREATE INDEX IF NOT EXISTS usage_time ON usage(time,session_id,seq);
        CREATE INDEX IF NOT EXISTS usage_model ON usage(model,time);
        CREATE TABLE IF NOT EXISTS tools (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq)) STRICT;
        CREATE INDEX IF NOT EXISTS tools_time ON tools(time,session_id,seq);
        CREATE TABLE IF NOT EXISTS price_meta (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS prices (id TEXT PRIMARY KEY, model TEXT NOT NULL, effective INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(model,effective)) STRICT;
      `)
      db.prepare('INSERT OR IGNORE INTO meta VALUES(1,0,NULL,?)').run(randomUUID())
      db.prepare('INSERT OR IGNORE INTO price_meta VALUES(1,?)').run(randomUUID())
      return new AdminStorage(db)
    } catch (error) { db.close(); throw error }
  }
  /** Release the database after all service work has settled. */
  close(): void { this.db.close() }
  /** Read the combined data identity used by paginated queries.
   * @returns current index and pricing revision token.
   */
  snapshot(): AdminSnapshotId {
    const metadata = this.db.prepare('SELECT revision,identity FROM meta WHERE id=1').get()
    const priceIdentity = this.db.prepare('SELECT identity FROM price_meta WHERE id=1').get()?.identity
    const prices = this.db.prepare('SELECT count(*) AS count FROM prices').get()?.count
    return `${String(metadata?.identity)}:${String(metadata?.revision)}:${String(priceIdentity)}:${String(prices)}` as AdminSnapshotId
  }
  /** Read the latest completed reconciliation time.
   * @returns timestamp of the most recent published index pass.
   */
  indexedAt(): number | null {
    return this.db.prepare('SELECT indexed_at FROM meta WHERE id=1').get()?.indexed_at as number | null
  }
  /** Count the conversations currently available to queries.
   * @returns indexed session count.
   */
  count(): number { return this.db.prepare('SELECT count(*) AS count FROM sessions').get()?.count as number }
  /**
   * Read an existing source identity without decoding its facts.
   * @param id - logical Session identity.
   * @returns persisted revision and event cursor, if indexed.
   */
  source(id: string): IndexedSource | undefined {
    return this.db.prepare('SELECT revision,cursor FROM sessions WHERE id=?').get(id) as IndexedSource | undefined
  }
  /**
   * Replace one Session's derived rows atomically.
   * @param facts - validated projection state.
   * @param revision - durable source revision, absent for live sources.
   */
  put(facts: AdminFacts, revision: string | null): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,title=excluded.title,workspace=excluded.workspace,created=excluded.created,updated=excluded.updated,state=excluded.state,revision=excluded.revision,cursor=excluded.cursor,data=excluded.data')
        .run(facts.id, facts.parentId, facts.title, facts.workspace, facts.createdAt, facts.updatedAt,
          facts.state, revision, facts.throughSeq, JSON.stringify(facts))
      this.db.prepare('DELETE FROM usage WHERE session_id=?').run(facts.id)
      this.db.prepare('DELETE FROM tools WHERE session_id=?').run(facts.id)
      const usage = this.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?)')
      for (const fact of Object.values(facts.usage)) usage.run(facts.id, fact.seq, fact.time, fact.model, JSON.stringify(fact))
      const tools = this.db.prepare('INSERT INTO tools VALUES(?,?,?,?)')
      for (const fact of Object.values(facts.tools)) tools.run(facts.id, fact.seq, fact.time, JSON.stringify(fact))
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1; COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /**
   * Remove sessions absent from a complete successful corpus listing.
   * @param ids - current corpus identities.
   */
  removeAbsent(ids: ReadonlySet<string>): void {
    for (const row of this.db.prepare('SELECT id FROM sessions').all()) {
      if (typeof row.id === 'string' && !ids.has(row.id)) {
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id)
        this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1')
      }
    }
  }
  /**
   * Publish completion time without changing a stable read revision.
   * @param time - index-pass completion time.
   */
  complete(time: number): void { this.db.prepare('UPDATE meta SET indexed_at=? WHERE id=1').run(time) }
  /** Clear only disposable metadata; price versions remain intact. */
  clear(): void {
    this.db.exec('DELETE FROM sessions; UPDATE meta SET revision=revision+1,indexed_at=NULL WHERE id=1')
  }
  /**
   * Read facts for an indexed Session.
   * @param id - logical Session identity.
   * @returns validated metadata, or undefined.
   */
  session(id: string): AdminFacts | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id)
    return row === undefined ? undefined : adminFactsSchema.parse(JSON.parse(String(row.data)))
  }
  /**
   * Select bounded indexed records without opening source journals.
   * @param kind - indexed table.
   * @param filter - shared caller selection.
   * @param offset - number of matched rows to skip.
   * @param limit - maximum rows to return.
   * @param sort - chronological direction.
   * @returns JSON records and complete matching count.
   */
  select(kind: 'sessions' | 'usage' | 'tools', filter: AdminFilter, offset: number, limit: number, sort: 'newest' | 'oldest'): { rows: { sessionId: string; data: string }[]; total: number } {
    const row = kind === 'sessions' ? 's' : 'r'
    const clauses: string[] = []
    const args: SQLInputValue[] = []
    const time = kind === 'sessions' ? 's.created' : 'r.time'
    if (filter.from !== undefined) { clauses.push(`${time}>=?`); args.push(filter.from) }
    if (filter.to !== undefined) { clauses.push(`${time}<?`); args.push(filter.to) }
    if (filter.query !== undefined) {
      clauses.push("(s.title LIKE ? ESCAPE '\\' OR s.workspace LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')")
      const query = `%${filter.query.replace(/[\\%_]/g, match => `\\${match}`)}%`
      args.push(query, query, query)
    }
    if (filter.state !== undefined) { clauses.push('s.state=?'); args.push(filter.state) }
    if (filter.model !== undefined) {
      clauses.push(kind === 'usage' ? 'r.model=?' : 'EXISTS (SELECT 1 FROM usage u WHERE u.session_id=s.id AND u.model=?)')
      args.push(filter.model)
    }
    if (filter.sessionId !== undefined) {
      clauses.push(filter.descendants === true
        ? 's.id IN (WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT child.id FROM sessions child JOIN tree ON child.parent=tree.id) SELECT id FROM tree)'
        : 's.id=?')
      args.push(filter.sessionId)
    }
    const from = kind === 'sessions' ? 'sessions s' : `${kind} r JOIN sessions s ON s.id=r.session_id`
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const total = this.db.prepare(`SELECT count(*) AS count FROM ${from}${where}`).get(...args)?.count as number
    const direction = sort === 'newest' ? 'DESC' : 'ASC'
    const tie = kind === 'sessions' ? 's.id' : 'r.session_id,r.seq'
    const rows = this.db.prepare(`SELECT s.id AS sessionId,${row}.data AS data FROM ${from}${where} ORDER BY ${kind === 'sessions' ? 's.updated' : time} ${direction},${tie} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as { sessionId: string; data: string }[]
    return { rows, total }
  }
  /** Read all configured prices from their independent database.
   * @returns validated immutable versions ordered by activation time.
   */
  listPrices(): AdminPriceVersion[] {
    return this.db.prepare('SELECT data FROM prices ORDER BY effective DESC,id').all().map(row => storedPriceSchema.parse(JSON.parse(String(row.data))))
  }
  /**
   * Append a unique model/time version without rewriting another version.
   * @param input - administrator-entered decimal rates.
   * @param historical - explicit permission to backdate this version.
   * @returns the durably committed price version.
   */
  addPrice(input: AdminPriceInput, historical: boolean): AdminPriceVersion {
    const parsed = priceSchema.safeParse(input)
    if (!parsed.success) throw adminError('invalid-request', 'Supply a model, three nonnegative decimal prices, an ISO currency and an effective time.')
    if (parsed.data.deepseekSchedule !== undefined && parsed.data.deepseekSchedule.validUntil <= parsed.data.effectiveFrom) {
      throw adminError('invalid-request', 'The verified calendar must extend beyond the price effective time.')
    }
    const now = Date.now()
    if (!historical && parsed.data.effectiveFrom <= now) throw adminError('invalid-request', 'Use historical repricing to add a past effective date.')
    if (historical && parsed.data.effectiveFrom > now) throw adminError('invalid-request', 'Use add price for future effective dates.')
    if (this.db.prepare('SELECT id FROM prices WHERE model=? AND effective=?').get(parsed.data.model, parsed.data.effectiveFrom) !== undefined) {
      throw adminError('invalid-request', 'A price version already exists for this model and effective time.')
    }
    const version: AdminPriceVersion = { ...parsed.data, id: randomUUID() as AdminPriceId, createdAt: now }
    this.db.prepare('INSERT INTO prices VALUES(?,?,?,?)').run(version.id, version.model, version.effectiveFrom, JSON.stringify(version))
    return version
  }
}

function rate(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}
/**
 * Price one recorded attempt without substituting zero for unknown counters.
 * @param sessionId - owning Session.
 * @param fact - domain-projected call metadata.
 * @param prices - immutable versions, newest effective date first.
 * @returns usage plus estimated monetary amount and coverage.
 */
export function priceUsage(sessionId: ReturnType<typeof SessionId>, fact: UsageFact, prices: readonly AdminPriceVersion[]): AdminUsageRow {
  const base = { sessionId, seq: fact.seq, time: fact.time, kind: fact.kind, model: fact.model,
    inputTokens: fact.inputTokens, cacheReadTokens: fact.cacheReadTokens, outputTokens: fact.outputTokens,
    amount: null, currency: null, priceId: null }
  if ((fact.provider !== 'deepseek-official' && fact.provider !== 'deepseek-account') || fact.unsupported) return { ...base, coverage: 'unsupported' }
  if (fact.inputTokens === null || fact.cacheReadTokens === null || fact.outputTokens === null) return { ...base, coverage: 'missing-usage' }
  const price = prices.find(item => item.model === fact.model && item.effectiveFrom <= fact.time)
  if (price === undefined || (price.deepseekSchedule !== undefined && fact.time >= price.deepseekSchedule.validUntil)) {
    return { ...base, coverage: 'missing-price' }
  }
  const numerator = BigInt(fact.inputTokens) * rate(price.inputPerMillion)
    + BigInt(fact.cacheReadTokens) * rate(price.cacheReadPerMillion) + BigInt(fact.outputTokens) * rate(price.outputPerMillion)
  const amount = Number(numerator) / (isOffPeak(price, fact.time) ? 2_000_000_000_000 : 1_000_000_000_000)
  if (!Number.isFinite(amount)) throw adminError('index-unavailable', 'The recorded amount exceeds the supported numeric range.')
  return { ...base, coverage: 'priced', amount, currency: price.currency, priceId: price.id }
}

/** Official schedule: Beijing weekday 09:00–12:00 and 14:00–18:00, excluding holidays. */
function isOffPeak(price: AdminPriceVersion, time: number): boolean {
  if (price.deepseekSchedule === undefined) return false
  const beijing = new Date(time + 8 * 60 * 60 * 1000)
  const weekday = beijing.getUTCDay()
  const hour = beijing.getUTCHours()
  return weekday === 0 || weekday === 6 || price.deepseekSchedule.holidays.includes(beijing.toISOString().slice(0, 10))
    || !((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}
