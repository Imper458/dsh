/** Offline migration from split administration databases to one verified SQLite file. */
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AdminStorage } from '../packages/session-query/admin/src/storage.ts'
import { toolSchema, usageSchema } from '../packages/session-query/admin/src/facts.ts'

const INDEX_TABLES = ['meta', 'sessions', 'usage', 'tools'] as const
const PRICE_TABLES = ['price_meta', 'prices'] as const

/** Open and identify an old database without changing its schema or records. */
function openSource(path: string, application: number, tables: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, application, `Unexpected database: ${path}`)
    assert.ok(version === 1 || version === 2, `Unsupported split administration schema: ${path}`)
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    assert.deepEqual(names, [...tables].sort(), `Unexpected tables: ${path}`)
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok', `Damaged database: ${path}`)
    return db
  } catch (error) { db.close(); throw error }
}

/** Copy known tables and compare every stored value before publishing the destination. */
function copyTables(source: DatabaseSync, destination: DatabaseSync, tables: readonly string[]): void {
  for (const table of tables) {
    const columns = destination.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
    destination.exec(`DELETE FROM ${table}`)
    const insert = destination.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    for (const row of source.prepare(`SELECT * FROM ${table}`).iterate()) {
      insert.run(...columns.map((column) => {
        const value = row[column]
        if (value === undefined) throw new Error(`Missing source column: ${table}.${column}`)
        return value
      }))
    }
    const query = `SELECT * FROM ${table} ORDER BY ${columns.join(',')}`
    assert.deepEqual(destination.prepare(query).all(), source.prepare(query).all(), `Migration verification failed: ${table}`)
  }
}

/**
 * Copy split schema 1/2 databases into a schema 3 file without overwriting any path.
 * Stop the owning Harness process first; both sources remain untouched as backups.
 * The destination is published only after row, JSON and integrity checks succeed.
 * @param indexPath - existing split metadata database.
 * @param pricePath - existing split price database.
 * @param outputPath - new unified database path; an existing file is rejected.
 */
export async function migrateAdminDatabase(indexPath: string, pricePath: string, outputPath: string): Promise<void> {
  const index = openSource(indexPath, 0x44534841, INDEX_TABLES)
  try {
    const prices = openSource(pricePath, 0x44534850, PRICE_TABLES)
    try {
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
      const temporary = await mkdtemp(join(dirname(outputPath), '.admin-migration-'))
      try {
        const stagedPath = join(temporary, 'admin.sqlite')
        const storage = await AdminStorage.open(stagedPath)
        try {
          storage.db.exec('BEGIN IMMEDIATE')
          try {
            copyTables(index, storage.db, INDEX_TABLES)
            copyTables(prices, storage.db, PRICE_TABLES)
            for (const row of storage.db.prepare('SELECT id FROM sessions').all()) storage.session(SessionId(String(row.id)))
            for (const row of storage.db.prepare('SELECT data FROM usage').all()) usageSchema.parse(JSON.parse(String(row.data)))
            for (const row of storage.db.prepare('SELECT data FROM tools').all()) toolSchema.parse(JSON.parse(String(row.data)))
            storage.listPrices()
            assert.deepEqual(storage.db.prepare('PRAGMA foreign_key_check').all(), [])
            assert.equal(storage.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
            storage.db.exec('COMMIT')
          } catch (error) { storage.db.exec('ROLLBACK'); throw error }
          storage.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE')
        } finally { storage.close() }
        await link(stagedPath, outputPath)
      } finally { await rm(temporary, { recursive: true, force: true }) }
    } finally { prices.close() }
  } finally { index.close() }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    index: { type: 'string' }, prices: { type: 'string' }, output: { type: 'string' },
  } })
  if (!values.index || !values.prices || !values.output) {
    throw new Error('Usage: pnpm exec tsx scripts/migrate-admin-database.ts --index <old-index> --prices <old-prices> --output <new-database> (stop Harness first)')
  }
  await migrateAdminDatabase(resolve(values.index), resolve(values.prices), resolve(values.output))
  console.log(`Administration database migrated and verified: ${resolve(values.output)}`)
}
