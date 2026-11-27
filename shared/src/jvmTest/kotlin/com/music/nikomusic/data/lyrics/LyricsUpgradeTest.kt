package com.music.nikomusic.data.lyrics

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LyricsUpgradeTest {

    @Test
    fun parsesOverflowMinutesHoursTenthsAndLastWordSweep() {
        val lrc = """
            [00:00.0]Opening line
            [00:12.3]Tenths stamp
            [01:02:03.40]<01:02:03.40>Hour <01:02:04.00>final
            [102:15.50]Long mix mark
        """.trimIndent()

        val lines = LrcLib.parseLrc(lrc)
        assertEquals(0L, lines[0].timeMs)
        assertEquals("Opening line", lines[0].text)
        assertEquals(12_300L, lines[1].timeMs)
        assertEquals(3_723_400L, lines[2].timeMs)
        assertTrue(lines[2].isWordSynced)
        assertEquals("final", lines[2].words.last().text)
        assertTrue(lines[2].words.last().endMs > lines[2].words.last().startMs)
        assertEquals(102 * 60_000L + 15_500L, lines[3].timeMs)
        assertFalse(lines[0].isWordSynced)
        assertFalse(lines[1].isWordSynced)
    }

    @Test
    fun ttmlRoundsMillisecondsAccurately() {
        assertEquals(12_349L, TtmlLyrics.time("12.349"))
        assertEquals(12_350L, TtmlLyrics.time("12.3496s"))
        assertEquals(65_200L, TtmlLyrics.time("1:05.20"))
    }

    @Test
    fun shortArtistNameDoesNotSubstringMatchUnrelatedArtist() {
        assertFalse(lyricsArtistMatches("Arijit Singh", "Ai"))
        assertTrue(lyricsArtistMatches("Ai", "Ai"))
        assertTrue(lyricsArtistMatches("Arijit Singh, Pritam", "Pritam"))
    }

    @Test
    fun zeroTimestampedTimedLinesStillCountAsSyncedOverPlainLyrics() = runBlocking {
        val zeroTimed = LyricsRepository.Result(
            LyricsSource.YOUTUBE_TRANSCRIPT,
            listOf(LyricLine(timeMs = 0L, text = "First line", sungUntilMs = 2_400L)),
        )
        val plain = LyricsRepository.Result(
            LyricsSource.GENIUS,
            listOf(LyricLine(timeMs = 0L, text = "Plain words")),
        )
        val picked = LyricsRepository.pick(
            listOf(
                LyricsSource.GENIUS to suspend { plain },
                LyricsSource.YOUTUBE_TRANSCRIPT to suspend { zeroTimed },
            ),
            prioritizeSyllableSync = true,
        )
        assertEquals(LyricsSource.YOUTUBE_TRANSCRIPT, picked?.source)
    }
}
