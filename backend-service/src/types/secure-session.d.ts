import type { SessionUser } from '../domain/auth.js'

declare module '@fastify/secure-session' {
  interface SessionData {
    sessionId: string
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: SessionUser | null
  }
}
