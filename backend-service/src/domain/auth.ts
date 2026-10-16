import type { FastifyRequest } from 'fastify'

import { ApiError } from '../errors.js'

export const Roles = {
  ADMIN: 'ADMIN',
  INSTRUCTOR: 'INSTRUCTOR',
  USER: 'USER',
} as const

export type UserRole = (typeof Roles)[keyof typeof Roles]

export type SessionUser = {
  authenticated: true
  role: UserRole
  userId: number
  displayName: string
}

export function currentUser(request: FastifyRequest): SessionUser | null {
  return request.currentUser ?? null
}

export function requireUser(request: FastifyRequest): SessionUser {
  const user = currentUser(request)
  if (!user) throw new ApiError(401, 'Inicie sesión para continuar')
  return user
}

export function requireRole(request: FastifyRequest, roles: readonly UserRole[]): SessionUser {
  const user = requireUser(request)
  if (!roles.includes(user.role)) throw new ApiError(403, 'No tiene permisos para realizar esta operación')
  return user
}

export function mayManageSchedule(role: UserRole) {
  return role === Roles.ADMIN || role === Roles.INSTRUCTOR
}
