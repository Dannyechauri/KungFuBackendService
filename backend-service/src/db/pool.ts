import pg, { type Pool, type PoolClient, types } from 'pg'

import { createDatabaseUrl } from '../config.js'

const { Pool: PgPool } = pg

// Keep school-wall-clock times local and return the ISO separator expected by
// the existing browser client without applying the server's timezone.
types.setTypeParser(1114, (value) => value.replace(' ', 'T'))
types.setTypeParser(1082, (value) => value)

export function createPool(databaseUrl = createDatabaseUrl()): Pool {
  return new PgPool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 30_000,
    // The application stores and compares all wall-clock timestamps in the
    // school's local timezone (Europe/Madrid). Force every session to that
    // timezone so containers or cloud instances configured as UTC do not shift
    // hours silently.
    options: '-c timezone=Europe/Madrid',
  })
}

export async function inTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
