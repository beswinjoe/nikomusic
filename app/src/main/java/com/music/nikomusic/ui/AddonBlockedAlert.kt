package com.music.nikomusic.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.music.nikomusic.R
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.settings.AppSettings
import com.music.nikomusic.data.sources.SourceRegistry
import com.music.nikomusic.ui.components.InfoAlert
import dev.chrisbanes.haze.HazeState

/**
 * Says why an addon row in the search results won't play, in an alert rather
 * than a toast, because the answer names the setting to change and a toast is
 * gone before it can be read.
 */
@Composable
fun AddonBlockedAlert(hazeState: HazeState, song: Song, onDismiss: () -> Unit) {
    val addon = SourceRegistry.parseTrackKey(song.videoId)
        ?.let { (configId, _) -> SourceRegistry.config(configId)?.displayName }
        ?: stringResource(R.string.search_source_addons)
    val metered = AppSettings.meteredConnection.value == true
    val effectiveQuality = AppSettings.effectiveAudioQuality
    val message = stringResource(
        R.string.addon_blocked_quality,
        stringResource(if (metered) R.string.mobile_data else R.string.wifi),
        stringResource(effectiveQuality.labelRes),
        addon,
    )
    InfoAlert(
        hazeState = hazeState,
        title = stringResource(R.string.addon_blocked_title),
        description = message,
        onDismiss = onDismiss,
    )
}

private val AudioQuality.labelRes: Int
    get() = when (this) {
        AudioQuality.LOW -> R.string.low
        AudioQuality.MEDIUM -> R.string.medium
        AudioQuality.HIGH -> R.string.high
        AudioQuality.LOSSLESS -> R.string.lossless
        AudioQuality.HI_RES_LOSSLESS -> R.string.hi_res_lossless
    }
