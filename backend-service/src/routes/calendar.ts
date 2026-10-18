import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { mayManageSchedule, requireRole, requireUser, Roles } from '../domain/auth.js'
import { ApiError } from '../errors.js'
import {
  cancelCalendarEvent,
  cancelRecurringRule,
  createCalendarCourse,
  createCalendarEvent,
  createCalendarRoom,
  createRecurringRules,
  listCalendarCourses,
  listCalendarEvents,
  listCalendarRooms,
  listRecurringRules,
  updateCalendarCourse,
  updateCalendarEvent,
  updateCalendarRoom,
  updateRecurringRule,
} from '../agenda/calendar-service.js'

type CalendarRoutesOptions = { pool: Pool }

const identifier = z.coerce.number().int().positive()
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const localTime = z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/u)
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u)

const eventInput = z.object({
  courseId: identifier,
  instructorId: identifier,
  roomId: identifier,
  startAt: localDateTime,
  endAt: localDateTime,
}).strict()

const eventPatch = z.object({
  courseId: identifier.optional(),
  instructorId: identifier.optional(),
  roomId: identifier.nullable().optional(),
  startAt: localDateTime.optional(),
  endAt: localDateTime.optional(),
}).strict().refine((value) => Object.keys(value).length > 0)
const courseInput = z.object({
  nombre: z.string().trim().min(1).max(100),
  tema: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(255).nullable().optional(),
  tipo_curso: z.enum(['HABITUAL', 'CURSO_ESPECIAL']),
}).strict()
const coursePatch = courseInput.partial().strict().refine((value) => Object.keys(value).length > 0)

const recurrenceInput = z.object({
  courseId: identifier,
  instructorId: identifier,
  roomId: identifier,
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startTime: localTime,
  endTime: localTime,
  startsOn: localDate,
  endsOn: localDate.nullable().optional(),
}).strict()

const recurrencePatch = z.object({
  courseId: identifier.optional(),
  instructorId: identifier.optional(),
  roomId: identifier.nullable().optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(1).optional(),
  startTime: localTime.optional(),
  endTime: localTime.optional(),
  startsOn: localDate.optional(),
  endsOn: localDate.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0)
const roomInput = z.object({ nombre: z.string().trim().min(1).max(100) }).strict()
const roomPatch = z.object({
  nombre: z.string().trim().min(1).max(100).optional(),
  activo: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0)

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(400, result.error.issues[0]?.message ?? 'Los datos enviados no son válidos.')
  return result.data
}

function parseId(value: string) {
  const parsed = identifier.safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'Identificador inválido.')
  return parsed.data
}

const readLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
const writeLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export const calendarRoutes: FastifyPluginAsync<CalendarRoutesOptions> = async (app, { pool }) => {
  app.get('/instructors', readLimit, async (request) => {
    requireRole(request, [Roles.ADMIN, Roles.INSTRUCTOR])
    const result = await pool.query<{ id_instructor: number; nombre: string; activo: boolean | null }>(`
      SELECT id_instructor, nombre, activo
      FROM instructores
      WHERE activo IS NULL OR activo = TRUE
      ORDER BY nombre, id_instructor
    `)
    return result.rows
  })

  app.get('/rooms', readLimit, async (request) => {
    requireUser(request)
    return listCalendarRooms(pool)
  })

  app.post<{ Body: unknown }>('/rooms', writeLimit, async (request, reply) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo el equipo docente puede gestionar las salas.')
    const room = await createCalendarRoom(pool, parseBody(roomInput, request.body))
    return reply.code(201).send(room)
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/rooms/:id', writeLimit, async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo el equipo docente puede gestionar las salas.')
    return updateCalendarRoom(pool, parseId(request.params.id), parseBody(roomPatch, request.body))
  })

  app.get('/courses', readLimit, async (request) => {
    requireUser(request)
    return listCalendarCourses(pool)
  })

  app.post<{ Body: unknown }>('/courses', writeLimit, async (request, reply) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar los cursos.')
    const input = parseBody(courseInput, request.body)
    const course = await createCalendarCourse(pool, { ...input, descripcion: input.descripcion ?? null })
    return reply.code(201).send(course)
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/courses/:id', writeLimit, async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar los cursos.')
    return updateCalendarCourse(pool, parseId(request.params.id), parseBody(coursePatch, request.body))
  })

  app.get<{ Querystring: { from?: string; to?: string; roomId?: string } }>('/events', readLimit, async (request) => {
    requireUser(request)
    if (!request.query.from || !request.query.to) {
      throw new ApiError(400, 'Indica el inicio y el final del intervalo con from y to.')
    }
    const roomId = request.query.roomId === undefined ? undefined : parseId(request.query.roomId)
    return listCalendarEvents(pool, request.query.from, request.query.to, roomId)
  })

  app.post<{ Body: unknown }>('/events', writeLimit, async (request, reply) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar la agenda.')
    const event = await createCalendarEvent(pool, parseBody(eventInput, request.body))
    return reply.code(201).send(event)
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/events/:id', writeLimit, async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar la agenda.')
    const input = parseBody(eventPatch, request.body)
    return updateCalendarEvent(pool, parseId(request.params.id), input)
  })

  app.post<{ Params: { id: string } }>('/events/:id/cancel', writeLimit, async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar la agenda.')
    return cancelCalendarEvent(pool, parseId(request.params.id))
  })

  app.get('/recurring-rules', readLimit, async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar horarios habituales.')
    return listRecurringRules(pool)
  })

  app.post<{ Body: unknown }>('/recurring-rules', writeLimit, async (request, reply) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar horarios habituales.')
    const input = parseBody(recurrenceInput, request.body)
    const result = await createRecurringRules(pool, { ...input, endsOn: input.endsOn ?? null })
    return reply.code(201).send(result)
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/recurring-rules/:id', writeLimit, async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar horarios habituales.')
    const input = parseBody(recurrencePatch, request.body)
    return updateRecurringRule(pool, parseId(request.params.id), input)
  })

  app.post<{ Params: { id: string } }>('/recurring-rules/:id/cancel', async (request) => {
    const user = requireUser(request)
    if (!mayManageSchedule(user.role)) throw new ApiError(403, 'Solo administradores e instructores pueden gestionar horarios habituales.')
    return cancelRecurringRule(pool, parseId(request.params.id))
  })
}
