-- Cuentas: solo administradores y alumnos inician sesión. Un alumno marcado como
-- instructor tiene un registro enlazado en instructores y obtiene permisos de instructor.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE alumnos
  ADD COLUMN IF NOT EXISTS es_instructor BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE instructores
  ADD COLUMN IF NOT EXISTS id_alumno BIGINT UNIQUE
    REFERENCES alumnos(id_alumno) ON DELETE SET NULL;

-- Enlaza instructores existentes con el alumno que comparte su correo.
UPDATE instructores i
SET id_alumno = m.id_alumno
FROM (
  SELECT DISTINCT ON (i2.id_instructor) i2.id_instructor, a.id_alumno
  FROM instructores i2
  JOIN alumnos a ON LOWER(a.correo_electronico) = LOWER(i2.correo_electronico)
  WHERE i2.correo_electronico IS NOT NULL
  ORDER BY i2.id_instructor, a.id_alumno
) m
WHERE i.id_instructor = m.id_instructor;

-- Los instructores sin alumno reciben una cuenta de alumno propia.
INSERT INTO alumnos (numero_matricula, fecha_ingreso, activo, nombre, id_grado, correo_electronico)
SELECT
  'INS-' || i.id_instructor,
  COALESCE(i.fecha_contratacion, CURRENT_DATE),
  COALESCE(i.activo, TRUE),
  i.nombre,
  (SELECT id_grado FROM grados ORDER BY orden_grado DESC LIMIT 1),
  i.correo_electronico
FROM instructores i
WHERE i.id_alumno IS NULL;

UPDATE instructores i
SET id_alumno = a.id_alumno
FROM alumnos a
WHERE i.id_alumno IS NULL
  AND a.numero_matricula = 'INS-' || i.id_instructor;

UPDATE alumnos a
SET es_instructor = TRUE
FROM instructores i
WHERE i.id_alumno = a.id_alumno
  AND COALESCE(i.activo, TRUE);

ALTER TABLE instructores DROP COLUMN IF EXISTS password_hash;
DROP INDEX IF EXISTS uk_instructores_correo_electronico;
ALTER TABLE instructores DROP COLUMN IF EXISTS correo_electronico;

-- Contraseña inicial: nombre en minúsculas, sin acentos ni espacios.
CREATE OR REPLACE FUNCTION contrasena_inicial(nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    translate(lower(COALESCE(nombre, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '\s+', '', 'g'
  )
$$;

UPDATE alumnos
SET password_hash = crypt(contrasena_inicial(nombre), gen_salt('bf', 10));

CREATE OR REPLACE FUNCTION alumnos_contrasena_por_defecto()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.password_hash IS NULL OR NEW.password_hash = '' THEN
    NEW.password_hash := crypt(contrasena_inicial(NEW.nombre), gen_salt('bf', 10));
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_alumnos_contrasena_por_defecto ON alumnos;
CREATE TRIGGER trg_alumnos_contrasena_por_defecto
  BEFORE INSERT ON alumnos
  FOR EACH ROW EXECUTE FUNCTION alumnos_contrasena_por_defecto();

-- Mantiene el registro de instructores sincronizado con el indicador del alumno.
-- Nunca se borra el instructor porque la agenda lo referencia.
CREATE OR REPLACE FUNCTION alumnos_sincronizar_instructor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.es_instructor AND NEW.activo THEN
    UPDATE instructores
    SET activo = TRUE, nombre = NEW.nombre
    WHERE id_alumno = NEW.id_alumno;
    IF NOT FOUND THEN
      INSERT INTO instructores (nombre, fecha_contratacion, activo, id_alumno)
      VALUES (NEW.nombre, CURRENT_DATE, TRUE, NEW.id_alumno);
    END IF;
  ELSE
    UPDATE instructores
    SET activo = FALSE, nombre = NEW.nombre
    WHERE id_alumno = NEW.id_alumno;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_alumnos_sincronizar_instructor ON alumnos;
CREATE TRIGGER trg_alumnos_sincronizar_instructor
  AFTER INSERT OR UPDATE OF es_instructor, activo, nombre ON alumnos
  FOR EACH ROW EXECUTE FUNCTION alumnos_sincronizar_instructor();

-- Las sesiones anteriores guardaban identificadores de instructor.
DELETE FROM api_sessions;
