ALTER TABLE desempenos_diarios
  ADD COLUMN aprobado_en TIMESTAMPTZ;

ALTER TABLE desempeno_confirmaciones
  DROP CONSTRAINT desempeno_confirmaciones_estado_check,
  ADD CONSTRAINT ck_desempeno_confirmacion_estado
    CHECK (estado IN ('PENDING', 'CONFIRMED', 'REJECTED', 'NOT_REQUIRED'));