import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import secureSession from '@fastify/secure-session'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'

import { hashSessionToken } from './auth/auth-service.js'
import { config, getSessionKey } from './config.js'
import { ApiError } from './errors.js'
import { migrateDatabase } from './db/migrate.js'
import { type SessionUser, type UserRole } from './domain/auth.js'
import { authRoutes } from './routes/auth.js'
import { databaseRoutes } from './routes/database.js'
import { calendarRoutes } from './routes/calendar.js'

type AppOptions = { pool: Pool; runMigrations?: boolean; logger?: boolean }

function trustProxySetting(): boolean | string | string[] {
  if (config.nodeEnv !== 'production') return true
  return config.trustedProxies ?? false
}

export async function createApp({ pool, runMigrations = config.nodeEnv !== 'production', logger = false }: AppOptions): Promise<FastifyInstance> {
  if (runMigrations) await migrateDatabase(pool)
  await pool.query('DELETE FROM api_sessions WHERE expires_at <= NOW()')

  const app = Fastify({
    logger,
    trustProxy: trustProxySetting(),
    bodyLimit: 1_048_576,
  })

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip ?? 'unknown',
  })

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(cookie)
  await app.register(secureSession, {
    key: getSessionKey(),
    cookieName: 'wushu_session',
    expiry: 12 * 60 * 60,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: 12 * 60 * 60,
    },
  })

  app.decorateRequest('currentUser', null)
  app.addHook('preHandler', async (request) => {
    const sessionId = request.session.get('sessionId')
    if (!sessionId) {
      request.currentUser = null
      return
    }

    const result = await pool.query<{
      role: UserRole
      user_id: string
      display_name: string
    }>(`
      SELECT role, user_id::text, display_name
      FROM api_sessions
      WHERE session_hash = $1 AND expires_at > NOW()
    `, [hashSessionToken(sessionId)])
    const session = result.rows[0]
    if (!session) {
      request.session.delete()
      request.currentUser = null
      return
    }
    request.currentUser = {
      authenticated: true,
      role: session.role,
      userId: Number(session.user_id),
      displayName: session.display_name,
    } satisfies SessionUser
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ message: error.message })
    }
    if ((error as { statusCode?: unknown }).statusCode === 429) {
      return reply.code(429).send({ message: 'Demasiados intentos. Espera antes de volver a probar.' })
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({ message: 'Los datos enviados no son válidos.' })
    }

    const pgCode = (error as { code?: string }).code
    if (pgCode === '23505') return reply.code(409).send({ message: 'Ya existe un registro con esos datos.' })
    if (pgCode === '23503' || pgCode === '23514' || pgCode === '22P02' || pgCode === '22007' || pgCode === '22001') {
      return reply.code(400).send({ message: 'Los datos enviados no son válidos.' })
    }

    request.log.error(error)
    return reply.code(500).send({ message: 'No se pudo completar la solicitud.' })
  })

  app.addHook('onClose', async () => pool.end())

  app.get('/api/database/health', async () => {
    const result = await pool.query<{ database_time: string }>('SELECT NOW()::text AS database_time')
    return {
      status: 'UP',
      databaseTime: result.rows[0]?.database_time ?? null,
      checkedAt: new Date().toISOString(),
    }
  })

  await app.register(authRoutes, { prefix: '/api/auth', pool })
  await app.register(databaseRoutes, { prefix: '/api/database', pool })
  await app.register(calendarRoutes, { prefix: '/api/calendar', pool })

  return app
}
