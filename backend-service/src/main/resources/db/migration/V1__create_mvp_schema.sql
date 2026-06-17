CREATE TABLE personas (
    id_persona BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    apellido_paterno VARCHAR(100) NOT NULL,
    apellido_materno VARCHAR(100),
    fecha_nacimiento DATE NOT NULL,
    telefono VARCHAR(15),
    email VARCHAR(150) UNIQUE,
    direccion VARCHAR(255),
    foto_url VARCHAR(255),
    fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alumnos (
    id_alumno BIGINT PRIMARY KEY,
    numero_matricula VARCHAR(20) UNIQUE NOT NULL,
    fecha_ingreso DATE NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_alumno_persona
        FOREIGN KEY (id_alumno) REFERENCES personas(id_persona)
);

CREATE TABLE instructores (
    id_instructor BIGINT PRIMARY KEY,
    fecha_contratacion DATE NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    especialidad VARCHAR(100),
    CONSTRAINT fk_instructor_alumno
        FOREIGN KEY (id_instructor) REFERENCES alumnos(id_alumno)
);

CREATE TABLE administradores (
    id_administrador BIGINT PRIMARY KEY,
    fecha_inicio DATE NOT NULL,
    CONSTRAINT fk_administrador_persona
        FOREIGN KEY (id_administrador) REFERENCES personas(id_persona)
);

CREATE TABLE usuarios (
    id_usuario BIGSERIAL PRIMARY KEY,
    id_persona BIGINT NOT NULL UNIQUE,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    rol VARCHAR(20) NOT NULL CHECK (rol IN ('administrador', 'instructor', 'alumno')),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    ultimo_acceso TIMESTAMP,
    CONSTRAINT fk_usuario_persona
        FOREIGN KEY (id_persona) REFERENCES personas(id_persona)
);

CREATE TABLE estilos (
    id_estilo BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(50) UNIQUE NOT NULL,
    descripcion VARCHAR(255)
);

CREATE TABLE formas (
    id_forma BIGSERIAL PRIMARY KEY,
    id_estilo BIGINT NOT NULL,
    nombre VARCHAR(120) UNIQUE NOT NULL,
    descripcion VARCHAR(255),
    CONSTRAINT fk_forma_estilo
        FOREIGN KEY (id_estilo) REFERENCES estilos(id_estilo)
);

CREATE TABLE grados (
    id_grado BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    orden_grado INT UNIQUE NOT NULL,
    color_cinturon VARCHAR(30) NOT NULL,
    formas_requeridas INT NOT NULL DEFAULT 0 CHECK (formas_requeridas >= 0)
);

CREATE TABLE grado_forma (
    id_grado BIGINT NOT NULL,
    id_forma BIGINT NOT NULL,
    es_opcional BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (id_grado, id_forma),
    CONSTRAINT fk_grado_forma_grado
        FOREIGN KEY (id_grado) REFERENCES grados(id_grado),
    CONSTRAINT fk_grado_forma_forma
        FOREIGN KEY (id_forma) REFERENCES formas(id_forma)
);

CREATE TABLE alumno_forma (
    id_alumno BIGINT NOT NULL,
    id_forma BIGINT NOT NULL,
    fecha_aprendida DATE NOT NULL,
    PRIMARY KEY (id_alumno, id_forma),
    CONSTRAINT fk_alumno_forma_alumno
        FOREIGN KEY (id_alumno) REFERENCES alumnos(id_alumno),
    CONSTRAINT fk_alumno_forma_forma
        FOREIGN KEY (id_forma) REFERENCES formas(id_forma)
);

CREATE TABLE cursos (
    id_curso BIGSERIAL PRIMARY KEY,
    id_instructor BIGINT NOT NULL,
    nombre VARCHAR(100) NOT NULL,
    tema VARCHAR(120) NOT NULL,
    descripcion VARCHAR(255),
    fecha_hora TIMESTAMP NOT NULL,
    CONSTRAINT fk_curso_instructor
        FOREIGN KEY (id_instructor) REFERENCES instructores(id_instructor)
);

CREATE TABLE inscripciones (
    id_inscripcion BIGSERIAL PRIMARY KEY,
    id_alumno BIGINT NOT NULL,
    id_curso BIGINT NOT NULL,
    fecha_inscripcion DATE NOT NULL DEFAULT CURRENT_DATE,
    estado VARCHAR(20) NOT NULL DEFAULT 'activa'
        CHECK (estado IN ('activa', 'inactiva', 'suspendida')),
    CONSTRAINT fk_inscripcion_alumno
        FOREIGN KEY (id_alumno) REFERENCES alumnos(id_alumno),
    CONSTRAINT fk_inscripcion_curso
        FOREIGN KEY (id_curso) REFERENCES cursos(id_curso),
    CONSTRAINT uk_inscripcion_alumno_curso UNIQUE (id_alumno, id_curso)
);

CREATE INDEX idx_formas_estilo ON formas(id_estilo);
CREATE INDEX idx_grado_forma_grado ON grado_forma(id_grado);
CREATE INDEX idx_alumno_forma_alumno ON alumno_forma(id_alumno);
CREATE INDEX idx_cursos_instructor_fecha ON cursos(id_instructor, fecha_hora);
CREATE INDEX idx_inscripciones_curso ON inscripciones(id_curso);
CREATE INDEX idx_inscripciones_alumno ON inscripciones(id_alumno);

INSERT INTO estilos(nombre, descripcion) VALUES
('Ving Tsun', 'Estilo tradicional de origen chino'),
('Jungar', 'Estilo enfocado en fuerza y disciplina'),
('Shaolin', 'Estilo tradicional asociado a formas clasicas');