# Backend de la escuela (Node.js + TypeScript)

API Fastify con PostgreSQL. Mantiene los endpoints usados por la web (`/api/auth` y `/api/database`) y añade una API de agenda con salas, clases habituales, cursos especiales, intervalos de inicio/fin, cancelación y generación de sesiones recurrentes.

## Requisitos

- Node.js 24.21.0 y npm 11.19.0, igual que el front.
- PostgreSQL local para desarrollo.

## Desarrollo local

Desde esta carpeta:

```text
npm ci
```

Configura las variables de PostgreSQL como `.env.local` o pásalas en el entorno. `.env.example` documenta los nombres; no contiene credenciales. Después:

```text
npm run dev
```

El servidor escucha en `http://127.0.0.1:8080` y aplica migraciones pendientes al arrancar en desarrollo. En producción no migra automáticamente: ejecutar `npm run db:migrate` con credenciales de migración antes de arrancar la nueva versión; así el usuario de base del proceso web puede tener menos privilegios. El lanzador del front puede arrancarlo junto con la base y los datos de demostración con `npm run dev` desde `KungFuSchoolWebPage`.

Las migraciones históricas `V1`–`V12` se conservan. El runner Node las aplica en una base nueva y reconoce `flyway_schema_history` en una base existente para continuar con `V13`–`V15`; no vuelve a ejecutar las migraciones ya aplicadas. V14 añade salas y su asignación a sesiones y horarios; conserva sin asignar las filas históricas cuya sala no se conoce. V15 impone una sola cuenta ADMIN y requiere consolidar cualquier base que ya tenga varias antes de migrarla.

## Comprobaciones

```text
npm run typecheck
npm run lint
npm test
npm run build
```

Las pruebas crean una base PostgreSQL local con un nombre aleatorio `kungfu_node_test_*` y una marca de propiedad; solo esa base temporal se elimina al acabar. Se niegan a conectarse a un host remoto.

## API de agenda

- `GET /api/calendar/rooms`
- `GET /api/calendar/instructors` (solo `ADMIN` e `INSTRUCTOR`; devuelve nombre, id y estado)
- `POST /api/calendar/rooms` y `PATCH /api/calendar/rooms/:id` (equipo docente)
- `GET /api/calendar/events?from=AAAA-MM-DDTHH:mm&to=AAAA-MM-DDTHH:mm&roomId=:id`
- `POST /api/calendar/events`
- `PATCH /api/calendar/events/:id`
- `POST /api/calendar/events/:id/cancel`
- `GET/POST /api/calendar/recurring-rules`
- `PATCH /api/calendar/recurring-rules/:id`
- `POST /api/calendar/recurring-rules/:id/cancel`

Las nuevas sesiones y reglas recurrentes requieren `roomId`. Los eventos incluyen `id_sala` y `sala_nombre`; las reglas habituales conservan también su sala. Se permiten actividades simultáneas en salas distintas y se rechazan con `409` los solapamientos en la misma sala. Los registros anteriores a V14 permanecen sin sala hasta que se asignen; mientras sigan así, se tratan de forma conservadora como posibles conflictos con cualquier sala. V15 impone una única cuenta `ADMIN`.

Las fechas son horas locales del centro (`Europe/Madrid`) sin offset. Cancelar marca la sesión como inactiva; no borra el registro ni las asistencias asociadas.

Hay tres roles de aplicación: una cuenta `ADMIN` para intervención del equipo de desarrollo; `INSTRUCTOR` para el maestro y los instructores, con gestión completa de agenda, cursos y salas; y `USER`, reservado para futuros flujos de la aplicación de alumnos. No existe un rol supremo ni varios niveles de instructor. La web rechaza `USER`; el backend conserva ese rol para clientes futuros.

La lectura y la gestión genérica de `/api/database` están reservadas a `ADMIN`. La única excepción son las operaciones de alta/baja de las asistencias propias, validadas por el backend. Los instructores reciben únicamente la información mínima de equipo mediante `GET /api/calendar/instructors`, además de las APIs específicas de agenda. La ruta HTTP `/api/database/migrate` no está disponible; las migraciones se aplican al arrancar el backend o mediante `npm run db:migrate`.

El login limita a 10 intentos por combinación de IP y correo cada 15 minutos, evitando que los intentos de una cuenta bloqueen a los instructores que comparten la conexión de la escuela. En producción, mantener el backend detrás del proxy confiable que termina HTTPS; el proceso confía en las cabeceras del proxy para determinar IP y servir cookies seguras.

## Compatibilidad y secretos

La sesión se envía en una cookie `HttpOnly`, cifrada y revocable; su estado se guarda en PostgreSQL. `SESSION_KEY` debe ser una clave aleatoria hexadecimal de 32 bytes en producción. Las credenciales de la base y esta clave se configuran mediante variables de entorno, nunca en el front.

Para crear la cuenta inicial de administración en un entorno nuevo, configura las variables de base de datos y ejecuta `npm run admin:create` desde este directorio. El comando comprueba que no exista ya una cuenta, aplica migraciones pendientes y solicita contraseña dos veces sin mostrarla en pantalla; requiere una terminal interactiva y una contraseña de al menos 12 caracteres. Guarda las credenciales en el gestor seguro del equipo. Las cuentas de instructores se pueden dar de alta desde el editor Datos con la cuenta ADMIN; el backend cifra las contraseñas recibidas.
