package com.music.nikomusic.data

import com.music.nikomusic.data.model.HomeShelf
import com.music.nikomusic.data.model.ShelfItem
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPick
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.data.model.isThirdPartyUpload
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * Pure multiplatform recommendation & mood-discovery ranking engine.
 *
 * Lives in `commonMain` so Android and desktop share identical scoring,
 * contradiction filtering, diversity caps, skip penalties, recency fatigue,
 * and shelf differentiation rules without depending on Android or network APIs.
 */
object RecommendationEngine {

    enum class RankingMode {
        TOP_PICK,
        MOOD,
        SUPERMIX,
        DISCOVERY,
        NEW_RELEASE,
        ARTIST_STATION,
    }

    /** Per-track behavioral signals collected locally and from account ratings. */
    data class TrackFeedback(
        val videoId: String,
        val title: String = "",
        val artist: String = "",
        val plays: Int = 0,
        val totalMs: Long = 0L,
        val skips: Int = 0,
        val earlySkips: Int = 0,
        val lastPlayedMs: Long = 0L,
        val lastSkippedMs: Long = 0L,
        val liked: Boolean = false,
        val disliked: Boolean = false,
    )

    /** Aggregated taste profile for a single artist. */
    data class ArtistAffinity(
        val name: String,
        val browseId: String? = null,
        val plays: Int = 0,
        val totalMs: Long = 0L,
        val skips: Int = 0,
        val earlySkips: Int = 0,
        val recentlyDiscovered: Boolean = false,
        val genres: List<String> = emptyList(),
    )

    /** Snapshot of everything known about a listener's taste at ranking time. */
    data class ListenerProfile(
        val artists: List<ArtistAffinity> = emptyList(),
        val tracks: Map<String, TrackFeedback> = emptyMap(),
        val recentTrackIds: Set<String> = emptySet(),
        val recentRecordings: Set<String> = emptySet(),
        val likedTrackIds: Set<String> = emptySet(),
        val dislikedTrackIds: Set<String> = emptySet(),
        val favoriteGenres: Map<String, Double> = emptyMap(),
        val favoriteMoods: Map<TopPickMood, Double> = emptyMap(),
        val discoveredArtists: Set<String> = emptySet(),
        val artistGenres: Map<String, List<String>> = emptyMap(),
        val peakHours: List<Int> = emptyList(),
    ) {
        val isEmpty: Boolean
            get() = artists.isEmpty() && tracks.isEmpty() && likedTrackIds.isEmpty() &&
                recentTrackIds.isEmpty() && favoriteGenres.isEmpty()
    }

    /** Candidate track along with contextual metadata from its origin shelf/playlist. */
    data class TrackCandidate(
        val song: Song,
        val sourcePlaylistTitle: String = "",
        val sourcePlaylistSubtitle: String = "",
        val isFamiliarSeed: Boolean = false,
        val isNewRelease: Boolean = false,
        val sourceOrder: Int = 0,
    )

    /** Semantic rules describing how a mood sounds and what contradicts it. */
    data class MoodRule(
        val positiveKeywords: List<String>,
        val preferredGenres: List<String>,
        val contradictoryKeywords: List<String>,
        val fallbackSearchQueries: List<String>,
        val preferredHours: IntRange = 0..23,
    )

    // ── Text Normalization (aligned with QueueBuilder) ───────────────────────

    private val NOISE_REGEX = Regex(
        """\((?:official|lyric|lyrics|lyrical|audio|video|visuali[sz]er|full song|hd|4k)[^)]*\)""" +
            """|\(from[^)]*\)""" +
            """|\[[^\]]*]""" +
            """|\b(?:official (?:video|audio|music video)|lyrical video|full video|4k video)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val TOPIC_SUFFIX = Regex("""\s*-\s*topic\b""", RegexOption.IGNORE_CASE)
    private val PUNCTUATION = Regex("""[^\p{L}\p{N}]+""")
    private val SPACES = Regex("""\s+""")
    private val CREDIT_SEPARATORS = Regex(
        """\s*(?:,|&|·|•|;|\bfeat\.?|\bft\.?|\bfeaturing|\bx\b|\bwith\b)\s*""",
        RegexOption.IGNORE_CASE,
    )

    fun normalizedTitle(raw: String): String = raw
        .lowercase()
        .substringBefore(" | ")
        .replace(NOISE_REGEX, " ")
        .replace(PUNCTUATION, " ")
        .replace(SPACES, " ")
        .trim()

    fun artistSet(raw: String): Set<String> = raw
        .lowercase()
        .replace(TOPIC_SUFFIX, " ")
        .split(CREDIT_SEPARATORS)
        .mapNotNull { part ->
            part.replace(PUNCTUATION, " ").replace(SPACES, " ").trim().takeIf { it.isNotEmpty() }
        }
        .toSet()

    fun recordingKey(title: String, artist: String): String {
        val t = normalizedTitle(title)
        val lead = artistSet(artist).minOrNull().orEmpty()
        return "$t::$lead"
    }

    fun isSameRecording(a: Song, b: Song): Boolean {
        if (a.videoId.isNotEmpty() && a.videoId == b.videoId) return true
        val titleA = normalizedTitle(a.title)
        if (titleA.isEmpty() || titleA != normalizedTitle(b.title)) return false
        val left = artistSet(a.artist)
        val right = artistSet(b.artist)
        return left.isEmpty() || right.isEmpty() || left.any { it in right }
    }

    // ── Mood Semantic Rules ──────────────────────────────────────────────────

    private val DEFAULT_CONTRA_HIGH_ENERGY = listOf(
        "sleep", "white noise", "rain sounds", "asmr", "lullaby", "meditation", "guided sleep",
        "brown noise", "pink noise", "storytime", "podcast",
    )

    private val DEFAULT_CONTRA_CALM = listOf(
        "gym", "workout", "beast mode", "hardstyle", "earrape", "death metal", "thrash metal",
        "dubstep", "phonk", "pre-workout", "running mix", "hiit", "cardio",
    )

    private val MOOD_RULES: Map<TopPickMood, MoodRule> = mapOf(
        TopPickMood.LOVE to MoodRule(
            positiveKeywords = listOf(
                "love", "romance", "romantic", "intimate", "slow jam", "r&b", "soul", "ballad",
                "serenade", "heart", "sweet", "tender", "date night", "duet", "ishq", "pyaar", "mohabbat",
            ),
            preferredGenres = listOf("randb", "soul", "pop", "singer songwriter", "acoustic", "bollywood", "sufi", "jazz"),
            contradictoryKeywords = DEFAULT_CONTRA_CALM + listOf(
                "breakup", "heartbreak", "heartache", "revenge", "diss track", "rage", "angry", "funeral",
            ),
            fallbackSearchQueries = listOf("romantic love songs playlist", "soft r&b love ballads"),
            preferredHours = 19..23,
        ),
        TopPickMood.SAD to MoodRule(
            positiveKeywords = listOf(
                "sad", "heartbreak", "breakup", "melanchol", "lonely", "heartache", "cry", "tears",
                "blue", "emotional", "pain", "miss you", "hurt", "grief", "dard", "bewafa", "tanha",
            ),
            preferredGenres = listOf("singer songwriter", "emo", "indie", "acoustic", "randb", "soul", "bollywood", "ghazal"),
            contradictoryKeywords = listOf(
                "party", "club", "festival", "workout", "gym", "hype", "cheerful", "happy",
                "celebration", "banger", "dancefloor", "fitness", "hiit",
            ),
            fallbackSearchQueries = listOf("sad heartbreak songs playlist", "melancholic emotional songs"),
            preferredHours = 21..23,
        ),
        TopPickMood.ENERGY to MoodRule(
            positiveKeywords = listOf(
                "energy", "energetic", "workout", "hype", "pump", "adrenaline", "power", "boost",
                "high voltage", "upbeat", "fast", "running", "gym", "rage", "beast", "tempo",
            ),
            preferredGenres = listOf("hip hop", "rap", "edm", "electronic", "rock", "metal", "trap", "phonk", "drum and bass", "bhangra"),
            contradictoryKeywords = DEFAULT_CONTRA_HIGH_ENERGY + listOf(
                "heartbreak", "crying", "slow ambient", "study piano", "yoga", "ambient sleep",
            ),
            fallbackSearchQueries = listOf("high energy workout hype songs playlist", "upbeat energetic hits"),
            preferredHours = 6..18,
        ),
        TopPickMood.CHILL to MoodRule(
            positiveKeywords = listOf(
                "chill", "relax", "unwind", "peaceful", "acoustic", "mellow", "laidback", "laid-back",
                "soft", "lofi", "lo-fi", "breeze", "easy", "slow", "sunset", "warm",
            ),
            preferredGenres = listOf("chillout", "lo fi", "indie", "indie pop", "acoustic", "dream pop", "bossa nova", "folk", "downtempo"),
            contradictoryKeywords = DEFAULT_CONTRA_CALM + listOf(
                "heavy metal", "metalcore", "drill", "festival", "club banger", "screamo",
            ),
            fallbackSearchQueries = listOf("chill acoustic mellow songs playlist", "laid back relaxing vibes"),
            preferredHours = 15..23,
        ),
        TopPickMood.FOCUS to MoodRule(
            positiveKeywords = listOf(
                "focus", "instrumental", "ambient", "concentration", "study", "deep focus", "work",
                "piano", "classical", "lofi", "lo-fi", "beats to study", "minimal", "soundtrack", "score",
            ),
            preferredGenres = listOf("ambient", "lo fi", "classical", "instrumental", "soundtrack", "post rock", "jazz", "chillout"),
            contradictoryKeywords = DEFAULT_CONTRA_CALM + listOf(
                "party", "club", "karaoke", "live concert", "festival", "dj mix", "scream", "diss",
                "podcast", "comedy", "interview",
            ),
            fallbackSearchQueries = listOf("deep focus instrumental ambient music playlist", "lo-fi study instrumental focus"),
            preferredHours = 8..17,
        ),
        TopPickMood.PARTY to MoodRule(
            positiveKeywords = listOf(
                "party", "dance", "club", "electronic", "pop", "disco", "remix", "turn up",
                "nightlife", "banger", "dj", "festival", "house", "friday", "saturday", "weekend",
            ),
            preferredGenres = listOf("electronic", "house", "pop", "edm", "hip hop", "disco", "reggaeton", "afrobeats", "punjabi", "bollywood"),
            contradictoryKeywords = DEFAULT_CONTRA_HIGH_ENERGY + listOf(
                "sad", "heartbreak", "funeral", "crying", "melanchol", "ambient sleep", "study",
                "acoustic ballad", "lofi",
            ),
            fallbackSearchQueries = listOf("party dance electronic pop hits playlist", "club dancefloor hits"),
            preferredHours = 19..23,
        ),
        TopPickMood.HAPPY to MoodRule(
            positiveKeywords = listOf(
                "happy", "feel good", "feel-good", "cheerful", "uplifting", "sunny", "joy",
                "bright", "smile", "good vibes", "summer", "optimistic", "groovy", "funk",
            ),
            preferredGenres = listOf("pop", "funk", "disco", "indie pop", "afrobeats", "soul", "synthpop", "reggae"),
            contradictoryKeywords = DEFAULT_CONTRA_HIGH_ENERGY + listOf(
                "sad", "heartbreak", "breakup", "depressing", "lonely", "grief", "death metal",
                "doom metal", "crying", "funeral",
            ),
            fallbackSearchQueries = listOf("happy feel good uplifting songs playlist", "cheerful good vibes hits"),
            preferredHours = 7..18,
        ),
        TopPickMood.LATE_NIGHT to MoodRule(
            positiveKeywords = listOf(
                "late night", "after hours", "midnight", "dreamy", "atmospheric", "night drive",
                "nocturnal", "moonlight", "slow jam", "moody", "dark", "3am", "2am", "1am", "neon",
            ),
            preferredGenres = listOf("randb", "dream pop", "shoegaze", "synthpop", "lo fi", "downtempo", "deep house", "cloud rap", "ambient"),
            contradictoryKeywords = listOf(
                "morning workout", "fitness", "cardio", "children", "kids", "nursery", "march",
                "thrash metal", "hardstyle", "pre-workout",
            ),
            fallbackSearchQueries = listOf("late night dreamy atmospheric r&b synth playlist", "midnight after hours drive music"),
            preferredHours = 21..4,
        ),
        TopPickMood.ROAD_TRIP to MoodRule(
            positiveKeywords = listOf(
                "road trip", "driving", "drive", "highway", "commute", "travel", "cruise",
                "sing-along", "sing along", "open road", "car", "sunset drive", "horizon", "anthem",
            ),
            preferredGenres = listOf("pop", "rock", "indie rock", "alternative", "classic rock", "synthpop", "country", "bollywood", "punjabi"),
            contradictoryKeywords = DEFAULT_CONTRA_HIGH_ENERGY + listOf(
                "sleep", "yoga", "meditation", "white noise", "asmr", "study focus",
            ),
            fallbackSearchQueries = listOf("road trip sing along driving songs playlist", "highway cruise hits"),
            preferredHours = 7..20,
        ),
        TopPickMood.NOSTALGIA to MoodRule(
            positiveKeywords = listOf(
                "nostalgia", "nostalgic", "throwback", "classic", "retro", "90s", "2000s", "80s", "70s",
                "00s", "oldies", "gold", "golden", "memories", "rewind", "timeless", "vintage", "decade",
            ),
            preferredGenres = listOf("rock", "pop", "randb", "hip hop", "soul", "classic rock", "motown", "disco", "bollywood", "britpop"),
            contradictoryKeywords = DEFAULT_CONTRA_HIGH_ENERGY + listOf(
                "hyperpop", "phonk", "2026 new", "study white noise", "guided meditation",
            ),
            fallbackSearchQueries = listOf("90s 2000s throwback nostalgia classics playlist", "timeless retro old favourites"),
            preferredHours = 16..23,
        ),
    )

    fun ruleFor(mood: TopPickMood): MoodRule {
        MOOD_RULES[mood]?.let { return it }
        return when (mood) {
            TopPickMood.RELAX -> ruleFor(TopPickMood.CHILL)
            TopPickMood.FEELING_BLUE, TopPickMood.HEARTBREAK -> ruleFor(TopPickMood.SAD)
            TopPickMood.FEEL_GOOD, TopPickMood.MORNING, TopPickMood.SUMMERTIME, TopPickMood.WEEKEND ->
                MoodRule(
                    positiveKeywords = ruleFor(TopPickMood.HAPPY).positiveKeywords + mood.shelfWords,
                    preferredGenres = ruleFor(TopPickMood.HAPPY).preferredGenres,
                    contradictoryKeywords = ruleFor(TopPickMood.HAPPY).contradictoryKeywords,
                    fallbackSearchQueries = listOf("${mood.name.lowercase().replace('_', ' ')} music playlist"),
                )
            TopPickMood.AFTER_HOURS -> ruleFor(TopPickMood.LATE_NIGHT)
            TopPickMood.COMMUTING, TopPickMood.OUTDOORS -> ruleFor(TopPickMood.ROAD_TRIP)
            TopPickMood.FITNESS, TopPickMood.MOTIVATION, TopPickMood.SPORTS -> ruleFor(TopPickMood.ENERGY)
            TopPickMood.EVENING, TopPickMood.ALONE_TIME, TopPickMood.HOME, TopPickMood.WELLBEING, TopPickMood.SLEEP ->
                MoodRule(
                    positiveKeywords = ruleFor(TopPickMood.CHILL).positiveKeywords + mood.shelfWords,
                    preferredGenres = ruleFor(TopPickMood.CHILL).preferredGenres + "ambient",
                    contradictoryKeywords = DEFAULT_CONTRA_CALM + "party" + "club banger",
                    fallbackSearchQueries = listOf("${mood.name.lowercase().replace('_', ' ')} music playlist"),
                )
            TopPickMood.WORK -> ruleFor(TopPickMood.FOCUS)
            TopPickMood.SOCIAL, TopPickMood.HOLIDAY -> ruleFor(TopPickMood.PARTY)
            TopPickMood.GAMING -> MoodRule(
                positiveKeywords = listOf("gaming", "phonk", "electronic", "synthwave", "trap", "rock", "soundtrack") + mood.shelfWords,
                preferredGenres = listOf("electronic", "hip hop", "phonk", "soundtrack", "edm", "rock"),
                contradictoryKeywords = DEFAULT_CONTRA_HIGH_ENERGY,
                fallbackSearchQueries = listOf("gaming music playlist hype electronic"),
            )
            TopPickMood.EATING_COOKING -> ruleFor(TopPickMood.CHILL)
            else -> MoodRule(
                positiveKeywords = mood.shelfWords,
                preferredGenres = emptyList(),
                contradictoryKeywords = emptyList(),
                fallbackSearchQueries = listOf("${mood.name.lowercase().replace('_', ' ')} playlist"),
            )
        }
    }

    // ── Playlist & Shelf Selection for Moods ─────────────────────────────────

    /**
     * Ranks playlists from YTM mood/genre shelves by semantic match to [mood],
     * regional/language [hints], listener genre affinities, and non-contradiction.
     */
    fun selectMoodPlaylists(
        shelves: List<HomeShelf>,
        mood: TopPickMood,
        hints: List<String>,
        profile: ListenerProfile,
        limit: Int = 5,
        random: Random = Random,
    ): List<ShelfItem> {
        val rule = ruleFor(mood)
        val loweredHints = hints.map { it.lowercase() }.filter { it.isNotBlank() }
        val userTopGenres = profile.favoriteGenres.keys.map { it.lowercase() }
        val userArtistNames = profile.artists.take(15).map { it.name.lowercase() }

        data class ScoredPlaylist(val item: ShelfItem, val score: Double)

        val scored = mutableListOf<ScoredPlaylist>()
        for (shelf in shelves) {
            val shelfText = "${shelf.title} ${shelf.subtitle}".lowercase()
            val shelfContra = rule.contradictoryKeywords.count { it in shelfText }
            if (shelfContra >= 2) continue

            var shelfBonus = 0.0
            for (word in mood.shelfWords) {
                if (word.lowercase() in shelfText) shelfBonus += 3.0
            }
            for (kw in rule.positiveKeywords) {
                if (kw in shelfText) shelfBonus += 1.6
            }
            for (hint in loweredHints) {
                if (hint in shelfText) shelfBonus += 2.2
            }
            if (shelf.title.isBlank()) shelfBonus += 0.5
            shelfBonus -= shelfContra * 2.5

            for (item in shelf.items) {
                if (item.browseId == null) continue
                val text = "${item.title} ${item.subtitle}".lowercase()
                val contraHits = rule.contradictoryKeywords.count { it in text }
                if (contraHits > 0) continue

                var score = 1.0 + shelfBonus
                for (word in mood.shelfWords) {
                    if (word.lowercase() in text) score += 2.8
                }
                for (kw in rule.positiveKeywords) {
                    if (kw in text) score += 1.5
                }
                for (hint in loweredHints) {
                    if (hint in text) score += 2.0
                }
                for (genre in rule.preferredGenres) {
                    if (genre in text) score += 1.3
                }
                for (genre in userTopGenres) {
                    if (genre.length >= 3 && genre in text) score += 1.8
                }
                for (artist in userArtistNames) {
                    if (artist.length >= 3 && artist in text) score += 2.2
                }
                // Small controlled randomness so successive taps discover varied playlists
                score += random.nextDouble() * 2.2
                scored += ScoredPlaylist(item, score)
            }
        }

        val unique = scored
            .distinctBy { it.item.browseId }
            .sortedByDescending { it.score }

        if (unique.size <= limit) return unique.map { it.item }

        // Weighted sampling from top tier so we vary playlists without sinking relevance
        val pool = unique.take(max(limit * 3, 12)).toMutableList()
        val chosen = mutableListOf<ShelfItem>()
        while (chosen.size < limit && pool.isNotEmpty()) {
            val minScore = pool.minOf { it.score }
            val weights = pool.map { (it.score - minScore + 1.0).let { w -> w * w } }
            val total = weights.sum()
            var pick = random.nextDouble() * total
            var chosenIndex = pool.lastIndex
            for (i in weights.indices) {
                pick -= weights[i]
                if (pick <= 0.0) {
                    chosenIndex = i
                    break
                }
            }
            chosen += pool.removeAt(chosenIndex).item
        }
        return chosen
    }

    // ── Multi-Factor Track Ranking & Queue Assembly ──────────────────────────

    /**
     * Checks if a track's title/album/playlist context clearly contradicts [mood].
     * Conservative so valid songs aren't over-pruned; catches obvious mismatches
     * (e.g. "1 Hour Rain Sounds", "Hardstyle Gym Workout", "Happy Birthday", "Death Metal")
     * on calm/sad/focus/love queues.
     */
    fun isContradictoryForMood(candidate: TrackCandidate, mood: TopPickMood): Boolean {
        val rule = ruleFor(mood)
        if (rule.contradictoryKeywords.isEmpty()) return false
        val text = buildString {
            append(candidate.song.title.lowercase())
            append(' ')
            append(candidate.song.albumName.orEmpty().lowercase())
            append(' ')
            append(candidate.song.artist.lowercase())
        }
        val titleText = candidate.song.title.lowercase()
        // Direct strong contradiction in title or album
        for (contra in rule.contradictoryKeywords) {
            if (contra in titleText || contra in text) {
                // Allow a track if the mood's primary word explicitly appears in title cleanly
                // (e.g., "Workout Love" wouldn't confuse "Party" vs "Sleep", keep conservative)
                val isLiteralSoundEffect = contra in setOf("white noise", "rain sounds", "asmr", "lullaby", "podcast")
                if (isLiteralSoundEffect || contra in titleText) return true
                // Or if playlist metadata did NOT explicitly invite this mood
                val meta = "${candidate.sourcePlaylistTitle} ${candidate.sourcePlaylistSubtitle}".lowercase()
                if (rule.positiveKeywords.none { it in meta }) return true
            }
        }
        return false
    }

    /**
     * Scores and orders [candidates] into a personalized, diverse, playable queue.
     */
    fun rankTracks(
        candidates: List<TrackCandidate>,
        profile: ListenerProfile,
        mode: RankingMode,
        mood: TopPickMood? = null,
        recentOpeners: Set<String> = emptySet(),
        nowMs: Long = 0L,
        limit: Int = 50,
        seed: Long = 0L,
    ): List<Song> {
        if (candidates.isEmpty()) return emptyList()

        val artistScores = buildArtistScoreMap(profile)
        val rng = Random(seed)
        val moodRule = mood?.let(::ruleFor)

        data class ScoredTrack(
            val song: Song,
            val score: Double,
            val isFamiliar: Boolean,
            val isDiscovery: Boolean,
            val primaryArtistKey: String,
        )

        val hasStudioCandidates = candidates.any { !it.song.isThirdPartyUpload() }
        val deduped = linkedMapOf<String, TrackCandidate>()
        for (candidate in candidates) {
            val s = candidate.song
            if (s.videoId.isBlank() || s.title.isBlank()) continue
            if (hasStudioCandidates && s.isThirdPartyUpload()) continue
            if (s.videoId in profile.dislikedTrackIds) continue
            val key = recordingKey(s.title, s.artist).takeIf { it != "::" } ?: s.videoId
            val existing = deduped[key]
            if (existing == null || (existing.song.isVideo && !s.isVideo)) {
                deduped[key] = candidate
            }
        }

        val scored = mutableListOf<ScoredTrack>()
        val threeHoursMs = 3L * 3_600_000L
        val twentyFourHoursMs = 24L * 3_600_000L

        for ((_, candidate) in deduped) {
            val s = candidate.song
            if (mood != null && isContradictoryForMood(candidate, mood)) continue

            val trackSignal = profile.tracks[s.videoId]
            if (trackSignal?.disliked == true) continue

            val skipCount = trackSignal?.skips ?: 0
            val earlySkips = trackSignal?.earlySkips ?: 0
            val plays = trackSignal?.plays ?: 0
            val totalRatioSkips = if (plays + earlySkips > 0) earlySkips.toDouble() / (plays + earlySkips) else 0.0

            // Hard filter tracks repeatedly skipped early with minimal completions
            if (earlySkips >= 2 && totalRatioSkips >= 0.65 && !trackSignal?.liked.orFalse()) continue
            if (earlySkips >= 1 && plays == 0 && mode == RankingMode.TOP_PICK) continue

            val recKey = recordingKey(s.title, s.artist)
            val lastPlayed = trackSignal?.lastPlayedMs ?: 0L
            val sixHoursMs = 6L * 3_600_000L
            val isRecent = if (nowMs > 0L && lastPlayed > 0L) {
                (nowMs - lastPlayed) < sixHoursMs
            } else {
                s.videoId in profile.recentTrackIds || recKey in profile.recentRecordings
            }

            // Discovery station strictly avoids already known history & likes
            val isLiked = s.videoId in profile.likedTrackIds || trackSignal?.liked == true
            val isKnownTrack = plays > 0 || isLiked || isRecent
            if (mode == RankingMode.DISCOVERY && isKnownTrack) continue

            var score = 0.25

            // 1. Artist taste affinity
            val credits = artistSet(s.artist)
            var maxArtistAffinity = 0.0
            var artistDiscovered = false
            var matchedArtistGenres = emptySet<String>()
            val genreAcc = mutableSetOf<String>()
            for (credit in credits) {
                artistScores[credit]?.let { aff ->
                    if (aff.score > maxArtistAffinity) maxArtistAffinity = aff.score
                    if (aff.recentlyDiscovered) artistDiscovered = true
                }
                profile.artistGenres[credit]?.forEach { genreAcc += it.lowercase() }
            }
            matchedArtistGenres = genreAcc

            score += when (mode) {
                RankingMode.DISCOVERY -> {
                    // Reward tracks from unexplored artists who share user's genres;
                    // lightly reward deep cuts by known artists vs total obsession
                    if (maxArtistAffinity <= 0.05) 0.16 else 0.06
                }
                else -> maxArtistAffinity * 0.34
            }
            if (artistDiscovered) score += 0.08

            // 2. Track play frequency & liked status (personal taste)
            if (isLiked) {
                score += if (mode == RankingMode.MOOD || mode == RankingMode.SUPERMIX) 0.32 else 0.26
            }
            if (plays > 0) {
                val familiarityBoost = min(0.22, ln(1.0 + plays) * 0.09)
                score += familiarityBoost
                val avgListenMs = (trackSignal?.totalMs ?: 0L) / max(1, plays)
                if (avgListenMs >= 120_000L) score += 0.08
                else if (avgListenMs >= 60_000L) score += 0.03
                // Over-saturation penalty when played heavily lately
                if (plays >= 8) score -= min(0.16, (plays - 7) * 0.025)
            }

            // 3. Discovery potential
            val isUnheardArtist = maxArtistAffinity == 0.0
            val isDiscovery = !isKnownTrack && (isUnheardArtist || plays == 0)
            if (mode == RankingMode.DISCOVERY) {
                if (isUnheardArtist) score += 0.24
                if (candidate.isNewRelease) score += 0.08
            } else if (mode == RankingMode.NEW_RELEASE) {
                if (!isKnownTrack) score += 0.22
                if (candidate.isNewRelease) score += 0.20
                if (maxArtistAffinity > 0.1 && !isKnownTrack) score += 0.24 // new release from liked artist!
            } else if (mode == RankingMode.MOOD || mode == RankingMode.SUPERMIX) {
                // Encourage fresh discoveries alongside favorites
                if (!isKnownTrack && maxArtistAffinity > 0.15) score += 0.14 // unheard song by artist user likes
                if (isUnheardArtist) score += 0.08
            }

            // 4. Genre preference overlap
            var genreOverlap = 0.0
            for (g in matchedArtistGenres) {
                genreOverlap += (profile.favoriteGenres[g] ?: 0.0)
            }
            // Also check metadata text for preferred genres
            val candidateMeta = "${candidate.sourcePlaylistTitle} ${candidate.sourcePlaylistSubtitle} ${s.albumName.orEmpty()}".lowercase()
            for ((genre, weight) in profile.favoriteGenres) {
                if (genre.length >= 3 && genre in candidateMeta) {
                    genreOverlap += weight * 0.5
                }
            }
            score += min(0.24, genreOverlap * 0.24)

            // 5. Mood relevance alignment
            if (moodRule != null) {
                val trackText = "${s.title} ${s.albumName.orEmpty()} $candidateMeta".lowercase()
                var moodMatch = 0.0
                for (kw in moodRule.positiveKeywords) {
                    if (kw in trackText) moodMatch += 0.07
                }
                for (g in moodRule.preferredGenres) {
                    if (g in matchedArtistGenres || g in candidateMeta) moodMatch += 0.08
                }
                score += min(0.32, moodMatch)
            }

            // 6. Recent play & opener fatigue penalty
            if (isRecent) {
                score -= when (mode) {
                    RankingMode.MOOD, RankingMode.SUPERMIX -> 0.34
                    RankingMode.NEW_RELEASE -> 0.40
                    else -> 0.30
                }
            } else if (nowMs > 0L && (trackSignal?.lastPlayedMs ?: 0L) > 0L) {
                val ageMs = nowMs - trackSignal!!.lastPlayedMs
                if (ageMs in threeHoursMs until twentyFourHoursMs) score -= 0.12
            }
            if (s.videoId in recentOpeners) {
                score -= 0.22
            }

            // 7. Skip penalty (recent skips hurt more)
            if (earlySkips > 0 || skipCount > 0) {
                val recentSkipMult = if (
                    nowMs > 0L && (trackSignal?.lastSkippedMs ?: 0L) > 0L &&
                    (nowMs - trackSignal!!.lastSkippedMs) < twentyFourHoursMs * 3
                ) 1.3 else 0.9
                val penalty = (earlySkips * 0.28 + max(0, skipCount - earlySkips) * 0.12) * recentSkipMult
                score -= min(0.85, penalty)
            }

            // 8. Slight penalty to music videos so audio studio versions lead
            if (s.isVideo) score -= 0.14

            // 9. Controlled freshness variation so repeated visits aren't identical
            score += rng.nextDouble() * 0.08

            val leadArtist = credits.minOrNull().orEmpty()
            scored += ScoredTrack(
                song = s,
                score = score,
                isFamiliar = isKnownTrack && !isRecent,
                isDiscovery = isDiscovery,
                primaryArtistKey = leadArtist,
            )
        }

        // Order descending, then apply diversity & familiar/discovery pacing
        val pool = scored.sortedByDescending { it.score }.toMutableList()
        if (pool.isEmpty()) return emptyList()

        val result = ArrayList<Song>(min(limit, pool.size))
        val artistTotalCount = mutableMapOf<String, Int>()
        val recentArtistWindow = ArrayDeque<String>(4)
        val windowArtistGap = 3
        val maxPerArtistInQueue = if (mode == RankingMode.ARTIST_STATION) 6 else max(2, limit / 12)
        val minHealthyQueue = min(limit, 8)

        // Pass 0: strict per-artist cap + spacing window + familiar/discovery pacing.
        // Pass 1: relax spacing window & pacing, keeping strict per-artist cap.
        // Pass 2: only if queue is critically short (< minHealthyQueue), exceed per-artist cap.
        var consecutiveFamiliars = 0
        var consecutiveDiscoveries = 0

        while (result.size < limit && pool.isNotEmpty()) {
            val wantDiscoverySwitch = (mode == RankingMode.MOOD || mode == RankingMode.SUPERMIX) &&
                !profile.isEmpty && result.isNotEmpty()
            var pickIdx = -1
            val maxPass = if (result.size < minHealthyQueue) 2 else 1

            for (pass in 0..maxPass) {
                val enforceGap = pass == 0
                val enforceBalance = pass == 0 && wantDiscoverySwitch
                for (i in pool.indices) {
                    val item = pool[i]
                    val artist = item.primaryArtistKey
                    if (artist.isNotEmpty()) {
                        val count = artistTotalCount[artist] ?: 0
                        if (pass < 2 && count >= maxPerArtistInQueue) continue
                        if (enforceGap && artist in recentArtistWindow) continue
                    }
                    if (enforceBalance) {
                        if (consecutiveFamiliars >= 2 && item.isFamiliar) continue
                        if (consecutiveDiscoveries >= 3 && item.isDiscovery) continue
                    }
                    pickIdx = i
                    break
                }
                if (pickIdx >= 0) break
            }

            if (pickIdx < 0) break
            val chosen = pool.removeAt(pickIdx)
            result += chosen.song
            if (chosen.primaryArtistKey.isNotEmpty()) {
                artistTotalCount[chosen.primaryArtistKey] = (artistTotalCount[chosen.primaryArtistKey] ?: 0) + 1
                recentArtistWindow.addLast(chosen.primaryArtistKey)
                if (recentArtistWindow.size > windowArtistGap) recentArtistWindow.removeFirst()
            }
            if (chosen.isFamiliar) {
                consecutiveFamiliars++
                consecutiveDiscoveries = 0
            } else if (chosen.isDiscovery) {
                consecutiveDiscoveries++
                consecutiveFamiliars = 0
            } else {
                consecutiveFamiliars = 0
                consecutiveDiscoveries = 0
            }
        }
        return result
    }

    private data class ComputedArtistAffinity(
        val score: Double,
        val recentlyDiscovered: Boolean,
    )

    private fun buildArtistScoreMap(profile: ListenerProfile): Map<String, ComputedArtistAffinity> {
        val raw = mutableMapOf<String, ArtistAffinity>()
        for (a in profile.artists) {
            val keys = artistSet(a.name).ifEmpty { setOf(a.name.lowercase().trim()) }
            for (k in keys) {
                if (k.isEmpty()) continue
                val existing = raw[k]
                raw[k] = if (existing == null) a else existing.copy(
                    plays = existing.plays + a.plays,
                    totalMs = existing.totalMs + a.totalMs,
                    skips = existing.skips + a.skips,
                    earlySkips = existing.earlySkips + a.earlySkips,
                    recentlyDiscovered = existing.recentlyDiscovered || a.recentlyDiscovered,
                )
            }
        }
        if (raw.isEmpty()) {
            // Derive artist affinities from track & liked signals if artists list is empty
            val derived = mutableMapOf<String, Double>()
            for (tf in profile.tracks.values) {
                val w = (tf.plays * 1.0 + (if (tf.liked) 2.5 else 0.0) - tf.earlySkips * 1.5).coerceAtLeast(0.0)
                if (w <= 0.0) continue
                for (k in artistSet(tf.artist)) {
                    derived[k] = (derived[k] ?: 0.0) + w
                }
            }
            val top = derived.values.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
            return derived.mapValues { (k, v) ->
                ComputedArtistAffinity(
                    score = (v / top).coerceIn(0.0, 1.0),
                    recentlyDiscovered = k in profile.discoveredArtists,
                )
            }
        }

        val maxWeight = raw.values.maxOfOrNull {
            val msFactor = it.totalMs / 180_000.0
            (it.plays + msFactor - it.earlySkips * 0.8).coerceAtLeast(0.1)
        } ?: 1.0

        return raw.mapValues { (k, a) ->
            val msFactor = a.totalMs / 180_000.0
            val effective = (a.plays + msFactor - a.earlySkips * 0.9 - (a.skips - a.earlySkips) * 0.3).coerceAtLeast(0.0)
            val normalized = if (maxWeight > 0.0) (effective / maxWeight).coerceIn(0.0, 1.0) else 0.0
            ComputedArtistAffinity(
                score = normalized,
                recentlyDiscovered = a.recentlyDiscovered || k in profile.discoveredArtists,
            )
        }
    }

    // ── Smart Time + Taste Mood Selection ────────────────────────────────────

    /**
     * Picks the featured "Mood for You" combining time-of-day mood candidates with
     * the listener's recorded mood affinity (and avoiding repetition where possible).
     */
    fun chooseFeaturedMood(
        hour: Int,
        profile: ListenerProfile,
        random: Random = Random,
    ): TopPickMood {
        val candidates = when (hour) {
            in 5..8 -> listOf(TopPickMood.ENERGY, TopPickMood.HAPPY, TopPickMood.ROAD_TRIP, TopPickMood.FOCUS)
            in 9..11 -> listOf(TopPickMood.FOCUS, TopPickMood.HAPPY, TopPickMood.ENERGY)
            in 12..16 -> listOf(TopPickMood.HAPPY, TopPickMood.ROAD_TRIP, TopPickMood.CHILL, TopPickMood.FOCUS)
            in 17..19 -> listOf(TopPickMood.ROAD_TRIP, TopPickMood.ENERGY, TopPickMood.NOSTALGIA, TopPickMood.PARTY)
            in 20..22 -> listOf(TopPickMood.LOVE, TopPickMood.CHILL, TopPickMood.LATE_NIGHT, TopPickMood.SAD)
            else -> listOf(TopPickMood.LATE_NIGHT, TopPickMood.CHILL, TopPickMood.SAD, TopPickMood.NOSTALGIA, TopPickMood.LOVE)
        }

        if (profile.favoriteMoods.isEmpty()) return candidates.random(random)

        val weighted = candidates.map { mood ->
            val affinity = profile.favoriteMoods[mood] ?: 0.0
            mood to (1.0 + affinity * 2.2)
        }
        val total = weighted.sumOf { it.second }
        var r = random.nextDouble() * total
        for ((mood, w) in weighted) {
            r -= w
            if (r <= 0.0) return mood
        }
        return candidates.first()
    }

    // ── Home Shelves Differentiation & Deduplication ─────────────────────────

    /**
     * Filters and differentiates home shelves so adjacent shelves do not present
     * virtually identical tracks, albums, or mixes, while keeping intentional
     * shelves like Recents / Listen Again intact.
     */
    fun differentiateShelves(
        shelves: List<HomeShelf>,
        profile: ListenerProfile,
    ): List<HomeShelf> {
        if (shelves.isEmpty()) return emptyList()
        val seenBrowseIds = mutableSetOf<String>()
        val seenVideoKeys = mutableMapOf<String, Int>()
        val out = mutableListOf<HomeShelf>()

        for (shelf in shelves) {
            val titleLower = shelf.title.lowercase()
            val isPersonalRecap = "recent" in titleLower || "listen again" in titleLower || "history" in titleLower
            val isDiscover = "discover" in titleLower
            val isNewRelease = "new release" in titleLower || "new albums" in titleLower

            if (isPersonalRecap) {
                shelf.items.forEach { item ->
                    item.browseId?.let { seenBrowseIds += it }
                }
                out += shelf
                continue
            }

            val shelfArtistCounts = mutableMapOf<String, Int>()
            val filteredItems = shelf.items.filter { item ->
                val vid = item.videoId
                val bid = item.browseId
                if (Song(vid ?: "", item.title, item.subtitle, null).isThirdPartyUpload()) return@filter false
                if (vid != null && vid in profile.dislikedTrackIds) return@filter false
                if (isDiscover && vid != null) {
                    val tf = profile.tracks[vid]
                    if (vid in profile.recentTrackIds || vid in profile.likedTrackIds || (tf?.plays ?: 0) >= 2) {
                        return@filter false
                    }
                }
                if (isDiscover && bid != null && bid in seenBrowseIds) return@filter false
                if (!isNewRelease && bid != null && !seenBrowseIds.add(bid)) return@filter false
                if (vid != null) {
                    val key = recordingKey(item.title, item.subtitle)
                    val shownCount = seenVideoKeys[key] ?: 0
                    if (shownCount >= 1) return@filter false
                    val leadArtist = artistSet(item.subtitle).minOrNull().orEmpty()
                    if (shelf.items.size >= 6 && leadArtist.isNotEmpty() && (shelfArtistCounts[leadArtist] ?: 0) >= 2) {
                        return@filter false
                    }
                    seenVideoKeys[key] = shownCount + 1
                    if (leadArtist.isNotEmpty()) {
                        shelfArtistCounts[leadArtist] = (shelfArtistCounts[leadArtist] ?: 0) + 1
                    }
                }
                true
            }

            val minKeep = if (shelf.items.size >= 4) 3 else 1
            if (filteredItems.size >= minKeep) {
                out += shelf.copy(items = filteredItems)
            } else if (filteredItems.isNotEmpty() && !isDiscover) {
                out += shelf.copy(items = filteredItems)
            }
        }
        return out
    }

    /** Ensures Top Picks strip cards don't promote the exact same artist across multiple personal cards. */
    fun diversifyTopPicks(picks: List<TopPick>): List<TopPick> {
        val usedArtistIds = mutableSetOf<String>()
        val result = mutableListOf<TopPick>()
        for (pick in picks) {
            val aid = pick.artistBrowseId
            if (aid != null && !usedArtistIds.add(aid)) continue
            result += pick
        }
        return result
    }

    private fun Boolean?.orFalse() = this == true
}
