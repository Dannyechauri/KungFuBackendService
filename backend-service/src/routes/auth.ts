import type { FastifyPluginAsync } from 'fastify'

import { authenticate, hashSessionToken, newSessionToken } from '../auth/auth-service.js'
import { requireUser } from '../domain/auth.js'

type AuthRoutesOptions = { pool: import('pg').Pool }

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { pool }) => {

  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    '/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          hook: 'preValidation',
          keyGenerator: (request) => {
            const body = request.body as { email?: unknown } | undefined
            const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '<missing-email>'
            return `${request.ip}:${email}`
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(pool, request.body?.email, request.body?.password)
      const sessionId = newSessionToken()
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000)
      await pool.query(`
        INSERT INTO api_sessions (session_hash, role, user_id, display_name, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [hashSessionToken(sessionId), user.role, user.userId, user.displayName, expiresAt])
      request.session.set('sessionId', sessionId)
      return reply.send(user)
    },
  )

  app.get('/me', async (request) => {
    const user = requireUser(request)
    return user
  })

  app.delete('/logout', async (request, reply) => {
    const sessionId = request.session.get('sessionId')
    if (sessionId) {
      await pool.query('DELETE FROM api_sessions WHERE session_hash = $1', [hashSessionToken(sessionId)])
    }
    request.session.delete()
    return reply.send({ authenticated: false })
  })
}
