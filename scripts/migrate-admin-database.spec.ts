/** Split-database migration preserves records and never publishes partial or overwritten data. */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AdminStorage, priceUsage } from '../packages/session-query/admin/src/storage.ts'
import { migrateAdminDatabase } from './migrate-admin-database.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(version = 2): Promise<{ root: string; index: string; prices: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admin-migration-'))
  roots.push(root)
  const paths = { root, index: join(root, 'index.sqlite'), prices: join(root, 'prices.sqlite'), output: join(root, 'admin.sqlite') }
  const usage = { seq: 2, time: 100, kind: 'conversation', provider: 'deepseek-official', model: 'deepseek-flash',
    inputTokens: 100, cacheReadTokens: 50, outputTokens: 20, unsupported: false }
  const tool = { seq: 3, time: 100, name: 'read', nested: false, resultSeq: 4, durationMs: 10, status: 'success' }
  const facts = { id: 's1', parentId: null, createdAt: 1, updatedAt: 110, title: '中文会话', workspace: '/work',
    inherited: 0, throughSeq: 5, state: 'completed', route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    pendingAttempt: null, usage: { '2': usage }, tools: { 'call-1': tool }, compactions: {} }
  const index = new DatabaseSync(paths.index)
  try {
    index.exec(`PRAGMA application_id=0x44534841; PRAGMA user_version=${version};
      CREATE TABLE meta (id INTEGER PRIMARY KEY, revision INTEGER, indexed_at INTEGER, identity TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, parent TEXT, title TEXT, workspace TEXT, created INTEGER, updated INTEGER, state TEXT, revision TEXT, cursor INTEGER, data TEXT);
      CREATE TABLE usage (session_id TEXT, seq INTEGER, time INTEGER, model TEXT, data TEXT, PRIMARY KEY(session_id,seq));
      CREATE TABLE tools (session_id TEXT, seq INTEGER, time INTEGER, data TEXT, PRIMARY KEY(session_id,seq));
      INSERT INTO meta VALUES (1,7,120,'index-identity');`)
    index.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)').run('s1', null, facts.title, '/work', 1, 110, 'completed', 'source-1', 5, JSON.stringify(facts))
    index.prepare('INSERT INTO usage VALUES(?,?,?,?,?)').run('s1', 2, 100, 'deepseek-flash', JSON.stringify(usage))
    index.prepare('INSERT INTO tools VALUES(?,?,?,?)').run('s1', 3, 100, JSON.stringify(tool))
  } finally { index.close() }
  const prices = new DatabaseSync(paths.prices)
  try {
    prices.exec(`PRAGMA application_id=0x44534850; PRAGMA user_version=${version};
      CREATE TABLE price_meta (id INTEGER PRIMARY KEY, identity TEXT);
      CREATE TABLE prices (id TEXT PRIMARY KEY, model TEXT, effective INTEGER, data TEXT, UNIQUE(model,effective));
      INSERT INTO price_meta VALUES(1,'price-identity');`)
    prices.prepare('INSERT INTO prices VALUES(?,?,?,?)').run('price-1', 'deepseek-flash', 0, JSON.stringify({
      id: 'price-1', model: 'deepseek-flash', effectiveFrom: 0, createdAt: 1, currency: 'CNY',
      inputPerMillion: '2', cacheReadPerMillion: '0.04', outputPerMillion: '8',
    }))
  } finally { prices.close() }
  return paths
}

it.each([1, 2])('migrates split schema %s and keeps prices after clearing, rebuilding and reopening the same database', async (version) => {
  const paths = await fixture(version)
  const sources = await Promise.all([readFile(paths.index), readFile(paths.prices)])
  await migrateAdminDatabase(paths.index, paths.prices, paths.output)
  expect(await Promise.all([readFile(paths.index), readFile(paths.prices)])).toEqual(sources)
  const storage = await AdminStorage.open(paths.output)
  try {
    expect(storage.snapshot()).toBe('index-identity:7:price-identity:1')
    expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
    expect(storage.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n).toBe(6)
    const facts = storage.session(SessionId('s1'))!
    const prices = storage.listPrices()
    const before = priceUsage(facts.id, facts.usage['2']!, prices)
    expect(before).toMatchObject({ amount: 0.000362, coverage: 'priced', priceId: 'price-1' })
    storage.clear()
    expect(storage.count()).toBe(0)
    expect(storage.select('usage', {}, 0, 50, 'newest').total).toBe(0)
    expect(storage.select('tools', {}, 0, 50, 'newest').total).toBe(0)
    expect(storage.listPrices()).toEqual(prices)
    storage.put(facts, 'source-1')
    expect(priceUsage(facts.id, storage.session(facts.id)!.usage['2']!, storage.listPrices())).toEqual(before)
  } finally { storage.close() }
  const reopened = await AdminStorage.open(paths.output)
  try {
    expect(reopened.listPrices()[0]?.id).toBe('price-1')
    expect(reopened.count()).toBe(1)
    expect(reopened.select('tools', {}, 0, 50, 'newest').total).toBe(1)
  } finally { reopened.close() }
  expect((await readdir(paths.root)).some(name => name.startsWith('.admin-migration-'))).toBe(false)
})

it('refuses existing destinations, including a source path, without changing their contents', async () => {
  const paths = await fixture()
  await migrateAdminDatabase(paths.index, paths.prices, paths.output)
  const output = await readFile(paths.output)
  await expect(migrateAdminDatabase(paths.index, paths.prices, paths.output)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(paths.output)).toEqual(output)
  const source = await readFile(paths.index)
  await expect(migrateAdminDatabase(paths.index, paths.prices, paths.index)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(paths.index)).toEqual(source)
})

it('refuses split files as runtime databases without mutating them', async () => {
  const paths = await fixture()
  const source = await readFile(paths.index)
  await expect(AdminStorage.open(paths.index)).rejects.toThrow('migrate split')
  expect(await readFile(paths.index)).toEqual(source)
  await expect(AdminStorage.open(paths.prices)).rejects.toThrow('migrate split')
})

it('leaves no destination after missing, wrong or invalid source data', async () => {
  const paths = await fixture()
  await expect(migrateAdminDatabase(paths.index, join(paths.root, 'missing.sqlite'), paths.output)).rejects.toThrow()
  await expect(migrateAdminDatabase(paths.prices, paths.index, paths.output)).rejects.toThrow('Unexpected database')
  const prices = new DatabaseSync(paths.prices)
  try { prices.exec("UPDATE prices SET data='{}'") } finally { prices.close() }
  await expect(migrateAdminDatabase(paths.index, paths.prices, paths.output)).rejects.toThrow()
  expect(await readdir(paths.root)).toEqual(expect.arrayContaining(['index.sqlite', 'prices.sqlite']))
  expect((await readdir(paths.root)).filter(name => name === 'admin.sqlite' || name.startsWith('.admin-migration-'))).toEqual([])
})
