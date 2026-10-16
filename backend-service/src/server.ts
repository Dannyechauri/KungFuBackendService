import { createApp } from './app.js'
import { config } from './config.js'
import { createPool } from './db/pool.js'

const pool = createPool()
const app = await createApp({ pool, logger: true })
let closing = false

async function shutdown() {
  if (closing) return
  closing = true
  await app.close()
}

process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`Backend disponible en http://${config.host}:${config.port}`)
} catch (error) {
  app.log.error(error)
  await app.close()
  process.exitCode = 1
}
