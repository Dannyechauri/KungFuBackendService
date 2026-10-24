import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

import { ApiError } from '../errors.js'
import { Roles, type AccountRole, type SessionUser } from '../domain/auth.js'

export const MIN_PASSWORD_LENGTH = 8

type AuthCandidate = {
  role: AccountRole
  user_id: number
  password_hash: string | null
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`)
  }
}

async function findCandidatesByEmail(pool: Pool, email: string, includeInactive = false): Promise<AuthCandidate[]> {
  const result = await pool.query<AuthCandidate>(`
    SELECT 'ADMIN'::text AS role, id_administrador AS user_id, password_hash
    FROM administradores
    WHERE LOWER(correo_electronico) = $1
    UNION ALL
    SELECT 'USER'::text AS role, id_alumno AS user_id, password_hash
    FROM alumnos
    WHERE LOWER(correo_electronico) = $1 AND ($2 OR activo IS NULL OR activo = TRUE)
  `, [email, includeInactive])
  return result.rows
}

/**
 * Construye el usuario de sesión a partir de la cuenta. Un alumno con
 * es_instructor y un registro de instructor activo obtiene el rol INSTRUCTOR.
 * Devuelve null si la cuenta ya no existe o el alumno está inactivo.
 */
export async function resolveSessionUser(pool: Pool, accountRole: AccountRole, accountId: number): Promise<SessionUser | null> {
  if (accountRole === Roles.ADMIN) {
    const result = await pool.query<{ display_name: string }>(
      `SELECT COALESCE(nombre, 'Administrador') AS display_name FROM administradores WHERE id_administrador = $1`,
      [accountId],
    )
    const admin = result.rows[0]
    if (!admin) return null
    return { authenticated: true, role: Roles.ADMIN, userId: accountId, displayName: admin.display_name, studentId: null, instructorId: null }
  }

  const result = await pool.query<{ display_name: string; id_instructor: string | null }>(`
    SELECT COALESCE(a.nombre, a.numero_matricula, 'Alumno') AS display_name,
           i.id_instructor::text AS id_instructor
    FROM alumnos a
    LEFT JOIN instructores i
      ON i.id_alumno = a.id_alumno AND a.es_instructor AND (i.activo IS NULL OR i.activo = TRUE)
    WHERE a.id_alumno = $1 AND (a.activo IS NULL OR a.activo = TRUE)
  `, [accountId])
  const student = result.rows[0]
  if (!student) return null
  const instructorId = student.id_instructor === null ? null : Number(student.id_instructor)
  return {
    authenticated: true,
    role: instructorId === null ? Roles.USER : Roles.INSTRUCTOR,
    userId: accountId,
    displayName: student.display_name,
    studentId: accountId,
    instructorId,
  }
}

export async function authenticate(pool: Pool, emailInput: unknown, passwordInput: unknown): Promise<{ accountRole: AccountRole; user: SessionUser }> {
  if (typeof emailInput !== 'string' || !emailInput.trim() || typeof passwordInput !== 'string' || !passwordInput) {
    throw new ApiError(400, 'Correo y contraseña son obligatorios.')
  }

  const email = emailInput.trim().toLowerCase()
  const candidates = await findCandidatesByEmail(pool, email)
  const matches: AuthCandidate[] = []

  for (const candidate of candidates) {
    if (!candidate.password_hash) continue
    if (await bcrypt.compare(passwordInput, candidate.password_hash)) {
      matches.push(candidate)
    }
  }

  if (matches.length === 0) {
    throw new ApiError(401, 'Credenciales inválidas')
  }

  if (matches.length > 1) {
    // Same credentials in more than one account table is a configuration error.
    // Refuse to authenticate to avoid role confusion.
    throw new ApiError(409, 'La cuenta tiene roles duplicados. Contacta con el equipo de desarrollo.')
  }

  const match = matches[0]!
  const user = await resolveSessionUser(pool, match.role, Number(match.user_id))
  if (!user) throw new ApiError(401, 'Credenciales inválidas')
  return { accountRole: match.role, user }
}

export async function isEmailAvailable(pool: Pool, email: string, exclude?: { table: string; id: number }): Promise<boolean> {
  const candidates = await findCandidatesByEmail(pool, email, true)
  const excludedRole = exclude?.table === 'administradores' ? Roles.ADMIN : exclude?.table === 'alumnos' ? Roles.USER : null
  return candidates.every((candidate) => excludedRole !== null && candidate.role === excludedRole && Number(candidate.user_id) === exclude!.id)
}

export function isBcryptHash(value: string) {
  return /^\$2[aby]\$\d{2}\$.{53}$/u.test(value)
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export async function hashPassword(value: unknown) {
  validatePassword(value)
  return bcrypt.hash(value.trim(), 10)
}
