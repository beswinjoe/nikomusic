package com.music.nikomusic.data

import com.music.nikomusic.data.model.HomeShelf
import com.music.nikomusic.data.model.ShelfItem
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPickMood
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RecommendationEngineTest {

    private fun song(
        id: String,
        title: String = "Track $id",
        artist: String = "Artist $id",
        album: String? = null,
        isVideo: Boolean = false,
    ) = Song(
        videoId = id,
        title = title,
        artist = artist,
        thumbnailUrl = null,
        albumName = album,
        isVideo = isVideo,
    )

    @Test
    fun tenCoreMoodsCoverAllRequestedCategories() {
        val core = TopPickMood.CORE_MOODS
        assertEquals(10, core.size)
        assertEquals(
            setOf(
                TopPickMood.LOVE,
                TopPickMood.SAD,
                TopPickMood.ENERGY,
                TopPickMood.CHILL,
                TopPickMood.FOCUS,
                TopPickMood.PARTY,
                TopPickMood.HAPPY,
                TopPickMood.LATE_NIGHT,
                TopPickMood.ROAD_TRIP,
                TopPickMood.NOSTALGIA,
            ),
            core.toSet(),
        )
        core.forEach { mood ->
            assertTrue(mood.isCoreMood, "Expected $mood to be a core mood")
            assertTrue(RecommendationEngine.ruleFor(mood).positiveKeywords.isNotEmpty())
        }
    }

    @Test
    fun moodFiltersContradictoryTracksCleanly() {
        val chillMix = listOf(
            RecommendationEngine.TrackCandidate(song("1", "Midnight Acoustic", "Alex"), "Chill Vibes"),
            RecommendationEngine.TrackCandidate(song("2", "Beast Mode Hardstyle Gym", "DJ Lift"), "Chill Vibes"),
            RecommendationEngine.TrackCandidate(song("3", "Soft Piano Drift", "Clara"), "Peaceful Acoustics"),
        )
        val rankedChill = RecommendationEngine.rankTracks(
            candidates = chillMix,
            profile = RecommendationEngine.ListenerProfile(),
            mode = RecommendationEngine.RankingMode.MOOD,
            mood = TopPickMood.CHILL,
            seed = 42L,
        )
        assertFalse(rankedChill.any { it.videoId == "2" }, "Workout hardstyle should be filtered from Chill")
        assertEquals(setOf("1", "3"), rankedChill.map { it.videoId }.toSet())

        val focusMix = listOf(
            RecommendationEngine.TrackCandidate(song("f1", "Study Ambient Keys", "Nils")),
            RecommendationEngine.TrackCandidate(song("f2", "Saturday Karaoke Party", "Club DJ")),
        )
        val rankedFocus = RecommendationEngine.rankTracks(
            candidates = focusMix,
            profile = RecommendationEngine.ListenerProfile(),
            mode = RecommendationEngine.RankingMode.MOOD,
            mood = TopPickMood.FOCUS,
            seed = 7L,
        )
        assertEquals(listOf("f1"), rankedFocus.map { it.videoId })
    }

    @Test
    fun coldStartNewUserStillGetsDiversePlayableQueue() {
        val candidates = (1..20).map { i ->
            val artist = if (i <= 10) "Same Artist" else "Artist $i"
            RecommendationEngine.TrackCandidate(song("v$i", "Song $i", artist))
        }
        val queue = RecommendationEngine.rankTracks(
            candidates = candidates,
            profile = RecommendationEngine.ListenerProfile(),
            mode = RecommendationEngine.RankingMode.MOOD,
            mood = TopPickMood.HAPPY,
            limit = 16,
            seed = 123L,
        )
        assertEquals(12, queue.size)
        val sameArtistCount = queue.count { it.artist == "Same Artist" }
        assertTrue(sameArtistCount <= 2, "Per-artist diversity cap should limit Same Artist to <= 2, got $sameArtistCount")
    }

    @Test
    fun skipPenaltyAndRecencyFatigueAffectRanking() {
        val candidates = listOf(
            RecommendationEngine.TrackCandidate(song("fav", "Beloved Track", "Fav Artist")),
            RecommendationEngine.TrackCandidate(song("skipped_once", "Skipped Once", "Other A")),
            RecommendationEngine.TrackCandidate(song("skipped_heavy", "Skipped Always", "Other B")),
            RecommendationEngine.TrackCandidate(song("recent", "Just Played 10m Ago", "Fav Artist")),
        )
        val now = 1_700_000_000_000L
        val profile = RecommendationEngine.ListenerProfile(
            artists = listOf(RecommendationEngine.ArtistAffinity("Fav Artist", plays = 20)),
            tracks = mapOf(
                "fav" to RecommendationEngine.TrackFeedback("fav", "Beloved Track", "Fav Artist", plays = 6, lastPlayedMs = now - 5L * 86_400_000L, liked = true),
                "skipped_once" to RecommendationEngine.TrackFeedback("skipped_once", "Skipped Once", "Other A", plays = 1, skips = 1, earlySkips = 1, lastSkippedMs = now - 3_600_000L),
                "skipped_heavy" to RecommendationEngine.TrackFeedback("skipped_heavy", "Skipped Always", "Other B", plays = 0, skips = 3, earlySkips = 3, lastSkippedMs = now - 3_600_000L),
                "recent" to RecommendationEngine.TrackFeedback("recent", "Just Played 10m Ago", "Fav Artist", plays = 4, lastPlayedMs = now - 600_000L),
            ),
            recentTrackIds = setOf("recent"),
            likedTrackIds = setOf("fav"),
        )
        val ranked = RecommendationEngine.rankTracks(
            candidates = candidates,
            profile = profile,
            mode = RecommendationEngine.RankingMode.SUPERMIX,
            nowMs = now,
            seed = 99L,
        )
        assertFalse(ranked.any { it.videoId == "skipped_heavy" }, "Repeated early-skipped track must be excluded")
        assertEquals("fav", ranked.first().videoId, "Liked non-fatigued favorite should lead Supermix")
        assertTrue(
            ranked.indexOfFirst { it.videoId == "fav" } < ranked.indexOfFirst { it.videoId == "recent" },
            "Recently played track should rank below fresh favorite",
        )
    }

    @Test
    fun discoveryModeExcludesKnownTracksAndPrefersNewArtists() {
        val candidates = listOf(
            RecommendationEngine.TrackCandidate(song("known", "Old Favorite", "Top Artist")),
            RecommendationEngine.TrackCandidate(song("deep_cut", "Deep Cut", "Top Artist")),
            RecommendationEngine.TrackCandidate(song("fresh", "Brand New Sound", "Unheard Artist")),
        )
        val profile = RecommendationEngine.ListenerProfile(
            artists = listOf(RecommendationEngine.ArtistAffinity("Top Artist", plays = 30)),
            tracks = mapOf("known" to RecommendationEngine.TrackFeedback("known", "Old Favorite", "Top Artist", plays = 5)),
            likedTrackIds = setOf("known"),
            recentTrackIds = setOf("known"),
        )
        val ranked = RecommendationEngine.rankTracks(
            candidates = candidates,
            profile = profile,
            mode = RecommendationEngine.RankingMode.DISCOVERY,
            seed = 1L,
        )
        assertFalse(ranked.any { it.videoId == "known" })
        assertEquals("fresh", ranked.first().videoId)
    }

    @Test
    fun moodPlaylistSelectorUsesHintsAndAvoidsContradictions() {
        val shelves = listOf(
            HomeShelf(
                title = "Workout Intense",
                items = listOf(ShelfItem("Gym Hype", "", null, null, "VL_GYM")),
            ),
            HomeShelf(
                title = "Romantic Hindi & Bollywood",
                items = listOf(ShelfItem("Ishq Ballads", "Acoustic romance", null, null, "VL_LOVE_IN")),
            ),
            HomeShelf(
                title = "Pop Love",
                items = listOf(ShelfItem("Sweet Hearts", "Pop", null, null, "VL_LOVE_POP")),
            ),
        )
        val chosen = RecommendationEngine.selectMoodPlaylists(
            shelves = shelves,
            mood = TopPickMood.LOVE,
            hints = listOf("bollywood", "hindi"),
            profile = RecommendationEngine.ListenerProfile(),
            limit = 2,
            random = Random(1234),
        )
        assertFalse(chosen.any { it.browseId == "VL_GYM" })
        assertTrue(chosen.any { it.browseId == "VL_LOVE_IN" })
    }

    @Test
    fun homeShelfDifferentiationRemovesDuplicatesAcrossShelves() {
        val shelves = listOf(
            HomeShelf("Recently played", listOf(ShelfItem("Song A", "Art A", null, "vA", null))),
            HomeShelf(
                "Recommended Picks",
                listOf(
                    ShelfItem("Album 1", "Art 1", null, null, "MPRE1"),
                    ShelfItem("Album 2", "Art 2", null, null, "MPRE2"),
                    ShelfItem("Album 3", "Art 3", null, null, "MPRE3"),
                    ShelfItem("Album 4", "Art 4", null, null, "MPRE4"),
                ),
            ),
            HomeShelf(
                "Discover Mix",
                listOf(
                    ShelfItem("Song A", "Art A", null, "vA", null), // recent -> drop from Discover
                    ShelfItem("Album 1", "Art 1", null, null, "MPRE1"), // dup -> drop
                    ShelfItem("Discovery 1", "New Art 1", null, "vD1", null),
                    ShelfItem("Discovery 2", "New Art 2", null, "vD2", null),
                    ShelfItem("Discovery 3", "New Art 3", null, "vD3", null),
                ),
            ),
        )
        val differentiated = RecommendationEngine.differentiateShelves(
            shelves = shelves,
            profile = RecommendationEngine.ListenerProfile(recentTrackIds = setOf("vA")),
        )
        val discover = differentiated.first { it.title == "Discover Mix" }
        assertFalse(discover.items.any { it.videoId == "vA" || it.browseId == "MPRE1" })
        assertEquals(3, discover.items.size)
    }

    @Test
    fun discoveryModeExcludesHiddenFeedbackAndRepeatedSkips() {
        val candidates = listOf(
            RecommendationEngine.TrackCandidate(
                song = Song("hidden-1", "Hidden Track", "New Artist A", null),
                genres = listOf("synthpop"),
            ),
            RecommendationEngine.TrackCandidate(
                song = Song("skip-heavy", "Skipped Track", "Artist B", null),
                genres = listOf("synthpop"),
            ),
            RecommendationEngine.TrackCandidate(
                song = Song("less-artist", "Turned Down", "Blocked Artist", null),
                genres = listOf("synthpop"),
            ),
            RecommendationEngine.TrackCandidate(
                song = Song("good-pick", "Fresh Gem", "Inspired Artist", null),
                genres = listOf("synthpop"),
                aiCurated = true,
            ),
        )
        val profile = RecommendationEngine.ListenerProfile(
            favoriteGenres = mapOf("synthpop" to 1.0),
            hiddenTrackIds = setOf("hidden-1"),
            lessLikeArtists = setOf("blocked artist"),
            moreLikeArtists = setOf("inspired artist"),
            tracks = mapOf(
                "skip-heavy" to RecommendationEngine.TrackFeedback(
                    videoId = "skip-heavy",
                    skips = 3,
                    earlySkips = 3,
                ),
            ),
        )
        val ranked = RecommendationEngine.rankTracks(
            candidates = candidates,
            profile = profile,
            mode = RecommendationEngine.RankingMode.DISCOVERY,
            limit = 10,
            seed = 42L,
        )
        assertFalse(ranked.any { it.videoId == "hidden-1" })
        assertFalse(ranked.any { it.videoId == "skip-heavy" })
        assertEquals("good-pick", ranked.firstOrNull()?.videoId)
    }

    @Test
    fun discoveryModeBalancesUnfamiliarArtistsAndGenreDiversity() {
        val candidates = listOf(
            RecommendationEngine.TrackCandidate(Song("fam-1", "Known 1", "Favorite Artist", null), genres = listOf("indie rock")),
            RecommendationEngine.TrackCandidate(Song("fam-2", "Known 2", "Favorite Artist", null), genres = listOf("indie rock")),
            RecommendationEngine.TrackCandidate(Song("fam-3", "Known 3", "Favorite Artist", null), genres = listOf("indie rock")),
            RecommendationEngine.TrackCandidate(Song("new-1", "Indie Echo", "Fresh Band 1", null), genres = listOf("indie rock"), aiCurated = true),
            RecommendationEngine.TrackCandidate(Song("new-2", "Dream Drift", "Fresh Band 2", null), genres = listOf("dream pop"), aiCurated = true),
            RecommendationEngine.TrackCandidate(Song("new-3", "Velvet Night", "Fresh Band 3", null), genres = listOf("neo soul")),
            RecommendationEngine.TrackCandidate(Song("new-4", "Solar Pulse", "Fresh Band 4", null), genres = listOf("electronic")),
        )
        val profile = RecommendationEngine.ListenerProfile(
            artists = listOf(RecommendationEngine.ArtistAffinity(name = "Favorite Artist", plays = 40)),
            favoriteGenres = mapOf("indie rock" to 1.0, "dream pop" to 0.7),
        )
        val ranked = RecommendationEngine.rankTracks(
            candidates = candidates,
            profile = profile,
            mode = RecommendationEngine.RankingMode.DISCOVERY,
            limit = 6,
            seed = 7L,
        )
        val favCount = ranked.count { it.artist == "Favorite Artist" }
        val unfamiliarCount = ranked.count { it.artist != "Favorite Artist" }
        assertTrue(favCount <= 2, "Artist diversity should cap Favorite Artist at <=2, got $favCount")
        assertTrue(unfamiliarCount >= 4, "Discovery mode should prioritize unfamiliar artists, got $unfamiliarCount")
    }

    @Test
    fun discoveryModeRewardsMatchedBpmAndEnergySweetSpot() {
        val near = RecommendationEngine.TrackCandidate(
            song = Song("bpm-near", "Groove Match", "Artist X", null),
            bpm = 118.0,
            energy = 0.72,
            genres = listOf("funk"),
        )
        val far = RecommendationEngine.TrackCandidate(
            song = Song("bpm-far", "Too Slow", "Artist Y", null),
            bpm = 64.0,
            energy = 0.15,
            genres = listOf("funk"),
        )
        val profile = RecommendationEngine.ListenerProfile(
            favoriteGenres = mapOf("funk" to 0.9),
            preferredBpm = 120.0,
            preferredEnergy = 0.70,
        )
        val ranked = RecommendationEngine.rankTracks(
            candidates = listOf(far, near),
            profile = profile,
            mode = RecommendationEngine.RankingMode.DISCOVERY,
            limit = 2,
            seed = 9L,
        )
        assertEquals(listOf("bpm-near", "bpm-far"), ranked.map { it.videoId })
    }
}
