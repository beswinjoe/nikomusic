package com.music.nikomusic.data

import com.music.nikomusic.data.model.HomeShelf
import com.music.nikomusic.data.model.SearchFilter
import com.music.nikomusic.data.model.SearchResult
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.data.model.WatchTarget
import com.music.nikomusic.data.model.normalizedArtistName
import com.music.nikomusic.playback.smart.AnalysisStore
import com.music.nikomusic.playback.smart.TrackAnalysis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/**
 * Coordinates disk caching, offline recovery, feedback persistence, backend AI
 * query generation, and catalog candidate resolution for **AI Daily Discovery**.
 *
 * Reuses [YtMusicRepository], [RecommendationEngine], and [AnalysisStore] instead
 * of duplicating music fetchers or scoring engines, and degrades transparently when
 * backend AI is disabled, opted out, rate-limited, or offline.
 */
class DailyDiscoveryRepository(
    private val filesDirProvider: () -> File,
    private val backendClient: DailyDiscoveryBackendClient = DailyDiscoveryBackendClient(),
    private val analysisStore: AnalysisStore = AnalysisStore(filesDirProvider),
    private val nowMsProvider: () -> Long = { System.currentTimeMillis() },
    private val todayKeyProvider: () -> String = { LocalDate.now().toString() },
    private val todayStartMsProvider: () -> Long = {
        LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
    },
    private val catalogFetcher: CatalogFetcher = YtMusicCatalogFetcher,
) {
    /** Pluggable catalog boundary so unit tests can exercise cold-start/offline/AI/diverse flows deterministically. */
    interface CatalogFetcher {
        suspend fun recentHistory(): List<Song>
        suspend fun searchSongs(query: String): List<Song>
        suspend fun watchQueue(target: WatchTarget): List<Song>
        suspend fun artistTopSongsAndRelated(browseId: String): List<Song>
        suspend fun mixedForYouWatchTargets(): List<WatchTarget>
        suspend fun moodPlaylists(mood: TopPickMood): List<Song>
    }

    object YtMusicCatalogFetcher : CatalogFetcher {
        override suspend fun recentHistory(): List<Song> =
            YtMusicRepository.recentHistory().getOrNull().orEmpty()

        override suspend fun searchSongs(query: String): List<Song> =
            YtMusicRepository.search(query, SearchFilter.SONGS).getOrNull().orEmpty()
                .mapNotNull { res ->
                    when (res) {
                        is SearchResult.TopTrack -> res.song
                        is SearchResult.Track -> res.song
                        is SearchResult.Browse -> null
                    }
                }

        override suspend fun watchQueue(target: WatchTarget): List<Song> =
            YtMusicRepository.watchQueue(target).getOrNull().orEmpty()

        override suspend fun artistTopSongsAndRelated(browseId: String): List<Song> {
            val page = YtMusicRepository.artistLanding(browseId).getOrNull() ?: return emptyList()
            val out = LinkedHashMap<String, Song>()
            page.songs.forEach { if (it.videoId.isNotBlank()) out.putIfAbsent(it.videoId, it) }
            page.radio?.let { radio ->
                YtMusicRepository.watchQueue(radio).getOrNull().orEmpty()
                    .forEach { if (it.videoId.isNotBlank()) out.putIfAbsent(it.videoId, it) }
            }
            return out.values.toList()
        }

        override suspend fun mixedForYouWatchTargets(): List<WatchTarget> =
            YtMusicRepository.mixedForYou().getOrNull().orEmpty()
                .mapNotNull { item ->
                    val id = item.browseId?.removePrefix("VL") ?: return@mapNotNull null
                    WatchTarget(playlistId = id)
                }

        override suspend fun moodPlaylists(mood: TopPickMood): List<Song> {
            val shelves = YtMusicRepository.moodGenreShelves(TopPickMood.CATEGORY_BROWSE_ID, mood.params)
                .getOrNull().orEmpty()
            val item = shelves.firstOrNull()?.items?.firstOrNull { it.browseId != null } ?: return emptyList()
            val bid = item.browseId ?: return emptyList()
            val pid = bid.removePrefix("VL")
            return YtMusicRepository.playlistAsAudio(pid).getOrNull()?.takeIf { it.isNotEmpty() }
                ?: YtMusicRepository.browseSongs(bid).getOrNull()?.songs.orEmpty()
        }
    }

    data class TasteInputs(
        val listenerKey: String? = null,
        val profile: RecommendationEngine.ListenerProfile = RecommendationEngine.ListenerProfile(),
        val seedSongs: List<Song> = emptyList(),
        val homeShelves: List<HomeShelf> = emptyList(),
        val hourOfDay: List<Long> = emptyList(),
        val regionHints: List<String> = emptyList(),
        val preferredScripts: List<String> = emptyList(),
    )

    sealed interface LoadStatus {
        data object Ready : LoadStatus
        data object CachedOffline : LoadStatus
        data object OfflineNoCache : LoadStatus
        data class RateLimited(val waitSeconds: Long, val dailyLimitReached: Boolean) : LoadStatus
        data class BackendErrorFallback(val message: String) : LoadStatus
        data class Failed(val message: String) : LoadStatus
    }

    data class LoadResult(
        val collection: DailyDiscoveryCollection?,
        val state: DailyDiscoveryStateStore,
        val status: LoadStatus,
        val refreshAllowance: RefreshPolicyResult,
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val ioMutex = Mutex()
    private val stateFile by lazy { File(filesDirProvider(), STATE_FILE_NAME) }

    suspend fun loadState(): DailyDiscoveryStateStore = ioMutex.withLock {
        readStateUnlocked()
    }

    suspend fun loadOrRefresh(
        taste: TasteInputs,
        aiOptIn: Boolean,
        backendBaseUrl: String,
        isNetworkAvailable: Boolean,
        forceRefresh: Boolean = false,
    ): LoadResult {
        val todayKey = todayKeyProvider()
        val nowMs = nowMsProvider()
        val todayStartMs = todayStartMsProvider()

        val initial = ioMutex.withLock { readStateUnlocked() }
        val sanitizedCached = initial.cached?.let { stripNotInterested(it, initial.feedbackByVideoId) }

        val allowance = DailyDiscoveryPlanner.checkManualRefresh(
            nowMs = nowMs,
            todayStartMs = todayStartMs,
            refreshTimestampsMs = initial.refreshTimestampsMs,
        )

        val sameListener = sanitizedCached?.listenerKey == taste.listenerKey
        val freshToday = sanitizedCached != null &&
            sanitizedCached.items.isNotEmpty() &&
            sameListener &&
            !DailyDiscoveryPlanner.needsDailyRefresh(sanitizedCached, todayKey, taste.listenerKey)

        // Repeated opens same day -> serve cached without hitting backend/YT again.
        if (!forceRefresh && freshToday) {
            return LoadResult(
                collection = sanitizedCached,
                state = initial.copy(cached = sanitizedCached),
                status = if (isNetworkAvailable) LoadStatus.Ready else LoadStatus.CachedOffline,
                refreshAllowance = allowance,
            )
        }

        // Manual refresh enforces sensible rate limits without wiping cached collection.
        if (forceRefresh) {
            when (allowance) {
                is RefreshPolicyResult.Cooldown -> {
                    return LoadResult(
                        collection = sanitizedCached,
                        state = initial.copy(cached = sanitizedCached),
                        status = LoadStatus.RateLimited(allowance.waitSeconds, dailyLimitReached = false),
                        refreshAllowance = allowance,
                    )
                }
                RefreshPolicyResult.DailyLimitReached -> {
                    return LoadResult(
                        collection = sanitizedCached,
                        state = initial.copy(cached = sanitizedCached),
                        status = LoadStatus.RateLimited(0L, dailyLimitReached = true),
                        refreshAllowance = allowance,
                    )
                }
                is RefreshPolicyResult.Allowed -> Unit
            }
        }

        // Offline handling: never destroy cached mix; show cached collection or honest offline state.
        if (!isNetworkAvailable) {
            val offlineCached = sanitizedCached?.copy(isStale = true, source = DiscoverySource.CACHED_OFFLINE)
            return LoadResult(
                collection = offlineCached,
                state = initial.copy(cached = offlineCached),
                status = if (offlineCached != null && offlineCached.items.isNotEmpty()) {
                    LoadStatus.CachedOffline
                } else {
                    LoadStatus.OfflineNoCache
                },
                refreshAllowance = allowance,
            )
        }

        return try {
            buildFreshCollection(
                prior = initial.copy(cached = sanitizedCached),
                taste = taste,
                aiOptIn = aiOptIn,
                backendBaseUrl = backendBaseUrl,
                todayKey = todayKey,
                nowMs = nowMs,
                todayStartMs = todayStartMs,
                recordManualRefresh = forceRefresh,
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DebugLog.w(TAG, "DailyDiscovery build error: ${e.message}")
            LoadResult(
                collection = sanitizedCached?.copy(isStale = true),
                state = initial.copy(cached = sanitizedCached),
                status = LoadStatus.Failed(e.message ?: "Unable to refresh Daily Discovery"),
                refreshAllowance = allowance,
            )
        }
    }

    suspend fun recordFeedback(
        song: Song,
        action: DiscoveryFeedbackAction,
        genres: List<String> = emptyList(),
    ): DailyDiscoveryStateStore = ioMutex.withLock {
        val current = readStateUnlocked()
        val analysis = runCatching { analysisStore.load(song.videoId) }.getOrNull()
        val entry = DiscoveryFeedbackEntry(
            videoId = song.videoId,
            title = song.title,
            artist = song.artist,
            action = action,
            updatedAtMs = nowMsProvider(),
            genres = genres.take(4),
            bpm = analysis?.takeIf { it.isUsable }?.bpm,
            energy = analysis?.takeIf { it.isUsable && it.energyCurve.isNotEmpty() }
                ?.let { it.energyCurve.sumOf { sample -> sample.energy } / it.energyCurve.size },
        )
        val nextFeedback = (current.feedbackByVideoId + (song.videoId to entry))
            .entries
            .sortedByDescending { it.value.updatedAtMs }
            .take(MAX_FEEDBACK_HISTORY)
            .associate { it.key to it.value }

        val updatedCached = current.cached?.let { DailyDiscoveryPlanner.applyFeedbackToCollection(it, entry) }
        val nextState = current.copy(
            feedbackByVideoId = nextFeedback,
            cached = updatedCached,
        )
        writeStateUnlocked(nextState)
        nextState
    }

    suspend fun clearAllData(): DailyDiscoveryStateStore = ioMutex.withLock {
        val empty = DailyDiscoveryStateStore()
        writeStateUnlocked(empty)
        empty
    }

    private suspend fun buildFreshCollection(
        prior: DailyDiscoveryStateStore,
        taste: TasteInputs,
        aiOptIn: Boolean,
        backendBaseUrl: String,
        todayKey: String,
        nowMs: Long,
        todayStartMs: Long,
        recordManualRefresh: Boolean,
    ): LoadResult = coroutineScope {
        val enrichedProfile = DailyDiscoveryPlanner.enrichProfileWithFeedback(
            base = taste.profile,
            feedback = prior.feedbackByVideoId,
        )
        val recentHistory = runCatching { catalogFetcher.recentHistory() }.getOrDefault(emptyList())
        val seedSongs = (taste.seedSongs + recentHistory).distinctBy { it.videoId }

        val likedOrTopIds = buildSet {
            addAll(enrichedProfile.likedTrackIds)
            seedSongs.take(15).forEach { if (it.videoId.isNotBlank()) add(it.videoId) }
        }
        val cachedAnalyses = withContext(Dispatchers.IO) {
            likedOrTopIds.take(25).mapNotNull { id -> analysisStore.load(id)?.takeIf { it.isUsable } }
        }
        val audioSummary = DailyDiscoveryPlanner.buildAcousticSummary(cachedAnalyses, enrichedProfile.likedTrackIds)
        val effectiveProfile = enrichedProfile.copy(
            preferredBpm = audioSummary?.avgBpm ?: enrichedProfile.preferredBpm,
            preferredEnergy = audioSummary?.avgEnergy ?: enrichedProfile.preferredEnergy,
            recentTrackIds = enrichedProfile.recentTrackIds + recentHistory.take(25).map { it.videoId },
            recentRecordings = enrichedProfile.recentRecordings +
                recentHistory.take(20).map { RecommendationEngine.recordingKey(it.title, it.artist) },
        )

        var aiResponse: AIRecommendResponse? = null
        var backendWarning: String? = null
        val isColdStart = DailyDiscoveryPlanner.isColdStart(effectiveProfile) && seedSongs.isEmpty()

        // 1. Optional backend AI request strictly when opted in & backend URL configured.
        if (aiOptIn && backendBaseUrl.isNotBlank() && !isColdStart) {
            val pattern = DailyDiscoveryPlanner.deriveListeningPattern(taste.hourOfDay)
            val request = DailyDiscoveryPlanner.buildSanitizedAIRequest(
                profile = effectiveProfile,
                feedback = prior.feedbackByVideoId,
                seedSongs = seedSongs,
                priorPersona = prior.priorPersona,
                listeningPattern = pattern,
                audio = audioSummary,
                preferredScripts = taste.preferredScripts,
            )
            when (val res = backendClient.recommend(backendBaseUrl, request)) {
                is DailyDiscoveryBackendClient.Result.Success -> {
                    aiResponse = res.response
                }
                DailyDiscoveryBackendClient.Result.RateLimited -> {
                    backendWarning = "AI rate limit reached — showing locally curated taste picks"
                }
                is DailyDiscoveryBackendClient.Result.NetworkError -> {
                    backendWarning = "AI backend unreachable — using your YouTube Music taste graph"
                }
                is DailyDiscoveryBackendClient.Result.HttpError -> {
                    backendWarning = "AI service temporarily unavailable (${res.message})"
                }
                DailyDiscoveryBackendClient.Result.Disabled -> Unit
            }
        }

        val candidates = ArrayList<RecommendationEngine.TrackCandidate>(96)
        val seenVideoIds = HashSet<String>()

        fun addCandidate(song: Song, genres: List<String> = emptyList(), aiCurated: Boolean = false, reason: String? = null, isNewRelease: Boolean = false) {
            if (song.videoId.isBlank() || song.title.isBlank() || !seenVideoIds.add(song.videoId)) return
            candidates += RecommendationEngine.TrackCandidate(
                song = song,
                genres = genres,
                aiCurated = aiCurated,
                reasonTag = reason,
                isNewRelease = isNewRelease,
                sourceOrder = candidates.size,
            )
        }

        // 2. Resolve AI-suggested queries & AI-suggested adjacent artists if available
        if (aiResponse != null) {
            val aiGenres = aiResponse.subgenres
            val queryTasks = aiResponse.queries.take(8).mapIndexed { idx, query ->
                val rawReason = aiResponse.reasons.getOrNull(idx).orEmpty()
                async {
                    val hits = catalogFetcher.searchSongs(query).take(3)
                    Triple(hits, aiGenres, rawReason)
                }
            }
            val artistTasks = aiResponse.artists.take(3).map { artist ->
                async { catalogFetcher.searchSongs(artist).take(4) }
            }
            queryTasks.awaitAll().forEach { (hits, genres, reason) ->
                hits.forEach { addCandidate(it, genres = genres, aiCurated = true, reason = reason.ifBlank { null }) }
            }
            artistTasks.awaitAll().flatten().forEach {
                addCandidate(it, genres = aiGenres, aiCurated = true)
            }
        }

        // 3. Multi-source taste & adjacency graph (Reuses existing YtMusicRepository graph & More Like This)
        val moreLikeSeeds = prior.feedbackByVideoId.values
            .filter { it.action == DiscoveryFeedbackAction.MORE_LIKE_THIS }
            .sortedByDescending { it.updatedAtMs }
            .take(2)
        val radioSeedIds = (moreLikeSeeds.map { it.videoId } + seedSongs.map { it.videoId })
            .distinct()
            .take(4)
        val radioTasks = radioSeedIds.map { vid ->
            async { catalogFetcher.watchQueue(WatchTarget(playlistId = "RDAMVM$vid", videoId = vid)) }
        }
        val artistLandingTasks = effectiveProfile.artists
            .mapNotNull { it.browseId }
            .distinct()
            .take(3)
            .map { bid -> async { catalogFetcher.artistTopSongsAndRelated(bid) } }

        radioTasks.awaitAll().flatten().forEach { song ->
            val genres = effectiveProfile.artistGenres[normalizedArtistName(song.artist)].orEmpty()
            addCandidate(song, genres = genres, aiCurated = false)
        }
        artistLandingTasks.awaitAll().flatten().forEach { song ->
            val genres = effectiveProfile.artistGenres[normalizedArtistName(song.artist)].orEmpty()
            addCandidate(song, genres = genres, aiCurated = false)
        }

        // 4. Discover Mix & New Release Mix / Cold-Start non-random fallback
        if (candidates.size < 24) {
            val mixes = catalogFetcher.mixedForYouWatchTargets().take(2)
            mixes.map { target -> async { catalogFetcher.watchQueue(target) } }
                .awaitAll()
                .flatten()
                .forEach { addCandidate(it, aiCurated = false) }
        }

        // For first-time users with virtually empty history, use mood + regional music charts
        // (never unseeded random tracks!)
        if (candidates.size < 12) {
            val coldStartMood = RecommendationEngine.chooseFeaturedMood(
                Instant.ofEpochMilli(nowMs).atZone(ZoneId.systemDefault()).hour,
                effectiveProfile,
            )
            val moodSongs = catalogFetcher.moodPlaylists(coldStartMood).take(15)
            moodSongs.forEach {
                addCandidate(it, genres = listOf(coldStartMood.name.lowercase().replace('_', ' ')), reason = "Popular in ${coldStartMood.name.lowercase().replace('_', ' ')}")
            }
            if (candidates.size < 12 && taste.regionHints.isNotEmpty()) {
                val hintQuery = taste.regionHints.take(2).joinToString(" ") + " trending music"
                catalogFetcher.searchSongs(hintQuery).take(12).forEach {
                    addCandidate(it, reason = "Trending in your region")
                }
            }
        }

        // 5. Curate via extended RecommendationEngine + Diversity & Novelty rules
        val knownArtistKeys = buildSet {
            effectiveProfile.artists.forEach { addAll(RecommendationEngine.artistSet(it.name)) }
            seedSongs.forEach { addAll(RecommendationEngine.artistSet(it.artist)) }
        }
        val exclusionIds = (prior.cached?.items.orEmpty().map { it.song.videoId }
            .takeIf { recordManualRefresh }
            .orEmpty())
            .toSet()

        var curated = DailyDiscoveryPlanner.curateDailyMix(
            candidates = candidates,
            baseProfile = effectiveProfile,
            feedback = prior.feedbackByVideoId,
            knownArtistKeys = knownArtistKeys,
            excludeVideoIds = exclusionIds,
            nowMs = nowMs,
            limit = DailyDiscoveryPlanner.MAX_DAILY_TRACKS,
            seed = nowMs xor todayKey.hashCode().toLong(),
        )
        // If manual refresh excluded everything from a tiny pool, retry without prior-mix exclusion
        if (curated.isEmpty() && exclusionIds.isNotEmpty()) {
            curated = DailyDiscoveryPlanner.curateDailyMix(
                candidates = candidates,
                baseProfile = effectiveProfile,
                feedback = prior.feedbackByVideoId,
                knownArtistKeys = knownArtistKeys,
                excludeVideoIds = emptySet(),
                nowMs = nowMs,
                limit = DailyDiscoveryPlanner.MAX_DAILY_TRACKS,
                seed = nowMs,
            )
        }

        val updatedRefreshes = if (recordManualRefresh && curated.isNotEmpty()) {
            DailyDiscoveryPlanner.pruneOldRefreshes(
                prior.refreshTimestampsMs + nowMs,
                todayStartMs - 86_400_000L,
            )
        } else {
            DailyDiscoveryPlanner.pruneOldRefreshes(prior.refreshTimestampsMs, todayStartMs - 86_400_000L)
        }
        val nextAllowance = DailyDiscoveryPlanner.checkManualRefresh(nowMs, todayStartMs, updatedRefreshes)

        if (curated.isEmpty()) {
            val fallbackCached = prior.cached?.copy(isStale = true)
            return@coroutineScope LoadResult(
                collection = fallbackCached,
                state = prior.copy(refreshTimestampsMs = updatedRefreshes, cached = fallbackCached),
                status = LoadStatus.Failed("No fresh recommendations available right now"),
                refreshAllowance = nextAllowance,
            )
        }

        val source = when {
            aiResponse != null -> DiscoverySource.BACKEND_AI
            isColdStart -> DiscoverySource.STARTER_COLD_START
            else -> DiscoverySource.LOCAL_TASTE
        }
        val summaryText = aiResponse?.tasteSummary?.takeIf { it.isNotBlank() }
            ?: when (source) {
                DiscoverySource.STARTER_COLD_START ->
                    "Starter discovery mix — play or rate a few songs to sharpen AI picks."
                else -> buildLocalSummaryText(effectiveProfile, audioSummary)
            }

        val collection = DailyDiscoveryCollection(
            dateKey = todayKey,
            generatedAtMs = nowMs,
            listenerKey = taste.listenerKey,
            items = curated,
            source = source,
            tasteSummary = summaryText,
            subgenres = aiResponse?.subgenres?.takeIf { it.isNotEmpty() }
                ?: effectiveProfile.favoriteGenres.keys.take(4),
            isStale = false,
        )
        val nextState = prior.copy(
            refreshTimestampsMs = updatedRefreshes,
            priorPersona = aiResponse?.tasteSummary?.takeIf { it.isNotBlank() } ?: prior.priorPersona,
            cached = collection,
        )
        ioMutex.withLock { writeStateUnlocked(nextState) }

        val finalStatus = if (backendWarning != null) {
            LoadStatus.BackendErrorFallback(backendWarning)
        } else {
            LoadStatus.Ready
        }
        LoadResult(
            collection = collection,
            state = nextState,
            status = finalStatus,
            refreshAllowance = nextAllowance,
        )
    }

    private fun buildLocalSummaryText(
        profile: RecommendationEngine.ListenerProfile,
        audio: AIRecommendAudio?,
    ): String {
        val topArtists = profile.artists.take(2).map { it.name }.filter { it.isNotBlank() }
        val topGenre = profile.favoriteGenres.keys.firstOrNull()
        val parts = buildList {
            if (topArtists.isNotEmpty()) add("Inspired by ${topArtists.joinToString(" & ")}")
            if (!topGenre.isNullOrBlank()) add(topGenre)
            if (audio != null && audio.avgBpm > 0) add("~${audio.avgBpm.toInt()} BPM")
        }
        return if (parts.isEmpty()) {
            "Fresh daily tracks matched to your listening taste."
        } else {
            parts.joinToString(" · ")
        }
    }

    private fun stripNotInterested(
        collection: DailyDiscoveryCollection,
        feedback: Map<String, DiscoveryFeedbackEntry>,
    ): DailyDiscoveryCollection {
        val hidden = feedback.filterValues {
            it.action == DiscoveryFeedbackAction.NOT_INTERESTED ||
                it.action == DiscoveryFeedbackAction.LESS_LIKE_THIS
        }.keys
        if (hidden.isEmpty()) return collection
        return collection.copy(items = collection.items.filterNot { it.song.videoId in hidden })
    }

    private fun readStateUnlocked(): DailyDiscoveryStateStore {
        val file = stateFile
        if (!file.exists()) return DailyDiscoveryStateStore()
        return runCatching {
            json.decodeFromString(DailyDiscoveryStateStore.serializer(), file.readText())
        }.getOrElse {
            DebugLog.w(TAG, "Resetting unreadable DailyDiscovery state: ${it.message}")
            DailyDiscoveryStateStore()
        }
    }

    private fun writeStateUnlocked(state: DailyDiscoveryStateStore) {
        runCatching {
            val file = stateFile
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, "${file.name}.tmp")
            try {
                tmp.writeText(json.encodeToString(DailyDiscoveryStateStore.serializer(), state))
                try {
                    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
            } finally {
                tmp.delete()
            }
        }.onFailure { DebugLog.w(TAG, "Failed saving DailyDiscovery state: ${it.message}") }
    }

    private companion object {
        const val TAG = "DailyDiscoveryRepo"
        const val STATE_FILE_NAME = "daily_discovery_state.json"
        const val MAX_FEEDBACK_HISTORY = 250
    }
}
