import type { Pool, PoolClient } from 'pg'

import { inTransaction } from '../db/pool.js'
import { ApiError } from '../errors.js'
import { scheduleLock } from './calendar-service.js'

export type EventInviteRole = 'ALUMNO' | 'INSTRUCTOR'
export type InvitationResponse = 'ACEPTADA' | 'RECHAZADA'

type LockedEvent = {
  id_curso_agendado: number
  limite_participantes: number | null
  futuro: boolean
}

async function lockEvent(client: PoolClient, eventId: number) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
  const result = await client.query<LockedEvent>(`
    SELECT id_curso_agendado, limite_participantes,
           fecha_hora > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid') AS futuro
    FROM cursos_agendados
    WHERE id_curso_agendado = $1 AND activo = TRUE
  `, [eventId])
  const event = result.rows[0]
  if (!event) throw new ApiError(404, 'No se encontró una actividad activa.')
  if (!event.futuro) throw new ApiError(409, 'La actividad ya ha empezado; no se pueden cambiar invitaciones.')
  return event
}

async function updatePublicationState(client: PoolClient, eventId: number) {
  await client.query(`
    UPDATE cursos_agendados ca
    SET estado_instructor = CASE
      WHEN EXISTS (
        SELECT 1 FROM participaciones_evento pe
        WHERE pe.id_curso_agendado = ca.id_curso_agendado AND pe.rol = 'INSTRUCTOR'
      ) OR EXISTS (
        SELECT 1 FROM invitaciones_evento ie
        WHERE ie.id_curso_agendado = ca.id_curso_agendado
          AND ie.rol = 'INSTRUCTOR' AND ie.estado = 'ACEPTADA'
      ) THEN 'ACEPTADO'
      WHEN EXISTS (
        SELECT 1 FROM invitaciones_evento ie
        WHERE ie.id_curso_agendado = ca.id_curso_agendado
          AND ie.rol = 'INSTRUCTOR' AND ie.estado = 'PENDIENTE'
      ) THEN 'PENDIENTE'
      ELSE 'RECHAZADO'
    END
    WHERE ca.id_curso_agendado = $1
  `, [eventId])
}

export async function countPendingInvitations(pool: Pool, studentId: number) {
  const result = await pool.query<{ count: number }>(`
    SELECT count(*)::int AS count
    FROM invitaciones_evento
    JOIN cursos_agendados ca ON ca.id_curso_agendado = invitaciones_evento.id_curso_agendado
    WHERE invitaciones_evento.id_alumno = $1 AND invitaciones_evento.estado = 'PENDIENTE'
      AND ca.activo = TRUE
      AND ca.fecha_hora > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
  `, [studentId])
  return Number(result.rows[0]?.count ?? 0)
}

export async function listPendingInvitations(pool: Pool, studentId: number) {
  const result = await pool.query(`
    SELECT ie.id_invitacion, ie.id_curso_agendado, ie.rol, ie.es_titular,
           ie.invitado_por_rol,
           COALESCE(admin.nombre, autor.nombre) AS invitado_por_nombre,
           c.nombre AS curso_nombre, c.tema AS curso_tema, ca.descripcion,
           to_char(ca.fecha_hora, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora,
           to_char(ca.fecha_hora_fin, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora_fin,
           i.nombre AS instructor_nombre, s.nombre AS sala_nombre
    FROM invitaciones_evento ie
    JOIN cursos_agendados ca ON ca.id_curso_agendado = ie.id_curso_agendado
    JOIN cursos c ON c.id_curso = ca.id_curso
    JOIN instructores i ON i.id_instructor = ca.id_instructor
    LEFT JOIN salas s ON s.id_sala = ca.id_sala
    LEFT JOIN administradores admin ON ie.invitado_por_rol = 'ADMIN' AND admin.id_administrador = ie.invitado_por_id
    LEFT JOIN alumnos autor ON ie.invitado_por_rol = 'INSTRUCTOR' AND autor.id_alumno = ie.invitado_por_id
    WHERE ie.id_alumno = $1 AND ie.estado = 'PENDIENTE'
      AND ca.activo = TRUE AND ca.fecha_hora > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
    ORDER BY ca.fecha_hora, ie.id_invitacion
  `, [studentId])
  return result.rows
}

export async function listEventInvitations(pool: Pool, eventId: number) {
  const result = await pool.query(`
    SELECT ie.id_invitacion, ie.id_alumno, a.nombre, ie.rol, ie.estado, ie.es_titular,
           ie.invitado_por_rol, ie.invitado_por_id, ie.fecha_invitacion, ie.fecha_respuesta
    FROM invitaciones_evento ie
    JOIN alumnos a ON a.id_alumno = ie.id_alumno
    WHERE ie.id_curso_agendado = $1 AND ie.estado <> 'RETIRADA'
    ORDER BY ie.es_titular DESC, ie.rol DESC, a.nombre, ie.id_alumno
  `, [eventId])
  return result.rows
}

export async function inviteToEvent(
  pool: Pool,
  eventId: number,
  targetStudentId: number,
  role: EventInviteRole,
  inviter: { role: 'ADMIN' | 'INSTRUCTOR'; userId: number },
) {
  return inTransaction(pool, async (client) => {
    await lockEvent(client, eventId)
    const target = await client.query<{ activo: boolean; es_instructor: boolean }>(
      'SELECT activo, es_instructor FROM alumnos WHERE id_alumno = $1',
      [targetStudentId],
    )
    if (!target.rows[0]?.activo) throw new ApiError(404, 'No se encontró un alumno activo con ese identificador.')
    if (role === 'INSTRUCTOR') {
      const instructor = await client.query(`
        SELECT 1 FROM instructores
        WHERE id_alumno = $1 AND (activo IS NULL OR activo = TRUE)
      `, [targetStudentId])
      if (!target.rows[0].es_instructor || !instructor.rows[0]) {
        throw new ApiError(400, 'Solo se puede invitar como instructor a una cuenta de instructor activa.')
      }
    }
    const existingParticipation = await client.query(
      'SELECT 1 FROM participaciones_evento WHERE id_curso_agendado = $1 AND id_alumno = $2',
      [eventId, targetStudentId],
    )
    if (existingParticipation.rows[0]) throw new ApiError(409, 'Esta persona ya participa en la actividad.')

    const inserted = await client.query(`
      INSERT INTO invitaciones_evento
        (id_curso_agendado, id_alumno, rol, invitado_por_rol, invitado_por_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id_curso_agendado, id_alumno)
      DO UPDATE SET rol = EXCLUDED.rol, estado = 'PENDIENTE',
                    invitado_por_rol = EXCLUDED.invitado_por_rol,
                    invitado_por_id = EXCLUDED.invitado_por_id,
                    fecha_invitacion = CURRENT_TIMESTAMP, fecha_respuesta = NULL, es_titular = FALSE
      WHERE invitaciones_evento.estado IN ('RECHAZADA', 'RETIRADA')
      RETURNING id_invitacion
    `, [eventId, targetStudentId, role, inviter.role, inviter.userId])
    if (!inserted.rows[0]) throw new ApiError(409, 'Ya existe una invitación activa para esta persona.')
    return { id_invitacion: inserted.rows[0].id_invitacion }
  })
}

export async function respondToEventInvitation(
  pool: Pool,
  invitationId: number,
  studentId: number,
  response: InvitationResponse,
) {
  return inTransaction(pool, async (client) => {
    const initialInvitation = await client.query<{ id_curso_agendado: number }>(`
      SELECT id_curso_agendado FROM invitaciones_evento
      WHERE id_invitacion = $1 AND id_alumno = $2 AND estado = 'PENDIENTE'
    `, [invitationId, studentId])
    const eventId = initialInvitation.rows[0]?.id_curso_agendado
    if (!eventId) throw new ApiError(404, 'No hay una invitación pendiente con ese identificador.')
    const event = await lockEvent(client, Number(eventId))
    const invitationResult = await client.query<{ rol: EventInviteRole }>(`
      SELECT rol FROM invitaciones_evento
      WHERE id_invitacion = $1 AND id_alumno = $2 AND id_curso_agendado = $3 AND estado = 'PENDIENTE'
      FOR UPDATE
    `, [invitationId, studentId, event.id_curso_agendado])
    const invitation = invitationResult.rows[0]
    if (!invitation) throw new ApiError(404, 'No hay una invitación pendiente con ese identificador.')

    if (response === 'ACEPTADA') {
      const student = await client.query<{ activo: boolean; es_instructor: boolean }>(
        'SELECT activo, es_instructor FROM alumnos WHERE id_alumno = $1',
        [studentId],
      )
      if (!student.rows[0]?.activo) throw new ApiError(403, 'Tu ficha de alumno no está activa.')
      if (invitation.rol === 'INSTRUCTOR' && !student.rows[0].es_instructor) {
        throw new ApiError(403, 'Esta invitación requiere una cuenta de instructor activa.')
      }
      if (invitation.rol === 'INSTRUCTOR') {
        const instructor = await client.query(`
          SELECT 1 FROM instructores
          WHERE id_alumno = $1 AND (activo IS NULL OR activo = TRUE)
        `, [studentId])
        if (!instructor.rows[0]) throw new ApiError(403, 'Esta invitación requiere una cuenta de instructor activa.')
      }
      if (invitation.rol === 'ALUMNO' && event.limite_participantes !== null) {
        const seats = await client.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM participaciones_evento
          WHERE id_curso_agendado = $1 AND rol = 'ALUMNO' AND id_alumno <> $2
        `, [event.id_curso_agendado, studentId])
        if (Number(seats.rows[0]?.count ?? 0) >= Number(event.limite_participantes)) {
          throw new ApiError(409, 'No quedan plazas de alumno en esta actividad.')
        }
      }
      await client.query(`
        INSERT INTO participaciones_evento (id_curso_agendado, id_alumno, rol)
        VALUES ($1, $2, $3)
        ON CONFLICT (id_curso_agendado, id_alumno) DO UPDATE SET rol = EXCLUDED.rol
      `, [event.id_curso_agendado, studentId, invitation.rol])
    }

    await client.query(`
      UPDATE invitaciones_evento
      SET estado = $2, fecha_respuesta = CURRENT_TIMESTAMP
      WHERE id_invitacion = $1
    `, [invitationId, response])
    await updatePublicationState(client, Number(event.id_curso_agendado))
    return { id_invitacion: invitationId, estado: response }
  })
}