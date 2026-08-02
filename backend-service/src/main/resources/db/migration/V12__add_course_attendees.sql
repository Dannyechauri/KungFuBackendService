-- Tabla de asistencias confirmadas a cursos agendados.
-- Soporta registro de alumnos, instructores y administradores con columnas
-- separadas para evitar colisión de IDs entre tablas distintas.
--
-- Si ya ejecutaste una versión anterior de esta migración:
--   DELETE FROM flyway_schema_history WHERE version = '12';
-- y vuelve a arrancar el backend para que se aplique correctamente.

DROP TABLE IF EXISTS asistencias_curso;

CREATE TABLE asistencias_curso (
    id_asistencia      BIGSERIAL   NOT NULL,
    id_curso_agendado  BIGINT      NOT NULL,
    id_alumno          BIGINT      NULL,
    id_instructor      BIGINT      NULL,
    id_administrador   BIGINT      NULL,
    fecha_registro     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_asistencia          PRIMARY KEY (id_asistencia),
    CONSTRAINT fk_asist_curso         FOREIGN KEY (id_curso_agendado) REFERENCES cursos_agendados(id_curso_agendado) ON DELETE CASCADE,
    CONSTRAINT fk_asist_alumno        FOREIGN KEY (id_alumno)         REFERENCES alumnos(id_alumno)                 ON DELETE CASCADE,
    CONSTRAINT fk_asist_instructor    FOREIGN KEY (id_instructor)     REFERENCES instructores(id_instructor)        ON DELETE CASCADE,
    CONSTRAINT fk_asist_administrador FOREIGN KEY (id_administrador)  REFERENCES administradores(id_administrador)  ON DELETE CASCADE,
    -- Una persona no puede confirmar asistencia dos veces al mismo evento
    CONSTRAINT uk_asist_alumno        UNIQUE (id_curso_agendado, id_alumno),
    CONSTRAINT uk_asist_instructor    UNIQUE (id_curso_agendado, id_instructor),
    CONSTRAINT uk_asist_admin         UNIQUE (id_curso_agendado, id_administrador)
);

