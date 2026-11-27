package com.music.nikomusic.data

import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.playback.smart.EnergySample
import com.music.nikomusic.playback.smart.TrackAnalysis
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class DailyDiscoveryPlannerTest {

    @Test
    fun coldStartDetectionIdentifiesNewListenersVsRichProfiles() {
        val empty = RecommendationEngine.ListenerProfile()
        assertTrue(DailyDiscoveryPlanner.isColdStart(empty))

        val rich = RecommendationEngine.ListenerProfile(
            artists = listOf(
                RecommendationEngine.ArtistAffinity(name = "Artist 1", plays = 12),
                RecommendationEngine.ArtistAffinity(name = "Artist 2", plays = 9),
            ),
            tracks = mapOf(
                "v1" to RecommendationEngine.TrackFeedback("v1", plays = 5),
                "v2" to RecommendationEngine.TrackFeedback("v2", plays = 4),
            ),
        )
        assertFalse(DailyDiscoveryPlanner.isColdStart(rich))
    }

    @Test
    fun sanitizedAiRequestStripsHiddenSongsAndCapsLists() {
        val seeds = (1..15).map { idx ->
            Song(
                videoId = "seed-$idx",
                title = "Track Title $idx",
                artist = "Artist $idx",
                thumbnailUrl = null,
            )
        }
        val profile = RecommendationEngine.ListenerProfile(
            artists = (1..12).map { RecommendationEngine.ArtistAffinity(name = "Top Artist $it", plays = 20 - it) },
            hiddenTrackIds = setOf("seed-1"),
            dislikedTrackIds = setOf("seed-2"),
            favoriteGenres = (1..10).associate { "genre-$it" to (1.0 - it * 0.05) },
            favoriteMoods = mapOf(
                TopPickMood.FOCUS to 0.9,
                TopPickMood.CHILL to 0.6,
                TopPickMood.WORKOUT to 0.3,
                TopPickMood.LATE_NIGHT to 0.2,
                TopPickMood.SAD to 0.1,
            ),
        )
        val feedback = mapOf(
            "rec-like" to DiscoveryFeedbackEntry(
                videoId = "rec-like",
                title = "Great Find",
                artist = "Good Artist",
                action = DiscoveryFeedbackAction.MORE_LIKE_THIS,
                updatedAtMs = 500L,
            ),
            "rec-skip" to DiscoveryFeedbackEntry(
                videoId = "rec-skip",
                title = "Not My Style",
                artist = "Noisy Band",
                action = DiscoveryFeedbackAction.NOT_INTERESTED,
                updatedAtMs = 600L,
            ),
        )

        val req = DailyDiscoveryPlanner.buildSanitizedAIRequest(
            profile = profile,
            feedback = feedback,
            seedSongs = seeds,
            priorPersona = "Warm indie and jazz fusion listener",
            listeningPattern = "Late-night listener",
            audio = AIRecommendAudio(avgBpm = 104.5, avgEnergy = 0.62),
            preferredScripts = listOf("Latn", "Jpan"),
        )

        assertFalse(req.topTracks.any { it.title == "Track Title 1" || it.title == "Track Title 2" })
        assertTrue(req.topTracks.size <= 10)
        assertTrue(req.likedArtists.size <= 8)
        assertTrue(req.preferredGenres.size <= 6)
        assertTrue(req.preferredMoods.size <= 4)
        assertEquals("Late-night listener", req.listeningPattern)
        assertEquals(listOf(AIRecommendTrackHint("Great Find", "Good Artist")), req.likedRecommendations)
        assertEquals(listOf(AIRecommendTrackHint("Not My Style", "Noisy Band")), req.skippedRecommendations)
        assertTrue("Noisy Band" in req.skippedArtists)
    }

    @Test
    fun deriveListeningPatternBucketsHourlyActivityPrivately() {
        val lateNightHours = LongArray(24) { if (it in 22..23 || it in 0..2) 10L else 1L }.toList()
        assertEquals("Late-night listener", DailyDiscoveryPlanner.deriveListeningPattern(lateNightHours))

        val evenHours = List(24) { 2L }
        assertEquals("All-day eclectic listener", DailyDiscoveryPlanner.deriveListeningPattern(evenHours))
    }

    @Test
    fun acousticSummaryWeightsLikedTracksHigher() {
        val liked = TrackAnalysis(
            status = TrackAnalysis.STATUS_READY,
            trackId = "liked-track",
            duration = 200.0,
            bpm = 120.0,
            energyCurve = listOf(EnergySample(1.0, 0.8), EnergySample(2.0, 0.8)),
        )
        val neutral = TrackAnalysis(
            status = TrackAnalysis.STATUS_READY,
            trackId = "neutral-track",
            duration = 200.0,
            bpm = 85.0,
            energyCurve = listOf(EnergySample(1.0, 0.2)),
        )
        val summary = DailyDiscoveryPlanner.buildAcousticSummary(
            analyses = listOf(liked, neutral),
            likedOrTopIds = setOf("liked-track"),
        )
        assertNotNull(summary)
        // Weighted average of 120 (w=2.5) and 85 (w=1.0) is 110.0
        assertEquals(110.0, summary.avgBpm)
        assertTrue(summary.avgEnergy > 0.6)
    }

    @Test
    fun manualRefreshPolicyEnforcesCooldownAndDailyCap() {
        val dayStart = 1_700_000_000_000L
        val firstAllowed = DailyDiscoveryPlanner.checkManualRefresh(
            nowMs = dayStart + 10_000L,
            todayStartMs = dayStart,
            refreshTimestampsMs = emptyList(),
        )
        assertEquals(RefreshPolicyResult.Allowed(3), firstAllowed)

        val cooldown = DailyDiscoveryPlanner.checkManualRefresh(
            nowMs = dayStart + 45_000L,
            todayStartMs = dayStart,
            refreshTimestampsMs = listOf(dayStart + 20_000L),
        )
        assertTrue(cooldown is RefreshPolicyResult.Cooldown)
        assertEquals(35L, cooldown.waitSeconds)

        val capped = DailyDiscoveryPlanner.checkManualRefresh(
            nowMs = dayStart + 500_000L,
            todayStartMs = dayStart,
            refreshTimestampsMs = listOf(dayStart + 10_000L, dayStart + 100_000L, dayStart + 200_000L),
        )
        assertEquals(RefreshPolicyResult.DailyLimitReached, capped)
    }

    @Test
    fun dailyRefreshCheckRespectsDateAndAccountChanges() {
        val mix = DailyDiscoveryCollection(
            dateKey = "2026-11-26",
            generatedAtMs = 123L,
            listenerKey = "user-a",
            items = listOf(
                DailyDiscoveryTrack(StoredDiscoverySong("v1", "Song 1", "Artist 1")),
            ),
            source = DiscoverySource.BACKEND_AI,
        )
        assertFalse(DailyDiscoveryPlanner.needsDailyRefresh(mix, "2026-11-26", "user-a"))
        assertTrue(DailyDiscoveryPlanner.needsDailyRefresh(mix, "2026-11-27", "user-a"))
        assertTrue(DailyDiscoveryPlanner.needsDailyRefresh(mix, "2026-11-26", "user-b"))
        assertTrue(DailyDiscoveryPlanner.needsDailyRefresh(mix.copy(items = emptyList()), "2026-11-26", "user-a"))
    }

    @Test
    fun feedbackUpdatesCollectionAndEnrichesFutureProfile() {
        val items = listOf(
            DailyDiscoveryTrack(StoredDiscoverySong("v1", "One", "Band A"), genres = listOf("synthwave")),
            DailyDiscoveryTrack(StoredDiscoverySong("v2", "Two", "Band A"), genres = listOf("synthwave")),
            DailyDiscoveryTrack(StoredDiscoverySong("v3", "Three", "Band B"), genres = listOf("jazz")),
        )
        val collection = DailyDiscoveryCollection(
            dateKey = "2026-11-26",
            generatedAtMs = 1L,
            listenerKey = null,
            items = items,
            source = DiscoverySource.LOCAL_TASTE,
        )

        val notInterested = DiscoveryFeedbackEntry(
            videoId = "v1",
            title = "One",
            artist = "Band A",
            action = DiscoveryFeedbackAction.NOT_INTERESTED,
            updatedAtMs = 10L,
        )
        val afterHide = DailyDiscoveryPlanner.applyFeedbackToCollection(collection, notInterested)
        assertEquals(listOf("v2", "v3"), afterHide.items.map { it.song.videoId })

        val lessLikeThis = DiscoveryFeedbackEntry(
            videoId = "v1",
            title = "One",
            artist = "Band A",
            action = DiscoveryFeedbackAction.LESS_LIKE_THIS,
            updatedAtMs = 11L,
            genres = listOf("synthwave"),
        )
        val afterLess = DailyDiscoveryPlanner.applyFeedbackToCollection(collection, lessLikeThis)
        assertEquals(listOf("v3", "v2"), afterLess.items.map { it.song.videoId })

        val moreLike = DiscoveryFeedbackEntry(
            videoId = "v3",
            title = "Three",
            artist = "Band B",
            action = DiscoveryFeedbackAction.MORE_LIKE_THIS,
            updatedAtMs = 12L,
            genres = listOf("jazz"),
        )
        val enriched = DailyDiscoveryPlanner.enrichProfileWithFeedback(
            base = RecommendationEngine.ListenerProfile(),
            feedback = mapOf("v1" to lessLikeThis, "v3" to moreLike),
        )
        assertTrue("v3" in enriched.likedTrackIds)
        assertTrue("v1" in enriched.hiddenTrackIds)
        assertTrue("band b" in enriched.moreLikeArtists)
        assertTrue("band a" in enriched.lessLikeArtists)
        assertTrue("synthwave" in enriched.dislikedGenres)
        assertTrue((enriched.favoriteGenres["jazz"] ?: 0.0) > 0.4)
    }
}
