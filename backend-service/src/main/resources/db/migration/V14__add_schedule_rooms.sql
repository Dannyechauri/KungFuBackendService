CREATE TABLE salas (
    id_sala BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_salas_nombre CHECK (length(btrim(nombre)) > 0)
);

CREATE UNIQUE INDEX ux_salas_nombre_normalizado ON salas (lower(btrim(nombre)));

-- Existing rows keep a NULL room until the school assigns their real location.
ALTER TABLE cursos_agendados
    ADD COLUMN id_sala BIGINT,
    ADD CONSTRAINT fk_curso_agendado_sala
        FOREIGN KEY (id_sala) REFERENCES salas(id_sala) ON DELETE RESTRICT;

ALTER TABLE horarios_recurrentes
    ADD COLUMN id_sala BIGINT,
    ADD CONSTRAINT fk_horario_recurrente_sala
        FOREIGN KEY (id_sala) REFERENCES salas(id_sala) ON DELETE RESTRICT;

CREATE INDEX idx_cursos_agendados_sala_intervalo
    ON cursos_agendados (id_sala, fecha_hora, fecha_hora_fin)
    WHERE activo = TRUE;

CREATE INDEX idx_horarios_recurrentes_sala_activos
    ON horarios_recurrentes (id_sala, dia_semana, fecha_inicio, fecha_fin)
    WHERE activo = TRUE;
