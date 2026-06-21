ALTER TABLE instructores
ADD COLUMN nombre VARCHAR(100);

UPDATE instructores i
SET nombre = CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno)
FROM alumnos a
JOIN personas p ON p.id_persona = a.id_alumno
WHERE i.id_instructor = a.id_alumno;

ALTER TABLE instructores
ALTER COLUMN nombre SET NOT NULL;

CREATE TABLE instructor_estilo (
    id_instructor BIGINT NOT NULL,
    id_estilo BIGINT NOT NULL,
    PRIMARY KEY (id_instructor, id_estilo),
    CONSTRAINT fk_instructor_estilo_instructor
        FOREIGN KEY (id_instructor) REFERENCES instructores(id_instructor),
    CONSTRAINT fk_instructor_estilo_estilo
        FOREIGN KEY (id_estilo) REFERENCES estilos(id_estilo)
);

CREATE INDEX idx_instructor_estilo_instructor ON instructor_estilo(id_instructor);
CREATE INDEX idx_instructor_estilo_estilo ON instructor_estilo(id_estilo);
