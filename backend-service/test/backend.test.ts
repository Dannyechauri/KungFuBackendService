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
let ids: { admin: number; instructor: number; student: number; habitualCourse: number; specialCourse: number; secondInstructor: number; primaryRoom: number; secondRoom: number; style: number }

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
  const instructor = await pool.query<{ id_instructor: number }>(`
    INSERT INTO instructores (nombre, fecha_contratacion, activo, especialidad, correo_electronico, password_hash)
    VALUES ('Instructor test', CURRENT_DATE, TRUE, 'Prueba', 'instructor@test.invalid', $1)
    RETURNING id_instructor
  `, [passwordHash])
  const secondInstructor = await pool.query<{ id_instructor: number }>(`
    INSERT INTO instructores (nombre, fecha_contratacion, activo, especialidad, correo_electronico, password_hash)
    VALUES ('Instructor dos', CURRENT_DATE, TRUE, 'Prueba', 'instructor2@test.invalid', $1)
    RETURNING id_instructor
  `, [passwordHash])
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
    instructor: Number(instructor.rows[0]!.id_instructor),
    secondInstructor: Number(secondInstructor.rows[0]!.id_instructor),
    student: Number(student.rows[0]!.id_alumno),
    habitualCourse: Number(habitual.rows[0]!.id_curso),
    specialCourse: Number(special.rows[0]!.id_curso),
    primaryRoom: Number(primaryRoom.rows[0]!.id_sala),
    secondRoom: Number(secondRoom.rows[0]!.id_sala),
    style: Number(style.rows[0]!.id_estilo),
  }
}

async function login(email: string) {
  if (!app) throw new Error('Test server has not been initialized.')
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-123' },
  })
  return { response, cookie: response.headers['set-cookie']?.toString().split(';')[0] }
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
    expect(teacher.response.json().role).toBe('INSTRUCTOR')
    expect(student.response.json().role).toBe('USER')
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
    expect(instructorRoom.statusCode).toBe(201)
    const renamedByInstructor = await app.inject({
      method: 'PATCH',
      url: `/api/calendar/rooms/${instructorRoom.json().id_sala}`,
      headers: authHeaders(instructorCookie),
      payload: { nombre: 'Sala compartida' },
    })
    expect(renamedByInstructor.statusCode).toBe(200)
    expect(renamedByInstructor.json().nombre).toBe('Sala compartida')
  })

  it('lets instructors create and edit habitual/special course definitions', async () => {
    const { cookie } = await login('instructor@test.invalid')
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
})

describe('database migration runner', () => {
  it('is safe to call on every backend start', async () => {
    if (!pool) throw new Error('Test database pool has not been initialized.')
    const result = await migrateDatabase(pool)
    expect(result.migrationsExecuted).toBe(0)
    expect(result.appliedVersions).toContain(15)
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
      expect(result.migrationsExecuted).toBe(3)
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
