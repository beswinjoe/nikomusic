package com.music.nikomusic.playback

import com.music.nikomusic.data.model.Song
import com.music.nikomusic.playback.smart.EnergySample
import com.music.nikomusic.playback.smart.TrackAnalysis
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class QueueBuilderSmoothMixTest {

    private fun song(id: String, artist: String, album: String) =
        Song(videoId = id, title = "Track $id", artist = artist, thumbnailUrl = null, albumName = album)

    private fun analysis(id: String, bpm: Double, key: String, energy: Double) = TrackAnalysis(
        trackId = id,
        status = TrackAnalysis.STATUS_READY,
        duration = 200.0,
        bpm = bpm,
        beatInterval = 60.0 / bpm,
        beatConfidence = 0.9,
        key = key,
        keyConfidence = 0.9,
        energyCurve = listOf(EnergySample(10.0, energy)),
    )

    @Test
    fun ordersCompatibleTempoAndKeyFirstWhileAvoidingArtistRepeats() {
        val anchor = song("anchor", "Anchor Artist", "Album A")
        val candidates = listOf(
            song("harsh", "Harsh DJ", "Album H"),
            song("sameArtist", "Anchor Artist", "Album A"),
            song("smooth", "Compatible Artist", "Album C"),
            song("followup", "Another Artist", "Album D"),
        )
        val analyses = mapOf(
            "anchor" to analysis("anchor", 120.0, "C major", 0.55),
            "harsh" to analysis("harsh", 172.0, "F# major", 0.95),
            "sameArtist" to analysis("sameArtist", 121.0, "C major", 0.55),
            "smooth" to analysis("smooth", 122.0, "G major", 0.56),
            "followup" to analysis("followup", 124.0, "D major", 0.58),
        )

        val ordered = QueueBuilder.orderForSmoothMix(
            anchor = anchor,
            tracks = candidates,
            analyses = { analyses[it] },
            limit = 4,
        )

        assertEquals(4, ordered.size)
        assertEquals("smooth", ordered.first().videoId)
        assertNotEquals("Anchor Artist", ordered.first().artist)
    }
}
