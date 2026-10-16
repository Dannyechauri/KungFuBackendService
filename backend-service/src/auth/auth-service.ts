import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

import { ApiError } from '../errors.js'
import type { SessionUser, UserRole } from '../domain/auth.js'

type AuthCandidate = {
  role: UserRole
  user_id: number
  display_name: string
  password_hash: string | null
}

export async function authenticate(pool: Pool, emailInput: unknown, passwordInput: unknown): Promise<SessionUser> {
  if (typeof emailInput !== 'string' || !emailInput.trim() || typeof passwordInput !== 'string' || !passwordInput) {
    throw new ApiError(400, 'Correo y contraseña son obligatorios.')
  }

  const email = emailInput.trim().toLowerCase()
  const results = await pool.query<AuthCandidate>(`
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

  for (const candidate of results.rows) {
    if (!candidate.password_hash) continue
    if (await bcrypt.compare(passwordInput, candidate.password_hash)) {
      return {
        authenticated: true,
        role: candidate.role,
        userId: Number(candidate.user_id),
        displayName: candidate.display_name,
      }
    }
  }

  throw new ApiError(401, 'Credenciales inválidas')
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
  if (typeof value !== 'string' || value.trim().length <= 6) {
    throw new ApiError(400, 'La contraseña debe tener más de 6 caracteres.')
  }
  return bcrypt.hash(value.trim(), 10)
}
