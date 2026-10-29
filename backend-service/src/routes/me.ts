import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { requireUser } from '../domain/auth.js'
import { ApiError } from '../errors.js'

type MeRoutesOptions = { pool: Pool }

const readLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
const writeLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
const formId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const progressInput = z.object({ percent: z.number().int().min(0).max(100) }).strict()

function parseFormId(value: string) {
  const parsed = formId.safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'Identificador inválido.')
  return parsed.data
}

function requireStudentId(request: Parameters<typeof requireUser>[0]) {
  const user = requireUser(request)
  if (user.studentId === null || user.studentId === undefined) throw new ApiError(404, 'Esta cuenta no tiene ficha de alumno')
  return user.studentId
}

/** Ficha propia de alumnos e instructores; siempre se resuelve desde la sesión, nunca por parámetro. */
export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (app, { pool }) => {
  app.get('/birthdays/today', readLimit, async (request) => {
    requireUser(request)
    const result = await pool.query<{ id_alumno: string; nombre: string }>(`
      SELECT id_alumno::text, nombre
      FROM alumnos
      WHERE activo = TRUE
        AND EXTRACT(MONTH FROM fecha_nacimiento) = EXTRACT(MONTH FROM CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
        AND EXTRACT(DAY FROM fecha_nacimiento) = EXTRACT(DAY FROM CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
      ORDER BY nombre
    `)
    return result.rows.map((row) => ({ id: Number(row.id_alumno), name: row.nombre }))
  })

  app.get('/profile', readLimit, async (request) => {
    const user = requireUser(request)
    if (user.studentId === null) throw new ApiError(404, 'Esta cuenta no tiene ficha de alumno')

    const studentResult = await pool.query<{
      id_alumno: string
      nombre: string
      numero_matricula: string
      correo_electronico: string | null
      fecha_nacimiento: string | null
      fecha_ingreso: string
      activo: boolean
      es_instructor: boolean
      id_grado: string
      grado_nombre: string
      color_cinturon: string
      orden_grado: number
      formas_requeridas: number
    }>(`
      SELECT a.id_alumno::text, a.nombre, a.numero_matricula, a.correo_electronico,
             to_char(a.fecha_nacimiento, 'YYYY-MM-DD') AS fecha_nacimiento,
             to_char(a.fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso,
             a.activo, a.es_instructor,
             g.id_grado::text, g.nombre AS grado_nombre, g.color_cinturon, g.orden_grado, g.formas_requeridas
      FROM alumnos a
      JOIN grados g ON g.id_grado = a.id_grado
      WHERE a.id_alumno = $1
    `, [user.studentId])
    const student = studentResult.rows[0]
    if (!student) throw new ApiError(404, 'Esta cuenta no tiene ficha de alumno')

    const [knownForms, gradeForms, instructor] = await Promise.all([
      pool.query<{ id_forma: string; nombre: string; descripcion: string | null; estilo: string; fecha_aprendida: string }>(`
        SELECT f.id_forma::text, f.nombre, f.descripcion, e.nombre AS estilo,
               to_char(af.fecha_aprendida, 'YYYY-MM-DD') AS fecha_aprendida
        FROM alumno_forma af
        JOIN formas f ON f.id_forma = af.id_forma
        JOIN estilos e ON e.id_estilo = f.id_estilo
        WHERE af.id_alumno = $1
        ORDER BY e.nombre, af.fecha_aprendida, f.nombre
      `, [user.studentId]),
      pool.query<{
        id_forma: string
        nombre: string
        descripcion: string | null
        estilo: string
        es_opcional: boolean
        sabida: boolean
        porcentaje: number | null
        fecha_actualizacion: string | null
      }>(`
        SELECT f.id_forma::text, f.nombre, f.descripcion, e.nombre AS estilo, gf.es_opcional,
               EXISTS (SELECT 1 FROM alumno_forma af WHERE af.id_alumno = $1 AND af.id_forma = f.id_forma) AS sabida,
               p.porcentaje, to_char(p.fecha_actualizacion, 'YYYY-MM-DD') AS fecha_actualizacion
        FROM grado_forma gf
        JOIN formas f ON f.id_forma = gf.id_forma
        JOIN estilos e ON e.id_estilo = f.id_estilo
        LEFT JOIN alumno_forma_progreso p ON p.id_alumno = $1 AND p.id_forma = f.id_forma
        WHERE gf.id_grado = $2
        ORDER BY gf.es_opcional, e.nombre, f.nombre
      `, [user.studentId, student.id_grado]),
      pool.query<{ id_instructor: string; especialidad: string | null; fecha_contratacion: string | null; activo: boolean; estilos: string[] }>(`
        SELECT i.id_instructor::text, i.especialidad,
               to_char(i.fecha_contratacion, 'YYYY-MM-DD') AS fecha_contratacion, i.activo,
               COALESCE(array_agg(e.nombre ORDER BY e.nombre) FILTER (WHERE e.id_estilo IS NOT NULL), '{}') AS estilos
        FROM instructores i
        LEFT JOIN instructor_estilo ie ON ie.id_instructor = i.id_instructor
        LEFT JOIN estilos e ON e.id_estilo = ie.id_estilo
        WHERE i.id_alumno = $1
        GROUP BY i.id_instructor
      `, [user.studentId]),
    ])
    const instructorRow = instructor.rows[0]

    return {
      student: {
        id: Number(student.id_alumno),
        name: student.nombre,
        enrollmentNumber: student.numero_matricula,
        email: student.correo_electronico,
        birthDate: student.fecha_nacimiento,
        joinedOn: student.fecha_ingreso,
        active: student.activo,
        isInstructor: student.es_instructor,
      },
      grade: {
        id: Number(student.id_grado),
        name: student.grado_nombre,
        beltColor: student.color_cinturon,
        order: student.orden_grado,
        requiredForms: student.formas_requeridas,
      },
      knownForms: knownForms.rows.map((form) => ({
        id: Number(form.id_forma),
        name: form.nombre,
        description: form.descripcion,
        style: form.estilo,
        learnedOn: form.fecha_aprendida,
      })),
      gradeForms: gradeForms.rows.map((form) => ({
        id: Number(form.id_forma),
        name: form.nombre,
        description: form.descripcion,
        style: form.estilo,
        optional: form.es_opcional,
        known: form.sabida,
        learning: !form.sabida && form.porcentaje !== null
          ? { percent: Number(form.porcentaje), updatedOn: form.fecha_actualizacion }
          : null,
      })),
      instructor: instructorRow ? {
        id: Number(instructorRow.id_instructor),
        specialty: instructorRow.especialidad,
        hiredOn: instructorRow.fecha_contratacion,
        active: instructorRow.activo,
        styles: instructorRow.estilos,
      } : null,
    }
  })

  // El alumno marca una forma de su grado como "aprendiendo" y su avance; la forma sabida la registra la administración.
  app.put<{ Params: { formId: string }; Body: unknown }>('/forms/:formId/progress', writeLimit, async (request) => {
    const studentId = requireStudentId(request)
    const id = parseFormId(request.params.formId)
    const parsed = progressInput.safeParse(request.body ?? {})
    if (!parsed.success) throw new ApiError(400, 'El avance debe ser un número entero entre 0 y 100.')

    const form = await pool.query<{ sabida: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM alumno_forma af WHERE af.id_alumno = $1 AND af.id_forma = gf.id_forma) AS sabida
      FROM alumnos a
      JOIN grado_forma gf ON gf.id_grado = a.id_grado AND gf.id_forma = $2
      WHERE a.id_alumno = $1
    `, [studentId, id])
    if (!form.rows[0]) throw new ApiError(404, 'Esa forma no pertenece a tu grado.')
    if (form.rows[0].sabida) throw new ApiError(409, 'Esa forma ya figura como sabida en tu ficha.')

    const result = await pool.query<{ porcentaje: number; fecha_actualizacion: string }>(`
      INSERT INTO alumno_forma_progreso (id_alumno, id_forma, porcentaje)
      VALUES ($1, $2, $3)
      ON CONFLICT (id_alumno, id_forma)
      DO UPDATE SET porcentaje = EXCLUDED.porcentaje, fecha_actualizacion = CURRENT_TIMESTAMP
      RETURNING porcentaje, to_char(fecha_actualizacion, 'YYYY-MM-DD') AS fecha_actualizacion
    `, [studentId, id, parsed.data.percent])
    const row = result.rows[0]!
    return { formId: id, percent: Number(row.porcentaje), updatedOn: row.fecha_actualizacion }
  })

  app.delete<{ Params: { formId: string } }>('/forms/:formId/progress', writeLimit, async (request) => {
    const studentId = requireStudentId(request)
    const id = parseFormId(request.params.formId)
    const result = await pool.query('DELETE FROM alumno_forma_progreso WHERE id_alumno = $1 AND id_forma = $2', [studentId, id])
    if (!result.rowCount) throw new ApiError(404, 'No estabas aprendiendo esa forma.')
    return { formId: id, removed: true }
  })
}