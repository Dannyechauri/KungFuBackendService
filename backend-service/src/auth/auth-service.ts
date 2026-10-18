import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

import { ApiError } from '../errors.js'
import type { SessionUser, UserRole } from '../domain/auth.js'

const MIN_PASSWORD_LENGTH = 12

type AuthCandidate = {
  role: UserRole
  user_id: number
  display_name: string
  password_hash: string | null
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`)
  }
}

async function findCandidatesByEmail(pool: Pool, email: string): Promise<AuthCandidate[]> {
  const result = await pool.query<AuthCandidate>(`
    SELECT 'ADMIN'::text AS role, id_administrador AS user_id,
           COALESCE(nombre, 'Administrador') AS display_name, password_hash
    FROM administradores
    WHERE LOWER(correo_electronico) = $1
    UNION ALL
    SELECT 'INSTRUCTOR'::text AS role, id_instructor AS user_id,
           COALESCE(nombre, 'Instructor') AS display_name, password_hash
    FROM instructores
    WHERE LOWER(correo_electronico) = $1 AND (activo IS NULL OR activo = TRUE)
    UNION ALL
    SELECT 'USER'::text AS role, id_alumno AS user_id,
           COALESCE(nombre, numero_matricula, 'Alumno') AS display_name, password_hash
    FROM alumnos
    WHERE LOWER(correo_electronico) = $1 AND (activo IS NULL OR activo = TRUE)
  `, [email])
  return result.rows
}

export async function authenticate(pool: Pool, emailInput: unknown, passwordInput: unknown): Promise<SessionUser> {
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
    // Same credentials in more than one role table is a configuration error.
    // Refuse to authenticate to avoid role confusion.
    throw new ApiError(409, 'La cuenta tiene roles duplicados. Contacta con el equipo de desarrollo.')
  }

  const user = matches[0]!
  return {
    authenticated: true,
    role: user.role,
    userId: Number(user.user_id),
    displayName: user.display_name,
  }
}

export async function isEmailAvailable(pool: Pool, email: string, exclude?: { table: string; id: number }): Promise<boolean> {
  const candidates = await findCandidatesByEmail(pool, email)
  if (!exclude) return candidates.length === 0

  const identityColumn =
    exclude.table === 'administradores' ? 'id_administrador'
      : exclude.table === 'instructores' ? 'id_instructor'
        : exclude.table === 'alumnos' ? 'id_alumno'
          : null
  if (!identityColumn) return candidates.length === 0

  return candidates.every((candidate) => Number(candidate.user_id) !== exclude.id)
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
