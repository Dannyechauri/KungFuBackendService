import type { Pool, PoolClient } from 'pg'

import { inTransaction } from '../db/pool.js'
import { ApiError } from '../errors.js'

const scheduleLock = 4_281_906_711
const maxQueryDays = 93
const materializationDays = 90

export type CalendarEventInput = {
  courseId: number
  instructorId: number
  roomId: number
  startAt: string
  endAt: string
}

export type RecurrenceInput = {
  courseId: number
  instructorId: number
  roomId: number
  weekdays: number[]
  startTime: string
  endTime: string
  startsOn: string
  endsOn: string | null | undefined
}

export type CalendarEventPatch = {
  courseId?: number | undefined
  instructorId?: number | undefined
  roomId?: number | null | undefined
  startAt?: string | undefined
  endAt?: string | undefined
}

export type RecurrencePatch = {
  courseId?: number | undefined
  instructorId?: number | undefined
  roomId?: number | null | undefined
  weekdays?: number[] | undefined
  startTime?: string | undefined
  endTime?: string | undefined
  startsOn?: string | undefined
  endsOn?: string | null | undefined
}

export type CourseInput = {
  nombre: string
  tema: string
  descripcion: string | null
  tipo_curso: 'HABITUAL' | 'CURSO_ESPECIAL'
}

export type CoursePatch = {
  nombre?: string | undefined
  tema?: string | undefined
  descripcion?: string | null | undefined
  tipo_curso?: 'HABITUAL' | 'CURSO_ESPECIAL' | undefined
}

export type RoomInput = {
  nombre: string
}

export type RoomPatch = {
  nombre?: string | undefined
  activo?: boolean | undefined
}

type RecurrenceRow = {
  id_horario_recurrente: number
  id_curso: number
  id_instructor: number
  id_sala: number | null
  dia_semana: number
  hora_inicio: string
  hora_fin: string
  fecha_inicio: string
  fecha_fin: string | null
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function validTime(value: string) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value)
  return Boolean(match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60)
}

export function normalizeLocalDateTime(value: string, fieldName = 'fecha y hora') {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/u.exec(value)
  if (!match?.[1] || !match[2] || !validDate(match[1]) || !validTime(`${match[2]}:${match[3] ?? '00'}`)) {
    throw new ApiError(400, `El campo '${fieldName}' debe ser una fecha y hora local válida (AAAA-MM-DDTHH:mm).`)
  }
  return `${match[1]} ${match[2]}:${match[3] ?? '00'}`
}

function normalizeTime(value: string) {
  if (!validTime(value)) throw new ApiError(400, 'La hora debe tener formato HH:mm.')
  return value.length === 5 ? `${value}:00` : value
}

function dateToWeekday(value: string) {
  const day = new Date(`${value}T00:00:00.000Z`).getUTCDay()
  return day === 0 ? 7 : day
}

function addDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function daysBetween(start: string, end: string) {
  const first = new Date(`${start}T00:00:00.000Z`).getTime()
  const last = new Date(`${end}T00:00:00.000Z`).getTime()
  return Math.floor((last - first) / 86_400_000)
}

function validateEventInterval(startAt: string, endAt: string) {
  const start = normalizeLocalDateTime(startAt, 'startAt')
  const end = normalizeLocalDateTime(endAt, 'endAt')
  if (end <= start) throw new ApiError(400, 'La hora de fin debe ser posterior a la hora de inicio.')
  const days = daysBetween(start.slice(0, 10), end.slice(0, 10))
  if (days > 7) throw new ApiError(400, 'Una actividad no puede durar más de ocho días.')
  return { start, end }
}

async function assertCourseAndInstructor(client: PoolClient, courseId: number, instructorId: number, habitualOnly = false) {
  const course = await client.query<{ tipo_curso: string }>(
    'SELECT tipo_curso FROM cursos WHERE id_curso = $1',
    [courseId],
  )
  if (!course.rows[0]) throw new ApiError(404, 'No se encontró el curso.')
  if (habitualOnly && course.rows[0].tipo_curso !== 'HABITUAL') {
    throw new ApiError(400, 'Solo se pueden crear horarios recurrentes para clases habituales.')
  }
  const instructor = await client.query(
    'SELECT id_instructor FROM instructores WHERE id_instructor = $1 AND (activo IS NULL OR activo = TRUE)',
    [instructorId],
  )
  if (!instructor.rows[0]) throw new ApiError(404, 'No se encontró un instructor activo.')
}

async function assertActiveRoom(client: PoolClient, roomId: number) {
  const room = await client.query(
    'SELECT id_sala FROM salas WHERE id_sala = $1 AND activo = TRUE',
    [roomId],
  )
  if (!room.rows[0]) throw new ApiError(404, 'No se encontró una sala activa.')
}

async function conflictingEvent(
  client: PoolClient,
  roomId: number | null,
  start: string,
  end: string,
  excludedId?: number,
) {
  const result = await client.query<{ id_curso_agendado: number }>(`
    SELECT id_curso_agendado
    FROM cursos_agendados
    WHERE activo = TRUE
      AND ($1::bigint IS NULL OR id_sala IS NULL OR id_sala = $1)
      AND fecha_hora < $3::timestamp
      AND fecha_hora_fin > $2::timestamp
      AND ($4::bigint IS NULL OR id_curso_agendado <> $4)
    ORDER BY fecha_hora
    LIMIT 1
  `, [roomId, start, end, excludedId ?? null])
  return result.rows[0]?.id_curso_agendado ?? null
}

async function assertAvailable(client: PoolClient, roomId: number | null, start: string, end: string, excludedId?: number) {
  const conflict = await conflictingEvent(client, roomId, start, end, excludedId)
  if (conflict) {
    throw new ApiError(409, `La actividad se solapa con otra actividad agendada (id ${conflict}).`)
  }
}

async function materializeRules(client: PoolClient, fromDate: string, toDateExclusive: string) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
  const rules = await client.query<RecurrenceRow>(`
    SELECT id_horario_recurrente, id_curso, id_instructor, id_sala, dia_semana,
           hora_inicio::text, hora_fin::text, fecha_inicio::text, fecha_fin::text
    FROM horarios_recurrentes
    WHERE activo = TRUE
      AND fecha_inicio < $2::date
      AND (fecha_fin IS NULL OR fecha_fin >= $1::date)
    ORDER BY id_horario_recurrente
  `, [fromDate, toDateExclusive])

  let inserted = 0
  for (const rule of rules.rows) {
    let date = rule.fecha_inicio > fromDate ? rule.fecha_inicio : fromDate
    const until = rule.fecha_fin && rule.fecha_fin < toDateExclusive
      ? addDays(rule.fecha_fin, 1)
      : toDateExclusive

    while (date < until) {
      if (dateToWeekday(date) === Number(rule.dia_semana)) {
        const existing = await client.query(
          'SELECT id_curso_agendado FROM cursos_agendados WHERE id_horario_recurrente = $1 AND fecha_recurrencia = $2::date',
          [rule.id_horario_recurrente, date],
        )
        if (!existing.rows[0]) {
          const start = `${date} ${normalizeTime(rule.hora_inicio)}`
          const end = `${date} ${normalizeTime(rule.hora_fin)}`
          const roomId = rule.id_sala === null ? null : Number(rule.id_sala)
          await assertAvailable(client, roomId, start, end)
          await client.query(`
            INSERT INTO cursos_agendados
              (id_curso, id_instructor, id_sala, fecha_hora, fecha_hora_fin, activo,
               id_horario_recurrente, fecha_recurrencia)
            VALUES ($1, $2, $3, $4::timestamp, $5::timestamp, TRUE, $6, $7::date)
          `, [rule.id_curso, rule.id_instructor, roomId, start, end, rule.id_horario_recurrente, date])
          inserted += 1
        }
      }
      date = addDays(date, 1)
    }
  }
  return inserted
}

function rangeDates(from: string, to: string) {
  const fromTimestamp = normalizeLocalDateTime(from, 'from')
  const toTimestamp = normalizeLocalDateTime(to, 'to')
  if (toTimestamp <= fromTimestamp) throw new ApiError(400, 'El final del intervalo debe ser posterior al inicio.')
  const fromDate = fromTimestamp.slice(0, 10)
  const toDate = toTimestamp.slice(0, 10)
  const span = daysBetween(fromDate, toDate)
  if (span > maxQueryDays) throw new ApiError(400, `El intervalo no puede superar ${maxQueryDays} días.`)
  return { fromTimestamp, toTimestamp, fromDate, toDateExclusive: addDays(toDate, 1) }
}

const eventSelect = `
  SELECT ca.id_curso_agendado,
         ca.id_curso,
         ca.id_instructor,
         ca.id_sala,
         to_char(ca.fecha_hora, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora,
         to_char(ca.fecha_hora_fin, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora_fin,
         ca.activo,
         ca.id_horario_recurrente,
         ca.modificado_manualmente,
         c.nombre AS curso_nombre,
         c.tema AS curso_tema,
         c.descripcion AS curso_descripcion,
         c.tipo_curso,
         i.nombre AS instructor_nombre,
         s.nombre AS sala_nombre
  FROM cursos_agendados ca
  JOIN cursos c ON c.id_curso = ca.id_curso
  JOIN instructores i ON i.id_instructor = ca.id_instructor
  LEFT JOIN salas s ON s.id_sala = ca.id_sala
`

export async function listCalendarEvents(pool: Pool, from: string, to: string, roomId?: number) {
  const range = rangeDates(from, to)
  await ensureCalendarOccurrences(pool, range.fromDate, range.toDateExclusive)

  const result = await pool.query(`${eventSelect}
    WHERE ca.fecha_hora < $2::timestamp AND ca.fecha_hora_fin > $1::timestamp
      AND ($3::bigint IS NULL OR ca.id_sala = $3)
    ORDER BY ca.fecha_hora, ca.id_curso_agendado
  `, [range.fromTimestamp, range.toTimestamp, roomId ?? null])
  return result.rows
}

export async function listCalendarRooms(pool: Pool) {
  const result = await pool.query(`
    SELECT id_sala, nombre, activo
    FROM salas
    ORDER BY lower(nombre), id_sala
  `)
  return result.rows
}

export async function createCalendarRoom(pool: Pool, input: RoomInput) {
  try {
    const result = await pool.query(`
      INSERT INTO salas (nombre)
      VALUES ($1)
      RETURNING id_sala, nombre, activo
    `, [input.nombre.trim()])
    return result.rows[0]
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new ApiError(409, 'Ya existe una sala con ese nombre.')
    }
    throw error
  }
}

export async function updateCalendarRoom(pool: Pool, id: number, input: RoomPatch) {
  const current = await pool.query('SELECT id_sala FROM salas WHERE id_sala = $1', [id])
  if (!current.rows[0]) throw new ApiError(404, 'No se encontró la sala.')

  if (input.activo === false) {
    const scheduledUse = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM cursos_agendados
        WHERE id_sala = $1 AND activo = TRUE
          AND fecha_hora_fin > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
      ) OR EXISTS (
        SELECT 1 FROM horarios_recurrentes
        WHERE id_sala = $1 AND activo = TRUE
          AND (fecha_fin IS NULL OR fecha_fin >= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')::date)
      ) AS in_use
    `, [id])
    if (scheduledUse.rows[0]?.in_use) {
      throw new ApiError(409, 'Mueve o cancela las actividades futuras antes de desactivar esta sala.')
    }
  }

  const fields: Array<[keyof RoomPatch, string]> = [['nombre', 'nombre'], ['activo', 'activo']]
  const updates = fields.filter(([key]) => input[key] !== undefined)
  if (!updates.length) throw new ApiError(400, 'Indica al menos un campo para actualizar.')
  const values = updates.map(([key]) => key === 'nombre' ? String(input[key]).trim() : input[key])
  const assignments = updates.map(([, column], index) => `${column} = $${index + 1}`).join(', ')

  try {
    const result = await pool.query(`
      UPDATE salas SET ${assignments}
      WHERE id_sala = $${values.length + 1}
      RETURNING id_sala, nombre, activo
    `, [...values, id])
    return result.rows[0]
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new ApiError(409, 'Ya existe una sala con ese nombre.')
    }
    throw error
  }
}

export async function listCalendarCourses(pool: Pool) {
  const result = await pool.query(`
    SELECT id_curso, nombre, tema, descripcion, tipo_curso
    FROM cursos
    ORDER BY nombre, id_curso
  `)
  return result.rows
}

export async function createCalendarCourse(pool: Pool, input: CourseInput) {
  const result = await pool.query(`
    INSERT INTO cursos (nombre, tema, descripcion, tipo_curso)
    VALUES ($1, $2, $3, $4)
    RETURNING id_curso, nombre, tema, descripcion, tipo_curso
  `, [input.nombre.trim(), input.tema.trim(), input.descripcion?.trim() || null, input.tipo_curso])
  return result.rows[0]
}

export async function updateCalendarCourse(pool: Pool, id: number, input: CoursePatch) {
  const current = await pool.query<{ tipo_curso: string }>('SELECT tipo_curso FROM cursos WHERE id_curso = $1', [id])
  if (!current.rows[0]) throw new ApiError(404, 'No se encontró el curso.')

  const nextType = input.tipo_curso ?? current.rows[0].tipo_curso
  if (nextType === 'CURSO_ESPECIAL' && current.rows[0].tipo_curso !== 'CURSO_ESPECIAL') {
    const activeRule = await pool.query(
      'SELECT 1 FROM horarios_recurrentes WHERE id_curso = $1 AND activo = TRUE LIMIT 1',
      [id],
    )
    if (activeRule.rows[0]) throw new ApiError(409, 'Cancela los horarios habituales antes de convertir este curso en especial.')
  }

  const fields: Array<[keyof CoursePatch, string]> = [
    ['nombre', 'nombre'], ['tema', 'tema'], ['descripcion', 'descripcion'], ['tipo_curso', 'tipo_curso'],
  ]
  const updates = fields.filter(([key]) => input[key] !== undefined)
  if (!updates.length) throw new ApiError(400, 'Indica al menos un campo para actualizar.')
  const values = updates.map(([key]) => {
    const value = input[key]
    return typeof value === 'string' && key !== 'descripcion' ? value.trim() : value
  })
  const assignments = updates.map(([, column], index) => `${column} = $${index + 1}`).join(', ')
  const result = await pool.query(`
    UPDATE cursos SET ${assignments}
    WHERE id_curso = $${values.length + 1}
    RETURNING id_curso, nombre, tema, descripcion, tipo_curso
  `, [...values, id])
  return result.rows[0]
}

export async function ensureCalendarOccurrences(pool: Pool, fromDate: string, toDateExclusive: string) {
  return inTransaction(pool, async (client) => materializeRules(client, fromDate, toDateExclusive))
}

export async function materializeUpcomingOccurrences(pool: Pool, days = materializationDays) {
  const todayResult = await pool.query<{ today: string }>(`
    SELECT to_char(NOW() AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD') AS today
  `)
  const today = todayResult.rows[0]?.today
  if (!today) throw new ApiError(500, 'No se pudo determinar la fecha local del calendario.')
  return ensureCalendarOccurrences(pool, today, addDays(today, days + 1))
}

export async function createCalendarEvent(pool: Pool, input: CalendarEventInput) {
  const { start, end } = validateEventInterval(input.startAt, input.endAt)
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
    await materializeRules(client, start.slice(0, 10), addDays(end.slice(0, 10), 1))
    await assertCourseAndInstructor(client, input.courseId, input.instructorId)
    await assertActiveRoom(client, input.roomId)
    await assertAvailable(client, input.roomId, start, end)
    const result = await client.query<{ id_curso_agendado: number }>(`
      INSERT INTO cursos_agendados
        (id_curso, id_instructor, id_sala, fecha_hora, fecha_hora_fin, activo)
      VALUES ($1, $2, $3, $4::timestamp, $5::timestamp, TRUE)
      RETURNING id_curso_agendado
    `, [input.courseId, input.instructorId, input.roomId, start, end])
    return result.rows[0]
  })
}

export async function updateCalendarEvent(pool: Pool, id: number, input: CalendarEventPatch) {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
    const existing = await client.query<{
      id_curso: number
      id_instructor: number
      id_sala: number | null
      fecha_hora: string
      fecha_hora_fin: string
      id_horario_recurrente: number | null
      fecha_recurrencia: string | null
    }>(`
      SELECT id_curso, id_instructor, id_sala,
             to_char(fecha_hora, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora,
             to_char(fecha_hora_fin, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora_fin,
             id_horario_recurrente, fecha_recurrencia::text
      FROM cursos_agendados WHERE id_curso_agendado = $1 AND activo = TRUE
    `, [id])
    const old = existing.rows[0]
    if (!old) throw new ApiError(404, 'No se encontró una actividad activa con ese identificador.')

    const courseId = input.courseId ?? Number(old.id_curso)
    const instructorId = input.instructorId ?? Number(old.id_instructor)
    const oldRoomId = old.id_sala === null ? null : Number(old.id_sala)
    const roomId = input.roomId === undefined ? oldRoomId : input.roomId
    const startAt = input.startAt ?? old.fecha_hora
    const endAt = input.endAt ?? old.fecha_hora_fin
    const interval = validateEventInterval(startAt, endAt)
    await materializeRules(client, interval.start.slice(0, 10), addDays(interval.end.slice(0, 10), 1))
    await assertCourseAndInstructor(client, courseId, instructorId)
    if (roomId !== null && roomId !== oldRoomId) await assertActiveRoom(client, roomId)
    await assertAvailable(client, roomId, interval.start, interval.end, id)

    const result = await client.query(`
      UPDATE cursos_agendados
      SET id_curso = $2, id_instructor = $3, id_sala = $4,
          fecha_hora = $5::timestamp, fecha_hora_fin = $6::timestamp,
          modificado_manualmente = CASE WHEN id_horario_recurrente IS NULL THEN FALSE ELSE TRUE END
      WHERE id_curso_agendado = $1
      RETURNING id_curso_agendado
    `, [id, courseId, instructorId, roomId, interval.start, interval.end])
    return result.rows[0]
  })
}

export async function cancelCalendarEvent(pool: Pool, id: number) {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
    const result = await client.query(`
      UPDATE cursos_agendados SET activo = FALSE
      WHERE id_curso_agendado = $1 AND activo = TRUE
      RETURNING id_curso_agendado
    `, [id])
    if (!result.rows[0]) throw new ApiError(404, 'No se encontró una actividad activa con ese identificador.')
    return { id_curso_agendado: id, activo: false }
  })
}

export async function createRecurringRules(pool: Pool, input: RecurrenceInput) {
  const startTime = normalizeTime(input.startTime)
  const endTime = normalizeTime(input.endTime)
  if (endTime <= startTime) throw new ApiError(400, 'La hora de fin debe ser posterior a la hora de inicio.')
  if (!validDate(input.startsOn) || (input.endsOn && !validDate(input.endsOn))) {
    throw new ApiError(400, 'La vigencia del horario debe usar fechas válidas (AAAA-MM-DD).')
  }
  if (input.endsOn && input.endsOn < input.startsOn) throw new ApiError(400, 'La fecha de fin debe ser posterior a la fecha de inicio.')
  if (input.endsOn && daysBetween(input.startsOn, input.endsOn) > 366) {
    throw new ApiError(400, 'Un horario recurrente no puede abarcar más de un año.')
  }
  const weekdays = [...new Set(input.weekdays)]
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new ApiError(400, 'Indica uno o varios días de la semana entre 1 (lunes) y 7 (domingo).')
  }

  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
    await assertCourseAndInstructor(client, input.courseId, input.instructorId, true)
    await assertActiveRoom(client, input.roomId)
    const created = []
    for (const weekday of weekdays) {
      const result = await client.query<{ id_horario_recurrente: number }>(`
        INSERT INTO horarios_recurrentes
          (id_curso, id_instructor, id_sala, dia_semana, hora_inicio, hora_fin, fecha_inicio, fecha_fin, activo)
        VALUES ($1, $2, $3, $4, $5::time, $6::time, $7::date, $8::date, TRUE)
        RETURNING id_horario_recurrente
      `, [input.courseId, input.instructorId, input.roomId, weekday, startTime, endTime, input.startsOn, input.endsOn])
      created.push(result.rows[0])
    }

    const initialEnd = input.endsOn && daysBetween(input.startsOn, input.endsOn) < materializationDays
      ? addDays(input.endsOn, 1)
      : addDays(input.startsOn, materializationDays + 1)
    const inserted = await materializeRules(client, input.startsOn, initialEnd)
    return { rules: created, occurrencesCreated: inserted }
  })
}

export async function updateRecurringRule(pool: Pool, id: number, input: RecurrencePatch) {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
    const query = await client.query<RecurrenceRow>(`
      SELECT id_horario_recurrente, id_curso, id_instructor, id_sala, dia_semana,
             hora_inicio::text, hora_fin::text, fecha_inicio::text, fecha_fin::text
      FROM horarios_recurrentes WHERE id_horario_recurrente = $1 AND activo = TRUE
    `, [id])
    const old = query.rows[0]
    if (!old) throw new ApiError(404, 'No se encontró un horario recurrente activo.')

    const courseId = input.courseId ?? Number(old.id_curso)
    const instructorId = input.instructorId ?? Number(old.id_instructor)
    const oldRoomId = old.id_sala === null ? null : Number(old.id_sala)
    const roomId = input.roomId === undefined ? oldRoomId : input.roomId
    const weekday = input.weekdays?.[0] ?? Number(old.dia_semana)
    const startTime = normalizeTime(input.startTime ?? old.hora_inicio)
    const endTime = normalizeTime(input.endTime ?? old.hora_fin)
    const startsOn = input.startsOn ?? old.fecha_inicio
    const endsOn = input.endsOn === undefined ? old.fecha_fin : input.endsOn
    if (endTime <= startTime) throw new ApiError(400, 'La hora de fin debe ser posterior a la hora de inicio.')
    if (!validDate(startsOn) || (endsOn && !validDate(endsOn))) throw new ApiError(400, 'La vigencia del horario contiene una fecha inválida.')
    if (endsOn && endsOn < startsOn) throw new ApiError(400, 'La fecha de fin debe ser posterior a la fecha de inicio.')
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new ApiError(400, 'El día de la semana debe estar entre 1 y 7.')
    await assertCourseAndInstructor(client, courseId, instructorId, true)
    if (roomId !== null && roomId !== oldRoomId) await assertActiveRoom(client, roomId)

    await client.query(`
      UPDATE horarios_recurrentes
      SET id_curso = $2, id_instructor = $3, id_sala = $4, dia_semana = $5,
          hora_inicio = $6::time, hora_fin = $7::time,
          fecha_inicio = $8::date, fecha_fin = $9::date
      WHERE id_horario_recurrente = $1
    `, [id, courseId, instructorId, roomId, weekday, startTime, endTime, startsOn, endsOn])

    const future = await client.query<{ id_curso_agendado: number; fecha_recurrencia: string }>(`
      SELECT id_curso_agendado, fecha_recurrencia::text
      FROM cursos_agendados
      WHERE id_horario_recurrente = $1 AND activo = TRUE
        AND modificado_manualmente = FALSE
        AND fecha_recurrencia >= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')::date
      ORDER BY fecha_recurrencia
    `, [id])

    for (const occurrence of future.rows) {
      const date = occurrence.fecha_recurrencia
      const shouldKeep = date >= startsOn && (!endsOn || date <= endsOn) && dateToWeekday(date) === weekday
      if (!shouldKeep) {
        await client.query('UPDATE cursos_agendados SET activo = FALSE WHERE id_curso_agendado = $1', [occurrence.id_curso_agendado])
        continue
      }
      const start = `${date} ${startTime}`
      const end = `${date} ${endTime}`
      await assertAvailable(client, roomId, start, end, Number(occurrence.id_curso_agendado))
      await client.query(`
        UPDATE cursos_agendados
        SET id_curso = $2, id_instructor = $3, id_sala = $4,
            fecha_hora = $5::timestamp, fecha_hora_fin = $6::timestamp
        WHERE id_curso_agendado = $1
      `, [occurrence.id_curso_agendado, courseId, instructorId, roomId, start, end])
    }

    const endDate = endsOn && daysBetween(startsOn, endsOn) < materializationDays
      ? addDays(endsOn, 1)
      : addDays(startsOn, materializationDays + 1)
    const occurrencesCreated = await materializeRules(client, startsOn, endDate)
    return { id_horario_recurrente: id, occurrencesCreated }
  })
}

export async function cancelRecurringRule(pool: Pool, id: number) {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [scheduleLock])
    const result = await client.query(`
      UPDATE horarios_recurrentes SET activo = FALSE
      WHERE id_horario_recurrente = $1 AND activo = TRUE
      RETURNING id_horario_recurrente
    `, [id])
    if (!result.rows[0]) throw new ApiError(404, 'No se encontró un horario recurrente activo.')
    const cancelled = await client.query(`
      UPDATE cursos_agendados SET activo = FALSE
      WHERE id_horario_recurrente = $1 AND activo = TRUE
        AND fecha_hora >= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
      RETURNING id_curso_agendado
    `, [id])
    return { id_horario_recurrente: id, activo: false, occurrencesCancelled: cancelled.rowCount ?? 0 }
  })
}

export async function listRecurringRules(pool: Pool) {
  const result = await pool.query(`
    SELECT hr.id_horario_recurrente, hr.id_curso, c.nombre AS curso_nombre,
           c.tipo_curso, hr.id_instructor, i.nombre AS instructor_nombre,
           hr.id_sala, s.nombre AS sala_nombre,
           hr.dia_semana, hr.hora_inicio::text, hr.hora_fin::text,
           hr.fecha_inicio::text, hr.fecha_fin::text, hr.activo
    FROM horarios_recurrentes hr
    JOIN cursos c ON c.id_curso = hr.id_curso
    JOIN instructores i ON i.id_instructor = hr.id_instructor
    LEFT JOIN salas s ON s.id_sala = hr.id_sala
    ORDER BY hr.dia_semana, hr.hora_inicio
  `)
  return result.rows
}
