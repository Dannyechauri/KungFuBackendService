CREATE TABLE desempenos_diarios (
  id_desempeno BIGSERIAL PRIMARY KEY,
  id_alumno BIGINT NOT NULL REFERENCES alumnos(id_alumno) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  trabajo_fisico TEXT NOT NULL,
  estiramiento TEXT,
  asistio_clase BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_desempeno_alumno_fecha UNIQUE (id_alumno, fecha),
  CONSTRAINT ck_desempeno_trabajo_no_vacio CHECK (length(trim(trabajo_fisico)) > 0)
);

CREATE INDEX idx_desempenos_diarios_fecha ON desempenos_diarios (fecha DESC);

CREATE TABLE desempeno_formas (
  id_desempeno BIGINT NOT NULL REFERENCES desempenos_diarios(id_desempeno) ON DELETE CASCADE,
  id_forma BIGINT NOT NULL REFERENCES formas(id_forma),
  PRIMARY KEY (id_desempeno, id_forma)
);

CREATE TABLE desempeno_confirmaciones (
  id_desempeno BIGINT NOT NULL REFERENCES desempenos_diarios(id_desempeno) ON DELETE CASCADE,
  id_alumno_confirmante BIGINT NOT NULL REFERENCES alumnos(id_alumno),
  estado VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (estado IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  respondido_en TIMESTAMPTZ,
  PRIMARY KEY (id_desempeno, id_alumno_confirmante)
);

CREATE INDEX idx_desempeno_confirmaciones_alumno_estado
  ON desempeno_confirmaciones (id_alumno_confirmante, estado);