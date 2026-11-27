package com.music.nikomusic.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ThumbDown
import androidx.compose.material.icons.rounded.ThumbUp
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import com.music.nikomusic.R
import com.music.nikomusic.data.DailyDiscoveryCollection
import com.music.nikomusic.data.DailyDiscoveryTrack
import com.music.nikomusic.data.DiscoveryFeedbackAction
import com.music.nikomusic.data.DiscoverySource
import com.music.nikomusic.data.RefreshPolicyResult
import com.music.nikomusic.data.model.CARD_ART_PX
import com.music.nikomusic.data.model.LikeStatus
import com.music.nikomusic.data.model.ROW_ART_PX
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.artworkAt
import com.music.nikomusic.data.settings.AppSettings
import com.music.nikomusic.sharedui.resources.Res as SharedRes
import com.music.nikomusic.sharedui.resources.ic_logo
import com.music.nikomusic.ui.DailyDiscoveryUiState
import com.music.nikomusic.ui.components.ExplicitSongTitle
import com.music.nikomusic.ui.components.GLASS_EDGE_COLOR
import com.music.nikomusic.ui.components.GLASS_EDGE_WIDTH
import com.music.nikomusic.ui.components.PAGE_GUTTER
import com.music.nikomusic.ui.components.ROW_DIVIDER_INSET
import com.music.nikomusic.ui.components.RowMoreButton
import com.music.nikomusic.ui.components.SearchPlayingBars
import com.music.nikomusic.ui.components.ShimmerBox
import com.music.nikomusic.ui.components.SwipeToQueueBox
import com.music.nikomusic.ui.components.lightweightLiquidGlass
import com.music.nikomusic.ui.components.longPressMenuClickable
import com.music.nikomusic.ui.components.thumbnailBorder
import com.music.nikomusic.ui.icons.SfIcons
import com.music.nikomusic.ui.theme.AccentGreen
import org.jetbrains.compose.resources.painterResource

private val HOME_CARD_SHAPE = RoundedCornerShape(18.dp)
private val TRACK_CARD_SHAPE = RoundedCornerShape(16.dp)
private val ARTWORK_SHAPE = RoundedCornerShape(10.dp)
private val ROW_ARTWORK_SHAPE = RoundedCornerShape(8.dp)
private val PILL_SHAPE = RoundedCornerShape(999.dp)

@Composable
private fun isDarkSurface(): Boolean =
    MaterialTheme.colorScheme.background.luminance() < 0.5f

/**
 * Native Liquid Glass Daily Discovery shelf embedded directly inside the Home feed.
 */
@Composable
fun DailyDiscoveryHomeSection(
    state: DailyDiscoveryUiState,
    aiOptIn: Boolean,
    likeStatuses: Map<String, LikeStatus>,
    currentSong: Song?,
    isPlaying: Boolean,
    onEnableAi: () -> Unit,
    onUseLocalOnly: () -> Unit,
    onRefresh: () -> Unit,
    onOpenAll: () -> Unit,
    onOpenPrivacy: () -> Unit,
    onTrackClick: (DailyDiscoveryTrack, Int) -> Unit,
    onTrackMore: (DailyDiscoveryTrack) -> Unit,
    onFeedback: (DailyDiscoveryTrack, DiscoveryFeedbackAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceMotion by AppSettings.reduceAnimation.collectAsStateWithLifecycle()
    val collection = state.collection

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 26.dp)
            .animateContentSize(animationSpec = tween(if (reduceMotion) 0 else 240)),
    ) {
        HomeDiscoveryHeader(
            state = state,
            aiOptIn = aiOptIn,
            onRefresh = onRefresh,
            onOpenAll = onOpenAll,
            onOpenPrivacy = onOpenPrivacy,
        )

        AnimatedContent(
            targetState = when {
                !aiOptIn && collection == null -> HomeDiscoveryMode.OPT_IN
                state.loading && collection == null -> HomeDiscoveryMode.LOADING
                collection != null && collection.items.isNotEmpty() -> HomeDiscoveryMode.CONTENT
                state.isOffline -> HomeDiscoveryMode.OFFLINE_EMPTY
                else -> HomeDiscoveryMode.EMPTY
            },
            transitionSpec = {
                if (reduceMotion) {
                    fadeIn(tween(0)) togetherWith fadeOut(tween(0))
                } else {
                    fadeIn(tween(220)) togetherWith fadeOut(tween(160))
                }
            },
            label = "daily discovery home state",
        ) { mode ->
            when (mode) {
                HomeDiscoveryMode.OPT_IN -> {
                    DailyDiscoveryOptInCard(
                        onEnableAi = onEnableAi,
                        onUseLocalOnly = onUseLocalOnly,
                        onOpenPrivacy = onOpenPrivacy,
                    )
                }
                HomeDiscoveryMode.LOADING -> {
                    DailyDiscoveryHomeSkeleton()
                }
                HomeDiscoveryMode.OFFLINE_EMPTY -> {
                    DailyDiscoveryStatusCard(
                        icon = Icons.Rounded.WifiOff,
                        message = stringResource(R.string.daily_discovery_offline_empty),
                        actionLabel = stringResource(R.string.retry),
                        onAction = onRefresh,
                    )
                }
                HomeDiscoveryMode.EMPTY -> {
                    DailyDiscoveryStatusCard(
                        icon = SfIcons.AutoAwesome,
                        message = state.errorMessage ?: stringResource(R.string.daily_discovery_empty),
                        actionLabel = stringResource(R.string.daily_discovery_refresh),
                        onAction = onRefresh,
                    )
                }
                HomeDiscoveryMode.CONTENT -> {
                    val items = collection?.items.orEmpty()
                    Column {
                        if (collection?.source == DiscoverySource.CACHED_OFFLINE || state.isOffline) {
                            DiscoveryInlineBanner(
                                icon = Icons.Rounded.WifiOff,
                                text = stringResource(R.string.daily_discovery_offline_cached),
                                modifier = Modifier.padding(horizontal = PAGE_GUTTER, vertical = 4.dp),
                            )
                        }
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = PAGE_GUTTER),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            itemsIndexed(
                                items = items.take(12),
                                key = { _, item -> item.song.videoId },
                            ) { index, item ->
                                val feedback = state.feedbackByVideoId[item.song.videoId]?.action
                                val isLiked = feedback == DiscoveryFeedbackAction.LIKE ||
                                    feedback == DiscoveryFeedbackAction.MORE_LIKE_THIS ||
                                    likeStatuses[item.song.videoId] == LikeStatus.LIKE
                                val isCurrent = currentSong?.videoId == item.song.videoId
                                DailyDiscoveryHomeCard(
                                    item = item,
                                    isCurrent = isCurrent,
                                    isPlaying = isCurrent && isPlaying,
                                    isLiked = isLiked,
                                    feedback = feedback,
                                    onClick = { onTrackClick(item, index) },
                                    onMore = { onTrackMore(item) },
                                    onFeedback = { action -> onFeedback(item, action) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private enum class HomeDiscoveryMode {
    OPT_IN,
    LOADING,
    CONTENT,
    OFFLINE_EMPTY,
    EMPTY,
}

@Composable
private fun HomeDiscoveryHeader(
    state: DailyDiscoveryUiState,
    aiOptIn: Boolean,
    onRefresh: () -> Unit,
    onOpenAll: () -> Unit,
    onOpenPrivacy: () -> Unit,
) {
    val collection = state.collection
    val subtitle = when {
        state.isOffline && collection != null -> stringResource(R.string.daily_discovery_offline_badge)
        collection != null -> {
            val unfamiliarCount = collection.items.count { it.isUnfamiliarArtist }
            if (unfamiliarCount > 0) {
                "${collection.items.size} tracks · $unfamiliarCount new artists"
            } else {
                stringResource(R.string.daily_discovery_subtitle)
            }
        }
        aiOptIn -> stringResource(R.string.daily_discovery_subtitle)
        else -> stringResource(R.string.daily_discovery_privacy_subtitle)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = PAGE_GUTTER, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = SfIcons.AutoAwesome,
                    contentDescription = null,
                    tint = AccentGreen,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = stringResource(R.string.daily_discovery),
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Spacer(Modifier.width(8.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DiscoveryGlassIconButton(
                icon = SfIcons.Lock,
                contentDescription = stringResource(R.string.daily_discovery_privacy_controls),
                onClick = onOpenPrivacy,
            )
            if (collection != null || aiOptIn) {
                DiscoveryRefreshPillButton(
                    refreshing = state.refreshing,
                    onClick = onRefresh,
                )
            }
            if (collection != null) {
                Box(
                    modifier = Modifier
                        .lightweightLiquidGlass(
                            shape = PILL_SHAPE,
                            fallbackColor = MaterialTheme.colorScheme.surfaceVariant,
                        )
                        .clickable(onClick = onOpenAll)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = stringResource(R.string.daily_discovery_open_all),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

@Composable
private fun DailyDiscoveryOptInCard(
    onEnableAi: () -> Unit,
    onUseLocalOnly: () -> Unit,
    onOpenPrivacy: () -> Unit,
) {
    val dark = isDarkSurface()
    val tintWash = if (dark) {
        Brush.linearGradient(
            listOf(AccentGreen.copy(alpha = 0.16f), Color(0xFF14181C).copy(alpha = 0.72f)),
        )
    } else {
        Brush.linearGradient(
            listOf(AccentGreen.copy(alpha = 0.14f), Color(0xFFF3F6F4)),
        )
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = PAGE_GUTTER)
            .lightweightLiquidGlass(HOME_CARD_SHAPE, MaterialTheme.colorScheme.surfaceVariant)
            .background(tintWash)
            .padding(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(
                painter = painterResource(SharedRes.drawable.ic_logo),
                contentDescription = null,
                colorFilter = ColorFilter.tint(AccentGreen),
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = "Niko Music · AI",
                style = MaterialTheme.typography.labelMedium,
                color = AccentGreen,
                fontWeight = FontWeight.W700,
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = stringResource(R.string.daily_discovery_privacy_controls),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .clip(PILL_SHAPE)
                    .clickable(onClick = onOpenPrivacy)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        Spacer(Modifier.height(10.dp))
        Text(
            text = stringResource(R.string.daily_discovery_opt_in_title),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = stringResource(R.string.daily_discovery_opt_in_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                modifier = Modifier
                    .clip(PILL_SHAPE)
                    .background(AccentGreen)
                    .clickable(onClick = onEnableAi)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text(
                    text = stringResource(R.string.daily_discovery_enable_ai),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.W700,
                    color = Color.Black,
                )
            }
            Box(
                modifier = Modifier
                    .lightweightLiquidGlass(PILL_SHAPE, MaterialTheme.colorScheme.surface)
                    .clickable(onClick = onUseLocalOnly)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                Text(
                    text = stringResource(R.string.daily_discovery_local_fallback_cta),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@Composable
private fun DailyDiscoveryStatusCard(
    icon: ImageVector,
    message: String,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = PAGE_GUTTER)
            .lightweightLiquidGlass(HOME_CARD_SHAPE, MaterialTheme.colorScheme.surfaceVariant)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(10.dp))
        Box(
            modifier = Modifier
                .lightweightLiquidGlass(PILL_SHAPE, MaterialTheme.colorScheme.surface)
                .clickable(onClick = onAction)
                .padding(horizontal = 12.dp, vertical = 7.dp),
        ) {
            Text(
                text = actionLabel,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun DailyDiscoveryHomeSkeleton() {
    LazyRow(
        contentPadding = PaddingValues(horizontal = PAGE_GUTTER),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        userScrollEnabled = false,
    ) {
        items(3) {
            Column(Modifier.width(166.dp)) {
                ShimmerBox(modifier = Modifier.size(166.dp), shape = TRACK_CARD_SHAPE)
                Spacer(Modifier.height(8.dp))
                ShimmerBox(modifier = Modifier.fillMaxWidth(0.8f).height(14.dp), shape = RoundedCornerShape(4.dp))
                Spacer(Modifier.height(4.dp))
                ShimmerBox(modifier = Modifier.fillMaxWidth(0.55f).height(12.dp), shape = RoundedCornerShape(4.dp))
            }
        }
    }
}

@Composable
private fun DailyDiscoveryHomeCard(
    item: DailyDiscoveryTrack,
    isCurrent: Boolean,
    isPlaying: Boolean,
    isLiked: Boolean,
    feedback: DiscoveryFeedbackAction?,
    onClick: () -> Unit,
    onMore: () -> Unit,
    onFeedback: (DiscoveryFeedbackAction) -> Unit,
) {
    val song = item.toPlayableSong()
    Column(
        modifier = Modifier
            .width(170.dp)
            .alpha(if (item.unavailable) 0.5f else 1f)
            .lightweightLiquidGlass(TRACK_CARD_SHAPE, MaterialTheme.colorScheme.surfaceVariant)
            .longPressMenuClickable(onClick = onClick, onLongClick = onMore)
            .padding(10.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(150.dp)
                .clip(ARTWORK_SHAPE)
                .thumbnailBorder(ARTWORK_SHAPE)
                .background(MaterialTheme.colorScheme.surface),
        ) {
            AsyncImage(
                model = song.artworkAt(CARD_ART_PX),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            if (item.isUnfamiliarArtist || item.aiCurated) {
                Row(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(6.dp)
                        .clip(PILL_SHAPE)
                        .background(Color.Black.copy(alpha = 0.62f))
                        .border(0.5.dp, Color.White.copy(alpha = 0.16f), PILL_SHAPE)
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (item.aiCurated) {
                        Icon(
                            imageVector = SfIcons.AutoAwesome,
                            contentDescription = null,
                            tint = AccentGreen,
                            modifier = Modifier.size(11.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(
                        text = if (item.isUnfamiliarArtist) "New artist" else "AI Pick",
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White,
                    )
                }
            }
            if (isCurrent && isPlaying) {
                SearchPlayingBars(Modifier.align(Alignment.Center))
            }
        }
        Spacer(Modifier.height(8.dp))
        ExplicitSongTitle(
            song = song,
            style = MaterialTheme.typography.titleMedium,
            color = if (isCurrent) AccentGreen else MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = song.artist,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (item.reason.isNotBlank()) {
            Text(
                text = item.reason,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Spacer(Modifier.height(6.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            FeedbackMiniButton(
                icon = if (isLiked) SfIcons.StarFill else SfIcons.Star,
                active = isLiked,
                contentDescription = stringResource(R.string.like),
                onClick = { onFeedback(DiscoveryFeedbackAction.LIKE) },
            )
            FeedbackMiniButton(
                icon = Icons.Rounded.ThumbUp,
                active = feedback == DiscoveryFeedbackAction.MORE_LIKE_THIS,
                contentDescription = stringResource(R.string.more_like_this),
                onClick = { onFeedback(DiscoveryFeedbackAction.MORE_LIKE_THIS) },
            )
            FeedbackMiniButton(
                icon = Icons.Rounded.ThumbDown,
                active = feedback == DiscoveryFeedbackAction.LESS_LIKE_THIS,
                contentDescription = stringResource(R.string.less_like_this),
                onClick = { onFeedback(DiscoveryFeedbackAction.LESS_LIKE_THIS) },
            )
            FeedbackMiniButton(
                icon = SfIcons.VisibilityOff,
                active = false,
                contentDescription = stringResource(R.string.not_interested),
                onClick = { onFeedback(DiscoveryFeedbackAction.NOT_INTERESTED) },
            )
            RowMoreButton(onClick = onMore, iconSize = 18.dp)
        }
    }
}

/**
 * Full-screen dedicated **AI Daily Discovery** page pushed via [AppRoute.DailyDiscovery].
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DailyDiscoveryScreen(
    state: DailyDiscoveryUiState,
    aiOptIn: Boolean,
    likeStatuses: Map<String, LikeStatus>,
    currentSong: Song?,
    isPlaying: Boolean,
    listState: LazyListState = rememberLazyListState(),
    contentPadding: PaddingValues,
    onEnableAi: () -> Unit,
    onUseLocalOnly: () -> Unit,
    onRefresh: () -> Unit,
    onOpenPrivacy: () -> Unit,
    onPlayAll: () -> Unit,
    onShufflePlay: () -> Unit,
    onTrackClick: (DailyDiscoveryTrack, Int) -> Unit,
    onTrackSwipe: (DailyDiscoveryTrack) -> Unit,
    onTrackMore: (DailyDiscoveryTrack) -> Unit,
    onFeedback: (DailyDiscoveryTrack, DiscoveryFeedbackAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val collection = state.collection
    val items = collection?.items.orEmpty()
    val reduceMotion by AppSettings.reduceAnimation.collectAsStateWithLifecycle()

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = contentPadding,
    ) {
        item(key = "hero") {
            DailyDiscoveryHeroCard(
                collection = collection,
                state = state,
                aiOptIn = aiOptIn,
                onEnableAi = onEnableAi,
                onUseLocalOnly = onUseLocalOnly,
                onRefresh = onRefresh,
                onOpenPrivacy = onOpenPrivacy,
                onPlayAll = onPlayAll,
                onShufflePlay = onShufflePlay,
            )
        }

        if (!aiOptIn && collection != null) {
            item(key = "opt-in-banner") {
                DailyDiscoveryOptInCard(
                    onEnableAi = onEnableAi,
                    onUseLocalOnly = onUseLocalOnly,
                    onOpenPrivacy = onOpenPrivacy,
                )
                Spacer(Modifier.height(12.dp))
            }
        }

        if (state.isOffline && collection != null) {
            item(key = "offline-banner") {
                DiscoveryInlineBanner(
                    icon = Icons.Rounded.WifiOff,
                    text = stringResource(R.string.daily_discovery_offline_cached),
                    modifier = Modifier.padding(horizontal = PAGE_GUTTER, vertical = 6.dp),
                )
            }
        }

        when {
            state.loading && collection == null -> {
                items(6, key = { "skel:$it" }) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = PAGE_GUTTER, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ShimmerBox(Modifier.size(54.dp), ROW_ARTWORK_SHAPE)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            ShimmerBox(Modifier.fillMaxWidth(0.65f).height(15.dp), RoundedCornerShape(4.dp))
                            Spacer(Modifier.height(6.dp))
                            ShimmerBox(Modifier.fillMaxWidth(0.45f).height(12.dp), RoundedCornerShape(4.dp))
                        }
                    }
                }
            }
            items.isEmpty() -> {
                item(key = "empty") {
                    DailyDiscoveryStatusCard(
                        icon = if (state.isOffline) Icons.Rounded.WifiOff else SfIcons.AutoAwesome,
                        message = when {
                            state.isOffline -> stringResource(R.string.daily_discovery_offline_empty)
                            state.errorMessage != null -> state.errorMessage
                            else -> stringResource(R.string.daily_discovery_empty)
                        },
                        actionLabel = stringResource(R.string.daily_discovery_refresh),
                        onAction = onRefresh,
                    )
                }
            }
            else -> {
                itemsIndexed(
                    items = items,
                    key = { _, item -> item.song.videoId },
                ) { index, item ->
                    val feedback = state.feedbackByVideoId[item.song.videoId]?.action
                    val isLiked = feedback == DiscoveryFeedbackAction.LIKE ||
                        feedback == DiscoveryFeedbackAction.MORE_LIKE_THIS ||
                        likeStatuses[item.song.videoId] == LikeStatus.LIKE
                    val isCurrent = currentSong?.videoId == item.song.videoId
                    DailyDiscoveryTrackRow(
                        item = item,
                        isCurrent = isCurrent,
                        isPlaying = isCurrent && isPlaying,
                        isLiked = isLiked,
                        feedback = feedback,
                        onClick = { onTrackClick(item, index) },
                        onSwipe = { onTrackSwipe(item) },
                        onMore = { onTrackMore(item) },
                        onFeedback = { action -> onFeedback(item, action) },
                        modifier = if (reduceMotion) Modifier else Modifier.animateItem(),
                    )
                    if (index < items.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(start = ROW_DIVIDER_INSET),
                            thickness = 0.5.dp,
                            color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DailyDiscoveryHeroCard(
    collection: DailyDiscoveryCollection?,
    state: DailyDiscoveryUiState,
    aiOptIn: Boolean,
    onEnableAi: () -> Unit,
    onUseLocalOnly: () -> Unit,
    onRefresh: () -> Unit,
    onOpenPrivacy: () -> Unit,
    onPlayAll: () -> Unit,
    onShufflePlay: () -> Unit,
) {
    val dark = isDarkSurface()
    val heroTint = if (dark) {
        Brush.verticalGradient(
            listOf(AccentGreen.copy(alpha = 0.20f), Color(0xFF121417).copy(alpha = 0.85f)),
        )
    } else {
        Brush.verticalGradient(
            listOf(AccentGreen.copy(alpha = 0.14f), Color(0xFFF6F8F7)),
        )
    }
    val artworks = collection?.items.orEmpty().mapNotNull { it.song.thumbnailUrl }.distinct().take(4)
    val badgeLabel = when (collection?.source) {
        DiscoverySource.BACKEND_AI -> stringResource(R.string.daily_discovery_ai_badge)
        DiscoverySource.LOCAL_TASTE -> stringResource(R.string.daily_discovery_local_badge)
        DiscoverySource.CACHED_OFFLINE -> stringResource(R.string.daily_discovery_offline_badge)
        DiscoverySource.STARTER_COLD_START -> stringResource(R.string.daily_discovery_cold_start_badge)
        null -> if (aiOptIn) stringResource(R.string.daily_discovery_ai_badge) else stringResource(R.string.daily_discovery_privacy_controls)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = PAGE_GUTTER, vertical = 10.dp)
            .lightweightLiquidGlass(HOME_CARD_SHAPE, MaterialTheme.colorScheme.surfaceVariant)
            .background(heroTint)
            .padding(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DiscoveryMosaicArtwork(urls = artworks, size = 84.dp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Image(
                        painter = painterResource(SharedRes.drawable.ic_logo),
                        contentDescription = null,
                        colorFilter = ColorFilter.tint(AccentGreen),
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = badgeLabel.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = AccentGreen,
                        fontWeight = FontWeight.W700,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = stringResource(R.string.daily_discovery),
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                val meta = collection?.let { col ->
                    val unfamiliar = col.items.count { it.isUnfamiliarArtist }
                    if (unfamiliar > 0) "${col.dateKey} · ${col.items.size} songs · $unfamiliar new artists"
                    else "${col.dateKey} · ${col.items.size} songs"
                } ?: stringResource(R.string.daily_discovery_subtitle)
                Text(
                    text = meta,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        collection?.tasteSummary?.takeIf { it.isNotBlank() }?.let { summary ->
            Spacer(Modifier.height(12.dp))
            Text(
                text = summary,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.88f),
            )
        }

        if (collection != null && collection.subgenres.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                collection.subgenres.take(5).forEach { genre ->
                    Box(
                        modifier = Modifier
                            .lightweightLiquidGlass(PILL_SHAPE, MaterialTheme.colorScheme.surface)
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    ) {
                        Text(
                            text = genre,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(14.dp))

        if (collection != null && collection.items.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .clip(PILL_SHAPE)
                        .background(AccentGreen)
                        .clickable(onClick = onPlayAll)
                        .padding(vertical = 11.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(SfIcons.Play, contentDescription = null, tint = Color.Black, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = stringResource(R.string.daily_discovery_play_mix),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.W700,
                        color = Color.Black,
                    )
                }
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .lightweightLiquidGlass(PILL_SHAPE, MaterialTheme.colorScheme.surface)
                        .clickable(onClick = onShufflePlay)
                        .padding(vertical = 11.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(SfIcons.Shuffle, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = stringResource(R.string.shuffle),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
                DiscoveryRefreshPillButton(refreshing = state.refreshing, onClick = onRefresh)
                DiscoveryGlassIconButton(
                    icon = SfIcons.Lock,
                    contentDescription = stringResource(R.string.daily_discovery_privacy_controls),
                    onClick = onOpenPrivacy,
                )
            }
            val remainingText = when (val allowance = state.refreshAllowance) {
                is RefreshPolicyResult.Allowed ->
                    stringResource(R.string.daily_discovery_refreshes_left, allowance.remainingToday)
                is RefreshPolicyResult.Cooldown ->
                    stringResource(R.string.daily_discovery_rate_limited_cooldown, allowance.waitSeconds.toInt())
                RefreshPolicyResult.DailyLimitReached ->
                    stringResource(R.string.daily_discovery_rate_limited_daily, com.music.nikomusic.data.DailyDiscoveryPlanner.MAX_MANUAL_REFRESHES_PER_DAY)
            }
            Text(
                text = remainingText,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )
        } else if (!aiOptIn) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    modifier = Modifier
                        .clip(PILL_SHAPE)
                        .background(AccentGreen)
                        .clickable(onClick = onEnableAi)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Text(
                        text = stringResource(R.string.daily_discovery_enable_ai),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.W700,
                        color = Color.Black,
                    )
                }
                Box(
                    modifier = Modifier
                        .lightweightLiquidGlass(PILL_SHAPE, MaterialTheme.colorScheme.surface)
                        .clickable(onClick = onUseLocalOnly)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    Text(
                        text = stringResource(R.string.daily_discovery_local_fallback_cta),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DailyDiscoveryTrackRow(
    item: DailyDiscoveryTrack,
    isCurrent: Boolean,
    isPlaying: Boolean,
    isLiked: Boolean,
    feedback: DiscoveryFeedbackAction?,
    onClick: () -> Unit,
    onSwipe: () -> Unit,
    onMore: () -> Unit,
    onFeedback: (DiscoveryFeedbackAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val song = item.toPlayableSong()
    val rowBg = MaterialTheme.colorScheme.background
    SwipeToQueueBox(
        onSwipeToQueue = if (item.unavailable) null else onSwipe,
        modifier = modifier,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(rowBg)
                .alpha(if (item.unavailable) 0.48f else 1f)
                .longPressMenuClickable(
                    onClick = onClick,
                    onLongClick = onMore,
                    liftPadding = PaddingValues(horizontal = PAGE_GUTTER),
                )
                .padding(horizontal = PAGE_GUTTER, vertical = 10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(54.dp)) {
                    AsyncImage(
                        model = song.artworkAt(ROW_ART_PX),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .matchParentSize()
                            .clip(ROW_ARTWORK_SHAPE)
                            .thumbnailBorder(ROW_ARTWORK_SHAPE)
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                    )
                    if (isCurrent && isPlaying) {
                        SearchPlayingBars(Modifier.align(Alignment.Center))
                    }
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    ExplicitSongTitle(
                        song = song,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (isCurrent) AccentGreen else MaterialTheme.colorScheme.onBackground,
                    )
                    Text(
                        text = listOfNotNull(
                            song.artist.takeIf { it.isNotBlank() },
                            item.song.albumName?.takeIf { it.isNotBlank() },
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (item.reason.isNotBlank() || item.unavailable) {
                        Text(
                            text = if (item.unavailable) stringResource(R.string.daily_discovery_unavailable_track) else item.reason,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (item.unavailable) MaterialTheme.colorScheme.error else AccentGreen,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
                song.durationText?.let { dur ->
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = dur,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                RowMoreButton(onClick = onMore)
            }

            if (!item.unavailable) {
                Spacer(Modifier.height(8.dp))
                FlowRow(
                    modifier = Modifier.padding(start = 68.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    FeedbackPillButton(
                        icon = if (isLiked) SfIcons.StarFill else SfIcons.Star,
                        label = stringResource(R.string.like),
                        active = isLiked,
                        onClick = { onFeedback(DiscoveryFeedbackAction.LIKE) },
                    )
                    FeedbackPillButton(
                        icon = Icons.Rounded.ThumbUp,
                        label = stringResource(R.string.more_like_this),
                        active = feedback == DiscoveryFeedbackAction.MORE_LIKE_THIS,
                        onClick = { onFeedback(DiscoveryFeedbackAction.MORE_LIKE_THIS) },
                    )
                    FeedbackPillButton(
                        icon = Icons.Rounded.ThumbDown,
                        label = stringResource(R.string.less_like_this),
                        active = feedback == DiscoveryFeedbackAction.LESS_LIKE_THIS,
                        onClick = { onFeedback(DiscoveryFeedbackAction.LESS_LIKE_THIS) },
                    )
                    FeedbackPillButton(
                        icon = SfIcons.VisibilityOff,
                        label = stringResource(R.string.not_interested),
                        active = false,
                        onClick = { onFeedback(DiscoveryFeedbackAction.NOT_INTERESTED) },
                    )
                }
            }
        }
    }
}

@Composable
private fun DiscoveryMosaicArtwork(urls: List<String>, size: androidx.compose.ui.unit.Dp) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier = Modifier
            .size(size)
            .clip(shape)
            .thumbnailBorder(shape)
            .background(MaterialTheme.colorScheme.surface),
        contentAlignment = Alignment.Center,
    ) {
        when {
            urls.isEmpty() -> {
                Icon(
                    imageVector = SfIcons.AutoAwesome,
                    contentDescription = null,
                    tint = AccentGreen,
                    modifier = Modifier.size(32.dp),
                )
            }
            urls.size < 4 -> {
                AsyncImage(
                    model = urls.first().artworkAt(CARD_ART_PX),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            else -> {
                Column(Modifier.fillMaxSize()) {
                    Row(Modifier.weight(1f)) {
                        AsyncImage(
                            model = urls[0].artworkAt(ROW_ART_PX),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.weight(1f).fillMaxSize(),
                        )
                        AsyncImage(
                            model = urls[1].artworkAt(ROW_ART_PX),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.weight(1f).fillMaxSize(),
                        )
                    }
                    Row(Modifier.weight(1f)) {
                        AsyncImage(
                            model = urls[2].artworkAt(ROW_ART_PX),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.weight(1f).fillMaxSize(),
                        )
                        AsyncImage(
                            model = urls[3].artworkAt(ROW_ART_PX),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.weight(1f).fillMaxSize(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DiscoveryInlineBanner(
    icon: ImageVector,
    text: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .lightweightLiquidGlass(RoundedCornerShape(12.dp), MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DiscoveryGlassIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .lightweightLiquidGlass(CircleShape, MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun DiscoveryRefreshPillButton(
    refreshing: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .lightweightLiquidGlass(CircleShape, MaterialTheme.colorScheme.surfaceVariant)
            .clickable(enabled = !refreshing, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (refreshing) {
            CircularProgressIndicator(
                modifier = Modifier.size(15.dp),
                strokeWidth = 2.dp,
                color = AccentGreen,
            )
        } else {
            Icon(
                imageVector = SfIcons.Cached,
                contentDescription = stringResource(R.string.daily_discovery_refresh),
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
private fun FeedbackMiniButton(
    icon: ImageVector,
    active: Boolean,
    contentDescription: String,
    onClick: () -> Unit,
) {
    val tint by animateColorAsState(
        targetValue = if (active) AccentGreen else MaterialTheme.colorScheme.onSurfaceVariant,
        label = "feedback mini tint",
    )
    Box(
        modifier = Modifier
            .size(26.dp)
            .clip(CircleShape)
            .background(if (active) AccentGreen.copy(alpha = 0.14f) else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint,
            modifier = Modifier.size(15.dp),
        )
    }
}

@Composable
private fun FeedbackPillButton(
    icon: ImageVector,
    label: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    val bg by animateColorAsState(
        targetValue = if (active) AccentGreen.copy(alpha = 0.16f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
        label = "feedback pill bg",
    )
    val fg by animateColorAsState(
        targetValue = if (active) AccentGreen else MaterialTheme.colorScheme.onSurfaceVariant,
        label = "feedback pill fg",
    )
    Row(
        modifier = Modifier
            .clip(PILL_SHAPE)
            .background(bg)
            .border(
                width = GLASS_EDGE_WIDTH,
                color = if (active) AccentGreen.copy(alpha = 0.45f) else GLASS_EDGE_COLOR,
                shape = PILL_SHAPE,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = fg,
            modifier = Modifier.size(13.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = fg,
            maxLines = 1,
        )
    }
}
