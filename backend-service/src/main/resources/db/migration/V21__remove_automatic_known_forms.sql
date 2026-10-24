DROP TRIGGER IF EXISTS trg_alumnos_sync_formas_obligatorias ON alumnos;
DROP FUNCTION IF EXISTS fn_alumnos_sync_formas_obligatorias();

DELETE FROM alumno_forma
WHERE es_automatica = TRUE;

ALTER TABLE alumno_forma
  DROP COLUMN es_automatica;