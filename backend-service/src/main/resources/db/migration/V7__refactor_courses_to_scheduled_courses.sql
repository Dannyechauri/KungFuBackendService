ALTER TABLE inscripciones
DROP CONSTRAINT IF EXISTS fk_inscripcion_curso;

DROP INDEX IF EXISTS idx_cursos_instructor_fecha;

ALTER TABLE cursos
DROP CONSTRAINT IF EXISTS fk_curso_instructor,
DROP COLUMN IF EXISTS id_instructor,
DROP COLUMN IF EXISTS fecha_hora;

CREATE TABLE cursos_agendados (
    id_curso_agendado BIGSERIAL PRIMARY KEY,
    id_curso BIGINT NOT NULL,
    id_instructor BIGINT NOT NULL,
    fecha_hora TIMESTAMP NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_cursos_agendados_curso
        FOREIGN KEY (id_curso) REFERENCES cursos(id_curso),
    CONSTRAINT fk_cursos_agendados_instructor
        FOREIGN KEY (id_instructor) REFERENCES instructores(id_instructor)
);

CREATE INDEX idx_cursos_agendados_curso ON cursos_agendados(id_curso);
CREATE INDEX idx_cursos_agendados_instructor ON cursos_agendados(id_instructor);
CREATE INDEX idx_cursos_agendados_fecha ON cursos_agendados(fecha_hora);

ALTER TABLE inscripciones
ADD COLUMN id_curso_agendado BIGINT;

UPDATE inscripciones i
SET id_curso_agendado = (
    SELECT ca.id_curso_agendado
    FROM cursos_agendados ca
    WHERE ca.id_curso = i.id_curso
    LIMIT 1
);

ALTER TABLE inscripciones
DROP COLUMN id_curso,
ALTER COLUMN id_curso_agendado SET NOT NULL,
ADD CONSTRAINT fk_inscripcion_curso_agendado
    FOREIGN KEY (id_curso_agendado) REFERENCES cursos_agendados(id_curso_agendado);

CREATE INDEX idx_inscripciones_curso_agendado ON inscripciones(id_curso_agendado);
