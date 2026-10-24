ALTER TABLE alumno_forma
  ADD COLUMN es_automatica BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION fn_alumnos_sync_formas_obligatorias()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_grade_order INTEGER;
BEGIN
  SELECT orden_grado
  INTO new_grade_order
  FROM grados
  WHERE id_grado = NEW.id_grado;

  IF new_grade_order IS NULL THEN
    RETURN NULL;
  END IF;

  DELETE FROM alumno_forma af
  WHERE af.id_alumno = NEW.id_alumno
    AND af.es_automatica = TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM grado_forma gf
      JOIN grados g ON g.id_grado = gf.id_grado
      WHERE gf.id_forma = af.id_forma
        AND gf.es_opcional = FALSE
        AND g.orden_grado < new_grade_order
    );

  INSERT INTO alumno_forma (id_alumno, id_forma, fecha_aprendida, es_automatica)
  SELECT DISTINCT NEW.id_alumno, gf.id_forma, CURRENT_DATE, TRUE
  FROM grado_forma gf
  JOIN grados g ON g.id_grado = gf.id_grado
  WHERE g.orden_grado < new_grade_order
    AND gf.es_opcional = FALSE
  ON CONFLICT (id_alumno, id_forma) DO NOTHING;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_alumnos_sync_formas_obligatorias
AFTER INSERT OR UPDATE OF id_grado ON alumnos
FOR EACH ROW
EXECUTE FUNCTION fn_alumnos_sync_formas_obligatorias();

-- Aplica también las formas obligatorias a los alumnos ya existentes.
UPDATE alumnos SET id_grado = id_grado;