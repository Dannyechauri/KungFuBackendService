ALTER TABLE desempenos_diarios
  DROP CONSTRAINT ck_desempeno_trabajo_no_vacio;

ALTER TABLE desempenos_diarios
  ADD COLUMN trabajo_cardiovascular BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE desempenos_diarios
  ALTER COLUMN trabajo_fisico TYPE BOOLEAN
    USING (length(trim(trabajo_fisico)) > 0),
  ALTER COLUMN trabajo_fisico SET DEFAULT FALSE,
  ALTER COLUMN estiramiento TYPE BOOLEAN
    USING (COALESCE(length(trim(estiramiento)) > 0, FALSE)),
  ALTER COLUMN estiramiento SET DEFAULT FALSE,
  ALTER COLUMN estiramiento SET NOT NULL;
