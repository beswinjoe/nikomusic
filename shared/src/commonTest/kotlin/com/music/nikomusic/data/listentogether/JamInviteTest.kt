package com.music.nikomusic.data.listentogether

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * What counts as an invite. Anything that is not the public URL shape must be refused outright
 * rather than half-parsed: a join is an action taken on someone else's behalf.
 */
class JamInviteTest {

    private companion object {
        const val TEST_ORIGIN = "https://jam.example.com"
    }

    @Test
    fun `it reads the code out of an invite url`() {
        assertEquals("ABC123", JamInvite.parse("$TEST_ORIGIN/invite/ABC123", TEST_ORIGIN))
    }

    @Test
    fun `a code is normalised to upper case`() {
        assertEquals("ABC123", JamInvite.parse("$TEST_ORIGIN/invite/abc123", TEST_ORIGIN))
    }

    @Test
    fun `the scheme and host may be in any case`() {
        // QR codes often carry URLs upper-cased; this used to fall through and
        // the desktop field kept the first six letters, "HTTPSB".
        assertEquals("ABC123", JamInvite.parse("HTTPS://JAM.EXAMPLE.COM/INVITE/ABC123", TEST_ORIGIN))
        assertEquals("ABC123", JamInvite.parse("Https://Jam.example.com/invite/abc123", TEST_ORIGIN))
    }

    @Test
    fun `query and fragment are ignored`() {
        assertEquals("ABC123", JamInvite.parse("$TEST_ORIGIN/invite/ABC123?utm=x", TEST_ORIGIN))
        assertEquals("ABC123", JamInvite.parse("$TEST_ORIGIN/invite/ABC123#top", TEST_ORIGIN))
    }

    @Test
    fun `another host is not an invite even with the same path`() {
        assertNull(JamInvite.parse("https://other.example.org/invite/ABC123", TEST_ORIGIN))
    }

    @Test
    fun `plain http is refused`() {
        assertNull(JamInvite.parse("http://jam.example.com/invite/ABC123", TEST_ORIGIN))
    }

    @Test
    fun `a wrong-length code is refused`() {
        assertNull(JamInvite.parse("$TEST_ORIGIN/invite/ABC12", TEST_ORIGIN))
        assertNull(JamInvite.parse("$TEST_ORIGIN/invite/ABC1234", TEST_ORIGIN))
    }

    @Test
    fun `rubbish and unconfigured origin are refused rather than guessed at`() {
        assertNull(JamInvite.parse(null, TEST_ORIGIN))
        assertNull(JamInvite.parse("", TEST_ORIGIN))
        assertNull(JamInvite.parse("ABC123", TEST_ORIGIN))
        assertNull(JamInvite.parse("$TEST_ORIGIN/invite/ABC123", ""))
    }

    @Test
    fun `a built url round-trips`() {
        assertEquals("ZZ99QQ", JamInvite.parse(JamInvite.url("zz99qq", TEST_ORIGIN), TEST_ORIGIN))
    }
}
