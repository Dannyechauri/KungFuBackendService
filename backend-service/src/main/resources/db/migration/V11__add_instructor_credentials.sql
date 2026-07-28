ALTER TABLE instructores
ADD COLUMN IF NOT EXISTS correo_electronico VARCHAR(150);

ALTER TABLE instructores
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uk_instructores_correo_electronico
ON instructores (LOWER(correo_electronico))
WHERE correo_electronico IS NOT NULL;
