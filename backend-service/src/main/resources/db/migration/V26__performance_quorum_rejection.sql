ALTER TABLE desempenos_diarios
  ADD COLUMN rechazado_en TIMESTAMPTZ;

UPDATE desempenos_diarios d
SET rechazado_en = CURRENT_TIMESTAMP
WHERE d.aprobado_en IS NULL
  AND (
    SELECT COUNT(*)
    FROM desempeno_confirmaciones dc
    WHERE dc.id_desempeno = d.id_desempeno
      AND dc.estado IN ('CONFIRMED', 'PENDING')
  ) < 2;