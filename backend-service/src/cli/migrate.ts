import { createPool } from '../db/pool.js'
import { migrateDatabase } from '../db/migrate.js'

const pool = createPool()
try {
  const result = await migrateDatabase(pool)
  console.log(`Migraciones ejecutadas: ${result.migrationsExecuted}. Versiones aplicadas: ${result.appliedVersions.join(', ') || 'ninguna nueva'}.`)
} finally {
  await pool.end()
}
