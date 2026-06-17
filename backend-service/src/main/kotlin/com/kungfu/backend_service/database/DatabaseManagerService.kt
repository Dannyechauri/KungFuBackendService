package com.kungfu.backend_service.database

import org.flywaydb.core.Flyway
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import java.time.Instant

@Service
class DatabaseManagerService(
    private val jdbcTemplate: JdbcTemplate,
    private val flyway: Flyway,
) {
    fun health(): DatabaseHealth {
        val databaseTime = jdbcTemplate.queryForObject("SELECT NOW()", String::class.java)
        return DatabaseHealth(
            status = "UP",
            databaseTime = databaseTime,
            checkedAt = Instant.now().toString(),
        )
    }

    fun listTables(): List<String> {
        return jdbcTemplate.queryForList(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
            """.trimIndent(),
            String::class.java,
        )
    }

    fun migrate(): MigrationSummary {
        val result = flyway.migrate()
        return MigrationSummary(
            migrationsExecuted = result.migrationsExecuted,
            targetSchemaVersion = result.targetSchemaVersion,
            initialSchemaVersion = result.initialSchemaVersion,
            database = result.database,
            flywayVersion = result.flywayVersion,
        )
    }
}

data class DatabaseHealth(
    val status: String,
    val databaseTime: String?,
    val checkedAt: String,
)

data class MigrationSummary(
    val migrationsExecuted: Int,
    val targetSchemaVersion: String?,
    val initialSchemaVersion: String?,
    val database: String,
    val flywayVersion: String,
)
