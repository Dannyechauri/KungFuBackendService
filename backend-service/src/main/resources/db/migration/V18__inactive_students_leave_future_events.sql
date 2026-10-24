-- Al desactivar un alumno se le quita de las actividades que aún no han empezado
-- y de las series a las que estaba apuntado. Las asistencias pasadas se conservan.
CREATE OR REPLACE FUNCTION fn_alumnos_quitar_participaciones_futuras()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM participaciones_evento pe
  USING cursos_agendados ca
  WHERE pe.id_curso_agendado = ca.id_curso_agendado
    AND pe.id_alumno = NEW.id_alumno
    AND ca.fecha_hora > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid');

  DELETE FROM participaciones_serie WHERE id_alumno = NEW.id_alumno;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alumnos_quitar_participaciones_futuras
AFTER UPDATE OF activo ON alumnos
FOR EACH ROW
WHEN (OLD.activo IS DISTINCT FROM NEW.activo AND NEW.activo = FALSE)
EXECUTE FUNCTION fn_alumnos_quitar_participaciones_futuras();

-- Las asistencias de actividades que ya han empezado no se pueden borrar
-- (tampoco en cascada al borrar el alumno o la actividad).
CREATE OR REPLACE FUNCTION fn_participaciones_evento_proteger_pasadas()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cursos_agendados
    WHERE id_curso_agendado = OLD.id_curso_agendado
      AND fecha_hora <= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')
  ) THEN
    RAISE EXCEPTION 'No se pueden borrar asistencias de fechas pasadas.'
      USING ERRCODE = '23001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_participaciones_evento_proteger_pasadas
BEFORE DELETE ON participaciones_evento
FOR EACH ROW
EXECUTE FUNCTION fn_participaciones_evento_proteger_pasadas();
