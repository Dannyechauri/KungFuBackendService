package com.kungfu.backend_service.database

import jakarta.servlet.http.HttpSession
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException

@RestController
@RequestMapping("/api/auth")
class AuthController(
    private val authService: AuthService,
) {
    @PostMapping("/login")
    fun login(
        @RequestBody request: LoginRequest,
        session: HttpSession,
    ): AuthSessionResponse {
        val user = authService.authenticate(request)
        session.setAttribute(SESSION_USER_KEY, user)
        return user.toResponse()
    }

    @GetMapping("/me")
    fun me(session: HttpSession): AuthSessionResponse {
        val user = session.getAttribute(SESSION_USER_KEY) as? SessionUser
            ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sesión no autenticada")
        return user.toResponse()
    }

    @DeleteMapping("/logout")
    fun logout(session: HttpSession): LogoutResponse {
        session.invalidate()
        return LogoutResponse(authenticated = false)
    }

    private fun SessionUser.toResponse(): AuthSessionResponse {
        return AuthSessionResponse(
            authenticated = true,
            role = role,
            userId = userId,
            displayName = displayName,
        )
    }
}

const val SESSION_USER_KEY = "sessionUser"
