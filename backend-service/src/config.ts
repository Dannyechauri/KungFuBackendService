import { randomBytes } from 'node:crypto'
import os from 'node:os'

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : fallback
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT debe ser un puerto entero entre 1 y 65535.')
  }
  return parsed
}

function parseOrigins(value: string | undefined) {
  const origins = value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return origins?.length
    ? origins
    : ['http://127.0.0.1:8000', 'http://localhost:8000']
}

function parseTrustedProxies(value: string | undefined): string[] | undefined {
  const proxies = value
    ?.split(',')
    .map((proxy) => proxy.trim())
    .filter(Boolean)
  return proxies?.length ? proxies : undefined
}

export const config = {
  host: process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  port: positiveInteger(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.DB_HOST ?? '127.0.0.1',
  databasePort: positiveInteger(process.env.DB_PORT, 5432),
  databaseName: process.env.DB_NAME ?? 'kungfu_school',
  databaseUser: process.env.DB_USER ?? (process.platform === 'win32' ? 'postgres' : os.userInfo().username),
  databasePassword: process.env.DB_PASSWORD,
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  secureCookies: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  sessionKeyHex: process.env.SESSION_KEY,
  trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXIES),
}

export function createDatabaseUrl() {
  if (config.databaseUrl) return config.databaseUrl

  const user = encodeURIComponent(config.databaseUser)
  const password = config.databasePassword
    ? `:${encodeURIComponent(config.databasePassword)}`
    : ''
  return `postgresql://${user}${password}@${config.databaseHost}:${config.databasePort}/${encodeURIComponent(config.databaseName)}`
}

export function getSessionKey() {
  if (config.sessionKeyHex) {
    const key = Buffer.from(config.sessionKeyHex, 'hex')
    if (key.byteLength !== 32) throw new Error('SESSION_KEY debe ser una clave hexadecimal de 32 bytes.')
    return key
  }

  if (config.nodeEnv === 'production') {
    throw new Error('SESSION_KEY es obligatorio en producción. Genera una clave aleatoria de 32 bytes y guárdala como secreto.')
  }

  return randomBytes(32)
}
