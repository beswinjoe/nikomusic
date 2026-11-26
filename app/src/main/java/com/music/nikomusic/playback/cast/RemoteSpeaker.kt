package com.music.nikomusic.playback.cast

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player

/**
 * Something other than this device playing the local queue, such as a Cast
 * receiver.
 *
 * The model is [CastPlayback]'s: the phone's player stays the owner of the
 * *queue* and is held paused, the receiver owns the *clock*, and the session
 * player reports the receiver's state in place of the paused local one — so
 * the app, the notification, and the widgets all show what is actually
 * playing. The phone moving to another track loads it on the receiver; the
 * receiver moving on moves the phone.
 */
interface RemoteSpeaker {
    var sink: CastSink?

    /** Whether this receiver is the speaker. Everything else is meaningful only while it is. */
    val active: Boolean
    val playWhenReady: Boolean
    val isPlaying: Boolean

    /** In [Player]'s own terms. */
    val playbackState: Int
    val positionMs: Long

    /** [C.TIME_UNSET] when the receiver does not know yet. */
    val durationMs: Long

    /** 0..100. */
    val deviceVolume: Int

    fun play()
    fun pause()
    fun seekTo(positionMs: Long)

    /** Queue-screen inverse only: accept a load/stop with an explicit clock and play intent. */
    fun restoreQueueCurrent(item: MediaItem?, positionMs: Long, playWhenReady: Boolean): Boolean = false

    /** 0..1 of the receiver's own range. */
    fun setVolume(fraction: Float)

    /** A new track became the phone's current one. */
    fun onLocalTransition(item: MediaItem?, reason: Int)

    /** The phone's queue changed under the playing track. */
    fun onLocalQueueChanged()
    fun onLocalRepeatChanged(repeatMode: Int)

    /** Something started the phone's own (paused) player while this is the speaker. */
    fun onLocalStartedPlaying(player: Player)
}
