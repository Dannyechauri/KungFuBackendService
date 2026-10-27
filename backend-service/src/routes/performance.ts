import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { createPerformanceRecord, respondToPerformanceConfirmation, resolvePerformanceAsAdmin } from '../agenda/performance-service.js'
import { getPerformanceRankings } from '../agenda/performance-ranking-service.js'
import { ApiError } from '../errors.js'
import { requireUser, Roles } from '../domain/auth.js'

type PerformanceRoutesOptions = { pool: Pool }

const identifier = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const recordInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  physicalWork: z.boolean(),
  cardioWork: z.boolean(),
  stretching: z.boolean(),
  attendedClass: z.boolean(),
  formIds: z.array(identifier).max(30),
  confirmerIds: z.array(identifier).min(2).max(100),
}).strict()
const confirmationInput = z.object({ decision: z.enum(['CONFIRMED', 'REJECTED']) }).strict()
const readLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
const writeLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

function parseId(value: string) {
  const parsed = identifier.safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'Identificador inválido.')
  return parsed.data
}

export const performanceRoutes: FastifyPluginAsync<PerformanceRoutesOptions> = async (app, { pool }) => {
  app.get('/rankings', readLimit, async (request) => {
    const user = requireUser(request)
    return getPerformanceRankings(pool, user.studentId, user.role === Roles.ADMIN)
  })

  app.get('/forms', readLimit, async (request) => {
    const user = requireUser(request)
    if (user.studentId === null) return []
    const result = await pool.query<{
      id_forma: string
      nombre: string
      estilo: string
      conocida: boolean
      en_grado_actual: boolean
      es_opcional: boolean
    }>(`
      SELECT f.id_forma::text, f.nombre, e.nombre AS estilo,
             EXISTS (SELECT 1 FROM alumno_forma af WHERE af.id_alumno = $1 AND af.id_forma = f.id_forma) AS conocida,
             gf.id_forma IS NOT NULL AS en_grado_actual, COALESCE(gf.es_opcional, FALSE) AS es_opcional
      FROM formas f
      JOIN estilos e ON e.id_estilo = f.id_estilo
      LEFT JOIN grado_forma gf ON gf.id_forma = f.id_forma
        AND gf.id_grado = (SELECT id_grado FROM alumnos WHERE id_alumno = $1)
      ORDER BY COALESCE(gf.es_opcional, FALSE), e.nombre, f.nombre
    `, [user.studentId])
    return result.rows.map((form) => ({
      id: Number(form.id_forma),
      name: form.nombre,
      style: form.estilo,
      known: form.conocida,
      inCurrentGrade: form.en_grado_actual,
      optional: form.es_opcional,
    }))
  })

  app.get('/confirmers', readLimit, async (request) => {
    const user = requireUser(request)
    if (user.studentId === null) throw new ApiError(403, 'Solo alumnos e instructores pueden registrar su desempeño.')
    const result = await pool.query<{ id_alumno: string; nombre: string; es_instructor: boolean }>(`
      SELECT a.id_alumno::text, a.nombre, a.es_instructor
      FROM alumnos a
      WHERE a.activo = TRUE AND a.id_alumno <> $1
      ORDER BY a.nombre, a.id_alumno
    `, [user.studentId])
    return result.rows.map((person) => ({
      id: Number(person.id_alumno),
      name: person.nombre,
      role: person.es_instructor ? 'INSTRUCTOR' : 'ALUMNO',
    }))
  })

  app.get('/records', readLimit, async (request) => {
    const user = requireUser(request)
    const canViewAll = user.role === Roles.ADMIN || user.role === Roles.INSTRUCTOR
    const records = await pool.query<{
      id_desempeno: string
      id_alumno: string
      nombre: string
      fecha: string
      trabajo_fisico: boolean
      trabajo_cardiovascular: boolean
      estiramiento: boolean
      asistio_clase: boolean
      aprobado_en: string | null
      rechazado_en: string | null
      resuelto_por_administrador: boolean
      creado_en: string
    }>(`
      SELECT d.id_desempeno::text, d.id_alumno::text, a.nombre,
             to_char(d.fecha, 'YYYY-MM-DD') AS fecha, d.trabajo_fisico, d.trabajo_cardiovascular, d.estiramiento,
             d.asistio_clase, d.aprobado_en::text, d.rechazado_en::text, d.resuelto_por_administrador, d.creado_en::text
      FROM desempenos_diarios d
      JOIN alumnos a ON a.id_alumno = d.id_alumno
      ${canViewAll ? '' : 'WHERE d.id_alumno = $1'}
      ORDER BY d.fecha DESC, d.id_desempeno DESC
      LIMIT 100
    `, canViewAll ? [] : [user.studentId])
    const ids = records.rows.map((record) => record.id_desempeno)
    if (!ids.length) return []

    const [forms, confirmations] = await Promise.all([
      pool.query<{ id_desempeno: string; id_forma: string; forma: string; estilo: string }>(`
        SELECT df.id_desempeno::text, f.id_forma::text, f.nombre AS forma, e.nombre AS estilo
        FROM desempeno_formas df
        JOIN formas f ON f.id_forma = df.id_forma
        JOIN estilos e ON e.id_estilo = f.id_estilo
        WHERE df.id_desempeno = ANY($1::bigint[])
        ORDER BY e.nombre, f.nombre
      `, [ids]),
      pool.query<{ id_desempeno: string; id_alumno_confirmante: string; nombre: string; estado: string }>(`
        SELECT dc.id_desempeno::text, dc.id_alumno_confirmante::text, a.nombre, dc.estado
        FROM desempeno_confirmaciones dc
        JOIN alumnos a ON a.id_alumno = dc.id_alumno_confirmante
        WHERE dc.id_desempeno = ANY($1::bigint[])
        ORDER BY a.nombre
      `, [ids]),
    ])
    return records.rows.map((record) => ({
      id: Number(record.id_desempeno),
      studentId: Number(record.id_alumno),
      studentName: record.nombre,
      date: record.fecha,
      physicalWork: record.trabajo_fisico,
      cardioWork: record.trabajo_cardiovascular,
      stretching: record.estiramiento,
      attendedClass: record.asistio_clase,
      approvedAt: record.aprobado_en,
      rejectedAt: record.rechazado_en,
      resolvedByAdmin: record.resuelto_por_administrador,
      forms: forms.rows.filter((form) => form.id_desempeno === record.id_desempeno)
        .map((form) => ({ id: Number(form.id_forma), name: form.forma, style: form.estilo })),
      confirmations: confirmations.rows.filter((confirmation) => confirmation.id_desempeno === record.id_desempeno)
        .map((confirmation) => ({
          studentId: Number(confirmation.id_alumno_confirmante),
          name: confirmation.nombre,
          status: confirmation.estado,
        })),
    }))
  })

  app.get('/confirmations/pending', readLimit, async (request) => {
    const user = requireUser(request)
    const isAdmin = user.role === Roles.ADMIN
    if (!isAdmin && user.studentId === null) return []
    const result = await pool.query<{
      id_desempeno: string
      nombre: string
      fecha: string
      trabajo_fisico: boolean
      trabajo_cardiovascular: boolean
      estiramiento: boolean
      asistio_clase: boolean
    }>(`
      SELECT d.id_desempeno::text, owner.nombre,
             to_char(d.fecha, 'YYYY-MM-DD') AS fecha, d.trabajo_fisico, d.trabajo_cardiovascular,
             d.estiramiento, d.asistio_clase
      FROM desempenos_diarios d
      JOIN alumnos owner ON owner.id_alumno = d.id_alumno
      WHERE d.aprobado_en IS NULL AND d.rechazado_en IS NULL
      ${isAdmin ? '' : `AND EXISTS (
        SELECT 1 FROM desempeno_confirmaciones dc
        WHERE dc.id_desempeno = d.id_desempeno AND dc.id_alumno_confirmante = $1 AND dc.estado = 'PENDING'
      )`}
      ORDER BY d.fecha DESC, d.id_desempeno DESC
    `, isAdmin ? [] : [user.studentId])
    const ids = result.rows.map((record) => record.id_desempeno)
    const forms = ids.length ? await pool.query<{ id_desempeno: string; nombre: string }>(`
      SELECT df.id_desempeno::text, f.nombre
      FROM desempeno_formas df
      JOIN formas f ON f.id_forma = df.id_forma
      WHERE df.id_desempeno = ANY($1::bigint[])
      ORDER BY f.nombre
    `, [ids]) : { rows: [] }
    return result.rows.map((record) => ({
      id: Number(record.id_desempeno),
      studentName: record.nombre,
      date: record.fecha,
      physicalWork: record.trabajo_fisico,
      cardioWork: record.trabajo_cardiovascular,
      stretching: record.estiramiento,
      attendedClass: record.asistio_clase,
      forms: forms.rows.filter((form) => form.id_desempeno === record.id_desempeno).map((form) => form.nombre),
    }))
  })

  app.post<{ Body: unknown }>('/records', writeLimit, async (request, reply) => {
    const user = requireUser(request)
    if (user.studentId === null || user.role === Roles.ADMIN) {
      throw new ApiError(403, 'Solo alumnos e instructores pueden registrar su desempeño.')
    }
    const parsed = recordInput.safeParse(request.body)
    if (!parsed.success) throw new ApiError(400, 'Revisa la fecha, la actividad física y selecciona al menos dos confirmantes.')
    const input = parsed.data
    const confirmerIds = [...new Set(input.confirmerIds)]
    const formIds = [...new Set(input.formIds)]
    if (confirmerIds.length < 2 || confirmerIds.includes(user.studentId)) {
      throw new ApiError(400, 'Selecciona al menos dos confirmantes distintos de ti.')
    }

    const [validConfirmers, validForms] = await Promise.all([
      pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM alumnos
        WHERE id_alumno = ANY($1::bigint[]) AND activo = TRUE
      `, [confirmerIds]),
      pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM formas WHERE id_forma = ANY($1::bigint[])
      `, [formIds]),
    ])
    if (Number(validConfirmers.rows[0]?.count) !== confirmerIds.length) throw new ApiError(400, 'Uno de los confirmantes no está disponible.')
    if (Number(validForms.rows[0]?.count) !== formIds.length) throw new ApiError(400, 'Una de las formas seleccionadas no existe.')

    const created = await createPerformanceRecord(pool, {
      studentId: user.studentId,
      date: input.date,
      physicalWork: input.physicalWork,
      cardioWork: input.cardioWork,
      stretching: input.stretching,
      attendedClass: input.attendedClass,
      formIds,
      confirmerIds,
    })
    return reply.code(201).send(created)
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/confirmations/:id/respond', writeLimit, async (request) => {
    const user = requireUser(request)
    const isAdmin = user.role === Roles.ADMIN
    if (!isAdmin && user.studentId === null) throw new ApiError(404, 'No se encontró esa solicitud.')
    const id = parseId(request.params.id)
    const parsed = confirmationInput.safeParse(request.body)
    if (!parsed.success) throw new ApiError(400, 'Indica si confirmas o rechazas la actividad.')
    const response = isAdmin ? await resolvePerformanceAsAdmin(pool, {
      recordId: id,
      decision: parsed.data.decision,
    }) : await respondToPerformanceConfirmation(pool, {
      recordId: id,
      studentId: user.studentId!,
      decision: parsed.data.decision,
    })
    if (!response) throw new ApiError(404, 'No se encontró esa solicitud pendiente.')
    return { id, ...response }
  })
}