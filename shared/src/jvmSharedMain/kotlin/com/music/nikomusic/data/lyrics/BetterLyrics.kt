package com.music.nikomusic.data.lyrics

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlin.math.abs

/**
 * Word-timed lyrics from BetterLyrics — the backend behind the YouTube Music
 * browser extension of the same name.
 *
 * One key-less call keyed on title, artist and duration, answering with Apple
 * Music's own TTML. That combination is why it leads the chain: no track-id
 * lookup, no token to scrape, no login, and the timing is per-syllable.
 *
 * Note this is the extension's original host. The project's newer Cloudflare
 * API puts the same endpoint behind a Turnstile challenge, which a native
 * client has no way to answer.
 */
object BetterLyrics {

    private const val BASE = "https://lyrics-api.boidu.dev/getLyrics"
    private const val PORTATO = "https://lyrics-api.boidu.dev/qq/getLyrics"

    suspend fun lyrics(
        title: String,
        artist: String,
        durationMs: Long,
        album: String? = null,
    ): List<LyricLine>? = fetch(BASE, title, artist, durationMs, album)

    /** QQ Music's karaoke timings through BetterLyrics' Portato endpoint. */
    suspend fun portato(
        title: String,
        artist: String,
        durationMs: Long,
        album: String? = null,
    ): List<LyricLine>? = fetch(PORTATO, title, artist, durationMs, album)

    private suspend fun fetch(
        endpoint: String,
        title: String,
        artist: String,
        durationMs: Long,
        album: String?,
    ): List<LyricLine>? = withContext(Dispatchers.IO) {
        requestOnce(endpoint, title, artist, durationMs, album)?.let { return@withContext it }
        val lead = leadLyricsArtist(artist)
        if (lead.isNotBlank() && lead != artist) {
            return@withContext requestOnce(endpoint, title, lead, durationMs, album)
        }
        null
    }

    private suspend fun requestOnce(
        endpoint: String,
        title: String,
        artist: String,
        durationMs: Long,
        album: String?,
    ): List<LyricLine>? {
        val url = endpoint.toHttpUrl().newBuilder()
            .addQueryParameter("s", title)
            .addQueryParameter("a", artist)
            .apply {
                val seconds = durationMs / 1000
                if (seconds > 0) addQueryParameter("d", seconds.toString())
                if (!album.isNullOrBlank()) addQueryParameter("al", album)
            }
            .build()

        val body = lyricsGet(url.toString()) ?: return null
        if (!matchesMetadataIfPresent(body, title, artist, durationMs)) return null
        return ProviderLyrics.parse(body)
    }

    private fun matchesMetadataIfPresent(
        raw: String,
        title: String,
        artist: String,
        durationMs: Long,
    ): Boolean {
        val obj = runCatching { lyricsJson.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return true
        val hitTitle = listOf("title", "song", "track", "trackName", "name")
            .firstNotNullOfOrNull { obj[it]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) }
        val hitArtist = listOf("artist", "artistName", "artists")
            .firstNotNullOfOrNull { obj[it]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) }
        if (hitTitle != null && (!lyricsTitleMatches(hitTitle, title) || !isLyricsVersionCompatible(title, hitTitle))) {
            return false
        }
        if (hitArtist != null && artist.isNotBlank() && !lyricsArtistMatches(hitArtist, artist)) {
            return false
        }
        val dur = obj["duration"]?.jsonPrimitive?.doubleOrNull
        if (dur != null && dur > 0.0 && durationMs > 0L) {
            val durMs = if (dur < 10_000.0) dur * 1000.0 else dur
            if (abs(durMs - durationMs) > 25_000.0) return false
        }
        return true
    }
}
