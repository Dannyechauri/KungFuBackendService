import type { Pool } from 'pg'

export type NewPerformanceRecord = {
  studentId: number
  date: string
  physicalWork: boolean
  cardioWork: boolean
  stretching: boolean
  attendedClass: boolean
  formIds: number[]
  confirmerIds: number[]
}

export async function createPerformanceRecord(pool: Pool, input: NewPerformanceRecord) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const record = await client.query<{ id_desempeno: string }>(`
      INSERT INTO desempenos_diarios (id_alumno, fecha, trabajo_fisico, trabajo_cardiovascular, estiramiento, asistio_clase)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id_alumno, fecha) DO UPDATE SET
        trabajo_fisico = EXCLUDED.trabajo_fisico,
        trabajo_cardiovascular = EXCLUDED.trabajo_cardiovascular,
        estiramiento = EXCLUDED.estiramiento,
        asistio_clase = EXCLUDED.asistio_clase,
        aprobado_en = NULL,
        rechazado_en = NULL,
        resuelto_por_administrador = FALSE,
        creado_en = CURRENT_TIMESTAMP
      RETURNING id_desempeno::text
    `, [input.studentId, input.date, input.physicalWork, input.cardioWork, input.stretching, input.attendedClass])
    const recordId = record.rows[0]!.id_desempeno

    await client.query('DELETE FROM desempeno_formas WHERE id_desempeno = $1', [recordId])
    await client.query('DELETE FROM desempeno_confirmaciones WHERE id_desempeno = $1', [recordId])

    if (input.formIds.length) {
      await client.query(`
        INSERT INTO desempeno_formas (id_desempeno, id_forma)
        SELECT $1, selected.id_forma
        FROM unnest($2::bigint[]) AS selected(id_forma)
      `, [recordId, input.formIds])
    }

    await client.query(`
      INSERT INTO desempeno_confirmaciones (id_desempeno, id_alumno_confirmante)
      SELECT $1, selected.id_alumno
      FROM unnest($2::bigint[]) AS selected(id_alumno)
    `, [recordId, input.confirmerIds])
    await client.query('COMMIT')
    return { id: Number(recordId) }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function respondToPerformanceConfirmation(
  pool: Pool,
  input: { recordId: number; studentId: number; decision: 'CONFIRMED' | 'REJECTED' },
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const pending = await client.query(`
      SELECT d.id_desempeno
      FROM desempenos_diarios d
      JOIN desempeno_confirmaciones dc ON dc.id_desempeno = d.id_desempeno
      WHERE d.id_desempeno = $1 AND dc.id_alumno_confirmante = $2 AND dc.estado = 'PENDING'
        AND d.aprobado_en IS NULL AND d.rechazado_en IS NULL
      FOR UPDATE OF d
    `, [input.recordId, input.studentId])
    if (!pending.rowCount) {
      await client.query('ROLLBACK')
      return null
    }

    const updated = await client.query(`
      UPDATE desempeno_confirmaciones
      SET estado = $3, respondido_en = CURRENT_TIMESTAMP
      WHERE id_desempeno = $1 AND id_alumno_confirmante = $2 AND estado = 'PENDING'
    `, [input.recordId, input.studentId, input.decision])
    if (!updated.rowCount) {
      await client.query('ROLLBACK')
      return null
    }

    const confirmations = await client.query<{ confirmed_count: string; pending_count: string }>(`
      SELECT COUNT(*) FILTER (WHERE estado = 'CONFIRMED')::text AS confirmed_count,
             COUNT(*) FILTER (WHERE estado = 'PENDING')::text AS pending_count
      FROM desempeno_confirmaciones
      WHERE id_desempeno = $1
    `, [input.recordId])
    const confirmedCount = Number(confirmations.rows[0]?.confirmed_count ?? 0)
    const pendingCount = Number(confirmations.rows[0]?.pending_count ?? 0)
    const approved = confirmedCount >= 2
    const rejected = !approved && confirmedCount + pendingCount < 2
    if (approved) {
      await client.query(`
        UPDATE desempenos_diarios
        SET aprobado_en = COALESCE(aprobado_en, CURRENT_TIMESTAMP)
        WHERE id_desempeno = $1
      `, [input.recordId])
      await client.query(`
        UPDATE desempeno_confirmaciones
        SET estado = 'NOT_REQUIRED', respondido_en = CURRENT_TIMESTAMP
        WHERE id_desempeno = $1 AND estado = 'PENDING'
      `, [input.recordId])
    } else if (rejected) {
      await client.query(`
        UPDATE desempenos_diarios
        SET rechazado_en = COALESCE(rechazado_en, CURRENT_TIMESTAMP)
        WHERE id_desempeno = $1
      `, [input.recordId])
      await client.query(`
        UPDATE desempeno_confirmaciones
        SET estado = 'NOT_REQUIRED', respondido_en = CURRENT_TIMESTAMP
        WHERE id_desempeno = $1 AND estado = 'PENDING'
      `, [input.recordId])
    }

    await client.query('COMMIT')
    return { status: input.decision, approved, rejected, confirmedCount }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function resolvePerformanceAsAdmin(
  pool: Pool,
  input: { recordId: number; decision: 'CONFIRMED' | 'REJECTED' },
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(`
      UPDATE desempenos_diarios
      SET aprobado_en = CASE WHEN $2 = 'CONFIRMED' THEN CURRENT_TIMESTAMP ELSE NULL END,
          rechazado_en = CASE WHEN $2 = 'REJECTED' THEN CURRENT_TIMESTAMP ELSE NULL END,
          resuelto_por_administrador = TRUE
      WHERE id_desempeno = $1 AND aprobado_en IS NULL AND rechazado_en IS NULL
      RETURNING id_desempeno
    `, [input.recordId, input.decision])
    if (!updated.rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    await client.query(`
      UPDATE desempeno_confirmaciones
      SET estado = 'NOT_REQUIRED', respondido_en = CURRENT_TIMESTAMP
      WHERE id_desempeno = $1 AND estado = 'PENDING'
    `, [input.recordId])
    await client.query('COMMIT')
    return { status: input.decision, approved: input.decision === 'CONFIRMED', rejected: input.decision === 'REJECTED', resolvedByAdmin: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}