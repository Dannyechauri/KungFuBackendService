package com.kungfu.backend_service.database

import jakarta.servlet.http.HttpSession
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException

@RestController
@RequestMapping("/api/database")
class DatabaseManagerController(
    private val databaseManagerService: DatabaseManagerService,
) {
    private val blockedUserReadTables = setOf("administradores", "flyway_schema_history")
    private val blockedAllMutationTables = setOf("flyway_schema_history")
    // Tablas donde cualquier usuario autenticado puede gestionar sus propias filas
    private val selfServiceTables = setOf("asistencias_curso")

    @GetMapping("/health")
    fun health(): DatabaseHealth {
        return databaseManagerService.health()
    }

    @GetMapping("/tables")
    fun tables(session: HttpSession): List<String> {
        val currentUser = requireAuthenticated(session)
        val tables = databaseManagerService.listTables()

        return if (currentUser.role == Roles.ADMIN) {
            tables
        } else {
            tables.filter { it !in blockedUserReadTables }
        }
    }

    @GetMapping("/tables/{tableName}/columns")
    fun tableColumns(
        @PathVariable tableName: String,
        session: HttpSession,
    ): List<TableColumnInfo> {
        requireCanReadTable(session, tableName)
        return databaseManagerService.listColumns(tableName)
    }

    @GetMapping("/tables/{tableName}/rows")
    fun tableRows(
        @PathVariable tableName: String,
        @RequestParam(defaultValue = "100") limit: Int,
        session: HttpSession,
    ): List<Map<String, Any?>> {
        requireCanReadTable(session, tableName)
        return databaseManagerService.listRows(tableName, limit)
    }

    @PostMapping("/tables/{tableName}/rows")
    fun insertRow(
        @PathVariable tableName: String,
        @RequestBody payload: Map<String, Any?>,
        session: HttpSession,
    ): Map<String, Any?> {
        val user = requireAuthenticated(session)
        if (tableName !in selfServiceTables && user.role != Roles.ADMIN) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Permiso de administrador requerido")
        }
        requireTableMutationAllowed(tableName)
        return databaseManagerService.insertRow(tableName, payload)
    }

    @PutMapping("/tables/{tableName}/rows/{id}")
    fun updateRow(
        @PathVariable tableName: String,
        @PathVariable id: String,
        @RequestBody payload: Map<String, Any?>,
        session: HttpSession,
    ): Map<String, Any?> {
        requireAdmin(session)
        requireTableMutationAllowed(tableName)

        if (tableName == "administradores") {
            throw ResponseStatusException(
                HttpStatus.FORBIDDEN,
                "Los administradores pueden crearse y borrarse, pero no editarse.",
            )
        }

        return databaseManagerService.updateRowByPrimaryKey(tableName, id, payload)
    }

    @DeleteMapping("/tables/{tableName}/rows/{id}")
    fun deleteRow(
        @PathVariable tableName: String,
        @PathVariable id: String,
        session: HttpSession,
    ): DeleteResult {
        val user = requireAuthenticated(session)
        if (tableName !in selfServiceTables && user.role != Roles.ADMIN) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Permiso de administrador requerido")
        }
        requireTableMutationAllowed(tableName)
        val deleted = databaseManagerService.deleteRowByPrimaryKey(tableName, id)
        return DeleteResult(deleted = deleted)
    }

    @PostMapping("/migrate")
    fun migrate(session: HttpSession): MigrationSummary {
        requireAdmin(session)
        return databaseManagerService.migrate()
    }

    private fun requireAuthenticated(session: HttpSession): SessionUser {
        return session.getAttribute(SESSION_USER_KEY) as? SessionUser
            ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "Inicie sesión para continuar")
    }

    private fun requireAdmin(session: HttpSession): SessionUser {
        val user = requireAuthenticated(session)
        if (user.role != Roles.ADMIN) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Permiso de administrador requerido")
        }
        return user
    }

    private fun requireCanReadTable(session: HttpSession, tableName: String) {
        val user = requireAuthenticated(session)
        if (user.role != Roles.ADMIN && tableName in blockedUserReadTables) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "No tiene permisos para consultar esta tabla")
        }
    }

    private fun requireTableMutationAllowed(tableName: String) {
        if (tableName in blockedAllMutationTables) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "No se permite modificar esta tabla")
        }
    }
}

data class DeleteResult(
    val deleted: Boolean,
)
