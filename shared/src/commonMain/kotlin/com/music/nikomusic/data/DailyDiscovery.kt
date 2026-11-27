package com.music.nikomusic.data

import com.music.nikomusic.data.model.ArtistRef
import com.music.nikomusic.data.model.PlaybackSourceType
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.data.model.isThirdPartyUpload
import com.music.nikomusic.playback.smart.TrackAnalysis
import kotlinx.serialization.Serializable
import kotlin.math.abs
import kotlin.math.min

/**
 * Pure multiplatform contracts, taste summarization, privacy sanitization,
 * diversity/novelty curation, rate limiting, and offline/feedback policies for
 * Android's **AI Daily Discovery**.
 *
 * Lives in `commonMain` so scoring, feedback, caching rules, and privacy filtering
 * remain deterministic, dependency-free, and unit-testable across targets.
 */
@Serializable
enum class DiscoveryFeedbackAction {
    LIKE,
    NOT_INTERESTED,
    MORE_LIKE_THIS,
    LESS_LIKE_THIS,
}

@Serializable
data class DiscoveryFeedbackEntry(
    val videoId: String,
    val title: String,
    val artist: String,
    val action: DiscoveryFeedbackAction,
    val updatedAtMs: Long,
    val genres: List<String> = emptyList(),
    val bpm: Double? = null,
    val energy: Double? = null,
)

@Serializable
data class StoredArtistRef(
    val name: String,
    val browseId: String? = null,
)

@Serializable
data class StoredDiscoverySong(
    val videoId: String,
    val title: String,
    val artist: String,
    val thumbnailUrl: String? = null,
    val durationText: String? = null,
    val artistId: String? = null,
    val artists: List<StoredArtistRef> = emptyList(),
    val albumId: String? = null,
    val albumName: String? = null,
    val isVideo: Boolean = false,
) {
    fun toSong(sourceTitle: String = "Daily Discovery"): Song = Song(
        videoId = videoId,
        title = title,
        artist = artist,
        thumbnailUrl = thumbnailUrl,
        durationText = durationText,
        artistId = artistId,
        artists = artists.map { ArtistRef(name = it.name, browseId = it.browseId) },
        albumId = albumId,
        albumName = albumName,
        isVideo = isVideo,
        isVideoOrigin = isVideo,
        playbackSource = sourceTitle,
        playbackSourceType = PlaybackSourceType.HOME,
    )

    companion object {
        fun from(song: Song): StoredDiscoverySong = StoredDiscoverySong(
            videoId = song.videoId,
            title = song.title,
            artist = song.artist,
            thumbnailUrl = song.thumbnailUrl,
            durationText = song.durationText,
            artistId = song.artistId,
            artists = song.artists.map { StoredArtistRef(name = it.name, browseId = it.browseId) },
            albumId = song.albumId,
            albumName = song.albumName,
            isVideo = song.isVideo,
        )
    }
}

@Serializable
data class DailyDiscoveryTrack(
    val song: StoredDiscoverySong,
    val reason: String = "",
    val isUnfamiliarArtist: Boolean = false,
    val aiCurated: Boolean = false,
    val genres: List<String> = emptyList(),
    val bpm: Double? = null,
    val energy: Double? = null,
    val unavailable: Boolean = false,
) {
    fun toPlayableSong(): Song = song.toSong()
}

@Serializable
enum class DiscoverySource {
    BACKEND_AI,
    LOCAL_TASTE,
    CACHED_OFFLINE,
    STARTER_COLD_START,
}

@Serializable
data class DailyDiscoveryCollection(
    val dateKey: String,
    val generatedAtMs: Long,
    val listenerKey: String? = null,
    val items: List<DailyDiscoveryTrack>,
    val source: DiscoverySource,
    val tasteSummary: String = "",
    val subgenres: List<String> = emptyList(),
    val isStale: Boolean = false,
)

@Serializable
data class DailyDiscoveryStateStore(
    val feedbackByVideoId: Map<String, DiscoveryFeedbackEntry> = emptyMap(),
    val refreshTimestampsMs: List<Long> = emptyList(),
    val priorPersona: String = "",
    val cached: DailyDiscoveryCollection? = null,
)

@Serializable
data class AIRecommendTrackHint(
    val title: String,
    val artist: String,
)

@Serializable
data class AIRecommendAudio(
    val avgBpm: Double = 0.0,
    val avgEnergy: Double = 0.5,
    val topKeys: List<String> = emptyList(),
)

@Serializable
data class AIRecommendRequest(
    val mode: String = "daily-discovery",
    val mood: String = "",
    val topTracks: List<AIRecommendTrackHint> = emptyList(),
    val likedArtists: List<String> = emptyList(),
    val skippedArtists: List<String> = emptyList(),
    val likedRecommendations: List<AIRecommendTrackHint> = emptyList(),
    val skippedRecommendations: List<AIRecommendTrackHint> = emptyList(),
    val preferredGenres: List<String> = emptyList(),
    val preferredMoods: List<String> = emptyList(),
    val listeningPattern: String = "",
    val priorPersona: String = "",
    val preferredScripts: List<String> = emptyList(),
    val explorationRatio: Double = 0.72,
    val audio: AIRecommendAudio? = null,
)

@Serializable
data class AIRecommendResponse(
    val enabled: Boolean = false,
    val provider: String = "",
    val queries: List<String> = emptyList(),
    val artists: List<String> = emptyList(),
    val subgenres: List<String> = emptyList(),
    val avoidKeywords: List<String> = emptyList(),
    val tasteSummary: String = "",
    val reasons: List<String> = emptyList(),
)

sealed interface RefreshPolicyResult {
    data class Allowed(val remainingToday: Int) : RefreshPolicyResult
    data class Cooldown(val waitSeconds: Long) : RefreshPolicyResult
    data object DailyLimitReached : RefreshPolicyResult
}

object DailyDiscoveryPlanner {

    const val MAX_MANUAL_REFRESHES_PER_DAY = 3
    const val MANUAL_REFRESH_COOLDOWN_MS = 60_000L
    const val MAX_DAILY_TRACKS = 24
    const val MIN_HISTORY_FOR_PERSONALIZATION = 2

    fun checkManualRefresh(
        nowMs: Long,
        todayStartMs: Long,
        refreshTimestampsMs: List<Long>,
    ): RefreshPolicyResult {
        val todays = refreshTimestampsMs.filter { it >= todayStartMs }.sorted()
        if (todays.size >= MAX_MANUAL_REFRESHES_PER_DAY) {
            return RefreshPolicyResult.DailyLimitReached
        }
        val latest = todays.lastOrNull()
        if (latest != null && nowMs - latest < MANUAL_REFRESH_COOLDOWN_MS) {
            val remainingMs = (MANUAL_REFRESH_COOLDOWN_MS - (nowMs - latest)).coerceAtLeast(1_000L)
            val waitSeconds = (remainingMs + 999L) / 1_000L
            return RefreshPolicyResult.Cooldown(waitSeconds)
        }
        return RefreshPolicyResult.Allowed(remainingToday = MAX_MANUAL_REFRESHES_PER_DAY - todays.size)
    }

    fun pruneOldRefreshes(refreshTimestampsMs: List<Long>, cutoffMs: Long): List<Long> =
        refreshTimestampsMs.filter { it >= cutoffMs }.takeLast(12)

    fun needsDailyRefresh(
        cached: DailyDiscoveryCollection?,
        todayKey: String,
        listenerKey: String?,
    ): Boolean {
        if (cached == null || cached.items.isEmpty()) return true
        if (cached.listenerKey != listenerKey) return true
        if (cached.dateKey != todayKey) return true
        return false
    }

    /** Distills raw 24-hour play counts into one anonymous pattern label without sending timestamps. */
    fun deriveListeningPattern(hourOfDay: List<Long>): String {
        if (hourOfDay.size < 24) return ""
        val total = hourOfDay.sum()
        if (total <= 0L) return ""
        var morning = 0L
        var afternoon = 0L
        var evening = 0L
        var night = 0L
        for (h in 0 until 24) {
            val v = hourOfDay[h]
            when (h) {
                in 5..11 -> morning += v
                in 12..16 -> afternoon += v
                in 17..21 -> evening += v
                else -> night += v
            }
        }
        val buckets = listOf(
            "Morning listener" to morning,
            "Daytime listener" to afternoon,
            "Evening listener" to evening,
            "Late-night listener" to night,
        ).sortedByDescending { it.second }
        val top = buckets.first()
        return if (top.second.toDouble() / total >= 0.34) top.first else "All-day eclectic listener"
    }

    /** Summarizes pre-analyzed cached tracks into an aggregate BPM/energy sweet spot. */
    fun buildAcousticSummary(
        analyses: List<TrackAnalysis>,
        likedOrTopIds: Set<String>,
    ): AIRecommendAudio? {
        var bpmSum = 0.0
        var bpmWeight = 0.0
        var energySum = 0.0
        var energyWeight = 0.0
        for (analysis in analyses) {
            if (!analysis.isUsable) continue
            val weight = if (analysis.trackId in likedOrTopIds) 2.5 else 1.0
            if (analysis.bpm in 40.0..240.0) {
                bpmSum += analysis.bpm * weight
                bpmWeight += weight
            }
            val meanE = analysis.energyCurve.takeIf { it.isNotEmpty() }
                ?.let { curve -> curve.sumOf { it.energy } / curve.size }
            if (meanE != null && meanE > 0.0 && meanE.isFinite()) {
                val clamped = meanE.coerceIn(0.0, 1.0)
                energySum += clamped * weight
                energyWeight += weight
            }
        }
        if (bpmWeight <= 0.0) return null
        val avgBpm = ((bpmSum / bpmWeight) * 10.0).toInt() / 10.0
        val avgEnergy = if (energyWeight > 0.0) ((energySum / energyWeight) * 100.0).toInt() / 100.0 else 0.5
        return AIRecommendAudio(
            avgBpm = avgBpm,
            avgEnergy = avgEnergy,
            topKeys = emptyList(),
        )
    }

    /**
     * Merges stored Daily Discovery feedback actions with listener profile so
     * [RecommendationEngine.rankTracks] and AI prompts learn continuously.
     */
    fun enrichProfileWithFeedback(
        base: RecommendationEngine.ListenerProfile,
        feedback: Map<String, DiscoveryFeedbackEntry>,
    ): RecommendationEngine.ListenerProfile {
        if (feedback.isEmpty()) return base
        val likedIds = base.likedTrackIds.toMutableSet()
        val hiddenIds = base.hiddenTrackIds.toMutableSet()
        val moreArtists = base.moreLikeArtists.toMutableSet()
        val lessArtists = base.lessLikeArtists.toMutableSet()
        val favoriteGenres = base.favoriteGenres.toMutableMap()
        val dislikedGenres = base.dislikedGenres.toMutableSet()

        for ((id, entry) in feedback) {
            val credits = RecommendationEngine.artistSet(entry.artist)
            when (entry.action) {
                DiscoveryFeedbackAction.LIKE -> {
                    likedIds += id
                    entry.genres.forEach { g ->
                        val k = g.lowercase().trim()
                        if (k.isNotEmpty()) favoriteGenres[k] = (favoriteGenres[k] ?: 0.0) + 0.35
                    }
                }
                DiscoveryFeedbackAction.MORE_LIKE_THIS -> {
                    likedIds += id
                    moreArtists += credits
                    entry.genres.forEach { g ->
                        val k = g.lowercase().trim()
                        if (k.isNotEmpty()) favoriteGenres[k] = (favoriteGenres[k] ?: 0.0) + 0.55
                    }
                }
                DiscoveryFeedbackAction.NOT_INTERESTED -> {
                    hiddenIds += id
                    lessArtists += credits
                }
                DiscoveryFeedbackAction.LESS_LIKE_THIS -> {
                    hiddenIds += id
                    lessArtists += credits
                    entry.genres.forEach { g ->
                        val k = g.lowercase().trim()
                        if (k.isNotEmpty() && k !in favoriteGenres) dislikedGenres += k
                    }
                }
            }
        }
        return base.copy(
            likedTrackIds = likedIds,
            hiddenTrackIds = hiddenIds,
            moreLikeArtists = moreArtists,
            lessLikeArtists = lessArtists,
            favoriteGenres = favoriteGenres,
            dislikedGenres = dislikedGenres,
        )
    }

    /**
     * Builds a minimal, privacy-preserving backend payload:
     * - Never contains account email, auth cookies, Google tokens, or raw timestamps.
     * - Caps every list strictly.
     */
    fun buildSanitizedAIRequest(
        profile: RecommendationEngine.ListenerProfile,
        feedback: Map<String, DiscoveryFeedbackEntry>,
        seedSongs: List<Song>,
        priorPersona: String,
        listeningPattern: String,
        audio: AIRecommendAudio?,
        preferredScripts: List<String> = emptyList(),
    ): AIRecommendRequest {
        val trackById = profile.tracks
        val likedSeeds = seedSongs
            .filter { it.title.isNotBlank() && it.videoId !in profile.dislikedTrackIds && it.videoId !in profile.hiddenTrackIds }
            .distinctBy { RecommendationEngine.recordingKey(it.title, it.artist) }
            .take(10)
            .map { AIRecommendTrackHint(it.title.take(80), it.artist.take(64)) }

        val topArtistNames = profile.artists
            .filter { it.earlySkips <= it.plays + 1 }
            .sortedByDescending { it.plays + (it.totalMs / 180_000.0) }
            .map { it.name.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
            .take(8)

        val skippedArtistNames = buildList {
            for (entry in feedback.values) {
                if (entry.action == DiscoveryFeedbackAction.LESS_LIKE_THIS ||
                    entry.action == DiscoveryFeedbackAction.NOT_INTERESTED
                ) {
                    val clean = entry.artist.trim()
                    if (clean.isNotEmpty()) add(clean)
                }
            }
            for (tf in trackById.values) {
                if (tf.earlySkips >= 2 && tf.plays == 0 && tf.artist.isNotBlank()) {
                    add(tf.artist.trim())
                }
            }
        }.distinct().take(8)

        val likedRecs = feedback.values
            .filter { it.action == DiscoveryFeedbackAction.LIKE || it.action == DiscoveryFeedbackAction.MORE_LIKE_THIS }
            .sortedByDescending { it.updatedAtMs }
            .take(8)
            .map { AIRecommendTrackHint(it.title.take(80), it.artist.take(64)) }

        val skippedRecs = feedback.values
            .filter { it.action == DiscoveryFeedbackAction.NOT_INTERESTED || it.action == DiscoveryFeedbackAction.LESS_LIKE_THIS }
            .sortedByDescending { it.updatedAtMs }
            .take(8)
            .map { AIRecommendTrackHint(it.title.take(80), it.artist.take(64)) }

        val topGenres = profile.favoriteGenres.entries
            .sortedByDescending { it.value }
            .map { it.key }
            .take(6)

        val topMoods = profile.favoriteMoods.entries
            .sortedByDescending { it.value }
            .map { it.key.name.lowercase().replace('_', ' ') }
            .take(4)

        return AIRecommendRequest(
            mode = "daily-discovery",
            topTracks = likedSeeds,
            likedArtists = topArtistNames,
            skippedArtists = skippedArtistNames,
            likedRecommendations = likedRecs,
            skippedRecommendations = skippedRecs,
            preferredGenres = topGenres,
            preferredMoods = topMoods,
            listeningPattern = listeningPattern.take(64),
            priorPersona = priorPersona.take(220),
            preferredScripts = preferredScripts.take(4),
            explorationRatio = 0.72,
            audio = audio,
        )
    }

    /**
     * Produces a personalized, artist/genre-diverse Daily Discovery lineup by reusing
     * [RecommendationEngine.rankTracks] plus discovery reason tags and unfamiliar-artist tagging.
     */
    fun curateDailyMix(
        candidates: List<RecommendationEngine.TrackCandidate>,
        baseProfile: RecommendationEngine.ListenerProfile,
        feedback: Map<String, DiscoveryFeedbackEntry>,
        knownArtistKeys: Set<String>,
        excludeVideoIds: Set<String> = emptySet(),
        nowMs: Long = 0L,
        limit: Int = MAX_DAILY_TRACKS,
        seed: Long = 0L,
    ): List<DailyDiscoveryTrack> {
        if (candidates.isEmpty()) return emptyList()
        val enrichedProfile = enrichProfileWithFeedback(baseProfile, feedback)
            .let { prof ->
                if (excludeVideoIds.isEmpty()) prof
                else prof.copy(hiddenTrackIds = prof.hiddenTrackIds + excludeVideoIds)
            }

        val cleanCandidates = candidates.filter { cand ->
            val song = cand.song
            song.videoId.isNotBlank() &&
                song.title.isNotBlank() &&
                !song.isThirdPartyUpload() &&
                song.videoId !in enrichedProfile.hiddenTrackIds &&
                song.videoId !in enrichedProfile.dislikedTrackIds
        }
        if (cleanCandidates.isEmpty()) return emptyList()

        // First try strict DISCOVERY mode (excludes known songs & skips, balances ~70% unfamiliar artists)
        var ranked = RecommendationEngine.rankTracks(
            candidates = cleanCandidates,
            profile = enrichedProfile,
            mode = RecommendationEngine.RankingMode.DISCOVERY,
            nowMs = nowMs,
            limit = limit,
            seed = seed,
        )

        // If the listener is brand new or candidate pool is small and strict discovery returned < 8,
        // widen cleanly with SUPERMIX rules (still excluding Not Interested / repeatedly skipped / recent)
        if (ranked.size < min(8, limit)) {
            val extra = RecommendationEngine.rankTracks(
                candidates = cleanCandidates,
                profile = enrichedProfile,
                mode = RecommendationEngine.RankingMode.SUPERMIX,
                nowMs = nowMs,
                limit = limit,
                seed = seed + 17L,
            )
            val seen = ranked.mapTo(HashSet()) { RecommendationEngine.recordingKey(it.title, it.artist) }
            val merged = ranked.toMutableList()
            for (song in extra) {
                if (merged.size >= limit) break
                val key = RecommendationEngine.recordingKey(song.title, song.artist)
                if (seen.add(key)) merged += song
            }
            ranked = merged
        }

        val candidateByVideoId = LinkedHashMap<String, RecommendationEngine.TrackCandidate>(cleanCandidates.size)
        for (cand in cleanCandidates) {
            val prev = candidateByVideoId[cand.song.videoId]
            if (prev == null || (!prev.aiCurated && cand.aiCurated)) {
                candidateByVideoId[cand.song.videoId] = cand
            }
        }

        return ranked.map { song ->
            val cand = candidateByVideoId[song.videoId]
            val credits = RecommendationEngine.artistSet(song.artist)
            val isUnfamiliar = credits.isNotEmpty() && credits.none { it in knownArtistKeys }
            val reason = formatReason(
                song = song,
                candidate = cand,
                profile = enrichedProfile,
                isUnfamiliar = isUnfamiliar,
            )
            DailyDiscoveryTrack(
                song = StoredDiscoverySong.from(song),
                reason = reason,
                isUnfamiliarArtist = isUnfamiliar,
                aiCurated = cand?.aiCurated == true,
                genres = cand?.genres.orEmpty(),
                bpm = cand?.bpm,
                energy = cand?.energy,
            )
        }
    }

    private fun formatReason(
        song: Song,
        candidate: RecommendationEngine.TrackCandidate?,
        profile: RecommendationEngine.ListenerProfile,
        isUnfamiliar: Boolean,
    ): String {
        candidate?.reasonTag?.trim()?.takeIf { it.isNotBlank() }?.let { tag ->
            return tag
        }
        val credits = RecommendationEngine.artistSet(song.artist)
        val matchedGenre = candidate?.genres?.firstOrNull { it.lowercase() in profile.favoriteGenres }
            ?: candidate?.genres?.firstOrNull()
        val matchedMoreLike = credits.any { it in profile.moreLikeArtists }
        val bpm = candidate?.bpm
        val targetBpm = profile.preferredBpm
        val bpmMatch = bpm != null && targetBpm != null && abs(bpm - targetBpm) <= 12.0

        return when {
            matchedMoreLike -> "More like artists you rated up"
            isUnfamiliar && candidate?.aiCurated == true -> "New artist · AI taste match"
            isUnfamiliar && matchedGenre != null -> "New artist · $matchedGenre"
            bpmMatch -> "Matches your ~${bpm.toInt()} BPM groove"
            isUnfamiliar -> "New artist aligned with your taste"
            candidate?.isNewRelease == true -> "Fresh release for you"
            matchedGenre != null -> "Picked for your $matchedGenre mix"
            else -> "Matched from your listening profile"
        }
    }

    /** Updates an existing cached collection immediately after the user gives feedback on a track. */
    fun applyFeedbackToCollection(
        collection: DailyDiscoveryCollection,
        entry: DiscoveryFeedbackEntry,
    ): DailyDiscoveryCollection {
        val dislikedCredits = RecommendationEngine.artistSet(entry.artist)
        val updated = when (entry.action) {
            DiscoveryFeedbackAction.NOT_INTERESTED -> {
                collection.items.filterNot { it.song.videoId == entry.videoId }
            }
            DiscoveryFeedbackAction.LESS_LIKE_THIS -> {
                val kept = collection.items.filterNot { it.song.videoId == entry.videoId }
                val other = kept.filter { item ->
                    RecommendationEngine.artistSet(item.song.artist).none { it in dislikedCredits }
                }
                val sameArtistTail = kept.filter { item ->
                    RecommendationEngine.artistSet(item.song.artist).any { it in dislikedCredits }
                }
                other + sameArtistTail
            }
            DiscoveryFeedbackAction.LIKE, DiscoveryFeedbackAction.MORE_LIKE_THIS -> {
                collection.items
            }
        }
        return collection.copy(items = updated)
    }

    /** Estimates whether a listener is a cold-start / minimal-history user. */
    fun isColdStart(profile: RecommendationEngine.ListenerProfile): Boolean {
        val significantTracks = profile.tracks.values.count { it.plays > 0 || it.liked } + profile.likedTrackIds.size
        return significantTracks < MIN_HISTORY_FOR_PERSONALIZATION && profile.artists.size < 2
    }
}
