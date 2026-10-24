import type { FastifyRequest } from 'fastify'

import { ApiError } from '../errors.js'

export const Roles = {
  ADMIN: 'ADMIN',
  INSTRUCTOR: 'INSTRUCTOR',
  USER: 'USER',
} as const

export type UserRole = (typeof Roles)[keyof typeof Roles]

/** Solo administradores y alumnos tienen cuenta; INSTRUCTOR es un rol derivado del alumno. */
export type AccountRole = typeof Roles.ADMIN | typeof Roles.USER

export type SessionUser = {
  authenticated: true
  role: UserRole
  /** id_administrador para ADMIN, id_alumno para alumnos e instructores. */
  userId: number
  displayName: string
  studentId: number | null
  instructorId: number | null
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

/** Altas y cambios del catálogo (cursos, salas, alumnos, grados, formas…). */
export function mayManageSchoolData(role: UserRole) {
  return role === Roles.ADMIN
}
