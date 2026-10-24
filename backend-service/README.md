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

Las migraciones históricas `V1`–`V12` se conservan. El runner Node las aplica en una base nueva y reconoce `flyway_schema_history` en una base existente para continuar con `V13` en adelante; no vuelve a ejecutar las migraciones ya aplicadas. V14 añade salas y su asignación a sesiones y horarios; conserva sin asignar las filas históricas cuya sala no se conoce. V15 impone una sola cuenta ADMIN y requiere consolidar cualquier base que ya tenga varias antes de migrarla. V16 deja las cuentas solo en `administradores` y `alumnos`: añade `alumnos.es_instructor` e `instructores.id_alumno`, enlaza cada instructor con el alumno de su mismo correo (o le crea uno con matrícula `INS-<id>`), retira el correo y la contraseña de `instructores`, asigna a todos los alumnos la contraseña inicial derivada del nombre (requiere la extensión `pgcrypto`) y cierra las sesiones abiertas. V17 añade participantes: `limite_participantes` (NULL = sin límite) y `mostrar_asistentes` en sesiones y horarios habituales, `participaciones_evento` (quién asiste a cada fecha y si como alumno o instructor) y `participaciones_serie` (inscripción a una serie, que ocupa plaza en las fechas futuras con sitio, también en las que se generen después). V18 quita al alumno de las actividades futuras y de sus series al desactivarlo, y protege las asistencias de fechas pasadas: no se pueden borrar, ni directamente ni en cascada (`409`). V19 añade `alumno_forma_progreso` (formas del grado que el alumno marca como «aprendiendo» y su porcentaje de avance, 0–100); el avance se borra solo al registrar la forma como sabida en `alumno_forma`.

V20 introdujo temporalmente el registro automático de formas de grados anteriores. V21 lo retira, elimina esas relaciones automáticas y deja que solo el administrador registre las formas sabidas.

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
- `POST /api/calendar/rooms` y `PATCH /api/calendar/rooms/:id` (solo `ADMIN`)
- `POST /api/calendar/courses` y `PATCH /api/calendar/courses/:id` (solo `ADMIN`)
- `GET /api/calendar/events?from=AAAA-MM-DDTHH:mm&to=AAAA-MM-DDTHH:mm&roomId=:id`
- `POST /api/calendar/events`
- `PATCH /api/calendar/events/:id`
- `POST /api/calendar/events/:id/cancel`
- `GET /api/calendar/events/:id/participants` (administrador e instructores: nombre, rol y si viene por serie)
- `POST /api/calendar/events/:id/participation` con `{ scope: 'occurrence' | 'series', role: 'ALUMNO' | 'INSTRUCTOR' }` (alumnos e instructores; solo un instructor puede elegir `INSTRUCTOR`, que no ocupa plaza; la serie se apunta desde esa fecha y omite las fechas completas, devueltas en `skipped`)
- `DELETE /api/calendar/events/:id/participation?scope=occurrence|series` (quitarse de ese día o de la serie desde ese día)
- `GET/POST /api/calendar/recurring-rules`
- `PATCH /api/calendar/recurring-rules/:id`
- `POST /api/calendar/recurring-rules/:id/cancel`
- `GET /api/me/profile` (alumnos e instructores: datos propios, grado, formas que sabe con su fecha, formas de su grado —obligatorias y opcionales— marcadas como sabidas, en aprendizaje (con su porcentaje) o pendientes y, si es instructor, especialidad y estilos; siempre la ficha de la sesión, sin parámetros)
- `PUT /api/me/forms/:formId/progress` (alumnos e instructores: marca una forma de su grado que aún no sabe como «aprendiendo» con `{ "percent": 0-100 }`; `404` si la forma no es de su grado, `409` si ya la sabe)
- `DELETE /api/me/forms/:formId/progress` (deja de marcar la forma como en aprendizaje)

Las nuevas sesiones y reglas recurrentes requieren `roomId`. Los eventos incluyen `id_sala` y `sala_nombre`; las reglas habituales conservan también su sala. Se permiten actividades simultáneas en salas distintas y se rechazan con `409` los solapamientos en la misma sala. Los registros anteriores a V14 permanecen sin sala hasta que se asignen; mientras sigan así, se tratan de forma conservadora como posibles conflictos con cualquier sala. V15 impone una única cuenta `ADMIN`.

Las fechas son horas locales del centro (`Europe/Madrid`) sin offset. Cancelar marca la sesión como inactiva; no borra el registro ni las asistencias asociadas.

Participantes: solo `ADMIN` puede enviar `participantLimit` (entero > 0 o `null` = sin límite) y `showAttendeeCount` al crear o editar sesiones y horarios habituales; un instructor que los envíe recibe `403`. Editar esos campos en un horario los aplica a todas sus sesiones futuras, y no se puede bajar el límite por debajo de los alumnos ya apuntados (`409`). Cada evento devuelve `limite_participantes`, `mostrar_asistentes`, `asistentes` (`{ alumnos, instructores }`, o `null` para cuentas `USER` cuando el número está oculto; administrador e instructores siempre lo ven), `completo` y `mi_participacion` (`{ rol, serie }` o `null`). Solo ocupa plaza quien se apunta como alumno, y no se puede cambiar la participación cuando la actividad ya ha empezado.

Solo hay dos tipos de cuenta: la única cuenta `ADMIN` y la de cada alumno. El rol de un alumno es `USER` (calendario en solo lectura y su propia asistencia) o `INSTRUCTOR` si tiene `es_instructor` y un registro de instructor activo; en ese caso programa, edita y cancela sesiones y horarios recurrentes. Cursos, salas, alumnos, grados, formas y demás altas son exclusivos de `ADMIN`. La sesión guarda la cuenta y el rol efectivo se recalcula en cada petición, de modo que activar o retirar `es_instructor`, o desactivar al alumno, se aplica de inmediato. `/api/auth/login` y `/api/auth/me` devuelven además `studentId` e `instructorId`.

Un trigger mantiene `instructores` sincronizado con `alumnos.es_instructor` (crea o reactiva el registro enlazado; al desmarcarlo lo desactiva, nunca lo borra). Otro trigger asigna a los alumnos creados sin contraseña su contraseña inicial: el nombre en minúsculas, sin acentos ni espacios. Las contraseñas que se fijen por la API deben tener al menos 8 caracteres; en una edición, una contraseña vacía deja la actual sin cambios.

La lectura y la gestión genérica de `/api/database` están reservadas a `ADMIN`. La única excepción son las operaciones de alta/baja de las asistencias propias, validadas por el backend. Los instructores reciben únicamente la información mínima de equipo mediante `GET /api/calendar/instructors`, además de las APIs específicas de agenda. La ruta HTTP `/api/database/migrate` no está disponible; las migraciones se aplican al arrancar el backend o mediante `npm run db:migrate`.

El login limita a 10 intentos por combinación de IP y correo cada 15 minutos, evitando que los intentos de una cuenta bloqueen a los instructores que comparten la conexión de la escuela. En producción, mantener el backend detrás del proxy confiable que termina HTTPS; el proceso confía en las cabeceras del proxy para determinar IP y servir cookies seguras.

## Compatibilidad y secretos

La sesión se envía en una cookie `HttpOnly`, cifrada y revocable; su estado se guarda en PostgreSQL. `SESSION_KEY` debe ser una clave aleatoria hexadecimal de 32 bytes en producción. Las credenciales de la base y esta clave se configuran mediante variables de entorno, nunca en el front.

Para crear la cuenta inicial de administración en un entorno nuevo, configura las variables de base de datos y ejecuta `npm run admin:create` desde este directorio. El comando comprueba que no exista ya una cuenta, aplica migraciones pendientes y solicita contraseña dos veces sin mostrarla en pantalla; requiere una terminal interactiva y una contraseña de al menos 8 caracteres. Guarda las credenciales en el gestor seguro del equipo. Los alumnos (y, marcando `es_instructor`, los instructores) se dan de alta desde el editor Datos con la cuenta ADMIN, que también puede cambiar sus contraseñas; el backend cifra las contraseñas recibidas.
