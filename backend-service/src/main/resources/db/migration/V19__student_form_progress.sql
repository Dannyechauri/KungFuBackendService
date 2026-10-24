-- Formas que el alumno está aprendiendo y su porcentaje de avance (lo marca el propio alumno).
-- Cuando la administración registra la forma como sabida (alumno_forma), el avance deja de tener sentido y se borra.
CREATE TABLE alumno_forma_progreso (
  id_alumno            BIGINT    NOT NULL REFERENCES alumnos(id_alumno) ON DELETE CASCADE,
  id_forma             BIGINT    NOT NULL REFERENCES formas(id_forma) ON DELETE CASCADE,
  porcentaje           SMALLINT  NOT NULL DEFAULT 0 CHECK (porcentaje BETWEEN 0 AND 100),
  fecha_actualizacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_alumno, id_forma)
);

CREATE OR REPLACE FUNCTION fn_alumno_forma_quitar_progreso()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM alumno_forma_progreso WHERE id_alumno = NEW.id_alumno AND id_forma = NEW.id_forma;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alumno_forma_quitar_progreso
AFTER INSERT OR UPDATE OF id_alumno, id_forma ON alumno_forma
FOR EACH ROW
EXECUTE FUNCTION fn_alumno_forma_quitar_progreso();
