ALTER TABLE administradores
ADD COLUMN IF NOT EXISTS correo_electronico VARCHAR(150);

CREATE UNIQUE INDEX IF NOT EXISTS uk_administradores_correo_electronico
ON administradores (correo_electronico)
WHERE correo_electronico IS NOT NULL;