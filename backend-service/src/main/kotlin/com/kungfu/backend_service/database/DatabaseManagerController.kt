package com.kungfu.backend_service.database

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
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

    @PostMapping("/migrate")
    fun migrate(): MigrationSummary {
        return databaseManagerService.migrate()
    }
}
