ALTER TABLE cursos
    ADD COLUMN tipo_curso VARCHAR(24) NOT NULL DEFAULT 'HABITUAL';

-- Seeded event names/topics make existing demonstration special courses
-- identifiable. Other existing courses remain regular classes by default.
UPDATE cursos
SET tipo_curso = 'CURSO_ESPECIAL'
WHERE tema ILIKE '%especial%'
   OR nombre ILIKE '%taller%'
   OR nombre ILIKE '%introducción%';

ALTER TABLE cursos
    ADD CONSTRAINT ck_cursos_tipo_curso
        CHECK (tipo_curso IN ('HABITUAL', 'CURSO_ESPECIAL'));

CREATE FUNCTION infer_tipo_curso() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.tipo_curso = 'HABITUAL' AND (
        NEW.tema ILIKE '%especial%'
        OR NEW.nombre ILIKE '%taller%'
        OR NEW.nombre ILIKE '%introducción%'
    ) THEN
        NEW.tipo_curso := 'CURSO_ESPECIAL';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_curso_infer_tipo
    BEFORE INSERT ON cursos
    FOR EACH ROW
    EXECUTE FUNCTION infer_tipo_curso();

ALTER TABLE cursos_agendados
    ADD COLUMN fecha_hora_fin TIMESTAMP,
    ADD COLUMN id_horario_recurrente BIGINT,
    ADD COLUMN fecha_recurrencia DATE,
    ADD COLUMN modificado_manualmente BOOLEAN NOT NULL DEFAULT FALSE;

-- Historical demo rows only stored their start. Keep them usable and let a
-- later edit replace this provisional duration with the school's real time.
UPDATE cursos_agendados
SET fecha_hora_fin = fecha_hora + INTERVAL '90 minutes'
WHERE fecha_hora_fin IS NULL;

ALTER TABLE cursos_agendados
    ALTER COLUMN fecha_hora_fin SET NOT NULL,
    ADD CONSTRAINT ck_cursos_agendados_intervalo
        CHECK (fecha_hora_fin > fecha_hora);

CREATE FUNCTION set_default_curso_agendado_end() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.fecha_hora_fin IS NULL THEN
        NEW.fecha_hora_fin := NEW.fecha_hora + INTERVAL '90 minutes';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_curso_agendado_default_end
    BEFORE INSERT ON cursos_agendados
    FOR EACH ROW
    EXECUTE FUNCTION set_default_curso_agendado_end();

CREATE TABLE horarios_recurrentes (
    id_horario_recurrente BIGSERIAL PRIMARY KEY,
    id_curso BIGINT NOT NULL,
    id_instructor BIGINT NOT NULL,
    dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 1 AND 7),
    hora_inicio TIME NOT NULL,
    hora_fin TIME NOT NULL,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_horarios_recurrentes_intervalo CHECK (hora_fin > hora_inicio),
    CONSTRAINT ck_horarios_recurrentes_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio),
    CONSTRAINT fk_horario_recurrente_curso FOREIGN KEY (id_curso) REFERENCES cursos(id_curso),
    CONSTRAINT fk_horario_recurrente_instructor FOREIGN KEY (id_instructor) REFERENCES instructores(id_instructor)
);

ALTER TABLE cursos_agendados
    ADD CONSTRAINT fk_curso_agendado_horario_recurrente
        FOREIGN KEY (id_horario_recurrente)
        REFERENCES horarios_recurrentes(id_horario_recurrente)
        ON DELETE SET NULL;

CREATE INDEX idx_cursos_agendados_intervalo ON cursos_agendados(fecha_hora, fecha_hora_fin);
CREATE INDEX idx_horarios_recurrentes_activos ON horarios_recurrentes(dia_semana, fecha_inicio, fecha_fin)
    WHERE activo = TRUE;
CREATE UNIQUE INDEX ux_curso_agendado_horario_fecha
    ON cursos_agendados(id_horario_recurrente, fecha_recurrencia)
    WHERE id_horario_recurrente IS NOT NULL;

CREATE TABLE api_sessions (
    session_hash CHAR(64) PRIMARY KEY,
    role VARCHAR(16) NOT NULL CHECK (role IN ('ADMIN', 'INSTRUCTOR', 'USER')),
    user_id BIGINT NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_api_sessions_expiry ON api_sessions(expires_at);
