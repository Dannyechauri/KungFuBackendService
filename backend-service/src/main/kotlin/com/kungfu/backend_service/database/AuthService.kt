package com.kungfu.backend_service.database

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.web.server.ResponseStatusException
import org.springframework.http.HttpStatus

@Service
class AuthService(
    private val jdbcTemplate: JdbcTemplate,
) {
    private val passwordEncoder: PasswordEncoder = BCryptPasswordEncoder()

    fun authenticate(request: LoginRequest): SessionUser {
        val email = request.email.trim().lowercase()
        val password = request.password

        require(email.isNotBlank()) {
            "Correo obligatorio."
        }

        val candidates = mutableListOf<AuthCandidate>()
        findAdminByEmail(email)?.let { candidates.add(it) }
        findStudentByEmail(email)?.let { candidates.add(it) }

        if (candidates.isEmpty()) {
            throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "Credenciales inválidas")
        }

        val authenticated = candidates.firstOrNull { candidate ->
            !candidate.passwordHash.isNullOrBlank() && passwordEncoder.matches(password, candidate.passwordHash)
        } ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "Credenciales inválidas")

        return SessionUser(
            role = authenticated.role,
            userId = authenticated.userId,
            displayName = authenticated.displayName,
        )
    }

    private fun findAdminByEmail(email: String): AuthCandidate? {
        return jdbcTemplate.query(
            """
            SELECT id_administrador, nombre, password_hash
            FROM administradores
            WHERE LOWER(correo_electronico) = LOWER(?)
            LIMIT 1
            """.trimIndent(),
            { rs, _ ->
                AuthCandidate(
                    role = Roles.ADMIN,
                    userId = rs.getLong("id_administrador"),
                    displayName = rs.getString("nombre") ?: "Administrador",
                    passwordHash = rs.getString("password_hash"),
                )
            },
            email,
        ).firstOrNull()
    }

    private fun findStudentByEmail(email: String): AuthCandidate? {
        return jdbcTemplate.query(
            """
            SELECT id_alumno, COALESCE(nombre, numero_matricula, 'Alumno') AS nombre_mostrado, password_hash
            FROM alumnos
            WHERE LOWER(correo_electronico) = LOWER(?)
            LIMIT 1
            """.trimIndent(),
            { rs, _ ->
                AuthCandidate(
                    role = Roles.USER,
                    userId = rs.getLong("id_alumno"),
                    displayName = rs.getString("nombre_mostrado") ?: "Alumno",
                    passwordHash = rs.getString("password_hash"),
                )
            },
            email,
        ).firstOrNull()
    }
}

data class LoginRequest(
    val email: String,
    val password: String,
)

data class SessionUser(
    val role: String,
    val userId: Long,
    val displayName: String,
)

data class AuthSessionResponse(
    val authenticated: Boolean,
    val role: String,
    val userId: Long,
    val displayName: String,
)

data class LogoutResponse(
    val authenticated: Boolean,
)

data class AuthCandidate(
    val role: String,
    val userId: Long,
    val displayName: String,
    val passwordHash: String?,
)

object Roles {
    const val ADMIN = "ADMIN"
    const val USER = "USER"
}
