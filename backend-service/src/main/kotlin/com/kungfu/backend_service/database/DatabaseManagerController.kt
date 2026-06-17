package com.kungfu.backend_service.database

import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/database")
class DatabaseManagerController(
    private val databaseManagerService: DatabaseManagerService,
) {
    @GetMapping("/health")
    fun health(): DatabaseHealth {
        return databaseManagerService.health()
    }

    @GetMapping("/tables")
    fun tables(): List<String> {
        return databaseManagerService.listTables()
    }

    @GetMapping("/tables/{tableName}/columns")
    fun tableColumns(
        @PathVariable tableName: String,
    ): List<TableColumnInfo> {
        return databaseManagerService.listColumns(tableName)
    }

    @GetMapping("/tables/{tableName}/rows")
    fun tableRows(
        @PathVariable tableName: String,
        @RequestParam(defaultValue = "100") limit: Int,
    ): List<Map<String, Any?>> {
        return databaseManagerService.listRows(tableName, limit)
    }

    @PostMapping("/tables/{tableName}/rows")
    fun insertRow(
        @PathVariable tableName: String,
        @RequestBody payload: Map<String, Any?>,
    ): Map<String, Any?> {
        return databaseManagerService.insertRow(tableName, payload)
    }

    @DeleteMapping("/tables/{tableName}/rows/{id}")
    fun deleteRow(
        @PathVariable tableName: String,
        @PathVariable id: String,
    ): DeleteResult {
        val deleted = databaseManagerService.deleteRowByPrimaryKey(tableName, id)
        return DeleteResult(deleted = deleted)
    }

    @PostMapping("/migrate")
    fun migrate(): MigrationSummary {
        return databaseManagerService.migrate()
    }
}

data class DeleteResult(
    val deleted: Boolean,
)
