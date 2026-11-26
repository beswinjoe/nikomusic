package com.music.nikomusic.data

import com.music.nikomusic.data.DebugLog as Log
import com.music.nikomusic.data.model.ArtistPage
import com.music.nikomusic.data.model.ArtistRef
import com.music.nikomusic.data.model.HomeShelf
import com.music.nikomusic.data.model.SearchFilter
import com.music.nikomusic.data.model.SearchResult
import com.music.nikomusic.data.model.ShelfItem
import com.music.nikomusic.data.model.Song
import com.music.nikomusic.data.model.TopPick
import com.music.nikomusic.data.model.TopPickKind
import com.music.nikomusic.data.model.TopPickMood
import com.music.nikomusic.data.model.WatchTarget
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import com.music.nikomusic.data.model.normalizedArtistName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.LocalDateTime
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random

/**
 * Builds Home's "Top Picks for You" row out of what the account already tells
 * YouTube Music, and starts the queue behind a card when it is tapped.
 *
 * Every card comes from YouTube's own data:
 *  - the listener's top artists are ranked from their YouTube listening
 *    history (the feed Recents was just built from, so normally no request),
 *    with this app's own play counts as a second opinion;
 *  - the three top artists' landing pages (one request each, in parallel)
 *    supply the latest release, the artist photos, related artists, and the
 *    header's Mix and Shuffle queues;
 *  - My Supermix, Discover Mix and New Release Mix come off Home's Mixed for
 *    you shelf when it is already loaded, or the Mixed for you page if not;
 *  - a mood is a fixed category id, so it costs nothing until tapped.
 *
 * A card with nothing behind it is left out rather than filled with a
 * placeholder. Queues are fetched only on tap.
 */
object TopPicks {

    private const val TAG = "NikoMusic"

    /** How many artists get a page fetched — and so a card. */
    private const val ARTISTS = 3

    /**
     * How far down the listener's chart those artists are drawn from. Every
     * build draws afresh, weighted toward the top, so the row changes each
     * time it is built without leaving the listener's own taste.
     */
    private const val ARTIST_POOL = 10

    /** Below this, a filtered station would be over before it got going; keep it unfiltered. */
    private const val MIN_FILTERED_QUEUE = 12

    /** Latest computed listener profile shared with on-tap station & mood queue builders. */
    @Volatile
    private var latestProfile: RecommendationEngine.ListenerProfile = RecommendationEngine.ListenerProfile()

    /** Recent opener tracks per mood to avoid serving identical mood intros back-to-back. */
    private val recentMoodOpeners = ConcurrentHashMap<TopPickMood, MutableSet<String>>()

    /**
     * What this app knows about the listener's taste without asking YouTube:
     * its own Replay chart, skip patterns, liked songs, genres and mood history.
     * Second to the account's history when signed in, and all there is when signed out.
     */
    data class LocalTaste(
        val artists: List<ArtistRef> = emptyList(),
        val songs: List<Song> = emptyList(),
        val genres: List<String> = emptyList(),
        val likedSongs: List<Song> = emptyList(),
        val recentSongIds: Set<String> = emptySet(),
        val trackStats: List<RecommendationEngine.TrackFeedback> = emptyList(),
        val artistGenres: Map<String, List<String>> = emptyMap(),
        val moodAffinities: Map<TopPickMood, Double> = emptyMap(),
        val discoveredArtists: Set<String> = emptySet(),
    )

    fun noteMoodSelected(mood: TopPickMood) {
        val current = latestProfile
        val updated = current.favoriteMoods.toMutableMap()
        updated[mood] = (updated[mood] ?: 0.0) + 1.0
        latestProfile = current.copy(favoriteMoods = updated)
    }

    fun noteTrackSkipped(videoId: String) {
        val current = latestProfile
        val tracks = current.tracks.toMutableMap()
        val prev = tracks[videoId]
        val next = (prev ?: RecommendationEngine.TrackFeedback(videoId = videoId)).let {
            it.copy(
                skips = it.skips + 1,
                earlySkips = it.earlySkips + 1,
                lastSkippedMs = System.currentTimeMillis(),
            )
        }
        tracks[videoId] = next
        latestProfile = current.copy(tracks = tracks)
    }

    private fun buildProfile(history: List<Song>, local: LocalTaste): RecommendationEngine.ListenerProfile {
        val trackMap = LinkedHashMap<String, RecommendationEngine.TrackFeedback>()
        for (tf in local.trackStats) {
            trackMap[tf.videoId] = tf
        }
        val likedIds = LinkedHashSet<String>()
        for (song in local.likedSongs) {
            likedIds += song.videoId
            val existing = trackMap[song.videoId]
            trackMap[song.videoId] = (existing ?: RecommendationEngine.TrackFeedback(
                videoId = song.videoId,
                title = song.title,
                artist = song.artist,
            )).copy(liked = true)
        }
        history.forEachIndexed { idx, song ->
            if (song.videoId !in trackMap) {
                trackMap[song.videoId] = RecommendationEngine.TrackFeedback(
                    videoId = song.videoId,
                    title = song.title,
                    artist = song.artist,
                    plays = 1,
                    lastPlayedMs = System.currentTimeMillis() - idx * 300_000L,
                )
            }
        }
        val recentIds = (local.recentSongIds + history.take(25).map { it.videoId }).toSet()
        val recentRecs = (local.songs.take(5) + history.take(20))
            .mapTo(HashSet()) { RecommendationEngine.recordingKey(it.title, it.artist) }

        val skipByArtist = mutableMapOf<String, Pair<Int, Int>>()
        for (tf in local.trackStats) {
            for (a in RecommendationEngine.artistSet(tf.artist)) {
                val prev = skipByArtist[a] ?: (0 to 0)
                skipByArtist[a] = (prev.first + tf.skips) to (prev.second + tf.earlySkips)
            }
        }
        val artistAffinities = local.artists.mapIndexed { idx, ref ->
            val key = normalizedArtistName(ref.name)
            val skips = skipByArtist[key] ?: (0 to 0)
            RecommendationEngine.ArtistAffinity(
                name = ref.name,
                browseId = ref.browseId,
                plays = (local.artists.size - idx).coerceAtLeast(1),
                skips = skips.first,
                earlySkips = skips.second,
                recentlyDiscovered = key in local.discoveredArtists,
                genres = local.artistGenres[key].orEmpty(),
            )
        }
        val genreMap = LinkedHashMap<String, Double>()
        local.genres.forEachIndexed { idx, genre ->
            genreMap[genre.lowercase(Locale.ROOT)] = 1.0 - (idx * 0.15).coerceAtMost(0.7)
        }
        for (genres in local.artistGenres.values) {
            for (g in genres) {
                val key = g.lowercase(Locale.ROOT)
                genreMap[key] = maxOf(genreMap[key] ?: 0.0, 0.35)
            }
        }

        return RecommendationEngine.ListenerProfile(
            artists = artistAffinities,
            tracks = trackMap,
            recentTrackIds = recentIds,
            recentRecordings = recentRecs,
            likedTrackIds = likedIds,
            favoriteGenres = genreMap,
            favoriteMoods = local.moodAffinities,
            discoveredArtists = local.discoveredArtists,
            artistGenres = local.artistGenres,
        )
    }

    suspend fun build(
        homeShelves: List<HomeShelf>,
        local: LocalTaste,
        now: LocalDateTime = LocalDateTime.now(),
    ): List<TopPick> = coroutineScope {
        val historyAsync = async { YtMusicRepository.recentHistory().getOrNull().orEmpty() }
        val mixesAsync = async { findMixes(homeShelves) }

        val history = historyAsync.await()
        val profile = buildProfile(history, local)
        latestProfile = profile

        val ranked = weightedSample(rankArtists(history, local, profile).take(ARTIST_POOL), ARTISTS)
        val pages = ranked.map { artist ->
            async { YtMusicRepository.artistLanding(artist.browseId!!).getOrNull() }
        }.awaitAll()
        val artists = ranked.zip(pages).mapNotNull { (ref, page) ->
            page?.let { ArtistCard(it.copy(name = it.name ?: ref.name), ref.browseId!!) }
        }
            .distinctBy { normalizedArtistName(it.name) }
        val photos = applePhotos(artists)
        val mixes = mixesAsync.await()
        Log.d(TAG, "topPicks: history=${history.size} artists=${artists.map { it.name }} mixes=${mixes.keys}")

        val lead = latestRelease(artists)
        val rest = buildList {
            personalStation(mixes, history, local, homeShelves)?.let(::add)
            add(moodPick(now, local))
            artists.getOrNull(0)?.let { andSimilar(it, photos) }?.let(::add)
            artists.getOrNull(1)?.let { featured(it, photos) }?.let(::add)
            mixes[Mix.NEW_RELEASE]?.let { mix ->
                add(
                    TopPick(
                        kind = TopPickKind.NEW_RELEASE_MIX,
                        title = mix.title,
                        subtitle = mix.subtitle,
                        images = listOfNotNull(mix.thumbnailUrl),
                        watch = mix.watchTarget(),
                    ),
                )
            }
            artists.getOrNull(2)?.let { andSimilar(it, photos) }?.let(::add)
            discoveryStation(mixes, artists, history, homeShelves)?.let(::add)
        }.shuffled()
        RecommendationEngine.diversifyTopPicks(listOfNotNull(lead) + rest)
    }

    /**
     * [count] of [ranked] at random, the higher an artist sits the likelier —
     * the top of the chart turns up most builds, the rest often enough to
     * keep the row moving.
     */
    private fun <T> weightedSample(ranked: List<T>, count: Int): List<T> {
        val pool = ranked.withIndex().toMutableList()
        val picked = mutableListOf<T>()
        while (picked.size < count && pool.isNotEmpty()) {
            val weights = pool.map { (ranked.size - it.index).toDouble() }
            var roll = Random.nextDouble() * weights.sum()
            val index = weights.indexOfFirst { roll -= it; roll <= 0 }.coerceAtLeast(0)
            picked += pool.removeAt(index).value
        }
        return picked
    }

    /** The queue a card starts. Never called for [TopPickKind.LATEST_RELEASE], which opens a page. */
    suspend fun queue(pick: TopPick): Result<List<Song>> {
        if (pick.kind == TopPickKind.MOOD) return moodQueue(pick)
        val target = pick.watch ?: return Result.failure(IllegalStateException("no queue behind ${pick.kind}"))
        return freshStation(pick, target)
    }

    /**
     * Ranks any Personalized, Discovery, New Release or Artist station via
     * [RecommendationEngine] using listener taste, skip fatigue, recency awareness,
     * and artist spread — instead of raw unranked shuffles.
     */
    private suspend fun freshStation(pick: TopPick, target: WatchTarget): Result<List<Song>> = coroutineScope {
        val mixAsync = async { YtMusicRepository.watchQueue(target) }
        val history = YtMusicRepository.recentHistory().getOrNull().orEmpty()
        val profile = latestProfile

        val favoriteSeeds = profile.tracks.values
            .filter { (it.plays > 0 || it.liked) && it.earlySkips == 0 }
            .sortedByDescending { (if (it.liked) 10 else 0) + it.plays }
            .take(15)
            .map { it.videoId }
        val seedIds = (favoriteSeeds + history.take(SEED_POOL).map { it.videoId })
            .distinct()
            .shuffled()
            .take(SEED_RADIOS)

        val radios = seedIds.map { vid ->
            async {
                YtMusicRepository.watchQueue(WatchTarget(playlistId = "RDAMVM$vid", videoId = vid))
                    .getOrNull().orEmpty()
            }
        }
        val mix = mixAsync.await().getOrElse { failure ->
            if (seedIds.isEmpty()) return@coroutineScope Result.failure(failure)
            emptyList()
        }
        val around = radios.awaitAll().flatten()

        val mode = when (pick.kind) {
            TopPickKind.DISCOVERY_STATION -> RecommendationEngine.RankingMode.DISCOVERY
            TopPickKind.NEW_RELEASE_MIX -> RecommendationEngine.RankingMode.NEW_RELEASE
            TopPickKind.ARTIST_AND_SIMILAR, TopPickKind.FEATURED_ARTIST -> RecommendationEngine.RankingMode.ARTIST_STATION
            else -> RecommendationEngine.RankingMode.SUPERMIX
        }

        val exclusions = pick.exclude.toHashSet()
        val seedArtist = pick.artistName?.takeIf { mode == RecommendationEngine.RankingMode.DISCOVERY }?.lowercase(Locale.ROOT)
        val rawCandidates = (mix.mapIndexed { i, song ->
            RecommendationEngine.TrackCandidate(
                song = song,
                isNewRelease = mode == RecommendationEngine.RankingMode.NEW_RELEASE,
                sourceOrder = i,
            )
        } + around.mapIndexed { i, song ->
            RecommendationEngine.TrackCandidate(song = song, sourceOrder = mix.size + i)
        }).filter { c ->
            c.song.videoId !in exclusions &&
                (seedArtist == null || !c.song.artist.lowercase(Locale.ROOT).contains(seedArtist))
        }

        val ranked = RecommendationEngine.rankTracks(
            candidates = rawCandidates,
            profile = profile,
            mode = mode,
            nowMs = System.currentTimeMillis(),
            limit = STATION_SIZE,
            seed = System.nanoTime(),
        )
        Log.d(TAG, "station ${pick.kind}: mix=${mix.size} around=${around.size} ranked=${ranked.size}")
        when {
            ranked.size >= MIN_FILTERED_QUEUE -> Result.success(ranked)
            ranked.isNotEmpty() -> Result.success(ranked)
            mix.isNotEmpty() -> Result.success(mix.shuffled().take(STATION_SIZE))
            else -> Result.failure(IllegalStateException("${pick.kind} came back empty"))
        }
    }

    /** History tracks a station's extra radios are seeded from: the recent end of it. */
    private const val SEED_POOL = 40
    private const val SEED_RADIOS = 3
    private const val STATION_FROM_MIX = 30
    private const val STATION_SIZE = 60

    // ---- Cards --------------------------------------------------------------

    private class ArtistCard(val page: ArtistPage, val browseId: String) {
        val name: String get() = page.name.orEmpty()

        /**
         * The page's "Fans might also like", by name, without the artist
         * themselves — YouTube can list a second channel of the same person
         * there — and without repeats. A few more than a card shows, so an
         * artist Apple has no photo of can be passed over.
         */
        val relatedNames: List<String> get() = related.keys.toList()

        /** [relatedNames] → each one's channel, which their Apple photo is checked against. */
        val related: Map<String, String> by lazy {
            val own = normalizedArtistName(name)
            page.sections
                .firstOrNull { shelf -> shelf.items.isNotEmpty() && shelf.items.all { it.browseId?.startsWith("UC") == true } }
                ?.items.orEmpty()
                .filter { it.browseId != browseId }
                .filter { normalizedArtistName(it.title).let { key -> key.isNotEmpty() && key != own } }
                .distinctBy { normalizedArtistName(it.title) }
                .take(RELATED_CANDIDATES)
                .associate { it.title to it.browseId!! }
        }
    }

    private const val RELATED_CANDIDATES = 4
    private const val PHOTO_LOOKUPS_AT_ONCE = 4

    /**
     * Apple Music photos for [artists] and the people their fans also play, by
     * name; an artist Apple has none of (or none provably theirs) is left out.
     * A card's own artist is checked against the page already in hand; a
     * related one's page is fetched only if their photo isn't known yet.
     */
    private suspend fun applePhotos(artists: List<ArtistCard>): Map<String, String> = coroutineScope {
        val catalogues = LinkedHashMap<String, suspend () -> Collection<String>>()
        artists.forEach { artist -> catalogues.putIfAbsent(artist.name) { AppleCatalogue.titlesOf(artist.page) } }
        artists.forEach { artist ->
            artist.related.forEach { (name, channel) ->
                catalogues.putIfAbsent(name) {
                    YtMusicRepository.artistLanding(channel).getOrNull()?.let(AppleCatalogue::titlesOf).orEmpty()
                }
            }
        }
        val limiter = Semaphore(PHOTO_LOOKUPS_AT_ONCE)
        catalogues.map { (name, catalogue) ->
            async { limiter.withPermit { AppleArtistPhotos.photoFor(name, catalogue)?.let { name to it } } }
        }.awaitAll().filterNotNull().toMap()
    }

    private fun latestRelease(artists: List<ArtistCard>): TopPick? {
        data class Candidate(val rank: Int, val artist: ArtistCard, val item: ShelfItem, val year: Int, val single: Boolean)
        val candidates = artists.flatMapIndexed { rank, artist ->
            // The release shelves are the ones of albums (MPRE… pages). Each is
            // newest first, so only its lead card is a candidate.
            artist.page.sections
                .mapNotNull { shelf -> shelf.items.firstOrNull()?.takeIf { it.browseId?.startsWith("MPRE") == true } }
                .map { item ->
                    Candidate(rank, artist, item, yearOf(item.subtitle), SINGLE.containsMatchIn(item.subtitle))
                }
        }
        // Newest year first. Within a year a single wins: a bare-year "album"
        // on a big artist's page is as often one of YouTube's auto-made
        // compilations as a real record, and a single never is.
        val best = candidates.maxWithOrNull(
            compareBy<Candidate> { it.year }.thenBy { it.single }.thenByDescending { it.rank },
        ) ?: return null
        return TopPick(
            kind = TopPickKind.LATEST_RELEASE,
            title = best.item.title,
            subtitle = best.item.subtitle,
            artistName = best.artist.name,
            images = listOfNotNull(best.item.thumbnailUrl),
            browseId = best.item.browseId,
        )
    }

    private fun personalStation(
        mixes: Map<Mix, ShelfItem>,
        history: List<Song>,
        local: LocalTaste,
        homeShelves: List<HomeShelf>,
    ): TopPick? {
        val homeFallbackTrack = homeShelves
            .filterNot {
                val t = it.title.lowercase(Locale.ROOT)
                "recent" in t || "history" in t || "listen again" in t
            }
            .flatMap { it.items }
            .firstOrNull { it.videoId != null }
            ?.videoId

        val watch = mixes[Mix.SUPERMIX]?.watchTarget()
            ?: (local.songs.firstOrNull() ?: local.likedSongs.firstOrNull() ?: history.firstOrNull())?.let { song ->
                WatchTarget(playlistId = "RDAMVM${song.videoId}", videoId = song.videoId)
            }
            ?: homeFallbackTrack?.let { vid -> WatchTarget(playlistId = "RDAMVM$vid", videoId = vid) }
            ?: return null
        return TopPick(kind = TopPickKind.PERSONAL_STATION, watch = watch)
    }

    private fun moodPick(now: LocalDateTime, local: LocalTaste): TopPick =
        TopPick(
            kind = TopPickKind.MOOD,
            mood = moodFor(now, local),
            hints = (local.genres.map { it.lowercase(Locale.ROOT) } + regionHints()).distinct(),
        )

    private fun andSimilar(artist: ArtistCard, photos: Map<String, String>): TopPick? {
        val radio = artist.page.radio ?: return null
        // No Apple photo of the artist, no card: the big circle is the card.
        val face = photos[artist.name] ?: return null
        val related = artist.relatedNames
            .mapNotNull { photos[it] }
            // Two names can share one photo; one face per circle.
            .filter { it != face }
            .distinct()
            .take(2)
        return TopPick(
            kind = TopPickKind.ARTIST_AND_SIMILAR,
            title = artist.name,
            artistName = artist.name,
            artistBrowseId = artist.browseId,
            images = listOf(face) + related,
            watch = radio,
        )
    }

    private fun featured(artist: ArtistCard, photos: Map<String, String>): TopPick? {
        val shuffle = artist.page.shuffle ?: artist.page.radio ?: return null
        val face = photos[artist.name] ?: return null
        return TopPick(
            kind = TopPickKind.FEATURED_ARTIST,
            title = artist.name,
            subtitle = artist.page.monthlyListenerCount ?: artist.page.subscriberCountText.orEmpty(),
            artistName = artist.name,
            artistBrowseId = artist.browseId,
            images = listOf(face),
            watch = shuffle,
        )
    }

    private fun discoveryStation(
        mixes: Map<Mix, ShelfItem>,
        artists: List<ArtistCard>,
        history: List<Song>,
        homeShelves: List<HomeShelf>,
    ): TopPick? {
        mixes[Mix.DISCOVER]?.watchTarget()?.let { watch ->
            return TopPick(kind = TopPickKind.DISCOVERY_STATION, watch = watch)
        }
        val seed = artists.firstOrNull()
        val radio = seed?.page?.radio
        if (seed != null && radio != null) {
            return TopPick(
                kind = TopPickKind.DISCOVERY_STATION,
                artistName = seed.name,
                watch = radio,
                exclude = history.take(200).map { it.videoId },
            )
        }
        // Cold-start fallback: build a discovery radio from an explore/new-release track on Home
        val exploreVideo = homeShelves
            .filter {
                val t = it.title.lowercase(Locale.ROOT)
                "new" in t || "quick" in t || "recommend" in t || "chart" in t
            }
            .flatMap { it.items }
            .firstOrNull { it.videoId != null }
            ?.videoId
            ?: return null
        return TopPick(
            kind = TopPickKind.DISCOVERY_STATION,
            watch = WatchTarget(playlistId = "RDAMVM$exploreVideo", videoId = exploreVideo),
            exclude = history.take(200).map { it.videoId },
        )
    }

    // ---- Artists ------------------------------------------------------------

    /**
     * The listener's artists, best first. Combines YTM history, local replay stats,
     * liked songs, recently discovered artist boost, and early-skip attenuation.
     */
    private fun rankArtists(
        history: List<Song>,
        local: LocalTaste,
        profile: RecommendationEngine.ListenerProfile = latestProfile,
    ): List<ArtistRef> {
        val scores = LinkedHashMap<String, Pair<String, Double>>()
        val skipByName = mutableMapOf<String, Int>()
        for (tf in local.trackStats) {
            for (a in RecommendationEngine.artistSet(tf.artist)) {
                skipByName[a] = (skipByName[a] ?: 0) + tf.earlySkips
            }
        }
        fun credit(id: String?, name: String, weight: Double) {
            if (id == null || !id.startsWith("UC") || name.isBlank()) return
            if (name.equals("Various Artists", ignoreCase = true)) return
            val key = normalizedArtistName(name)
            val skipPenalty = (skipByName[key] ?: 0) * 0.45
            val discoveryBonus = if (key in profile.discoveredArtists) 0.35 else 0.0
            val (_, score) = scores[id] ?: (name to 0.0)
            scores[id] = name to (score + weight + discoveryBonus - skipPenalty).coerceAtLeast(0.05)
        }
        history.forEachIndexed { index, song ->
            val recency = 1.0 - index.toDouble() / history.size.coerceAtLeast(1)
            val lead = song.artists.firstOrNull { it.browseId != null }
            if (lead != null) credit(lead.browseId, lead.name, 1.0 + recency * 0.5)
            else credit(song.artistId, song.artist, 1.0 + recency * 0.5)
        }
        local.likedSongs.forEach { song ->
            val lead = song.artists.firstOrNull { it.browseId != null }
            if (lead != null) credit(lead.browseId, lead.name, 1.1)
            else credit(song.artistId, song.artist, 1.1)
        }
        local.artists.forEachIndexed { index, artist ->
            credit(artist.browseId, artist.name, (local.artists.size - index).toDouble() * 0.6)
        }
        return scores.entries
            .sortedByDescending { it.value.second }
            .map { ArtistRef(name = it.value.first, browseId = it.key) }
    }

    // ---- Mixes --------------------------------------------------------------

    private enum class Mix { SUPERMIX, DISCOVER, NEW_RELEASE }

    /**
     * The account's mixes. All of them are `RDTMAK…` playlists, so the id says
     * "a mix" but not which; the title does, in English. In another interface
     * language only the Supermix is placed, as the lead mix, which is where
     * YouTube puts it.
     */
    private suspend fun findMixes(homeShelves: List<HomeShelf>): Map<Mix, ShelfItem> {
        val onHome = homeShelves.flatMap { it.items }.filter { it.isMix() }
        val mixes = onHome.takeIf { it.isNotEmpty() }
            ?: YtMusicRepository.mixedForYou().getOrNull().orEmpty().filter { it.isMix() }
        if (mixes.isEmpty()) return emptyMap()
        val found = mutableMapOf<Mix, ShelfItem>()
        mixes.forEach { item ->
            val title = item.title.lowercase(Locale.ROOT)
            val kind = when {
                "supermix" in title -> Mix.SUPERMIX
                "discover" in title -> Mix.DISCOVER
                "new release" in title -> Mix.NEW_RELEASE
                else -> null
            }
            if (kind != null) found.putIfAbsent(kind, item)
        }
        if (found.isEmpty()) found[Mix.SUPERMIX] = mixes.first()
        return found
    }

    private fun ShelfItem.isMix(): Boolean =
        browseId?.removePrefix("VL")?.startsWith("RDTMAK") == true

    private fun ShelfItem.watchTarget(): WatchTarget? =
        browseId?.removePrefix("VL")?.let { WatchTarget(playlistId = it) }

    // ---- Moods --------------------------------------------------------------

    /**
     * A mood at random, leaning on the hour: most of the time one that suits
     * it (Focus mid-morning, Love late in the evening), sometimes any of
     * them. Only Apple's seven Find Your Mood moods, as on Apple Music's own
     * Top Picks — the activities live in Find Your Mood's Show all.
     */
    fun moodFor(now: LocalDateTime, local: LocalTaste = LocalTaste()): TopPickMood {
        val profile = if (local.moodAffinities.isNotEmpty()) {
            latestProfile.copy(favoriteMoods = local.moodAffinities)
        } else {
            latestProfile
        }
        return RecommendationEngine.chooseFeaturedMood(now.hour, profile)
    }

    /**
     * Builds a personalized, non-repetitive mood queue:
     * 1. Scores ALL shelves & playlists in the mood category against keywords, regional hints,
     *    and listener genres, sampling varied playlists so consecutive opens sound fresh.
     * 2. Falls back to targeted playlist/track search if the YTM category returns sparse content.
     * 3. Mixes a personal favorite seed radio (if taste history exists) alongside discoveries.
     * 4. Runs [RecommendationEngine.rankTracks] with contradiction filtering, skip penalties,
     *    recency fatigue, artist spread caps, and opener rotation.
     */
    private suspend fun moodQueue(pick: TopPick): Result<List<Song>> = coroutineScope {
        val mood = pick.mood ?: return@coroutineScope Result.failure(IllegalStateException("mood card without a mood"))
        val profile = latestProfile
        val shelves = YtMusicRepository.moodGenreShelves(TopPickMood.CATEGORY_BROWSE_ID, mood.params)
            .getOrElse { emptyList() }
        val chosen = RecommendationEngine.selectMoodPlaylists(
            shelves = shelves,
            mood = mood,
            hints = pick.hints,
            profile = profile,
            limit = MOOD_PLAYLISTS,
        )

        val candidates = mutableListOf<RecommendationEngine.TrackCandidate>()
        if (chosen.isNotEmpty()) {
            val loaded = chosen.map { item ->
                async {
                    val browseId = item.browseId ?: return@async emptyList()
                    val playlistId = browseId.removePrefix("VL")
                    val tracks = YtMusicRepository.playlistAsAudio(playlistId).getOrNull()?.takeIf { it.isNotEmpty() }
                        ?: YtMusicRepository.browseSongs(browseId).getOrNull()?.songs.orEmpty()
                    tracks.mapIndexed { idx, song ->
                        RecommendationEngine.TrackCandidate(
                            song = song,
                            sourcePlaylistTitle = item.title,
                            sourcePlaylistSubtitle = item.subtitle,
                            sourceOrder = idx,
                        )
                    }
                }
            }.awaitAll().flatten()
            candidates += loaded
        }

        // Graceful fallback when YTM category shelves return too few songs
        if (candidates.size < MIN_FILTERED_QUEUE) {
            val rule = RecommendationEngine.ruleFor(mood)
            for (query in rule.fallbackSearchQueries) {
                val hits = YtMusicRepository.search(query, SearchFilter.PLAYLISTS).getOrNull().orEmpty()
                val plItem = hits.filterIsInstance<SearchResult.Browse>().firstOrNull()?.item
                if (plItem != null) {
                    val pid = plItem.browseId.removePrefix("VL")
                    val tracks = YtMusicRepository.playlistAsAudio(pid).getOrNull()?.takeIf { it.isNotEmpty() }
                        ?: YtMusicRepository.browseSongs(plItem.browseId).getOrNull()?.songs.orEmpty()
                    candidates += tracks.mapIndexed { idx, song ->
                        RecommendationEngine.TrackCandidate(
                            song = song,
                            sourcePlaylistTitle = plItem.title,
                            sourcePlaylistSubtitle = plItem.subtitle,
                            sourceOrder = idx,
                        )
                    }
                }
                if (candidates.size >= MIN_FILTERED_QUEUE * 2) break
            }
        }

        // Mix one personal favorite seed radio (without letting it dominate non-compatible moods)
        val favSeed = profile.tracks.values
            .filter { (it.plays > 0 || it.liked) && it.earlySkips == 0 }
            .sortedByDescending { (if (it.liked) 10 else 0) + it.plays }
            .firstOrNull()
        if (favSeed != null) {
            YtMusicRepository.watchQueue(WatchTarget(playlistId = "RDAMVM${favSeed.videoId}", videoId = favSeed.videoId))
                .getOrNull()
                ?.take(15)
                ?.forEachIndexed { idx, song ->
                    candidates += RecommendationEngine.TrackCandidate(
                        song = song,
                        isFamiliarSeed = true,
                        sourceOrder = 1000 + idx,
                    )
                }
        }

        val openers = recentMoodOpeners[mood].orEmpty()
        val ranked = RecommendationEngine.rankTracks(
            candidates = candidates,
            profile = profile,
            mode = RecommendationEngine.RankingMode.MOOD,
            mood = mood,
            recentOpeners = openers,
            nowMs = System.currentTimeMillis(),
            limit = MOOD_QUEUE,
            seed = System.nanoTime(),
        )

        if (ranked.isNotEmpty()) {
            val historySet = recentMoodOpeners.computeIfAbsent(mood) { java.util.Collections.synchronizedSet(LinkedHashSet()) }
            if (historySet.size > 20) historySet.clear()
            ranked.take(5).forEach { historySet += it.videoId }
            return@coroutineScope Result.success(ranked)
        }

        val fallbackRaw = candidates.map { it.song }.distinctBy { it.videoId }.shuffled().take(MOOD_QUEUE)
        if (fallbackRaw.isEmpty()) Result.failure(IllegalStateException("$mood playlists were empty"))
        else Result.success(fallbackRaw)
    }

    private const val MOOD_PLAYLISTS = 4
    private const val MOOD_QUEUE = 60

    /**
     * A mood station for a Find Your Mood tile — the same queue the Mood for
     * You card plays, steered toward the listener's scene by [hints].
     */
    fun moodStation(mood: TopPickMood, hints: List<String> = regionHints()): TopPick =
        TopPick(kind = TopPickKind.MOOD, mood = mood, hints = hints)

    fun regionHints(): List<String> = when (Locale.getDefault().country) {
        "IN" -> listOf("bollywood", "indian", "hindi", "punjabi", "desi")
        "PK" -> listOf("pakistani", "urdu", "punjabi")
        "KR" -> listOf("k-pop", "korean")
        "JP" -> listOf("j-pop", "japanese")
        "BR" -> listOf("brazil", "sertanejo", "funk")
        "MX", "ES", "AR", "CO", "CL", "PE" -> listOf("latin", "latino", "reggaeton")
        else -> emptyList()
    }

    private val YEAR = Regex("""\b(19|20)\d{2}\b""")
    private val SINGLE = Regex("""\b(Single|EP)\b""")

    private fun yearOf(subtitle: String): Int =
        YEAR.findAll(subtitle).lastOrNull()?.value?.toIntOrNull() ?: 0

    // ---- Storage ------------------------------------------------------------

    /** A day's row as stored on disk, so Home can paint it before any request. */
    @Serializable
    data class Stored(
        val listener: String?,
        /** The hour it was built in, e.g. `2026-10-21T15`. */
        val day: String,
        val picks: List<TopPick>,
        /** [AppleArtistPhotos]' answers, misses included, so the next build doesn't ask again. */
        val photos: Map<String, String> = emptyMap(),
    )

    private val json = Json { ignoreUnknownKeys = true }

    fun encode(stored: Stored): String = json.encodeToString(Stored.serializer(), stored)

    fun decode(text: String): Stored? = runCatching { json.decodeFromString(Stored.serializer(), text) }.getOrNull()
}
