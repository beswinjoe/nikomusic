package com.music.nikomusic

import com.music.nikomusic.data.DailyDiscoveryCollection
import com.music.nikomusic.data.DailyDiscoveryPlanner
import com.music.nikomusic.data.DailyDiscoveryTrack
import com.music.nikomusic.data.DiscoveryFeedbackAction
import com.music.nikomusic.data.DiscoveryFeedbackEntry
import com.music.nikomusic.data.DiscoverySource
import com.music.nikomusic.data.StoredArtistRef
import com.music.nikomusic.data.StoredDiscoverySong
import com.music.nikomusic.data.model.PlaybackSourceType
import com.music.nikomusic.data.model.SPOTIFY_MISSING_PREFIX
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.isUnresolvedSpotify
import com.music.nikomusic.data.settings.AppSettings
import com.music.nikomusic.ui.DailyDiscoveryUiState
import com.music.nikomusic.ui.navigation.AppNavigator
import com.music.nikomusic.ui.navigation.AppRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DailyDiscoveryIntegrationTest {

    @Test
    fun navigatorPushesAndPopsDailyDiscoveryCleanlyAcrossSettingsAndDetails() {
        val releases = mutableListOf<String>()
        lateinit var nav: AppNavigator
        nav = AppNavigator(
            detailDepth = { releases.size },
            popDetail = {
                if (releases.isEmpty()) false
                else {
                    releases.removeAt(releases.lastIndex)
                    nav.onDetailStackShrunk(releases.size)
                    true
                }
            },
            clearDetails = {
                releases.clear()
                nav.onDetailStackShrunk(0)
            },
        )

        nav.push(AppRoute.DailyDiscovery)
        assertEquals(AppRoute.DailyDiscovery, nav.visibleRoute())

        releases += "album:123"
        assertNull(nav.visibleRoute())

        assertTrue(nav.pop())
        assertEquals(AppRoute.DailyDiscovery, nav.visibleRoute())

        assertTrue(nav.pop())
        assertNull(nav.visibleRoute())
    }

    @Test
    fun playbackMappingPreservesQueueMetadataAndFiltersUnavailableTracks() {
        val collection = DailyDiscoveryCollection(
            dateKey = "2026-11-26",
            generatedAtMs = 1L,
            listenerKey = "u1",
            source = DiscoverySource.BACKEND_AI,
            items = listOf(
                DailyDiscoveryTrack(
                    song = StoredDiscoverySong(
                        videoId = "vid-playable-1",
                        title = "Sunrise Groove",
                        artist = "Band One",
                        artists = listOf(StoredArtistRef("Band One", "UC_1")),
                        albumId = "MPRE_1",
                        albumName = "Morning Dew",
                    ),
                    reason = "Fresh artist",
                ),
                DailyDiscoveryTrack(
                    song = StoredDiscoverySong(
                        videoId = "${SPOTIFY_MISSING_PREFIX}unmatched",
                        title = "Missing Track",
                        artist = "Ghost",
                    ),
                    unavailable = true,
                ),
                DailyDiscoveryTrack(
                    song = StoredDiscoverySong(
                        videoId = "vid-playable-2",
                        title = "Midnight Jazz",
                        artist = "Quartet",
                    ),
                ),
            ),
        )

        val playableSongs: List<Song> = collection.items
            .map { it to it.toPlayableSong() }
            .filter { (item, song) -> !item.unavailable && song.videoId.isNotBlank() && !song.isUnresolvedSpotify }
            .map { it.second }

        assertEquals(listOf("vid-playable-1", "vid-playable-2"), playableSongs.map { it.videoId })
        val first = playableSongs.first()
        assertEquals("Daily Discovery", first.playbackSource)
        assertEquals(PlaybackSourceType.HOME, first.playbackSourceType)
        assertEquals("MPRE_1", first.albumId)
        assertEquals("UC_1", first.artists.first().browseId)
    }

    @Test
    fun privacySettingsDefaultToExplicitOptIn() {
        assertFalse(AppSettings.aiDiscoveryOptIn.value)
        assertTrue(AppSettings.showDailyDiscoveryHome.value)

        val state = DailyDiscoveryUiState()
        assertNull(state.collection)
        assertFalse(state.loading)
    }

    @Test
    fun feedbackFlowFiltersHiddenTracksFromCollection() {
        val collection = DailyDiscoveryCollection(
            dateKey = "2026-11-26",
            generatedAtMs = 10L,
            items = listOf(
                DailyDiscoveryTrack(StoredDiscoverySong("t1", "Keep", "Art 1")),
                DailyDiscoveryTrack(StoredDiscoverySong("t2", "Hide", "Art 2")),
            ),
            source = DiscoverySource.BACKEND_AI,
        )
        val entry = DiscoveryFeedbackEntry(
            videoId = "t2",
            title = "Hide",
            artist = "Art 2",
            action = DiscoveryFeedbackAction.NOT_INTERESTED,
            updatedAtMs = 20L,
        )
        val updated = DailyDiscoveryPlanner.applyFeedbackToCollection(collection, entry)
        assertEquals(listOf("t1"), updated.items.map { it.song.videoId })
    }
}
