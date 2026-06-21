ALTER TABLE alumnos
ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE,
ADD COLUMN IF NOT EXISTS grado VARCHAR(50),
ADD COLUMN IF NOT EXISTS correo_electronico VARCHAR(150);

UPDATE alumnos
SET grado = 'Blanco'
WHERE grado IS NULL OR grado = '';

ALTER TABLE alumnos
ALTER COLUMN grado SET DEFAULT 'Blanco';

CREATE UNIQUE INDEX IF NOT EXISTS uk_alumnos_correo_electronico
ON alumnos (correo_electronico)
WHERE correo_electronico IS NOT NULL;
