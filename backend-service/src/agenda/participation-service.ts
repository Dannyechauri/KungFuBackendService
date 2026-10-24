import type { Pool, PoolClient } from 'pg'

import { inTransaction } from '../db/pool.js'
import { ApiError } from '../errors.js'
import { scheduleLock } from './calendar-service.js'

export type ParticipationRole = 'ALUMNO' | 'INSTRUCTOR'
export type ParticipationScope = 'occurrence' | 'series'

export type Participant = {
  studentId: number | null
  instructorId: number | null
}

type EventRow = {
  id_curso_agendado: number
  fecha_hora: string
  id_horario_recurrente: number | null
  fecha_recurrencia: string | null
  limite_participantes: number | null
  futuro: boolean
}

async function lockedFutureEvent(client: PoolClient, eventId: number) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
  const result = await client.query<EventRow>(`
    SELECT id_curso_agendado, fecha_hora::text, id_horario_recurrente, fecha_recurrencia::text,
           limite_participantes,
           fecha_hora > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid') AS futuro
    FROM cursos_agendados
    WHERE id_curso_agendado = $1 AND activo = TRUE
  `, [eventId])
  const event = result.rows[0]
  if (!event) throw new ApiError(404, 'No se encontró una actividad activa con ese identificador.')
  if (!event.futuro) throw new ApiError(409, 'La actividad ya ha empezado; no se puede cambiar la participación.')
  return event
}

function requireStudent(participant: Participant) {
  if (!participant.studentId) throw new ApiError(403, 'Solo los alumnos e instructores pueden apuntarse a las actividades.')
  return participant.studentId
}

async function hasSeat(client: PoolClient, eventId: number, studentId: number, limit: number | null) {
  if (limit === null) return true
  const result = await client.query<{ alumnos: number }>(`
    SELECT count(*)::int AS alumnos FROM participaciones_evento
    WHERE id_curso_agendado = $1 AND rol = 'ALUMNO' AND id_alumno <> $2
  `, [eventId, studentId])
  return Number(result.rows[0]?.alumnos ?? 0) < Number(limit)
}

async function upsertParticipation(client: PoolClient, eventId: number, studentId: number, role: ParticipationRole) {
  await client.query(`
    INSERT INTO participaciones_evento (id_curso_agendado, id_alumno, rol)
    VALUES ($1, $2, $3)
    ON CONFLICT (id_curso_agendado, id_alumno) DO UPDATE SET rol = EXCLUDED.rol
  `, [eventId, studentId, role])
}

export async function joinEvent(
  pool: Pool,
  participant: Participant,
  eventId: number,
  scope: ParticipationScope,
  role: ParticipationRole,
) {
  const studentId = requireStudent(participant)
  return inTransaction(pool, async (client) => {
    const event = await lockedFutureEvent(client, eventId)
    const student = await client.query<{ activo: boolean; es_instructor: boolean }>(
      'SELECT activo, es_instructor FROM alumnos WHERE id_alumno = $1',
      [studentId],
    )
    if (!student.rows[0]?.activo) throw new ApiError(403, 'Tu ficha de alumno no está activa.')
    if (role === 'INSTRUCTOR' && !(participant.instructorId && student.rows[0].es_instructor)) {
      throw new ApiError(403, 'Solo los instructores pueden participar como instructor.')
    }

    // Quien participa como instructor no ocupa plaza de alumno.
    const limitFor = (limit: number | null) => (role === 'INSTRUCTOR' || limit === null ? null : Number(limit))

    if (scope === 'occurrence') {
      if (!await hasSeat(client, eventId, studentId, limitFor(event.limite_participantes))) {
        throw new ApiError(409, 'No quedan plazas libres en esta actividad.')
      }
      await upsertParticipation(client, eventId, studentId, role)
      return { scope, role, joined: [eventId], skipped: [] as string[] }
    }

    const ruleId = event.id_horario_recurrente
    if (ruleId === null) throw new ApiError(400, 'Esta actividad no forma parte de una serie.')
    const rule = await client.query(
      'SELECT 1 FROM horarios_recurrentes WHERE id_horario_recurrente = $1 AND activo = TRUE',
      [ruleId],
    )
    if (!rule.rows[0]) throw new ApiError(409, 'El horario habitual de esta actividad ya no está activo.')

    await client.query(`
      INSERT INTO participaciones_serie (id_horario_recurrente, id_alumno, rol, fecha_desde)
      VALUES ($1, $2, $3, $4::date)
      ON CONFLICT (id_horario_recurrente, id_alumno)
      DO UPDATE SET rol = EXCLUDED.rol, fecha_desde = EXCLUDED.fecha_desde
    `, [ruleId, studentId, role, event.fecha_recurrencia ?? event.fecha_hora.slice(0, 10)])

    const occurrences = await client.query<{ id_curso_agendado: number; fecha: string; limite_participantes: number | null }>(`
      SELECT id_curso_agendado, to_char(fecha_hora, 'YYYY-MM-DD') AS fecha, limite_participantes
      FROM cursos_agendados
      WHERE id_horario_recurrente = $1 AND activo = TRUE AND fecha_hora >= $2::timestamp
      ORDER BY fecha_hora
    `, [ruleId, event.fecha_hora])

    const joined: number[] = []
    const skipped: string[] = []
    for (const occurrence of occurrences.rows) {
      const occurrenceId = Number(occurrence.id_curso_agendado)
      if (await hasSeat(client, occurrenceId, studentId, limitFor(occurrence.limite_participantes))) {
        await upsertParticipation(client, occurrenceId, studentId, role)
        joined.push(occurrenceId)
      } else {
        skipped.push(occurrence.fecha)
      }
    }
    return { scope, role, joined, skipped }
  })
}

export async function leaveEvent(pool: Pool, participant: Participant, eventId: number, scope: ParticipationScope) {
  const studentId = requireStudent(participant)
  return inTransaction(pool, async (client) => {
    const event = await lockedFutureEvent(client, eventId)

    if (scope === 'occurrence') {
      const removed = await client.query(
        'DELETE FROM participaciones_evento WHERE id_curso_agendado = $1 AND id_alumno = $2',
        [eventId, studentId],
      )
      if (!removed.rowCount) throw new ApiError(404, 'No estabas apuntado a esta actividad.')
      return { scope, removed: removed.rowCount }
    }

    if (event.id_horario_recurrente === null) throw new ApiError(400, 'Esta actividad no forma parte de una serie.')
    const series = await client.query(
      'DELETE FROM participaciones_serie WHERE id_horario_recurrente = $1 AND id_alumno = $2',
      [event.id_horario_recurrente, studentId],
    )
    const removed = await client.query(`
      DELETE FROM participaciones_evento pe
      USING cursos_agendados ca
      WHERE pe.id_curso_agendado = ca.id_curso_agendado
        AND ca.id_horario_recurrente = $1 AND pe.id_alumno = $2
        AND ca.fecha_hora >= $3::timestamp
    `, [event.id_horario_recurrente, studentId, event.fecha_hora])
    if (!series.rowCount && !removed.rowCount) throw new ApiError(404, 'No estabas apuntado a esta serie.')
    return { scope, removed: removed.rowCount ?? 0 }
  })
}

export async function listEventParticipants(pool: Pool, eventId: number) {
  const event = await pool.query<{ id_horario_recurrente: number | null }>(
    'SELECT id_horario_recurrente FROM cursos_agendados WHERE id_curso_agendado = $1',
    [eventId],
  )
  if (!event.rows[0]) throw new ApiError(404, 'No se encontró la actividad.')
  const result = await pool.query(`
    SELECT pe.id_alumno, a.nombre, pe.rol,
           EXISTS (
             SELECT 1 FROM participaciones_serie ps
             WHERE ps.id_horario_recurrente = ca.id_horario_recurrente AND ps.id_alumno = pe.id_alumno
           ) AS serie
    FROM participaciones_evento pe
    JOIN cursos_agendados ca ON ca.id_curso_agendado = pe.id_curso_agendado
    JOIN alumnos a ON a.id_alumno = pe.id_alumno
    WHERE pe.id_curso_agendado = $1
    ORDER BY pe.rol DESC, a.nombre, pe.id_alumno
  `, [eventId])
  return result.rows
}
