package com.music.nikomusic.playback

import com.music.nikomusic.data.model.Song
import java.util.Locale

/**
 * Builds the station that plays on after a one-off song.
 *
 * Shared: Android and the desktop assemble the same station from the same
 * watch queue, so the de-duplication and the per-artist caps are one
 * implementation rather than two that drift.
 *
 * Two problems this exists to solve:
 *
 *  - YouTube's watch queues routinely carry the same recording twice — the
 *    official audio and the music video are separate videoIds with near
 *    identical titles — so de-duping on id alone lets a track play, then play
 *    again as its video. Songs are matched on a normalised title plus lead
 *    artist instead.
 *
 *  - A radio mix leans hard on the seed's own artist. Capping how many tracks
 *    any one artist contributes keeps a station from turning into a single
 *    artist's discography.
 */
object QueueBuilder {

    /** No more than this many tracks by one artist in a single batch. */
    const val PER_ARTIST_LIMIT = 2

    /** The artist the station was seeded on gets more room, but not the run of it. */
    const val SEED_ARTIST_LIMIT = 4

    /** Fewer videos than this in a mix and a video station plays on with its songs too. */
    const val MIN_VIDEO_STATION = 3

    /**
     * The subset of [candidates] worth appending after [existing]: nothing
     * already queued, nothing repeated, at most [limit] tracks.
     */
    fun extend(existing: List<Song>, candidates: List<Song>, limit: Int, preferVideos: Boolean = false): List<Song> {
        val taken = existing.toMutableList()
        val perArtist = mutableMapOf<String, Int>()
        val seedArtists = existing.lastOrNull()?.artist?.let(::artistSet).orEmpty()
        val out = mutableListOf<Song>()

        // A mix pairs all but every track with its own music-video upload —
        // the same recording under a different id, titled far enough apart
        // ("Dildaara (Stand By Me)" against "Lyrical Video: Dildara Song")
        // that no title match will catch it. The catalogue cut is the one a
        // music app wants; videos only stand in when there is nothing else.
        // [preferVideos] turns that round for a station playing on from a music
        // video: its videos, where the mix has enough of them to be one.
        val songsOnly = candidates.filterNot { it.isVideo }
        val videosOnly = candidates.filter { it.isVideo }
        val ordered = when {
            preferVideos && videosOnly.size >= MIN_VIDEO_STATION -> videosOnly
            preferVideos -> candidates
            else -> songsOnly.ifEmpty { candidates }
        }

        for (candidate in ordered) {
            if (out.size >= limit) break
            if (taken.any { isSameRecording(it, candidate) }) continue

            val artists = artistSet(candidate.artist)
            val key = artists.minOrNull()
            if (key != null) {
                val cap = if (artists.any { it in seedArtists }) {
                    SEED_ARTIST_LIMIT
                } else {
                    PER_ARTIST_LIMIT
                }
                val played = perArtist[key] ?: 0
                if (played >= cap) continue
                perArtist[key] = played + 1
            }

            taken += candidate
            out += candidate
        }
        return out
    }

    /**
     * Whether two entries are the same recording. Ids differ between the audio
     * and video cuts of a track, which is exactly the case id equality misses.
     */
    fun isSameRecording(a: Song, b: Song): Boolean {
        if (a.videoId == b.videoId) return true
        val title = normalisedTitle(a.title)
        if (title.isEmpty() || title != normalisedTitle(b.title)) return false
        // One shared name is enough. The two cuts of a track get billed in
        // whatever order the upload used — "Pritam, Arijit Singh & Shilpa Rao"
        // against "Shilpa Rao, Arijit Singh, & Pritam" is one song, twice.
        val left = artistSet(a.artist)
        val right = artistSet(b.artist)
        return left.isEmpty() || right.isEmpty() || left.any { it in right }
    }

    /**
     * `Kesariya (From "Brahmastra") | Official Video` and `Kesariya` are one
     * recording as far as a queue is concerned. Remix and cover markers are
     * deliberately left in — those really are different tracks.
     */
    fun normalisedTitle(raw: String): String = raw.lowercase(Locale.ROOT)
        .substringBefore(" | ")
        .replace(NOISE, " ")
        .replace(PUNCTUATION, " ")
        .replace(SPACES, " ")
        .trim()

    /** The cast behind a credit, split out so billing order stops mattering. */
    fun artistSet(raw: String): Set<String> = raw.lowercase(Locale.ROOT)
        .replace(TOPIC, " ")
        .split(",", "&", "·", "•", ";", " feat", " ft.", " ft ", " x ", " with ")
        .map { it.replace(PUNCTUATION, " ").replace(SPACES, " ").trim() }
        .filter { it.isNotEmpty() }
        .toSet()

    /**
     * Reorders [tracks] greedily from [anchor] to balance Automix compatibility
     * (octave-folded BPM stretch reachability, harmonic Camelot key, energy
     * continuity) with artist and album variety so consecutive transitions sound
     * cohesive without stagnating on one artist or sound.
     */
    fun orderForSmoothMix(
        anchor: Song?,
        tracks: List<Song>,
        analyses: (String) -> com.music.nikomusic.playback.smart.TrackAnalysis?,
        limit: Int = tracks.size,
    ): List<Song> {
        if (tracks.size <= 1 || limit <= 0) return tracks.take(limit.coerceAtLeast(0))
        val pool = tracks.toMutableList()
        val ordered = ArrayList<Song>(minOf(limit, tracks.size))
        var current = anchor
        val artistCounts = mutableMapOf<String, Int>()
        val albumCounts = mutableMapOf<String, Int>()
        var prevLeadArtist = anchor?.let { artistSet(it.artist).minOrNull() }
        var prevAlbum = anchor?.albumName?.lowercase(Locale.ROOT)?.trim()?.takeIf { it.isNotEmpty() }

        while (ordered.size < limit && pool.isNotEmpty()) {
            val currentAnalysis = current?.videoId?.let(analyses)?.takeIf {
                it.status == com.music.nikomusic.playback.smart.TrackAnalysis.STATUS_READY
            }
            val currentEnergy = currentAnalysis?.let(::meanEnergy) ?: Double.NaN
            var bestIndex = 0
            var bestScore = Double.NEGATIVE_INFINITY
            for (index in pool.indices) {
                val candidate = pool[index]
                val candAnalysis = analyses(candidate.videoId)?.takeIf {
                    it.status == com.music.nikomusic.playback.smart.TrackAnalysis.STATUS_READY
                }
                val leadArtist = artistSet(candidate.artist).minOrNull()
                val albumKey = candidate.albumName?.lowercase(Locale.ROOT)?.trim()?.takeIf { it.isNotEmpty() }

                var score = 0.0
                if (currentAnalysis != null && candAnalysis != null) {
                    val outBpm = currentAnalysis.bpm
                    val inBpm = candAnalysis.bpm
                    if (outBpm > 0.0 && inBpm > 0.0) {
                        val aligned = com.music.nikomusic.playback.smart.alignTempoOctave(outBpm, inBpm)
                        val rel = kotlin.math.abs(aligned - outBpm) / outBpm
                        score += when {
                            rel <= 0.06 -> 2.4 - rel * 10.0
                            com.music.nikomusic.playback.smart.stretchReachable(outBpm, inBpm) -> 1.3 - (rel - 0.06) * 5.0
                            else -> -1.4 - rel
                        }
                    }
                    score += harmonicScore(currentAnalysis.key, candAnalysis.key)
                    val candEnergy = meanEnergy(candAnalysis)
                    if (!currentEnergy.isNaN() && !candEnergy.isNaN()) {
                        score += (0.8 - kotlin.math.abs(candEnergy - currentEnergy) * 2.2).coerceAtLeast(-1.0)
                    }
                } else if (candAnalysis != null) {
                    score += 0.15
                }

                // Preserve mild preference for the station's native ordering.
                score -= index * 0.03

                if (leadArtist != null) {
                    if (leadArtist == prevLeadArtist) score -= 2.4
                    val prior = artistCounts[leadArtist] ?: 0
                    if (prior > 0) score -= prior * 0.7
                }
                if (albumKey != null) {
                    if (albumKey == prevAlbum) score -= 1.0
                    val priorAlbum = albumCounts[albumKey] ?: 0
                    if (priorAlbum > 0) score -= priorAlbum * 0.35
                }

                if (score > bestScore) {
                    bestScore = score
                    bestIndex = index
                }
            }

            val chosen = pool.removeAt(bestIndex)
            ordered += chosen
            current = chosen
            prevLeadArtist = artistSet(chosen.artist).minOrNull()
            prevLeadArtist?.let { artistCounts[it] = (artistCounts[it] ?: 0) + 1 }
            prevAlbum = chosen.albumName?.lowercase(Locale.ROOT)?.trim()?.takeIf { it.isNotEmpty() }
            prevAlbum?.let { albumCounts[it] = (albumCounts[it] ?: 0) + 1 }
        }
        return ordered
    }

    private fun meanEnergy(analysis: com.music.nikomusic.playback.smart.TrackAnalysis): Double {
        if (analysis.energyCurve.isNotEmpty()) {
            var sum = 0.0
            var count = 0
            for (sample in analysis.energyCurve) {
                if (sample.energy.isFinite()) {
                    sum += sample.energy
                    count++
                }
            }
            if (count > 0) return sum / count
        }
        val firstWindow = analysis.levelWindows.firstOrNull { it.values.isNotEmpty() } ?: return Double.NaN
        var sum = 0.0
        for (value in firstWindow.values) sum += value
        return sum / firstWindow.values.size
    }

    private fun harmonicScore(leftKey: String, rightKey: String): Double {
        val left = parseCamelot(leftKey) ?: return 0.0
        val right = parseCamelot(rightKey) ?: return 0.0
        if (left == right) return 1.1
        val numDiff = kotlin.math.min(
            kotlin.math.abs(left.first - right.first),
            12 - kotlin.math.abs(left.first - right.first),
        )
        return when {
            left.first == right.first && left.second != right.second -> 0.85
            left.second == right.second && numDiff == 1 -> 0.75
            left.second != right.second && numDiff == 1 -> 0.3
            numDiff >= 4 -> -0.8
            else -> -0.2
        }
    }

    private fun parseCamelot(raw: String): Pair<Int, Char>? {
        val norm = raw.trim().lowercase(Locale.ROOT)
            .replace("♭", "b")
            .replace("♯", "#")
            .replace("major", "maj")
            .replace("minor", "min")
        if (norm.isEmpty()) return null
        Regex("""^(\d{1,2})\s*([ab])$""").matchEntire(norm)?.let { match ->
            val num = match.groupValues[1].toIntOrNull() ?: return null
            if (num in 1..12) return num to match.groupValues[2][0].uppercaseChar()
        }
        return CAMELOT_WHEEL[norm]
    }

    private val CAMELOT_WHEEL = mapOf(
        "c maj" to (8 to 'B'), "c" to (8 to 'B'), "a min" to (8 to 'A'), "am" to (8 to 'A'),
        "g maj" to (9 to 'B'), "g" to (9 to 'B'), "e min" to (9 to 'A'), "em" to (9 to 'A'),
        "d maj" to (10 to 'B'), "d" to (10 to 'B'), "b min" to (10 to 'A'), "bm" to (10 to 'A'),
        "a maj" to (11 to 'B'), "a" to (11 to 'B'), "f# min" to (11 to 'A'), "f#m" to (11 to 'A'), "gb min" to (11 to 'A'), "gbm" to (11 to 'A'),
        "e maj" to (12 to 'B'), "e" to (12 to 'B'), "c# min" to (12 to 'A'), "c#m" to (12 to 'A'), "db min" to (12 to 'A'), "dbm" to (12 to 'A'),
        "b maj" to (1 to 'B'), "b" to (1 to 'B'), "cb maj" to (1 to 'B'), "g# min" to (1 to 'A'), "g#m" to (1 to 'A'), "ab min" to (1 to 'A'), "abm" to (1 to 'A'),
        "f# maj" to (2 to 'B'), "f#" to (2 to 'B'), "gb maj" to (2 to 'B'), "gb" to (2 to 'B'), "d# min" to (2 to 'A'), "d#m" to (2 to 'A'), "eb min" to (2 to 'A'), "ebm" to (2 to 'A'),
        "db maj" to (3 to 'B'), "db" to (3 to 'B'), "c# maj" to (3 to 'B'), "c#" to (3 to 'B'), "bb min" to (3 to 'A'), "bbm" to (3 to 'A'), "a# min" to (3 to 'A'), "a#m" to (3 to 'A'),
        "ab maj" to (4 to 'B'), "ab" to (4 to 'B'), "g# maj" to (4 to 'B'), "f min" to (4 to 'A'), "fm" to (4 to 'A'),
        "eb maj" to (5 to 'B'), "eb" to (5 to 'B'), "d# maj" to (5 to 'B'), "c min" to (5 to 'A'), "cm" to (5 to 'A'),
        "bb maj" to (6 to 'B'), "bb" to (6 to 'B'), "a# maj" to (6 to 'B'), "g min" to (6 to 'A'), "gm" to (6 to 'A'),
        "f maj" to (7 to 'B'), "f" to (7 to 'B'), "d min" to (7 to 'A'), "dm" to (7 to 'A'),
    )

    private val NOISE = Regex(
        """\((?:official|lyric|lyrics|lyrical|audio|video|visuali[sz]er|full song|hd|4k)[^)]*\)""" +
            """|\(from[^)]*\)""" +
            """|\[[^]]*]""" +
            """|\b(?:official (?:video|audio|music video)|lyrical video|full video|4k video)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val TOPIC = Regex("""\s*-\s*topic\b""", RegexOption.IGNORE_CASE)
    private val PUNCTUATION = Regex("""[^\p{L}\p{N}]+""")
    private val SPACES = Regex("""\s+""")
}
