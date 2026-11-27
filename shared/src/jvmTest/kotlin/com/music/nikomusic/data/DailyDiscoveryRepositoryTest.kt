package com.music.nikomusic.data

import com.music.nikomusic.data.model.ArtistRef
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.data.model.WatchTarget
import com.music.nikomusic.playback.smart.AnalysisStore
import com.music.nikomusic.playback.smart.EnergySample
import com.music.nikomusic.playback.smart.TrackAnalysis
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DailyDiscoveryRepositoryTest {

    private lateinit var tempDir: File
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        tempDir = Files.createTempDirectory("daily-discovery-test").toFile()
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        runCatching { server.shutdown() }
        tempDir.deleteRecursively()
    }

    private class FakeCatalogFetcher(
        var history: List<Song> = emptyList(),
        var searchResults: Map<String, List<Song>> = emptyMap(),
        var watchQueues: Map<String, List<Song>> = emptyMap(),
        var artistSongs: Map<String, List<Song>> = emptyMap(),
        var mixedTargets: List<WatchTarget> = emptyList(),
        var moodSongs: List<Song> = emptyList(),
    ) : DailyDiscoveryRepository.CatalogFetcher {
        val searchCalls = AtomicInteger(0)
        val watchCalls = AtomicInteger(0)

        override suspend fun recentHistory(): List<Song> = history

        override suspend fun searchSongs(query: String): List<Song> {
            searchCalls.incrementAndGet()
            return searchResults.entries
                .firstOrNull { (k, _) -> query.contains(k, ignoreCase = true) }
                ?.value
                ?: emptyList()
        }

        override suspend fun watchQueue(target: WatchTarget): List<Song> {
            watchCalls.incrementAndGet()
            val key = target.videoId ?: target.playlistId
            return watchQueues[key] ?: emptyList()
        }

        override suspend fun artistTopSongsAndRelated(browseId: String): List<Song> =
            artistSongs[browseId] ?: emptyList()

        override suspend fun mixedForYouWatchTargets(): List<WatchTarget> = mixedTargets

        override suspend fun moodPlaylists(mood: TopPickMood): List<Song> = moodSongs
    }

    private fun song(id: String, title: String, artist: String) = Song(
        videoId = id,
        title = title,
        artist = artist,
        thumbnailUrl = "https://img.example/$id.jpg",
    )

    @Test
    fun coldStartListenerGetsStarterMoodAndRegionalMixWithoutCallingBackendAi() = runBlocking {
        val fetcher = FakeCatalogFetcher(
            moodSongs = (1..10).map { song("mood-$it", "Starter Track $it", "Starter Artist $it") },
            searchResults = mapOf(
                "trending" to (1..4).map { song("reg-$it", "Regional Rising $it", "Local Gem $it") },
            ),
        )
        val repo = DailyDiscoveryRepository(
            filesDirProvider = { tempDir },
            nowMsProvider = { 1_700_000_000_000L },
            todayKeyProvider = { "2026-11-26" },
            todayStartMsProvider = { 1_699_990_000_000L },
            catalogFetcher = fetcher,
        )

        val res = repo.loadOrRefresh(
            taste = DailyDiscoveryRepository.TasteInputs(
                listenerKey = "new-user",
                profile = RecommendationEngine.ListenerProfile(),
                regionHints = listOf("india"),
            ),
            aiOptIn = true,
            backendBaseUrl = server.url("/").toString(),
            isNetworkAvailable = true,
        )

        assertEquals(DailyDiscoveryRepository.LoadStatus.Ready, res.status)
        assertNotNull(res.collection)
        assertEquals(DiscoverySource.STARTER_COLD_START, res.collection!!.source)
        assertTrue(res.collection!!.items.size >= 8)
        assertEquals(0, server.requestCount, "Cold-start profile should not make unnecessary AI requests")
    }

    @Test
    fun richListenerWithOptInUsesBackendAiAndReusesCachedCollectionOnSameDay() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """
                    {
                      "enabled": true,
                      "provider": "openai",
                      "queries": ["khruangbin nocturnal groove", "glass beams mirage"],
                      "artists": ["Hermanos Gutierrez"],
                      "subgenres": ["psychedelic soul", "desert funk"],
                      "avoidKeywords": ["nightcore"],
                      "tasteSummary": "Hypnotic instrumental grooves around 108 BPM",
                      "reasons": ["Matches your late-night psychedelic groove", "Fresh instrumental discovery"]
                    }
                    """.trimIndent(),
                ),
        )

        val analysisStore = AnalysisStore { tempDir }
        analysisStore.save(
            "seed-1",
            TrackAnalysis(
                status = TrackAnalysis.STATUS_READY,
                trackId = "seed-1",
                duration = 210.0,
                bpm = 108.0,
                energyCurve = listOf(EnergySample(10.0, 0.64)),
            ),
        )

        val fetcher = FakeCatalogFetcher(
            history = listOf(song("recent-hist", "Recently Played", "Known Artist")),
            searchResults = mapOf(
                "khruangbin" to listOf(
                    song("ai-1", "Time (You and I)", "Khruangbin"),
                    song("ai-2", "So We Won't Forget", "Khruangbin"),
                ),
                "glass beams" to listOf(
                    song("ai-3", "Mahal", "Glass Beams"),
                ),
                "Hermanos Gutierrez" to listOf(
                    song("ai-4", "El Bueno Y El Malo", "Hermanos Gutierrez"),
                ),
            ),
            watchQueues = mapOf(
                "seed-1" to (1..8).map { song("radio-$it", "Related Cut $it", "New Artist $it") },
            ),
        )

        var today = "2026-11-26"
        var now = 1_700_000_050_000L
        val repo = DailyDiscoveryRepository(
            filesDirProvider = { tempDir },
            analysisStore = analysisStore,
            nowMsProvider = { now },
            todayKeyProvider = { today },
            todayStartMsProvider = { 1_700_000_000_000L },
            catalogFetcher = fetcher,
        )

        val taste = DailyDiscoveryRepository.TasteInputs(
            listenerKey = "acct-1",
            profile = RecommendationEngine.ListenerProfile(
                artists = listOf(
                    RecommendationEngine.ArtistAffinity(name = "Known Artist", browseId = "UC_KNOWN", plays = 25),
                    RecommendationEngine.ArtistAffinity(name = "Second Fave", plays = 18),
                ),
                tracks = mapOf(
                    "seed-1" to RecommendationEngine.TrackFeedback("seed-1", "Seed Song", "Known Artist", plays = 15, liked = true),
                    "recent-hist" to RecommendationEngine.TrackFeedback("recent-hist", "Recently Played", "Known Artist", plays = 1),
                    "repeat-skip" to RecommendationEngine.TrackFeedback("repeat-skip", "Skipped", "Bad", skips = 4, earlySkips = 4),
                ),
                recentTrackIds = setOf("recent-hist"),
                likedTrackIds = setOf("seed-1"),
                favoriteGenres = mapOf("psychedelic soul" to 0.9),
                favoriteMoods = mapOf(TopPickMood.LATE_NIGHT to 0.85),
            ),
            seedSongs = listOf(song("seed-1", "Seed Song", "Known Artist")),
            hourOfDay = List(24) { if (it in 22..23) 30L else 1L },
        )

        val first = repo.loadOrRefresh(
            taste = taste,
            aiOptIn = true,
            backendBaseUrl = server.url("/").toString(),
            isNetworkAvailable = true,
        )

        assertEquals(DailyDiscoveryRepository.LoadStatus.Ready, first.status)
        assertNotNull(first.collection)
        assertEquals(DiscoverySource.BACKEND_AI, first.collection!!.source)
        assertTrue(first.collection!!.items.any { it.aiCurated && it.isUnfamiliarArtist })
        assertFalse(first.collection!!.items.any { it.song.videoId == "recent-hist" || it.song.videoId == "repeat-skip" })
        assertEquals(1, server.requestCount)
        val recorded = server.takeRequest()
        assertEquals("/api/ai/recommend", recorded.path)
        val bodyText = recorded.body.readUtf8()
        assertTrue(bodyText.contains("Late-night listener"))
        assertTrue(bodyText.contains("108.0"))

        val searchCallsBeforeReopen = fetcher.searchCalls.get()
        // Reopening same day does NOT regenerate or hit backend AI again
        now += 15_000L
        val reopen = repo.loadOrRefresh(
            taste = taste,
            aiOptIn = true,
            backendBaseUrl = server.url("/").toString(),
            isNetworkAvailable = true,
        )
        assertEquals(DailyDiscoveryRepository.LoadStatus.Ready, reopen.status)
        assertEquals(1, server.requestCount, "Reopening same day must reuse cached mix")
        assertEquals(searchCallsBeforeReopen, fetcher.searchCalls.get())

        // Offline reopening serves saved collection cleanly
        val offline = repo.loadOrRefresh(
            taste = taste,
            aiOptIn = true,
            backendBaseUrl = server.url("/").toString(),
            isNetworkAvailable = false,
        )
        assertEquals(DailyDiscoveryRepository.LoadStatus.CachedOffline, offline.status)
        assertEquals(DiscoverySource.CACHED_OFFLINE, offline.collection?.source)
        assertTrue(offline.collection?.isStale == true)
        assertTrue(offline.collection?.items?.isNotEmpty() == true)
    }

    @Test
    fun offlineWithoutCacheDegradesGracefully() = runBlocking {
        val repo = DailyDiscoveryRepository(
            filesDirProvider = { tempDir },
            nowMsProvider = { 1_700_000_000_000L },
            todayKeyProvider = { "2026-11-26" },
            todayStartMsProvider = { 1_699_990_000_000L },
            catalogFetcher = FakeCatalogFetcher(),
        )
        val res = repo.loadOrRefresh(
            taste = DailyDiscoveryRepository.TasteInputs(listenerKey = "u1"),
            aiOptIn = true,
            backendBaseUrl = server.url("/").toString(),
            isNetworkAvailable = false,
        )
        assertEquals(DailyDiscoveryRepository.LoadStatus.OfflineNoCache, res.status)
        assertNull(res.collection)
    }

    @Test
    fun backendErrorsAndEmptyCatalogDegradeGracefully() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"rate_limited"}"""))

        val fetcher = FakeCatalogFetcher(
            watchQueues = mapOf(
                "seed-1" to (1..10).map { song("local-$it", "Local Discovery $it", "Local Artist $it") },
            ),
        )
        val repo = DailyDiscoveryRepository(
            filesDirProvider = { tempDir },
            nowMsProvider = { 1_700_000_000_000L },
            todayKeyProvider = { "2026-11-26" },
            todayStartMsProvider = { 1_699_990_000_000L },
            catalogFetcher = fetcher,
        )
        val richTaste = DailyDiscoveryRepository.TasteInputs(
            listenerKey = "acct-err",
            profile = RecommendationEngine.ListenerProfile(
                artists = listOf(
                    RecommendationEngine.ArtistAffinity(name = "Artist A", plays = 10),
                    RecommendationEngine.ArtistAffinity(name = "Artist B", plays = 8),
                ),
                tracks = mapOf(
                    "seed-1" to RecommendationEngine.TrackFeedback("seed-1", "Seed", "Artist A", plays = 8),
                    "seed-2" to RecommendationEngine.TrackFeedback("seed-2", "Seed 2", "Artist B", plays = 5),
                ),
                favoriteGenres = mapOf("indie" to 0.9),
            ),
            seedSongs = listOf(song("seed-1", "Seed", "Artist A")),
        )

        val rateLimitedFallback = repo.loadOrRefresh(
            taste = richTaste,
            aiOptIn = true,
            backendBaseUrl = server.url("/").toString(),
            isNetworkAvailable = true,
        )
        assertTrue(rateLimitedFallback.status is DailyDiscoveryRepository.LoadStatus.BackendErrorFallback)
        assertNotNull(rateLimitedFallback.collection)
        assertEquals(DiscoverySource.LOCAL_TASTE, rateLimitedFallback.collection!!.source)
        assertTrue(rateLimitedFallback.collection!!.items.isNotEmpty())

        // Empty catalog repo never throws and returns Failed
        val emptyDir = Files.createTempDirectory("daily-discovery-empty").toFile()
        try {
            val emptyRepo = DailyDiscoveryRepository(
                filesDirProvider = { emptyDir },
                nowMsProvider = { 1_700_000_000_000L },
                todayKeyProvider = { "2026-11-26" },
                todayStartMsProvider = { 1_699_990_000_000L },
                catalogFetcher = FakeCatalogFetcher(),
            )
            val emptyRes = emptyRepo.loadOrRefresh(
                taste = richTaste.copy(profile = RecommendationEngine.ListenerProfile(), seedSongs = emptyList()),
                aiOptIn = false,
                backendBaseUrl = "",
                isNetworkAvailable = true,
            )
            assertTrue(emptyRes.status is DailyDiscoveryRepository.LoadStatus.Failed)
            assertNull(emptyRes.collection)
        } finally {
            emptyDir.deleteRecursively()
        }
    }

    @Test
    fun manualRefreshRateLimitsAndFeedbackClearDataWorkEndToEnd() = runBlocking {
        val fetcher = FakeCatalogFetcher(
            moodSongs = (1..12).map { song("m-$it", "Track $it", "Artist $it") },
        )
        var now = 1_700_000_010_000L
        val dayStart = 1_700_000_000_000L
        val repo = DailyDiscoveryRepository(
            filesDirProvider = { tempDir },
            nowMsProvider = { now },
            todayKeyProvider = { "2026-11-26" },
            todayStartMsProvider = { dayStart },
            catalogFetcher = fetcher,
        )
        val taste = DailyDiscoveryRepository.TasteInputs(
            listenerKey = "u-rate",
            profile = RecommendationEngine.ListenerProfile(),
        )

        val initial = repo.loadOrRefresh(taste, aiOptIn = false, backendBaseUrl = "", isNetworkAvailable = true)
        val firstTrack = initial.collection!!.items.first().song.toSong()

        // Manual refresh #1 succeeds
        now += 10_000L
        val ref1 = repo.loadOrRefresh(taste, aiOptIn = false, backendBaseUrl = "", isNetworkAvailable = true, forceRefresh = true)
        assertEquals(DailyDiscoveryRepository.LoadStatus.Ready, ref1.status)

        // Immediate retry within 60s hits cooldown
        now += 15_000L
        val cooldown = repo.loadOrRefresh(taste, aiOptIn = false, backendBaseUrl = "", isNetworkAvailable = true, forceRefresh = true)
        assertTrue(cooldown.status is DailyDiscoveryRepository.LoadStatus.RateLimited)
        assertFalse((cooldown.status as DailyDiscoveryRepository.LoadStatus.RateLimited).dailyLimitReached)

        // Feedback persists and removes NOT_INTERESTED from cached list
        val afterFeedback = repo.recordFeedback(firstTrack, DiscoveryFeedbackAction.NOT_INTERESTED, listOf("indie"))
        assertEquals(DiscoveryFeedbackAction.NOT_INTERESTED, afterFeedback.feedbackByVideoId[firstTrack.videoId]?.action)
        assertFalse(afterFeedback.cached!!.items.any { it.song.videoId == firstTrack.videoId })

        // Manual refreshes #2 and #3 succeed past cooldown; #4 hits daily cap
        now += 70_000L
        assertEquals(
            DailyDiscoveryRepository.LoadStatus.Ready,
            repo.loadOrRefresh(taste, aiOptIn = false, backendBaseUrl = "", isNetworkAvailable = true, forceRefresh = true).status,
        )
        now += 70_000L
        assertEquals(
            DailyDiscoveryRepository.LoadStatus.Ready,
            repo.loadOrRefresh(taste, aiOptIn = false, backendBaseUrl = "", isNetworkAvailable = true, forceRefresh = true).status,
        )
        now += 70_000L
        val capped = repo.loadOrRefresh(taste, aiOptIn = false, backendBaseUrl = "", isNetworkAvailable = true, forceRefresh = true)
        assertTrue(capped.status is DailyDiscoveryRepository.LoadStatus.RateLimited)
        assertTrue((capped.status as DailyDiscoveryRepository.LoadStatus.RateLimited).dailyLimitReached)

        // Clear all wipes persisted cache and feedback
        val cleared = repo.clearAllData()
        assertNull(cleared.cached)
        assertTrue(cleared.feedbackByVideoId.isEmpty())
    }
}
