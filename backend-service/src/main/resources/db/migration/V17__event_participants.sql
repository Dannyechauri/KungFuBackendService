-- Participantes de la agenda.
-- limite_participantes NULL = sin límite; solo cuentan las plazas de quien se apunta como alumno.
-- mostrar_asistentes decide si los alumnos ven el número de asistentes (admin e instructores siempre lo ven).
ALTER TABLE cursos_agendados
  ADD COLUMN IF NOT EXISTS limite_participantes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS mostrar_asistentes BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE cursos_agendados
  ADD CONSTRAINT ck_cursos_agendados_limite CHECK (limite_participantes IS NULL OR limite_participantes > 0);

ALTER TABLE horarios_recurrentes
  ADD COLUMN IF NOT EXISTS limite_participantes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS mostrar_asistentes BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE horarios_recurrentes
  ADD CONSTRAINT ck_horarios_recurrentes_limite CHECK (limite_participantes IS NULL OR limite_participantes > 0);

-- Participación en una fecha concreta. Es la fuente de verdad del aforo de cada actividad.
CREATE TABLE participaciones_evento (
  id_participacion   BIGSERIAL   PRIMARY KEY,
  id_curso_agendado  BIGINT      NOT NULL REFERENCES cursos_agendados(id_curso_agendado) ON DELETE CASCADE,
  id_alumno          BIGINT      NOT NULL REFERENCES alumnos(id_alumno) ON DELETE CASCADE,
  rol                VARCHAR(20) NOT NULL CHECK (rol IN ('ALUMNO', 'INSTRUCTOR')),
  fecha_registro     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_participacion_evento UNIQUE (id_curso_agendado, id_alumno)
);

CREATE INDEX idx_participaciones_evento_alumno ON participaciones_evento (id_alumno);

-- Inscripción a toda una serie: se apunta a las fechas futuras con plaza,
-- incluidas las que se generen más adelante.
CREATE TABLE participaciones_serie (
  id_participacion_serie BIGSERIAL   PRIMARY KEY,
  id_horario_recurrente  BIGINT      NOT NULL REFERENCES horarios_recurrentes(id_horario_recurrente) ON DELETE CASCADE,
  id_alumno              BIGINT      NOT NULL REFERENCES alumnos(id_alumno) ON DELETE CASCADE,
  rol                    VARCHAR(20) NOT NULL CHECK (rol IN ('ALUMNO', 'INSTRUCTOR')),
  fecha_desde            DATE        NOT NULL,
  fecha_registro         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_participacion_serie UNIQUE (id_horario_recurrente, id_alumno)
);
