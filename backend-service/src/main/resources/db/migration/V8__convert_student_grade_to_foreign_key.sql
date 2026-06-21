INSERT INTO grados (nombre, orden_grado, color_cinturon, formas_requeridas)
SELECT
    'Cinta Amarilla',
    COALESCE((SELECT MAX(orden_grado) FROM grados), 0) + 1,
    'Amarillo',
    0
WHERE NOT EXISTS (
    SELECT 1
    FROM grados
    WHERE LOWER(nombre) = 'cinta amarilla'
);

ALTER TABLE alumnos
ADD COLUMN IF NOT EXISTS id_grado BIGINT;

UPDATE alumnos a
SET id_grado = g.id_grado
FROM grados g
WHERE a.id_grado IS NULL
  AND a.grado IS NOT NULL
  AND (
      LOWER(g.nombre) = LOWER(a.grado)
      OR LOWER(g.color_cinturon) = LOWER(a.grado)
      OR LOWER(g.nombre) = LOWER(CONCAT('Cinta ', a.grado))
  );

UPDATE alumnos
SET id_grado = (
    SELECT id_grado
    FROM grados
    WHERE LOWER(nombre) = 'cinta amarilla'
    ORDER BY id_grado
    LIMIT 1
)
WHERE id_grado IS NULL;

ALTER TABLE alumnos
ALTER COLUMN id_grado SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_alumno_grado'
    ) THEN
        ALTER TABLE alumnos
        ADD CONSTRAINT fk_alumno_grado
            FOREIGN KEY (id_grado) REFERENCES grados(id_grado);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alumnos_id_grado ON alumnos(id_grado);

ALTER TABLE alumnos
DROP COLUMN IF EXISTS grado;
