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

El servidor escucha en `http://127.0.0.1:8080` y aplica migraciones pendientes al arrancar. El lanzador del front puede arrancarlo junto con la base y los datos de demostración con `npm run dev` desde `KungFuSchoolWebPage`.

Las migraciones históricas `V1`–`V12` se conservan. El runner Node las aplica en una base nueva y reconoce `flyway_schema_history` en una base existente para continuar con `V13` y `V14`; no vuelve a ejecutar las migraciones ya aplicadas. V14 añade salas y su asignación a sesiones y horarios; conserva sin asignar las filas históricas cuya sala no se conoce.

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
- `POST /api/calendar/rooms` y `PATCH /api/calendar/rooms/:id` (solo administradores)
- `GET /api/calendar/events?from=AAAA-MM-DDTHH:mm&to=AAAA-MM-DDTHH:mm&roomId=:id`
- `POST /api/calendar/events`
- `PATCH /api/calendar/events/:id`
- `POST /api/calendar/events/:id/cancel`
- `GET/POST /api/calendar/recurring-rules`
- `PATCH /api/calendar/recurring-rules/:id`
- `POST /api/calendar/recurring-rules/:id/cancel`

Las nuevas sesiones y reglas recurrentes requieren `roomId`. Los eventos incluyen `id_sala` y `sala_nombre`; las reglas habituales conservan también su sala. Se permiten actividades simultáneas en salas distintas y se rechazan con `409` los solapamientos en la misma sala. Los registros anteriores a V14 permanecen sin sala hasta que se asignen; mientras sigan así, se tratan de forma conservadora como posibles conflictos con cualquier sala.

Las fechas son horas locales del centro (`Europe/Madrid`) sin offset. Cancelar marca la sesión como inactiva; no borra el registro ni las asistencias asociadas.

Los administradores e instructores pueden gestionar la agenda. Los usuarios pueden consultar eventos, pero no acceder a las tablas internas de gestión.

## Compatibilidad y secretos

La sesión se envía en una cookie `HttpOnly`, cifrada y revocable; su estado se guarda en PostgreSQL. `SESSION_KEY` debe ser una clave aleatoria hexadecimal de 32 bytes en producción. Las credenciales de la base y esta clave se configuran mediante variables de entorno, nunca en el front.
