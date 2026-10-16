import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'

type MigrationFile = { version: number; name: string; file: string }

const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/main/resources/db/migration',
)
const advisoryLock = 884_210_071

async function discoverMigrations(): Promise<MigrationFile[]> {
  const files = await readdir(migrationDirectory)
  return files
    .map((file) => {
      const match = /^V(\d+)__(.+)\.sql$/u.exec(file)
      return match?.[1] && match[2]
        ? { version: Number(match[1]), name: match[2].replaceAll('_', ' '), file }
        : null
    })
    .filter((migration): migration is MigrationFile => migration !== null)
    .sort((left, right) => left.version - right.version)
}

async function createMigrationTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS node_schema_history (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function baselineFromFlyway(client: PoolClient, migrations: MigrationFile[]) {
  const existing = await client.query<{ history: string | null }>(
    `SELECT to_regclass('public.flyway_schema_history')::text AS history`,
  )
  if (!existing.rows[0]?.history) return

  const result = await client.query<{ version: string }>(`
    SELECT version
    FROM flyway_schema_history
    WHERE success = TRUE AND version ~ '^[0-9]+$'
    ORDER BY version::integer DESC
    LIMIT 1
  `)
  const flywayVersion = Number(result.rows[0]?.version ?? 0)
  if (!flywayVersion) return

  for (const migration of migrations.filter(({ version }) => version <= flywayVersion)) {
    await client.query(
      'INSERT INTO node_schema_history (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
      [migration.version, `Flyway baseline: ${migration.name}`],
    )
  }
}

export async function migrateDatabase(pool: Pool) {
  const client = await pool.connect()
  let lockAcquired = false

  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLock])
    lockAcquired = true
    await createMigrationTable(client)
    const migrations = await discoverMigrations()
    await baselineFromFlyway(client, migrations)

    const applied = await client.query<{ version: number }>('SELECT version FROM node_schema_history')
    const appliedVersions = new Set(applied.rows.map(({ version }) => Number(version)))
    const newlyApplied: number[] = []

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue

      const sql = await readFile(path.join(migrationDirectory, migration.file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO node_schema_history (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
        await client.query('COMMIT')
        newlyApplied.push(migration.version)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }

    return {
      migrationsExecuted: newlyApplied.length,
      appliedVersions: migrations.map(({ version }) => version).filter((version) => appliedVersions.has(version) || newlyApplied.includes(version)),
    }
  } finally {
    if (lockAcquired) await client.query('SELECT pg_advisory_unlock($1)', [advisoryLock]).catch(() => undefined)
    client.release()
  }
}
