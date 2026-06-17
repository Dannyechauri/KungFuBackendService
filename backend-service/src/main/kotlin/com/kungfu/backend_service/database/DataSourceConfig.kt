package com.kungfu.backend_service.database

import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary
import java.sql.DriverManager
import javax.sql.DataSource

@Configuration
class DataSourceConfig {

    private val logger = LoggerFactory.getLogger(javaClass)

    @Bean
    @Primary
    fun dataSource(properties: DataSourceProperties): DataSource {
        ensureDatabaseExists(properties.url, properties.username, properties.password)
        return properties.initializeDataSourceBuilder().build()
    }

    private fun ensureDatabaseExists(url: String, username: String, password: String) {
        val dbName = url.substringAfterLast("/").substringBefore("?")
        val adminUrl = url.substringBeforeLast("/") + "/postgres"
        try {
            DriverManager.getConnection(adminUrl, username, password).use { conn ->
                conn.prepareStatement("SELECT 1 FROM pg_database WHERE datname = ?").use { stmt ->
                    stmt.setString(1, dbName)
                    if (!stmt.executeQuery().next()) {
                        logger.info("Base de datos '$dbName' no encontrada. Creando...")
                        conn.createStatement().execute("""CREATE DATABASE "$dbName"""")
                        logger.info("Base de datos '$dbName' creada exitosamente.")
                    } else {
                        logger.info("Base de datos '$dbName' ya existe.")
                    }
                }
            }
        } catch (e: Exception) {
            logger.warn("No se pudo auto-crear la base de datos '{}': {}", dbName, e.message)
        }
    }
}
