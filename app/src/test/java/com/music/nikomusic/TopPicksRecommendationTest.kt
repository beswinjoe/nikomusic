package com.music.nikomusic

import com.music.nikomusic.data.RecommendationEngine
import com.music.nikomusic.data.TopPicks
import com.music.nikomusic.data.model.ArtistRef
import com.music.nikomusic.data.model.HomeShelf
import com.music.nikomusic.data.model.ShelfItem
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.data.model.withoutRepeatsOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

class TopPicksRecommendationTest {

    @Test
    fun topPicksMoodForRespectsLocalMoodPreferences() {
        val local = TopPicks.LocalTaste(
            moodAffinities = mapOf(TopPickMood.LATE_NIGHT to 50.0),
        )
        val evening = LocalDateTime.of(2026, 11, 26, 23, 0)
        val picks = (1..25).map { TopPicks.moodFor(evening, local) }
        assertTrue(
            picks.count { it == TopPickMood.LATE_NIGHT } >= 10,
            "Heavy Late Night preference should boost Late Night at night, got $picks",
        )
    }

    @Test
    fun noteTrackSkippedUpdatesSessionProfile() {
        TopPicks.noteTrackSkipped("skip-vid-123")
        val ranked = RecommendationEngine.rankTracks(
            candidates = listOf(
                RecommendationEngine.TrackCandidate(Song("skip-vid-123", "Bad", "Art", null)),
                RecommendationEngine.TrackCandidate(Song("good-vid-456", "Good", "Art 2", null)),
            ),
            profile = RecommendationEngine.ListenerProfile(
                tracks = mapOf(
                    "skip-vid-123" to RecommendationEngine.TrackFeedback(
                        videoId = "skip-vid-123",
                        skips = 2,
                        earlySkips = 2,
                    ),
                ),
            ),
            mode = RecommendationEngine.RankingMode.TOP_PICK,
            seed = 1L,
        )
        assertFalse(ranked.any { it.videoId == "skip-vid-123" })
        assertEquals(listOf("good-vid-456"), ranked.map { it.videoId })
    }

    @Test
    fun homeShelvesDifferentiateMixesFromRecentlyPlayed() {
        val shelves = listOf(
            HomeShelf("Recently played", listOf(ShelfItem("Track 1", "Artist 1", null, "v1", null))),
            HomeShelf(
                "Discover Mix",
                listOf(
                    ShelfItem("Track 1", "Artist 1", null, "v1", null),
                    ShelfItem("New Gem 1", "New Artist 1", null, "n1", null),
                    ShelfItem("New Gem 2", "New Artist 2", null, "n2", null),
                    ShelfItem("New Gem 3", "New Artist 3", null, "n3", null),
                ),
            ),
        )
        val filtered = RecommendationEngine.differentiateShelves(
            shelves = shelves.withoutRepeatsOf(emptyList()),
            profile = RecommendationEngine.ListenerProfile(recentTrackIds = setOf("v1")),
        )
        val discover = filtered.first { it.title == "Discover Mix" }
        assertFalse(discover.items.any { it.videoId == "v1" })
        assertEquals(listOf("n1", "n2", "n3"), discover.items.map { it.videoId })
    }

    @Test
    fun coreMoodsMatchAllTenRequestedCategories() {
        assertEquals(10, TopPickMood.CORE_MOODS.size)
        assertEquals(10, TopPickMood.entries.count { it.isCoreMood })
        val names = TopPickMood.CORE_MOODS.map { it.name }.toSet()
        assertTrue(
            names.containsAll(
                listOf("LOVE", "SAD", "ENERGY", "CHILL", "FOCUS", "PARTY", "HAPPY", "LATE_NIGHT", "ROAD_TRIP", "NOSTALGIA"),
            ),
        )
        // Region hints still populates cleanly alongside genre hints
        val taste = TopPicks.LocalTaste(artists = listOf(ArtistRef("Tester", "UC1")))
        assertEquals(1, taste.artists.size)
    }
}
