import type { Pool } from 'pg'

type MemberScore = {
  studentId: number
  name: string
  attendance: number
  stretching: number
  strength: number
  cardio: number
  forms: number
}

export type RankingEntry = {
  rank: number
  studentId: number
  name: string
  points: number
}

export type PerformanceRankings = {
  month: string
  attendance: RankingEntry[]
  stretching: RankingEntry[]
  strength: RankingEntry[]
  cardio: RankingEntry[]
  forms: RankingEntry[]
  overall: RankingEntry[]
}

function categoryRanking(members: MemberScore[], valueFor: (member: MemberScore) => number, currentStudentId: number | null) {
  const ordered = [...members]
    .map((member) => ({ studentId: member.studentId, name: member.name, points: valueFor(member) }))
    .sort((left, right) => right.points - left.points || left.name.localeCompare(right.name, 'es'))
  const ranked = ordered.map((member, index) => ({ ...member, rank: index + 1 }))
  const visible = ranked.slice(0, 3)
  const current = currentStudentId === null ? undefined : ranked.find((entry) => entry.studentId === currentStudentId)
  if (current && current.rank > 3) visible.push(current)
  return visible
}

export async function getPerformanceRankings(pool: Pool, currentStudentId: number | null): Promise<PerformanceRankings> {
  const [period, result] = await Promise.all([
    pool.query<{ month: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM') AS month`),
    pool.query<{
    student_id: string
    name: string
    attendance: number
    stretching: number
    strength: number
    cardio: number
    forms: number
    }>(`
    SELECT a.id_alumno::text AS student_id, a.nombre AS name,
           COUNT(DISTINCT d.id_desempeno) FILTER (WHERE d.asistio_clase)::int AS attendance,
           COUNT(DISTINCT d.id_desempeno) FILTER (WHERE d.estiramiento)::int AS stretching,
           COUNT(DISTINCT d.id_desempeno) FILTER (WHERE d.trabajo_fisico)::int AS strength,
           COUNT(DISTINCT d.id_desempeno) FILTER (WHERE d.trabajo_cardiovascular)::int AS cardio,
           COUNT(df.id_forma)::int AS forms
    FROM alumnos a
    LEFT JOIN desempenos_diarios d
      ON d.id_alumno = a.id_alumno
      AND d.aprobado_en IS NOT NULL
      AND d.rechazado_en IS NULL
      AND d.fecha >= date_trunc('month', CURRENT_DATE)::date
      AND d.fecha < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
    LEFT JOIN desempeno_formas df ON df.id_desempeno = d.id_desempeno
    WHERE a.activo = TRUE
    GROUP BY a.id_alumno, a.nombre
    `),
  ])
  const members: MemberScore[] = result.rows.map((row) => ({
    studentId: Number(row.student_id),
    name: row.name,
    attendance: row.attendance,
    stretching: row.stretching,
    strength: row.strength,
    cardio: row.cardio,
    forms: row.forms,
  }))

  return {
    month: period.rows[0]!.month,
    attendance: categoryRanking(members, (member) => member.attendance, currentStudentId),
    stretching: categoryRanking(members, (member) => member.stretching, currentStudentId),
    strength: categoryRanking(members, (member) => member.strength, currentStudentId),
    cardio: categoryRanking(members, (member) => member.cardio, currentStudentId),
    forms: categoryRanking(members, (member) => member.forms, currentStudentId),
    overall: categoryRanking(
      members,
      (member) => member.attendance + member.stretching + member.strength + member.cardio + member.forms,
      currentStudentId,
    ),
  }
}