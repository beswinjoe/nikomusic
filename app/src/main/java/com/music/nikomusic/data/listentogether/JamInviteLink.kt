package com.music.nikomusic.data.listentogether

import android.content.Intent
import com.music.nikomusic.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

data class ParsedJamInvite(
    val code: String,
    val serverUrl: String? = null,
)

/** Relays a Niko Music web or scheme invite from [com.music.nikomusic.MainActivity] to Compose. */
object JamInviteLink {

    val ORIGIN: String
        get() = (BuildConfig.JAM_INVITE_ORIGIN.ifBlank { ListenTogether.defaultServer })
            .trim()
            .trimEnd('/')

    private const val EXTRA_CONSUMED = "nikomusic.jamInviteConsumed"
    private const val CUSTOM_SCHEME = "nikomusic"
    private const val CUSTOM_HOST = "party"

    private fun hostOf(origin: String): String? {
        if (!origin.startsWith("https://", ignoreCase = true)) return null
        return runCatching { URI(origin).host?.lowercase() }.getOrNull()
    }

    private val _pending = MutableStateFlow<ParsedJamInvite?>(null)
    val pending: StateFlow<ParsedJamInvite?> = _pending.asStateFlow()

    /** Reads a web invite from a cold launch or a new intent on the existing task. */
    fun consume(intent: Intent?): Boolean {
        if (
            intent == null ||
            intent.action != Intent.ACTION_VIEW ||
            intent.getBooleanExtra(EXTRA_CONSUMED, false)
        ) return false

        val invite = parseInvite(intent.dataString) ?: return false
        intent.putExtra(EXTRA_CONSUMED, true)
        _pending.value = invite
        return true
    }

    fun handled() {
        _pending.value = null
    }

    /** Returns the normalized party code only for the public invite URL shape. */
    fun parse(value: String?, defaultOrigin: String = ORIGIN): String? =
        parseInvite(value, defaultOrigin)?.code

    /**
     * Parses an incoming invite:
     * 1. `nikomusic://party/<CODE>?server=<SERVER>`
     * 2. `<defaultOrigin>/invite/<CODE>?server=<SERVER>` (when `defaultOrigin` is HTTPS)
     */
    fun parseInvite(value: String?, defaultOrigin: String = ORIGIN): ParsedJamInvite? {
        val uri = runCatching { URI(value ?: return null) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val query = uri.rawQuery
        val server = extractQueryParam(query, "server")?.let { sanitizeServerUrl(it) }

        // 1. Custom scheme: nikomusic://party/<CODE> or nikomusic://party?code=<CODE>
        if (scheme == CUSTOM_SCHEME && host == CUSTOM_HOST) {
            val pathPart = uri.path.orEmpty().trim('/').takeIf { it.isNotBlank() }
            val candidate = pathPart ?: extractQueryParam(query, "code") ?: return null
            val code = cleanCode(candidate) ?: return null
            return ParsedJamInvite(code = code, serverUrl = server)
        }

        // 2. Configured HTTPS web domain: <defaultOrigin>/invite/<CODE>
        val configuredHost = hostOf(defaultOrigin.trim().trimEnd('/'))
        if (scheme == "https" && configuredHost != null && host == configuredHost) {
            val match = INVITE_PATH.matchEntire(uri.path.orEmpty()) ?: return null
            val code = match.groupValues[1].uppercase()
            return ParsedJamInvite(code = code, serverUrl = server)
        }

        return null
    }

    fun url(code: String, customServer: String? = null, defaultOrigin: String = ORIGIN): String {
        val normalizedCode = code.uppercase()
        val base = customServer?.trim()?.trimEnd('/')
        val cleanOrigin = defaultOrigin.trim().trimEnd('/')
        return when {
            !base.isNullOrBlank() && !base.equals(cleanOrigin, ignoreCase = true) ->
                "$base/invite/$normalizedCode"
            cleanOrigin.isNotBlank() ->
                "$cleanOrigin/invite/$normalizedCode"
            else ->
                schemeUrl(normalizedCode, null)
        }
    }

    fun schemeUrl(code: String, customServer: String? = null): String {
        val normalizedCode = code.uppercase()
        val base = customServer?.trim()?.trimEnd('/')
        return if (!base.isNullOrBlank()) {
            val encoded = runCatching { URLEncoder.encode(base, "UTF-8") }.getOrDefault(base)
            "nikomusic://party/$normalizedCode?server=$encoded"
        } else {
            "nikomusic://party/$normalizedCode"
        }
    }

    private fun cleanCode(raw: String): String? {
        val cleaned = raw.filter { it.isLetterOrDigit() }.uppercase()
        return if (cleaned.length == ListenTogether.CODE_LENGTH) cleaned else null
    }

    private fun extractQueryParam(query: String?, paramName: String): String? {
        if (query.isNullOrBlank()) return null
        return query.split('&').asSequence()
            .map { it.split('=', limit = 2) }
            .firstOrNull { it.isNotEmpty() && it[0].equals(paramName, ignoreCase = true) }
            ?.getOrNull(1)
            ?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrDefault(it) }
    }

    private fun sanitizeServerUrl(raw: String?): String? {
        val trimmed = raw?.trim()?.trimEnd('/') ?: return null
        if (trimmed.isBlank()) return null
        val withScheme = if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) {
            trimmed
        } else {
            "https://$trimmed"
        }
        val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
        if (uri.host.isNullOrBlank()) return null
        return withScheme
    }

    private val INVITE_PATH = Regex("""/invite/([A-Za-z0-9]{${ListenTogether.CODE_LENGTH}})""")
}

