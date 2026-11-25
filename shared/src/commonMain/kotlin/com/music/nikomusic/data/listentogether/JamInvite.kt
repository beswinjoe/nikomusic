package com.music.nikomusic.data.listentogether

/**
 * The public invite URL for a party, and the only shape that is accepted back.
 *
 * Shared because both applications have to agree on it exactly: a link built on one and opened on
 * the other must resolve to the same code, and a link that is not this shape must be refused on
 * both rather than half-parsed into a join attempt.
 */
object JamInvite {

    const val ORIGIN = ""

    /** How many characters a party code carries. */
    const val CODE_LENGTH = 6

    /** The normalized party code, for the configured public HTTPS invite URL shape only. */
    fun parse(value: String?, origin: String = ORIGIN): String? {
        val cleanOrigin = origin.trim().trimEnd('/')
        if (!cleanOrigin.startsWith("https://", ignoreCase = true)) return null
        val text = value?.trim() ?: return null
        val prefix = "$cleanOrigin/invite/"
        if (!text.startsWith(prefix, ignoreCase = true)) return null
        // Not removePrefix: it is case-sensitive, and the check above is not.
        val code = text.substring(prefix.length).substringBefore('?').substringBefore('#')
        if (code.length != CODE_LENGTH || !code.all(Char::isLetterOrDigit)) return null
        return code.uppercase()
    }

    fun url(code: String, origin: String = ORIGIN): String {
        val cleanOrigin = origin.trim().trimEnd('/')
        return if (cleanOrigin.isBlank()) "" else "$cleanOrigin/invite/${code.uppercase()}"
    }
}
