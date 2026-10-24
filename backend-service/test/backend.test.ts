import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import pg from 'pg'

import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { createPool } from '../src/db/pool.js'
import { migrateDatabase } from '../src/db/migrate.js'

const { Client } = pg
const testDatabaseMarker = 'kungfu-node-backend-test:v1'
const testDatabaseName = `kungfu_node_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
const localHosts = new Set(['localhost', '127.0.0.1', '::1'])

let adminUrl!: URL
let pool!: ReturnType<typeof createPool>
let app!: Awaited<ReturnType<typeof createApp>>
let ids: { admin: number; instructor: number; instructorStudent: number; student: number; grade: number; habitualCourse: number; specialCourse: number; secondInstructor: number; primaryRoom: number; secondRoom: number; style: number }

function quoteDatabaseName(name: string) {
  if (!/^kungfu_node_test_\d+_[a-f0-9]+$/u.test(name)) throw new Error('Refusing to touch a database outside the backend test naming scheme.')
  return `"${name}"`
}

function makeAdminUrl() {
  const explicit = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
  if (explicit) {
    const url = new URL(explicit)
    if (!localHosts.has(url.hostname)) throw new Error('Backend integration tests only run against a local PostgreSQL server.')
    url.pathname = '/postgres'
    return url
  }
  if (!localHosts.has(config.databaseHost)) throw new Error('Backend integration tests only run against a local PostgreSQL server.')
  const password = config.databasePassword ? `:${encodeURIComponent(config.databasePassword)}` : ''
  return new URL(`postgresql://${encodeURIComponent(config.databaseUser)}${password}@${config.databaseHost}:${config.databasePort}/postgres`)
}

async function withAdminClient<T>(callback: (client: InstanceType<typeof Client>) => Promise<T>) {
  if (!adminUrl) throw new Error('Test PostgreSQL admin URL has not been initialized.')
  const client = new Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    return await callback(client)
  } finally {
    await client.end()
  }
}

async function seedAccountsAndCourses() {
  if (!pool) throw new Error('Test database pool has not been initialized.')
  const grade = await pool.query<{ id_grado: number }>(`
    INSERT INTO grados (nombre, orden_grado, color_cinturon, formas_requeridas)
    VALUES ('Test cintura', 101, 'Negro', 0)
    RETURNING id_grado
  `)
  const passwordHash = await bcrypt.hash('test-password-123', 4)
  const admin = await pool.query<{ id_administrador: number }>(`
    INSERT INTO administradores (nombre, fecha_inicio, correo_electronico, password_hash)
    VALUES ('Admin test', CURRENT_DATE, 'admin@test.invalid', $1)
    RETURNING id_administrador
  `, [passwordHash])
  const instructorAccount = async (matricula: string, email: string, nombre: string) => {
    const account = await pool.query<{ id_alumno: number }>(`
      INSERT INTO alumnos (numero_matricula, fecha_ingreso, activo, id_grado, correo_electronico, password_hash, nombre, es_instructor)
      VALUES ($1, CURRENT_DATE, TRUE, $2, $3, $4, $5, TRUE)
      RETURNING id_alumno
    `, [matricula, grade.rows[0]!.id_grado, email, passwordHash, nombre])
    const linked = await pool.query<{ id_instructor: number }>(
      `UPDATE instructores SET especialidad = 'Prueba' WHERE id_alumno = $1 RETURNING id_instructor`,
      [account.rows[0]!.id_alumno],
    )
    return { studentId: Number(account.rows[0]!.id_alumno), instructorId: Number(linked.rows[0]!.id_instructor) }
  }
  const instructor = await instructorAccount('TEST-INS-1', 'instructor@test.invalid', 'Instructor test')
  const secondInstructor = await instructorAccount('TEST-INS-2', 'instructor2@test.invalid', 'Instructor dos')
  const primaryRoom = await pool.query<{ id_sala: number }>(`
    INSERT INTO salas (nombre) VALUES ('Sala Principal') RETURNING id_sala
  `)
  const secondRoom = await pool.query<{ id_sala: number }>(`
    INSERT INTO salas (nombre) VALUES ('Sala Tatami') RETURNING id_sala
  `)
  const style = await pool.query<{ id_estilo: number }>(`
    INSERT INTO estilos (nombre, descripcion)
    VALUES ('Estilo test', 'Estilo para validar claves foráneas')
    RETURNING id_estilo
  `)
  const student = await pool.query<{ id_alumno: number }>(`
    INSERT INTO alumnos (numero_matricula, fecha_ingreso, activo, fecha_nacimiento, id_grado, correo_electronico, password_hash, nombre)
    VALUES ('TEST-001', CURRENT_DATE, TRUE, DATE '2000-01-01', $1, 'student@test.invalid', $2, 'Alumno test')
    RETURNING id_alumno
  `, [grade.rows[0]!.id_grado, passwordHash])
  const habitual = await pool.query<{ id_curso: number }>(`
    INSERT INTO cursos (nombre, tema, descripcion, tipo_curso)
    VALUES ('Clase habitual test', 'Técnica', 'Sesión recurrente', 'HABITUAL')
    RETURNING id_curso
  `)
  const special = await pool.query<{ id_curso: number }>(`
    INSERT INTO cursos (nombre, tema, descripcion, tipo_curso)
    VALUES ('Curso especial test', 'Especial', 'Curso de fin de semana', 'CURSO_ESPECIAL')
    RETURNING id_curso
  `)

  return {
    admin: Number(admin.rows[0]!.id_administrador),
    instructor: instructor.instructorId,
    instructorStudent: instructor.studentId,
    secondInstructor: secondInstructor.instructorId,
    grade: Number(grade.rows[0]!.id_grado),
    student: Number(student.rows[0]!.id_alumno),
    habitualCourse: Number(habitual.rows[0]!.id_curso),
    specialCourse: Number(special.rows[0]!.id_curso),
    primaryRoom: Number(primaryRoom.rows[0]!.id_sala),
    secondRoom: Number(secondRoom.rows[0]!.id_sala),
    style: Number(style.rows[0]!.id_estilo),
  }
}

let latestAdminCookie: string | undefined

async function login(email: string, password = 'test-password-123') {
  if (!app) throw new Error('Test server has not been initialized.')
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  })
  const cookie = response.headers['set-cookie']?.toString().split(';')[0]
  if (email === 'admin@test.invalid' && response.statusCode === 200) latestAdminCookie = cookie
  return { response, cookie }
}

function authHeaders(cookie: string | undefined) {
  return cookie ? { cookie } : {}
}

beforeAll(async () => {
  adminUrl = makeAdminUrl()
  await withAdminClient(async (client) => {
    await client.query(`CREATE DATABASE ${quoteDatabaseName(testDatabaseName)}`)
    await client.query(`COMMENT ON DATABASE ${quoteDatabaseName(testDatabaseName)} IS '${testDatabaseMarker}'`)
  })

  const databaseUrl = new URL(adminUrl)
  databaseUrl.pathname = `/${testDatabaseName}`
  pool = createPool(databaseUrl.toString())
  await migrateDatabase(pool)
  ids = await seedAccountsAndCourses()
  app = await createApp({ pool, runMigrations: false })
  await app.ready()
}, 30_000)

afterAll(async () => {
  if (app) await app.close()
  else if (pool) await pool.end()
  if (adminUrl) {
    await withAdminClient(async (client) => {
      const marker = await client.query<{ description: string | null }>(`
        SELECT shobj_description(oid, 'pg_database') AS description
        FROM pg_database WHERE datname = $1
      `, [testDatabaseName])
      if (marker.rows[0]?.description !== testDatabaseMarker) return
      await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [testDatabaseName])
      await client.query(`DROP DATABASE ${quoteDatabaseName(testDatabaseName)}`)
    })
  }
}, 30_000)

describe('auth and backwards-compatible database API', () => {
  it('keeps the login, session and logout contract', async () => {
    const { response, cookie } = await login('admin@test.invalid')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ authenticated: true, role: 'ADMIN', userId: ids.admin })
    expect(cookie).toBeTruthy()

    const me = await app.inject({ url: '/api/auth/me', headers: authHeaders(cookie) })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ role: 'ADMIN', displayName: 'Admin test' })

    const logout = await app.inject({ method: 'DELETE', url: '/api/auth/logout', headers: authHeaders(cookie) })
    expect(logout.statusCode).toBe(200)
    expect(logout.json()).toEqual({ authenticated: false })
    const afterLogout = await app.inject({ url: '/api/auth/me', headers: authHeaders(cookie) })
    expect(afterLogout.statusCode).toBe(401)
  })

  it('distinguishes instructor and student roles at login', async () => {
    const teacher = await login('instructor@test.invalid')
    const student = await login('student@test.invalid')
    expect(teacher.response.json()).toMatchObject({
      role: 'INSTRUCTOR',
      userId: ids.instructorStudent,
      studentId: ids.instructorStudent,
      instructorId: ids.instructor,
    })
    expect(student.response.json()).toMatchObject({ role: 'USER', userId: ids.student, studentId: ids.student, instructorId: null })
  })

  it('derives instructor permissions from the student flag on every request', async () => {
    const { cookie: adminCookie } = await login('admin@test.invalid')
    const created = await app.inject({
      method: 'POST',
      url: '/api/database/tables/alumnos/rows',
      headers: authHeaders(adminCookie),
      payload: { numero_matricula: 'TEST-FLAG', fecha_ingreso: '2092-01-01', nombre: 'Toggle Ñandú', id_grado: ids.grade, correo_electronico: 'toggle@test.invalid' },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).not.toHaveProperty('password_hash')
    const studentId = Number(created.json().id_alumno)

    const { response, cookie } = await login('toggle@test.invalid', 'togglenandu')
    expect(response.json()).toMatchObject({ role: 'USER', instructorId: null })

    const promoted = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(adminCookie),
      payload: { es_instructor: true, password_hash: '' },
    })
    expect(promoted.statusCode).toBe(200)
    const me = await app.inject({ url: '/api/auth/me', headers: authHeaders(cookie) })
    expect(me.json()).toMatchObject({ role: 'INSTRUCTOR', studentId })
    const linked = await pool.query('SELECT id_instructor, nombre, activo FROM instructores WHERE id_alumno = $1', [studentId])
    expect(linked.rows[0]).toMatchObject({ nombre: 'Toggle Ñandú', activo: true })
    expect(Number(me.json().instructorId)).toBe(Number(linked.rows[0].id_instructor))
    expect((await login('toggle@test.invalid', 'togglenandu')).response.statusCode).toBe(200)

    const demoted = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(adminCookie),
      payload: { es_instructor: false },
    })
    expect(demoted.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/auth/me', headers: authHeaders(cookie) })).json()).toMatchObject({ role: 'USER', instructorId: null })
    const deactivated = await pool.query('SELECT activo FROM instructores WHERE id_alumno = $1', [studentId])
    expect(deactivated.rows[0].activo).toBe(false)

    await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(adminCookie),
      payload: { activo: false },
    })
    expect((await app.inject({ url: '/api/auth/me', headers: authHeaders(cookie) })).statusCode).toBe(401)
    expect((await login('toggle@test.invalid', 'togglenandu')).response.statusCode).toBe(401)
  })

  it('lets only the admin change student passwords', async () => {
    const { cookie: adminCookie } = await login('admin@test.invalid')
    const created = await app.inject({
      method: 'POST',
      url: '/api/database/tables/alumnos/rows',
      headers: authHeaders(adminCookie),
      payload: { numero_matricula: 'TEST-PWD', fecha_ingreso: '2092-01-01', nombre: 'José Pérez', id_grado: ids.grade, correo_electronico: 'pwd@test.invalid' },
    })
    const studentId = created.json().id_alumno
    expect((await login('pwd@test.invalid', 'joseperez')).response.statusCode).toBe(200)

    const tooShort = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(adminCookie),
      payload: { password_hash: 'corta' },
    })
    expect(tooShort.statusCode).toBe(400)

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(adminCookie),
      payload: { password_hash: 'nueva-clave-1' },
    })
    expect(changed.statusCode).toBe(200)
    expect((await login('pwd@test.invalid', 'joseperez')).response.statusCode).toBe(401)
    expect((await login('pwd@test.invalid', 'nueva-clave-1')).response.statusCode).toBe(200)

    const { cookie: instructorCookie } = await login('instructor@test.invalid')
    const byInstructor = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(instructorCookie),
      payload: { password_hash: 'instructor-clave' },
    })
    expect(byInstructor.statusCode).toBe(403)
    const createdByInstructor = await app.inject({
      method: 'POST',
      url: '/api/database/tables/alumnos/rows',
      headers: authHeaders(instructorCookie),
      payload: { numero_matricula: 'TEST-NO', fecha_ingreso: '2092-01-01', nombre: 'No permitido', id_grado: ids.grade },
    })
    expect(createdByInstructor.statusCode).toBe(403)
  })

  it('limits repeated login attempts per IP and account', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.10',
        payload: { email: 'limited@test.invalid', password: 'wrong-password' },
      })
      expect(response.statusCode).toBe(401)
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.10',
      payload: { email: 'limited@test.invalid', password: 'wrong-password' },
    })
    expect(limited.statusCode).toBe(429)
  })

  it('limits unauthenticated access and retains table metadata/CRUD for admins', async () => {
    expect((await app.inject({ url: '/api/database/tables' })).statusCode).toBe(401)
    const { cookie } = await login('admin@test.invalid')
    const tables = await app.inject({ url: '/api/database/tables', headers: authHeaders(cookie) })
    expect(tables.statusCode).toBe(200)
    expect(tables.json()).toContain('cursos')
    expect(tables.json()).toContain('salas')
    expect(tables.json()).toContain('horarios_recurrentes')
    expect(tables.json()).not.toContain('node_schema_history')
    expect((await app.inject({ method: 'POST', url: '/api/database/migrate', headers: authHeaders(cookie) })).statusCode).toBe(404)

    const metadata = await app.inject({ url: '/api/database/tables/cursos/columns', headers: authHeaders(cookie) })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tipo_curso' }),
    ]))

    const scheduleMetadata = await app.inject({ url: '/api/database/tables/cursos_agendados/columns', headers: authHeaders(cookie) })
    expect(scheduleMetadata.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id_curso', foreignKey: { tableName: 'cursos', columnName: 'id_curso' } }),
      expect.objectContaining({ name: 'id_sala', foreignKey: { tableName: 'salas', columnName: 'id_sala' } }),
    ]))

    const inserted = await app.inject({
      method: 'POST',
      url: '/api/database/tables/cursos/rows',
      headers: authHeaders(cookie),
      payload: { nombre: 'Curso CRUD', tema: 'Técnica', descripcion: 'Compatibilidad' },
    })
    expect(inserted.statusCode).toBe(200)
    expect(inserted.json()).toMatchObject({ nombre: 'Curso CRUD', tipo_curso: 'HABITUAL' })
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/cursos/rows/${inserted.json().id_curso}`,
      headers: authHeaders(cookie),
      payload: { nombre: 'Curso CRUD editado' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().nombre).toBe('Curso CRUD editado')

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/database/tables/cursos/rows/${inserted.json().id_curso}`,
      headers: authHeaders(cookie),
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ deleted: true })

    const composite = await app.inject({
      method: 'POST',
      url: '/api/database/tables/instructor_estilo/rows',
      headers: authHeaders(cookie),
      payload: { id_instructor: ids.instructor, id_estilo: ids.style },
    })
    expect(composite.statusCode).toBe(200)
    expect(Number(composite.json().id_instructor)).toBe(ids.instructor)
    const compositeDelete = await app.inject({
      method: 'DELETE',
      url: `/api/database/tables/instructor_estilo/rows/${ids.instructor},${ids.style}`,
      headers: authHeaders(cookie),
    })
    expect(compositeDelete.statusCode).toBe(200)
    expect(compositeDelete.json()).toEqual({ deleted: true })

    const genericRule = await app.inject({
      method: 'POST',
      url: '/api/database/tables/horarios_recurrentes/rows',
      headers: authHeaders(cookie),
      payload: {
        id_curso: ids.habitualCourse,
        id_instructor: ids.instructor,
        id_sala: ids.primaryRoom,
        dia_semana: 2,
        hora_inicio: '12:00',
        hora_fin: '13:00',
        fecha_inicio: '2092-12-01',
      },
    })
    expect(genericRule.statusCode).toBe(200)
    expect(Number(genericRule.json().id_sala)).toBe(ids.primaryRoom)
    const genericRuleId = genericRule.json().id_horario_recurrente
    const updatedRule = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/horarios_recurrentes/rows/${genericRuleId}`,
      headers: authHeaders(cookie),
      payload: { hora_inicio: '13:30', hora_fin: '14:30' },
    })
    expect(updatedRule.statusCode).toBe(200)
    expect(updatedRule.json().hora_inicio).toMatch(/^13:30/u)
    const cancelledRule = await app.inject({
      method: 'DELETE',
      url: `/api/database/tables/horarios_recurrentes/rows/${genericRuleId}`,
      headers: authHeaders(cookie),
    })
    expect(cancelledRule.statusCode).toBe(200)
    expect(cancelledRule.json()).toEqual({ deleted: true })
    const persistedRule = await pool.query('SELECT activo FROM horarios_recurrentes WHERE id_horario_recurrente = $1', [genericRuleId])
    expect(persistedRule.rows[0].activo).toBe(false)

    const special = await app.inject({
      method: 'POST',
      url: '/api/database/tables/cursos/rows',
      headers: authHeaders(cookie),
      payload: { nombre: 'Taller de verano', tema: 'Especialización', descripcion: 'Curso puntual' },
    })
    expect(special.statusCode).toBe(200)
    expect(special.json().tipo_curso).toBe('CURSO_ESPECIAL')

    const legacySchedule = await app.inject({
      method: 'POST',
      url: '/api/database/tables/cursos_agendados/rows',
      headers: authHeaders(cookie),
      payload: {
        id_curso: ids.habitualCourse,
        id_instructor: ids.instructor,
        fecha_hora: '2092-10-01T10:00:00',
        activo: true,
      },
    })
    expect(legacySchedule.statusCode).toBe(200)
    expect(legacySchedule.json().fecha_hora_fin).toBe('2092-10-01T11:30:00')
    expect(Number(legacySchedule.json().id_sala)).toBe(ids.primaryRoom)
  })

  it('keeps exactly one application administrator account', async () => {
    const { cookie } = await login('admin@test.invalid')
    const secondAdmin = await app.inject({
      method: 'POST',
      url: '/api/database/tables/administradores/rows',
      headers: authHeaders(cookie),
      payload: { nombre: 'Segundo admin', correo_electronico: 'admin2@test.invalid', password_hash: 'another-test-password' },
    })
    expect(secondAdmin.statusCode).toBe(409)

    const deleteLastAdmin = await app.inject({
      method: 'DELETE',
      url: `/api/database/tables/administradores/rows/${ids.admin}`,
      headers: authHeaders(cookie),
    })
    expect(deleteLastAdmin.statusCode).toBe(409)

    const existingHash = await pool.query<{ password_hash: string }>('SELECT password_hash FROM administradores WHERE id_administrador = $1', [ids.admin])
    await expect(pool.query(`
      INSERT INTO administradores (nombre, fecha_inicio, correo_electronico, password_hash)
      VALUES ('Segundo admin', CURRENT_DATE, 'admin2@test.invalid', $1)
    `, [existingHash.rows[0]!.password_hash])).rejects.toMatchObject({ code: '23505' })
  })

  it('blocks student writes to generic tables and their access to admin data', async () => {
    const { cookie } = await login('student@test.invalid')
    const admins = await app.inject({ url: '/api/database/tables/administradores/rows', headers: authHeaders(cookie) })
    const students = await app.inject({ url: '/api/database/tables/alumnos/rows', headers: authHeaders(cookie) })
    const insert = await app.inject({
      method: 'POST',
      url: '/api/database/tables/cursos/rows',
      headers: authHeaders(cookie),
      payload: { nombre: 'No autorizado', tema: 'X' },
    })
    expect(admins.statusCode).toBe(403)
    expect(students.statusCode).toBe(403)
    expect(insert.statusCode).toBe(403)
    expect((await app.inject({
      url: '/api/calendar/events?from=2092-10-01T00:00&to=2092-10-02T00:00',
      headers: authHeaders(cookie),
    })).statusCode).toBe(200)
  })

  it('keeps generic school data admin-only and exposes only calendar-safe instructor details', async () => {
    const { cookie } = await login('instructor@test.invalid')
    const tables = await app.inject({ url: '/api/database/tables', headers: authHeaders(cookie) })
    expect(tables.statusCode).toBe(403)
    const students = await app.inject({
      url: '/api/database/tables/alumnos/rows?limit=1',
      headers: authHeaders(cookie),
    })
    expect(students.statusCode).toBe(403)
    const instructors = await app.inject({ url: '/api/calendar/instructors', headers: authHeaders(cookie) })
    expect(instructors.statusCode).toBe(200)
    expect(instructors.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id_instructor: String(ids.instructor), nombre: 'Instructor test', activo: true }),
    ]))
    expect(instructors.json()[0]).not.toHaveProperty('correo_electronico')
    expect(instructors.json()[0]).not.toHaveProperty('password_hash')
  })

  it('shows students and instructors only their own profile and known forms', async () => {
    const forms = await pool.query<{ id_forma: number }>(`
      INSERT INTO formas (id_estilo, nombre, descripcion)
      VALUES ($1, 'Forma perfil sabida', 'Primera forma'), ($1, 'Forma perfil pendiente', NULL)
      RETURNING id_forma
    `, [ids.style])
    const [knownForm, pendingForm] = forms.rows.map((row) => Number(row.id_forma))
    await pool.query(`INSERT INTO alumno_forma (id_alumno, id_forma, fecha_aprendida) VALUES ($1, $2, DATE '2091-03-04')`, [ids.student, knownForm])
    await pool.query(`INSERT INTO grado_forma (id_grado, id_forma, es_opcional) VALUES ($1, $2, FALSE), ($1, $3, TRUE)`, [ids.grade, knownForm, pendingForm])

    expect((await app.inject({ url: '/api/me/profile' })).statusCode).toBe(401)

    const { cookie: adminCookie } = await login('admin@test.invalid')
    const adminKnownForms = await app.inject({
      url: `/api/database/students/${ids.student}/known-forms`,
      headers: authHeaders(adminCookie),
    })
    expect(adminKnownForms.statusCode).toBe(200)

    const { cookie: studentCookie } = await login('student@test.invalid')
    const studentProfile = await app.inject({ url: '/api/me/profile?id=1', headers: authHeaders(studentCookie) })
    expect(studentProfile.statusCode).toBe(200)
    const body = studentProfile.json()
    expect(body.student).toMatchObject({ id: ids.student, name: 'Alumno test', birthDate: '2000-01-01', isInstructor: false })
    expect(body.student).not.toHaveProperty('password_hash')
    expect(body.grade).toMatchObject({ id: ids.grade, name: 'Test cintura' })
    expect(body.knownForms).toEqual([
      { id: knownForm, name: 'Forma perfil sabida', description: 'Primera forma', style: 'Estilo test', learnedOn: '2091-03-04' },
    ])
    expect(adminKnownForms.json()).toHaveLength(body.knownForms.length)
    expect(adminKnownForms.json().map((form: { id_forma: string }) => Number(form.id_forma)))
      .toEqual(body.knownForms.map((form: { id: number }) => form.id))
    expect(body.gradeForms).toEqual([
      expect.objectContaining({ id: knownForm, optional: false, known: true }),
      expect.objectContaining({ id: pendingForm, optional: true, known: false }),
    ])
    expect(body.instructor).toBeNull()

    const { cookie: instructorCookie } = await login('instructor2@test.invalid')
    const instructorProfile = await app.inject({ url: '/api/me/profile', headers: authHeaders(instructorCookie) })
    expect(instructorProfile.statusCode).toBe(200)
    expect(instructorProfile.json().student.name).toBe('Instructor dos')
    expect(instructorProfile.json().knownForms).toEqual([])
    expect(instructorProfile.json().instructor).toMatchObject({ id: ids.secondInstructor, specialty: 'Prueba', active: true })
    expect((await app.inject({
      url: `/api/database/students/${ids.student}/known-forms`,
      headers: authHeaders(instructorCookie),
    })).statusCode).toBe(403)

    // El alumno marca las formas de su grado que está aprendiendo y su avance.
    const otherForm = Number((await pool.query<{ id_forma: number }>(`
      INSERT INTO formas (id_estilo, nombre) VALUES ($1, 'Forma de otro grado') RETURNING id_forma
    `, [ids.style])).rows[0]!.id_forma)
    const progress = (id: number | undefined, payload: unknown) => app.inject({
      method: 'PUT', url: `/api/me/forms/${id}/progress`, headers: authHeaders(studentCookie), payload: payload as object,
    })
    expect((await app.inject({ method: 'PUT', url: `/api/me/forms/${pendingForm}/progress`, payload: { percent: 40 } })).statusCode).toBe(401)
    expect((await progress(pendingForm, { percent: 140 })).statusCode).toBe(400)
    expect((await progress(otherForm, { percent: 10 })).statusCode).toBe(404)
    expect((await progress(knownForm, { percent: 10 })).statusCode).toBe(409)
    const saved = await progress(pendingForm, { percent: 40 })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ formId: pendingForm, percent: 40 })
    expect((await progress(pendingForm, { percent: 75 })).json().percent).toBe(75)
    const withProgress = (await app.inject({ url: '/api/me/profile', headers: authHeaders(studentCookie) })).json()
    expect(withProgress.gradeForms).toEqual([
      expect.objectContaining({ id: knownForm, known: true, learning: null }),
      expect.objectContaining({ id: pendingForm, known: false, learning: expect.objectContaining({ percent: 75 }) }),
    ])
    // Cada cuenta solo ve su propio avance.
    expect((await app.inject({ url: '/api/me/profile', headers: authHeaders(instructorCookie) })).json().gradeForms
      .every((form: { learning: unknown }) => form.learning === null)).toBe(true)

    const stopped = await app.inject({ method: 'DELETE', url: `/api/me/forms/${pendingForm}/progress`, headers: authHeaders(studentCookie) })
    expect(stopped.statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/me/forms/${pendingForm}/progress`, headers: authHeaders(studentCookie) })).statusCode).toBe(404)

    // Al registrarse como sabida, el avance desaparece.
    await progress(pendingForm, { percent: 90 })
    await pool.query(`INSERT INTO alumno_forma (id_alumno, id_forma, fecha_aprendida) VALUES ($1, $2, CURRENT_DATE)`, [ids.student, pendingForm])
    expect((await pool.query('SELECT count(*) FROM alumno_forma_progreso WHERE id_alumno = $1', [ids.student])).rows[0].count).toBe('0')
    await pool.query('DELETE FROM alumno_forma WHERE id_alumno = $1 AND id_forma = $2', [ids.student, pendingForm])
  })

  it('restricts self-service attendance rows to the authenticated student', async () => {
    const { cookie: adminCookie } = await login('admin@test.invalid')
    const event = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.habitualCourse,
        instructorId: ids.instructor,
        roomId: ids.primaryRoom,
        startAt: '2092-11-01T10:00',
        endAt: '2092-11-01T11:30',
      },
    })
    const { cookie } = await login('student@test.invalid')
    const attendance = await app.inject({
      method: 'POST',
      url: '/api/database/tables/asistencias_curso/rows',
      headers: authHeaders(cookie),
      payload: { id_curso_agendado: event.json().id_curso_agendado, id_alumno: ids.student },
    })
    expect(attendance.statusCode).toBe(200)

    const impersonation = await app.inject({
      method: 'POST',
      url: '/api/database/tables/asistencias_curso/rows',
      headers: authHeaders(cookie),
      payload: { id_curso_agendado: event.json().id_curso_agendado, id_alumno: ids.student + 1 },
    })
    expect(impersonation.statusCode).toBe(403)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/database/tables/asistencias_curso/rows/${attendance.json().id_asistencia}`,
      headers: authHeaders(cookie),
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ deleted: true })

    const { cookie: instructorCookie } = await login('instructor@test.invalid')
    const asStudent = await app.inject({
      method: 'POST',
      url: '/api/database/tables/asistencias_curso/rows',
      headers: authHeaders(instructorCookie),
      payload: { id_curso_agendado: event.json().id_curso_agendado, id_alumno: ids.instructorStudent },
    })
    expect(asStudent.statusCode).toBe(200)
    const asOtherInstructor = await app.inject({
      method: 'POST',
      url: '/api/database/tables/asistencias_curso/rows',
      headers: authHeaders(instructorCookie),
      payload: { id_curso_agendado: event.json().id_curso_agendado, id_instructor: ids.secondInstructor },
    })
    expect(asOtherInstructor.statusCode).toBe(403)
  })
})

describe('agenda API', () => {
  it('lets the teaching team manage rooms used by the calendar', async () => {
    expect((await app.inject({ url: '/api/calendar/rooms' })).statusCode).toBe(401)

    const { cookie: adminCookie } = await login('admin@test.invalid')
    const rooms = await app.inject({ url: '/api/calendar/rooms', headers: authHeaders(adminCookie) })
    expect(rooms.statusCode).toBe(200)
    expect(rooms.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id_sala: String(ids.primaryRoom), nombre: 'Sala Principal', activo: true }),
      expect.objectContaining({ id_sala: String(ids.secondRoom), nombre: 'Sala Tatami', activo: true }),
    ]))

    const created = await app.inject({
      method: 'POST',
      url: '/api/calendar/rooms',
      headers: authHeaders(adminCookie),
      payload: { nombre: 'Sala Auxiliar' },
    })
    expect(created.statusCode).toBe(201)
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/calendar/rooms',
      headers: authHeaders(adminCookie),
      payload: { nombre: ' sala auxiliar ' },
    })
    expect(duplicate.statusCode).toBe(409)

    const scheduled = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.instructor,
        roomId: created.json().id_sala,
        startAt: '2092-05-01T10:00',
        endAt: '2092-05-01T11:00',
      },
    })
    expect(scheduled.statusCode).toBe(201)

    const inUse = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/rooms/${created.json().id_sala}`,
      headers: authHeaders(adminCookie),
      payload: { activo: false },
    })
    expect(inUse.statusCode).toBe(409)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/calendar/events/${scheduled.json().id_curso_agendado}/cancel`,
      headers: authHeaders(adminCookie),
    })
    expect(cancelled.statusCode).toBe(200)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/rooms/${created.json().id_sala}`,
      headers: authHeaders(adminCookie),
      payload: { activo: false },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ activo: false })

    const { cookie: instructorCookie } = await login('instructor@test.invalid')
    const instructorRoom = await app.inject({
      method: 'POST',
      url: '/api/calendar/rooms',
      headers: authHeaders(instructorCookie),
      payload: { nombre: 'Sala del instructor' },
    })
    expect(instructorRoom.statusCode).toBe(403)
    const renamedByInstructor = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/rooms/${created.json().id_sala}`,
      headers: authHeaders(instructorCookie),
      payload: { nombre: 'Sala compartida' },
    })
    expect(renamedByInstructor.statusCode).toBe(403)
  })

  it('keeps course definitions admin-only', async () => {
    const { cookie } = await login('admin@test.invalid')
    const created = await app.inject({
      method: 'POST',
      url: '/api/calendar/courses',
      headers: authHeaders(cookie),
      payload: { nombre: 'Seminario especial', tema: 'Especialización', descripcion: 'Finde de prueba', tipo_curso: 'CURSO_ESPECIAL' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ tipo_curso: 'CURSO_ESPECIAL', nombre: 'Seminario especial' })

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/courses/${created.json().id_curso}`,
      headers: authHeaders(cookie),
      payload: { nombre: 'Seminario especial actualizado' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().nombre).toBe('Seminario especial actualizado')

    const { cookie: instructorCookie } = await login('instructor@test.invalid')
    const byInstructor = await app.inject({
      method: 'POST',
      url: '/api/calendar/courses',
      headers: authHeaders(instructorCookie),
      payload: { nombre: 'Curso del instructor', tema: 'X', tipo_curso: 'HABITUAL' },
    })
    expect(byInstructor.statusCode).toBe(403)
    const editedByInstructor = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/courses/${created.json().id_curso}`,
      headers: authHeaders(instructorCookie),
      payload: { nombre: 'Cambio no permitido' },
    })
    expect(editedByInstructor.statusCode).toBe(403)

    const { cookie: studentCookie } = await login('student@test.invalid')
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/calendar/courses',
      headers: authHeaders(studentCookie),
      payload: { nombre: 'No autorizado', tema: 'Especial', tipo_curso: 'CURSO_ESPECIAL' },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('creates a multi-day special course with start and end instants', async () => {
    const { cookie } = await login('admin@test.invalid')
    const created = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.instructor,
        roomId: ids.primaryRoom,
        startAt: '2092-06-14T10:00',
        endAt: '2092-06-15T17:00',
      },
    })
    expect(created.statusCode).toBe(201)

    const list = await app.inject({
      url: '/api/calendar/events?from=2092-06-14T00:00&to=2092-06-16T00:00',
      headers: authHeaders(cookie),
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id_curso_agendado: created.json().id_curso_agendado,
        id_sala: String(ids.primaryRoom),
        sala_nombre: 'Sala Principal',
        tipo_curso: 'CURSO_ESPECIAL',
        fecha_hora: '2092-06-14T10:00:00',
        fecha_hora_fin: '2092-06-15T17:00:00',
        activo: true,
      }),
    ]))
  })

  it('prevents overlapping events, allows adjacent events, and cancels without deleting', async () => {
    const { cookie } = await login('instructor@test.invalid')
    const first = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.habitualCourse,
        instructorId: ids.instructor,
        roomId: ids.primaryRoom,
        startAt: '2092-07-01T10:00',
        endAt: '2092-07-01T11:30',
      },
    })
    expect(first.statusCode).toBe(201)

    const overlap = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.secondInstructor,
        roomId: ids.primaryRoom,
        startAt: '2092-07-01T11:00',
        endAt: '2092-07-01T12:00',
      },
    })
    expect(overlap.statusCode).toBe(409)

    const parallel = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.secondInstructor,
        roomId: ids.secondRoom,
        startAt: '2092-07-01T10:00',
        endAt: '2092-07-01T11:30',
      },
    })
    expect(parallel.statusCode).toBe(201)

    const adjacent = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.secondInstructor,
        roomId: ids.primaryRoom,
        startAt: '2092-07-01T11:30',
        endAt: '2092-07-01T12:30',
      },
    })
    expect(adjacent.statusCode).toBe(201)

    const roomFiltered = await app.inject({
      url: `/api/calendar/events?from=2092-07-01T00:00&to=2092-07-02T00:00&roomId=${ids.secondRoom}`,
      headers: authHeaders(cookie),
    })
    expect(roomFiltered.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id_curso_agendado: parallel.json().id_curso_agendado, id_sala: String(ids.secondRoom) }),
    ]))
    expect(roomFiltered.json()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id_curso_agendado: first.json().id_curso_agendado }),
    ]))

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/calendar/events/${first.json().id_curso_agendado}/cancel`,
      headers: authHeaders(cookie),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json()).toMatchObject({ activo: false })
    const saved = await pool.query('SELECT activo FROM cursos_agendados WHERE id_curso_agendado = $1', [first.json().id_curso_agendado])
    expect(saved.rows[0].activo).toBe(false)
    const calendar = await app.inject({
      url: '/api/calendar/events?from=2092-07-01T00:00&to=2092-07-02T00:00',
      headers: authHeaders(cookie),
    })
    expect(calendar.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id_curso_agendado: first.json().id_curso_agendado, activo: false }),
    ]))
  })

  it('materializes habitual weekly rules, supports moving occurrences and cancelling a rule', async () => {
    const { cookie } = await login('instructor@test.invalid')
    const rule = await app.inject({
      method: 'POST',
      url: '/api/calendar/recurring-rules',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.habitualCourse,
        instructorId: ids.instructor,
        roomId: ids.primaryRoom,
        weekdays: [1, 3],
        startTime: '09:30',
        endTime: '11:00',
        startsOn: '2092-08-01',
        endsOn: '2092-08-31',
      },
    })
    expect(rule.statusCode).toBe(201)
    expect(rule.json().occurrencesCreated).toBeGreaterThan(0)

    const events = await app.inject({
      url: '/api/calendar/events?from=2092-08-01T00:00&to=2092-08-31T23:59',
      headers: authHeaders(cookie),
    })
    const generated = events.json().filter((event: { id_horario_recurrente: number }) =>
      event.id_horario_recurrente === rule.json().rules[0].id_horario_recurrente ||
      event.id_horario_recurrente === rule.json().rules[1].id_horario_recurrente)
    expect(generated.length).toBeGreaterThan(4)
    expect(generated.every((event: { fecha_hora_fin: string }) => event.fecha_hora_fin.endsWith('11:00:00'))).toBe(true)

    const target = generated[0]
    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/events/${target.id_curso_agendado}`,
      headers: authHeaders(cookie),
      payload: { startAt: '2092-08-02T12:00', endAt: '2092-08-02T13:30' },
    })
    expect(moved.statusCode).toBe(200)

    const adjustedRule = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/recurring-rules/${rule.json().rules[1].id_horario_recurrente}`,
      headers: authHeaders(cookie),
      payload: { roomId: ids.secondRoom, startTime: '10:00', endTime: '11:30' },
    })
    expect(adjustedRule.statusCode).toBe(200)
    const adjustedEvents = await app.inject({
      url: '/api/calendar/events?from=2092-08-01T00:00&to=2092-08-31T23:59',
      headers: authHeaders(cookie),
    })
    const adjustedRuleEvents = adjustedEvents.json().filter((event: { id_horario_recurrente: number; modificado_manualmente: boolean; id_sala: number }) =>
      event.id_horario_recurrente === rule.json().rules[1].id_horario_recurrente && !event.modificado_manualmente)
    expect(adjustedRuleEvents.length).toBeGreaterThan(0)
    expect(adjustedRuleEvents.every((event: { fecha_hora: string; fecha_hora_fin: string }) =>
      event.fecha_hora.endsWith('10:00:00') && event.fecha_hora_fin.endsWith('11:30:00'))).toBe(true)
    expect(adjustedRuleEvents.every((event: { id_sala: string }) => Number(event.id_sala) === ids.secondRoom)).toBe(true)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/calendar/recurring-rules/${rule.json().rules[0].id_horario_recurrente}/cancel`,
      headers: authHeaders(cookie),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().activo).toBe(false)
  })

  it('rejects student writes and invalid event intervals', async () => {
    const { cookie } = await login('student@test.invalid')
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(cookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.instructor,
        roomId: ids.primaryRoom,
        startAt: '2092-09-01T11:00',
        endAt: '2092-09-01T10:00',
      },
    })
    expect(forbidden.statusCode).toBe(403)

    const { cookie: adminCookie } = await login('admin@test.invalid')
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/calendar/events',
      headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.specialCourse,
        instructorId: ids.instructor,
        roomId: ids.primaryRoom,
        startAt: '2092-09-01T11:00',
        endAt: '2092-09-01T10:00',
      },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('manages event participants, capacity, series sign-ups and attendee visibility', async () => {
    // El administrador ya agotó sus intentos de login en esta ventana; se reutiliza su última sesión.
    const adminCookie = latestAdminCookie
    expect(adminCookie).toBeDefined()
    const passwordHash = await bcrypt.hash('test-password-123', 4)
    for (const [index, email] of ['part.a@test.invalid', 'part.b@test.invalid'].entries()) {
      await pool.query(`
        INSERT INTO alumnos (numero_matricula, fecha_ingreso, activo, id_grado, correo_electronico, password_hash, nombre)
        VALUES ($1, CURRENT_DATE, TRUE, $2, $3, $4, $5)
      `, [`TEST-PART-${index}`, ids.grade, email, passwordHash, `Participante ${index === 0 ? 'A' : 'B'}`])
    }
    const { cookie: aCookie } = await login('part.a@test.invalid')
    const { cookie: bCookie } = await login('part.b@test.invalid')
    const { cookie: instructorCookie } = await login('instructor2@test.invalid')
    const join = (cookie: string | undefined, eventId: number, payload: object) => app.inject({
      method: 'POST', url: `/api/calendar/events/${eventId}/participation`, headers: authHeaders(cookie), payload,
    })
    const leave = (cookie: string | undefined, eventId: number, scope: string) => app.inject({
      method: 'DELETE', url: `/api/calendar/events/${eventId}/participation?scope=${scope}`, headers: authHeaders(cookie),
    })
    const eventsFor = async (cookie: string | undefined, from: string, to: string) => (await app.inject({
      url: `/api/calendar/events?from=${from}&to=${to}&roomId=${ids.secondRoom}`, headers: authHeaders(cookie),
    })).json()

    const instructorSettings = await app.inject({
      method: 'POST', url: '/api/calendar/events', headers: authHeaders(instructorCookie),
      payload: {
        courseId: ids.specialCourse, instructorId: ids.secondInstructor, roomId: ids.secondRoom,
        startAt: '2093-01-10T10:00', endAt: '2093-01-10T11:00', participantLimit: 3,
      },
    })
    expect(instructorSettings.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST', url: '/api/calendar/events', headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.specialCourse, instructorId: ids.secondInstructor, roomId: ids.secondRoom,
        startAt: '2093-01-10T10:00', endAt: '2093-01-10T11:00', participantLimit: 1, showAttendeeCount: false,
      },
    })
    expect(created.statusCode).toBe(201)
    const eventId = Number(created.json().id_curso_agendado)

    expect((await join(aCookie, eventId, { scope: 'occurrence' })).statusCode).toBe(200)
    expect((await join(bCookie, eventId, { scope: 'occurrence' })).statusCode).toBe(409)
    expect((await join(bCookie, eventId, { role: 'INSTRUCTOR' })).statusCode).toBe(403)
    expect((await join(bCookie, eventId, { scope: 'series' })).statusCode).toBe(400)
    expect((await join(instructorCookie, eventId, { role: 'INSTRUCTOR' })).statusCode).toBe(200)

    const studentView = (await eventsFor(bCookie, '2093-01-10T00:00', '2093-01-10T23:59'))[0]
    expect(studentView).toMatchObject({ asistentes: null, completo: true, limite_participantes: 1, mi_participacion: null })
    const ownView = (await eventsFor(aCookie, '2093-01-10T00:00', '2093-01-10T23:59'))[0]
    expect(ownView.mi_participacion).toEqual({ rol: 'ALUMNO', serie: false })
    const instructorView = (await eventsFor(instructorCookie, '2093-01-10T00:00', '2093-01-10T23:59'))[0]
    expect(instructorView.asistentes).toEqual({ alumnos: 1, instructores: 1 })
    expect(instructorView.mi_participacion).toEqual({ rol: 'INSTRUCTOR', serie: false })

    expect((await app.inject({ url: `/api/calendar/events/${eventId}/participants`, headers: authHeaders(bCookie) })).statusCode).toBe(403)
    const participants = await app.inject({ url: `/api/calendar/events/${eventId}/participants`, headers: authHeaders(instructorCookie) })
    expect(participants.json()).toEqual([
      expect.objectContaining({ nombre: 'Instructor dos', rol: 'INSTRUCTOR', serie: false }),
      expect.objectContaining({ nombre: 'Participante A', rol: 'ALUMNO', serie: false }),
    ])

    const unlimited = await app.inject({
      method: 'PATCH', url: `/api/calendar/events/${eventId}`, headers: authHeaders(adminCookie),
      payload: { participantLimit: null, showAttendeeCount: true },
    })
    expect(unlimited.statusCode).toBe(200)
    expect((await join(bCookie, eventId, {})).statusCode).toBe(200)
    expect((await eventsFor(bCookie, '2093-01-10T00:00', '2093-01-10T23:59'))[0]).toMatchObject({
      asistentes: { alumnos: 2, instructores: 1 }, completo: false, limite_participantes: null,
    })
    const tooLow = await app.inject({
      method: 'PATCH', url: `/api/calendar/events/${eventId}`, headers: authHeaders(adminCookie), payload: { participantLimit: 1 },
    })
    expect(tooLow.statusCode).toBe(409)
    expect((await leave(bCookie, eventId, 'occurrence')).statusCode).toBe(200)
    expect((await leave(bCookie, eventId, 'occurrence')).statusCode).toBe(404)

    const rule = await app.inject({
      method: 'POST', url: '/api/calendar/recurring-rules', headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.habitualCourse, instructorId: ids.secondInstructor, roomId: ids.secondRoom,
        weekdays: [2], startTime: '18:00', endTime: '19:00', startsOn: '2093-03-01', endsOn: null, participantLimit: 1,
      },
    })
    expect(rule.statusCode).toBe(201)
    const ruleId = Number(rule.json().rules[0].id_horario_recurrente)
    const march = (await eventsFor(aCookie, '2093-03-01T00:00', '2093-03-31T23:59'))
      .filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect(march.length).toBeGreaterThanOrEqual(4)
    expect(march[0].limite_participantes).toBe(1)

    // Guardar el formulario completo sin cambiar el horario no desvincula la sesión de su regla.
    const sameSchedule = await app.inject({
      method: 'PATCH', url: `/api/calendar/events/${march[3].id_curso_agendado}`, headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.habitualCourse, instructorId: ids.secondInstructor, roomId: ids.secondRoom,
        startAt: march[3].fecha_hora, endAt: march[3].fecha_hora_fin, participantLimit: 2, showAttendeeCount: true,
      },
    })
    expect(sameSchedule.statusCode).toBe(200)
    const sameScheduleRow = await pool.query('SELECT modificado_manualmente, limite_participantes FROM cursos_agendados WHERE id_curso_agendado = $1', [march[3].id_curso_agendado])
    expect(sameScheduleRow.rows[0]).toEqual({ modificado_manualmente: false, limite_participantes: 2 })
    await pool.query('UPDATE cursos_agendados SET limite_participantes = 1 WHERE id_curso_agendado = $1', [march[3].id_curso_agendado])

    expect((await join(bCookie, march[2].id_curso_agendado, { scope: 'occurrence' })).statusCode).toBe(200)
    const series = await join(aCookie, march[0].id_curso_agendado, { scope: 'series' })
    expect(series.statusCode).toBe(200)
    expect(series.json().skipped).toEqual([march[2].fecha_hora.slice(0, 10)])
    expect((await leave(aCookie, march[1].id_curso_agendado, 'occurrence')).statusCode).toBe(200)

    const marchAfter = (await eventsFor(aCookie, '2093-03-01T00:00', '2093-03-31T23:59'))
      .filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect(marchAfter.map((event: { mi_participacion: unknown }) => event.mi_participacion)).toEqual(
      marchAfter.map((_: unknown, index: number) => (index === 1 || index === 2 ? null : { rol: 'ALUMNO', serie: true })),
    )

    // Las fechas generadas más tarde incluyen a quien está apuntado a la serie.
    const july = (await eventsFor(aCookie, '2093-07-01T00:00', '2093-07-31T23:59'))
      .filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect(july.length).toBeGreaterThanOrEqual(4)
    expect(july.every((event: { mi_participacion: unknown }) => JSON.stringify(event.mi_participacion) === JSON.stringify({ rol: 'ALUMNO', serie: true }))).toBe(true)

    const lowered = await app.inject({
      method: 'PATCH', url: `/api/calendar/recurring-rules/${ruleId}`, headers: authHeaders(adminCookie),
      payload: { participantLimit: 5, showAttendeeCount: false },
    })
    expect(lowered.statusCode).toBe(200)
    expect((await eventsFor(bCookie, '2093-07-01T00:00', '2093-07-31T23:59'))
      .filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
      .every((event: { asistentes: unknown; limite_participantes: number }) => event.asistentes === null && event.limite_participantes === 5)).toBe(true)

    expect((await leave(aCookie, july[0].id_curso_agendado, 'series')).statusCode).toBe(200)
    const septemberEvents = (await eventsFor(aCookie, '2093-09-01T00:00', '2093-09-30T23:59'))
      .filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect(septemberEvents.length).toBeGreaterThan(0)
    expect(septemberEvents.every((event: { mi_participacion: unknown }) => event.mi_participacion === null)).toBe(true)
    const marchKept = (await eventsFor(aCookie, '2093-03-01T00:00', '2093-03-31T23:59'))
      .filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect(marchKept[0].mi_participacion).toEqual({ rol: 'ALUMNO', serie: false })
  })

  it('removes an inactive student from future events and keeps past attendance', async () => {
    const adminCookie = latestAdminCookie
    expect(adminCookie).toBeDefined()
    const passwordHash = await bcrypt.hash('test-password-123', 4)
    const student = await pool.query<{ id_alumno: string }>(`
      INSERT INTO alumnos (numero_matricula, fecha_ingreso, activo, id_grado, correo_electronico, password_hash, nombre)
      VALUES ('TEST-BAJA', CURRENT_DATE, TRUE, $1, 'baja@test.invalid', $2, 'Alumno baja')
      RETURNING id_alumno
    `, [ids.grade, passwordHash])
    const studentId = student.rows[0]!.id_alumno
    const { cookie } = await login('baja@test.invalid')

    const rule = await app.inject({
      method: 'POST', url: '/api/calendar/recurring-rules', headers: authHeaders(adminCookie),
      payload: {
        courseId: ids.habitualCourse, instructorId: ids.secondInstructor, roomId: ids.secondRoom,
        weekdays: [4], startTime: '18:00', endTime: '19:00', startsOn: '2094-03-01', endsOn: null,
      },
    })
    expect(rule.statusCode).toBe(201)
    const ruleId = Number(rule.json().rules[0].id_horario_recurrente)
    const march = (await app.inject({
      url: `/api/calendar/events?from=2094-03-01T00:00&to=2094-03-31T23:59&roomId=${ids.secondRoom}`, headers: authHeaders(cookie),
    })).json().filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect((await app.inject({
      method: 'POST', url: `/api/calendar/events/${march[0].id_curso_agendado}/participation`,
      headers: authHeaders(cookie), payload: { scope: 'series' },
    })).statusCode).toBe(200)

    // Una asistencia pasada (no se puede crear desde la API porque la actividad ya empezó).
    const past = await pool.query<{ id_curso_agendado: string }>(`
      INSERT INTO cursos_agendados (id_curso, id_instructor, id_sala, fecha_hora, fecha_hora_fin, activo)
      VALUES ($1, $2, $3, TIMESTAMP '2001-05-10 10:00', TIMESTAMP '2001-05-10 11:00', TRUE)
      RETURNING id_curso_agendado
    `, [ids.specialCourse, ids.secondInstructor, ids.secondRoom])
    const pastEventId = past.rows[0]!.id_curso_agendado
    await pool.query(`INSERT INTO participaciones_evento (id_curso_agendado, id_alumno, rol) VALUES ($1, $2, 'ALUMNO')`, [pastEventId, studentId])

    const countFuture = async () => Number((await pool.query(`
      SELECT count(*) FROM participaciones_evento pe JOIN cursos_agendados ca USING (id_curso_agendado)
      WHERE pe.id_alumno = $1 AND ca.fecha_hora > now()
    `, [studentId])).rows[0].count)
    expect(await countFuture()).toBeGreaterThan(0)

    const deactivated = await app.inject({
      method: 'PUT', url: `/api/database/tables/alumnos/rows/${studentId}`, headers: authHeaders(adminCookie),
      payload: { activo: false },
    })
    expect(deactivated.statusCode).toBe(200)
    expect(await countFuture()).toBe(0)
    expect((await pool.query('SELECT count(*) FROM participaciones_serie WHERE id_alumno = $1', [studentId])).rows[0].count).toBe('0')
    const kept = await pool.query('SELECT count(*) FROM participaciones_evento WHERE id_alumno = $1 AND id_curso_agendado = $2', [studentId, pastEventId])
    expect(kept.rows[0].count).toBe('1')

    // Las fechas que se generen después tampoco lo incluyen.
    const july = (await app.inject({
      url: `/api/calendar/events?from=2094-07-01T00:00&to=2094-07-31T23:59&roomId=${ids.secondRoom}`, headers: authHeaders(adminCookie),
    })).json().filter((event: { id_horario_recurrente: number }) => Number(event.id_horario_recurrente) === ruleId)
    expect(july.length).toBeGreaterThan(0)
    expect(july.every((event: { asistentes: { alumnos: number } }) => event.asistentes.alumnos === 0)).toBe(true)

    await expect(pool.query('DELETE FROM participaciones_evento WHERE id_curso_agendado = $1', [pastEventId]))
      .rejects.toMatchObject({ code: '23001' })
    const deleteRow = await app.inject({
      method: 'DELETE', url: `/api/database/tables/alumnos/rows/${studentId}`, headers: authHeaders(adminCookie),
    })
    expect(deleteRow.statusCode).toBe(409)
    expect(deleteRow.json().message).toBe('No se pueden borrar asistencias de fechas pasadas.')
  })
})

describe('student forms on grade changes', () => {
  it('keeps forms manual when a student is created, promoted or demoted', async () => {
    const suffix = randomUUID().slice(0, 8)
    const maximumOrder = await pool.query<{ next_order: number }>(
      'SELECT COALESCE(MAX(orden_grado), 0) + 1 AS next_order FROM grados',
    )
    const firstOrder = Number(maximumOrder.rows[0]!.next_order)
    const grades = await pool.query<{ id_grado: number; orden_grado: number }>(`
      INSERT INTO grados (nombre, orden_grado, color_cinturon)
      VALUES ($1, $2, 'Verde'), ($3, $4, 'Azul'), ($5, $6, 'Negro')
      RETURNING id_grado, orden_grado
    `, [
      `Auto inferior ${suffix}`, firstOrder,
      `Auto medio ${suffix}`, firstOrder + 1,
      `Auto superior ${suffix}`, firstOrder + 2,
    ])
    const lowerGrade = grades.rows.find((grade) => grade.orden_grado === firstOrder)!
    const middleGrade = grades.rows.find((grade) => grade.orden_grado === firstOrder + 1)!
    const upperGrade = grades.rows.find((grade) => grade.orden_grado === firstOrder + 2)!
    const forms = await pool.query<{ id_forma: string; nombre: string }>(`
      INSERT INTO formas (id_estilo, nombre)
      VALUES ($1, $2), ($1, $3), ($1, $4)
      RETURNING id_forma, nombre
    `, [ids.style, `Forma inferior ${suffix}`, `Forma media ${suffix}`, `Forma superior ${suffix}`])
    const lowerForm = Number(forms.rows.find((form) => form.nombre === `Forma inferior ${suffix}`)!.id_forma)
    const middleForm = Number(forms.rows.find((form) => form.nombre === `Forma media ${suffix}`)!.id_forma)
    const upperForm = Number(forms.rows.find((form) => form.nombre === `Forma superior ${suffix}`)!.id_forma)
    await pool.query(`
      INSERT INTO grado_forma (id_grado, id_forma, es_opcional)
      VALUES ($1, $2, FALSE), ($3, $4, FALSE), ($5, $6, FALSE)
    `, [lowerGrade.id_grado, lowerForm, middleGrade.id_grado, middleForm, upperGrade.id_grado, upperForm])

    const { cookie } = await login('admin@test.invalid')
    const created = await app.inject({
      method: 'POST',
      url: '/api/database/tables/alumnos/rows',
      headers: authHeaders(cookie),
      payload: {
        numero_matricula: `MAN-${suffix}`,
        fecha_ingreso: '2092-01-01',
        nombre: `Alumno manual ${suffix}`,
        id_grado: middleGrade.id_grado,
        correo_electronico: `manual-${suffix}@test.invalid`,
      },
    })
    expect(created.statusCode).toBe(200)
    const studentId = Number(created.json().id_alumno)
    const knownAfterCreate = await pool.query<{ id_forma: string }>(
      'SELECT id_forma::text FROM alumno_forma WHERE id_alumno = $1',
      [studentId],
    )
    expect(knownAfterCreate.rows).toEqual([])

    const markedByAdmin = await app.inject({
      method: 'POST',
      url: '/api/database/tables/alumno_forma/rows',
      headers: authHeaders(cookie),
      payload: { id_alumno: studentId, id_forma: lowerForm, fecha_aprendida: '2090-01-01' },
    })
    expect(markedByAdmin.statusCode).toBe(200)
    expect(Number(markedByAdmin.json().id_alumno)).toBe(studentId)
    expect(Number(markedByAdmin.json().id_forma)).toBe(lowerForm)

    const promoted = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(cookie),
      payload: { id_grado: upperGrade.id_grado },
    })
    expect(promoted.statusCode).toBe(200)
    const knownAfterPromotion = await pool.query<{ id_forma: string }>(
      'SELECT id_forma::text FROM alumno_forma WHERE id_alumno = $1',
      [studentId],
    )
    expect(knownAfterPromotion.rows.map((form) => Number(form.id_forma))).toEqual([lowerForm])

    const demoted = await app.inject({
      method: 'PUT',
      url: `/api/database/tables/alumnos/rows/${studentId}`,
      headers: authHeaders(cookie),
      payload: { id_grado: lowerGrade.id_grado },
    })
    expect(demoted.statusCode).toBe(200)
    const knownAfterDemotion = await pool.query<{ id_forma: string }>(
      'SELECT id_forma::text FROM alumno_forma WHERE id_alumno = $1',
      [studentId],
    )
    expect(knownAfterDemotion.rows.map((form) => Number(form.id_forma))).toEqual([lowerForm])
  })
})

describe('database migration runner', () => {
  it('is safe to call on every backend start', async () => {
    if (!pool) throw new Error('Test database pool has not been initialized.')
    const result = await migrateDatabase(pool)
    expect(result.migrationsExecuted).toBe(0)
    expect(result.appliedVersions).toContain(21)
  })

  it('baselines an existing Flyway v12 database and preserves scheduled rows', async () => {
    if (!adminUrl) throw new Error('Test PostgreSQL admin URL has not been initialized.')
    const legacyName = `kungfu_node_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const marker = `${testDatabaseMarker}:legacy`
    await withAdminClient(async (client) => {
      await client.query(`CREATE DATABASE ${quoteDatabaseName(legacyName)}`)
      await client.query(`COMMENT ON DATABASE ${quoteDatabaseName(legacyName)} IS '${marker}'`)
    })

    const legacyUrl = new URL(adminUrl)
    legacyUrl.pathname = `/${legacyName}`
    const legacyPool = createPool(legacyUrl.toString())
    try {
      const migrationDirectory = path.join(process.cwd(), 'src/main/resources/db/migration')
      const migrationFiles = (await readdir(migrationDirectory))
        .filter((file) => /^V\d+__/u.test(file))
        .sort((left, right) => Number(/^V(\d+)/u.exec(left)?.[1]) - Number(/^V(\d+)/u.exec(right)?.[1]))

      for (const file of migrationFiles.filter((name) => Number(/^V(\d+)/u.exec(name)?.[1]) <= 12)) {
        await legacyPool.query(await readFile(path.join(migrationDirectory, file), 'utf8'))
      }

      const instructor = await legacyPool.query<{ id_instructor: string }>(`
        INSERT INTO instructores (nombre, fecha_contratacion, activo, especialidad, correo_electronico, password_hash)
        VALUES ('Legacy instructor', CURRENT_DATE, TRUE, 'Prueba', 'legacy@test.invalid', NULL)
        RETURNING id_instructor
      `)
      const course = await legacyPool.query<{ id_curso: string }>(`
        INSERT INTO cursos (nombre, tema, descripcion)
        VALUES ('Taller legado', 'Especialización', 'Curso anterior a Node')
        RETURNING id_curso
      `)
      await legacyPool.query(`
        INSERT INTO cursos_agendados (id_curso, id_instructor, fecha_hora, activo)
        VALUES ($1, $2, TIMESTAMP '2092-10-04 10:00:00', TRUE)
      `, [course.rows[0]!.id_curso, instructor.rows[0]!.id_instructor])
      await legacyPool.query(`
        CREATE TABLE flyway_schema_history (
          installed_rank INTEGER PRIMARY KEY,
          version VARCHAR(50),
          success BOOLEAN NOT NULL
        )
      `)
      await legacyPool.query('INSERT INTO flyway_schema_history (installed_rank, version, success) VALUES (12, $1, TRUE)', ['12'])

      const result = await migrateDatabase(legacyPool)
      expect(result.migrationsExecuted).toBe(9)
      const converted = await legacyPool.query(`
        SELECT a.numero_matricula, a.correo_electronico, a.es_instructor, a.password_hash
        FROM instructores i JOIN alumnos a ON a.id_alumno = i.id_alumno
        WHERE i.id_instructor = $1
      `, [instructor.rows[0]!.id_instructor])
      expect(converted.rows[0]).toMatchObject({
        numero_matricula: `INS-${instructor.rows[0]!.id_instructor}`,
        correo_electronico: 'legacy@test.invalid',
        es_instructor: true,
      })
      expect(await bcrypt.compare('legacyinstructor', converted.rows[0].password_hash)).toBe(true)
      const migrated = await legacyPool.query(`
        SELECT ca.fecha_hora::text, ca.fecha_hora_fin::text, ca.id_sala, c.tipo_curso
        FROM cursos_agendados ca JOIN cursos c USING (id_curso)
      `)
      expect(migrated.rows[0]).toMatchObject({
        fecha_hora: '2092-10-04 10:00:00',
        fecha_hora_fin: '2092-10-04 11:30:00',
        id_sala: null,
        tipo_curso: 'CURSO_ESPECIAL',
      })
    } finally {
      await legacyPool.end()
      await withAdminClient(async (client) => {
        const database = await client.query<{ description: string | null }>(`
          SELECT shobj_description(oid, 'pg_database') AS description
          FROM pg_database WHERE datname = $1
        `, [legacyName])
        if (database.rows[0]?.description !== marker) return
        await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [legacyName])
        await client.query(`DROP DATABASE ${quoteDatabaseName(legacyName)}`)
      })
    }
  })
})
