package com.music.nikomusic.data.lyrics

/**
 * A YouTube title, as a lyrics database would have indexed it.
 *
 * Every source here but [SimpMusicLyrics] is asked for a name, and the name
 * this app has is YouTube's, which is not the name anyone catalogued. "Dracula
 * (feat. JENNIE)" is filed by Apple, LRCLIB and everyone else as "Dracula", and
 * asked for verbatim it misses all of them — which is exactly how a track ends
 * up answered by whichever source happened to clean the title on its own
 * ([PaxSenix] was the only one that did) regardless of the order the user put
 * their sources in.
 *
 * ### What is taken off, and what is deliberately left on
 *
 * Only credits and packaging: who else is on the record, and how the upload was
 * labelled. Those are not part of the recording's name anywhere.
 *
 * Anything that names a *different recording* stays — "(Remix)", "(Acoustic)",
 * "(Live)", "(Remastered 2011)", "(Sped Up)". Those look like the same kind of
 * bracket and are the opposite: stripping them turns a search for one recording
 * into a search for another, and the lyrics that come back are confidently
 * wrong rather than merely missing. A miss is recoverable; the wrong words
 * scrolling in time with the right song is not.
 */
fun String.forLyricsSearch(): String {
    var name = this
    CREDITS.forEach { pattern -> name = pattern.replace(name, " ") }
    return name.replace(WHITESPACE, " ").trim().trimEnd(',', '-', '–', '—').trim()
        // A title that was *only* packaging is no title at all; better to ask
        // with what we were given than with nothing.
        .ifBlank { trim() }
}

/**
 * Trims " - Topic" off an auto-generated channel name.
 *
 * YouTube's own artist channels for licensed music are named this way, and it
 * reaches the player as the artist on anything played from one.
 */
fun String.artistForLyricsSearch(): String =
    removeSuffix(" - Topic").trim().ifBlank { trim() }

private val THIRD_PARTY_LYRIC_CHANNEL = Regex(
    """\b(?:7clouds|shadow\s*music|koala\s*kontrol|taz\s*network|vibe\s*music|syrebralvibes|uniq\s*vibes|aura\s*melodic|chill\s*only|cloudkid|xefox|nightblue|wave\s*music|latin\s*hype|rap\s*city|trap\s*nation|bass\s*nation|lyrics?\s*hub|polar\s*records)\b""",
    RegexOption.IGNORE_CASE,
)

private val VERSION_MODIFIERS = listOf(
    "remix", "live", "acoustic", "instrumental", "karaoke",
    "sped up", "slowed", "nightcore", "cover", "parody",
    "a cappella", "acapella", "demo", "mix",
)

private val NON_LYRICS_GENIUS_PAGE = Regex(
    """\b(?:genius\s+translations?|romanization|tracklist|liner\s+notes|credits|interview|booklet|discography)\b""",
    RegexOption.IGNORE_CASE,
)

private val BRACKET_CONTENT_REGEX = Regex("""\s*[(\[][^)\]]*[)\]]""")
private val PUNCT_REGEX = Regex("""[^\p{L}\p{N}\s]""")
private val MULTI_ARTIST_SPLIT = Regex("""\s*(?:,|&|\band\b|\bx\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|/)\s*""", RegexOption.IGNORE_CASE)

/**
 * Cleans both song title and artist before lyrics lookup:
 * strips third-party lyric channels (e.g. `7clouds R&B`) and recovers `"Artist - Title"`
 * when a fan upload placed both inside the title.
 */
fun cleanLyricsSearchTerms(rawTitle: String, rawArtist: String): Pair<String, String> {
    val baseArtist = rawArtist.artistForLyricsSearch()
    val cleanArtist = if (THIRD_PARTY_LYRIC_CHANNEL.containsMatchIn(baseArtist)) "" else baseArtist
    val dashParts = rawTitle.split(Regex("""\s[-–—]\s"""))
    if (cleanArtist.isEmpty() && dashParts.size >= 2 && dashParts[0].isNotBlank() && dashParts[1].isNotBlank()) {
        val parsedArtist = dashParts[0].trim().artistForLyricsSearch()
        val parsedTitle = dashParts.drop(1).joinToString(" - ").forLyricsSearch()
        if (!THIRD_PARTY_LYRIC_CHANNEL.containsMatchIn(parsedArtist) && parsedTitle.isNotBlank()) {
            return parsedTitle to parsedArtist
        }
    }
    return rawTitle.forLyricsSearch() to cleanArtist
}

internal fun normalizeLyricsMatchText(text: String): String =
    text.lowercase()
        .replace(BRACKET_CONTENT_REGEX, " ")
        .replace(PUNCT_REGEX, " ")
        .replace(WHITESPACE, " ")
        .trim()

private fun tokenizeLyricsMatch(text: String): List<String> =
    normalizeLyricsMatchText(text).split(' ').filter { it.isNotEmpty() }

internal fun lyricsTitleMatches(candidateTitle: String, targetTitle: String): Boolean {
    val normCand = normalizeLyricsMatchText(candidateTitle)
    val normTarget = normalizeLyricsMatchText(targetTitle)
    if (normCand.isEmpty() || normTarget.isEmpty()) return false
    if (normCand == normTarget) return true
    val candTokens = tokenizeLyricsMatch(candidateTitle)
    val targetTokens = tokenizeLyricsMatch(targetTitle)
    if (candTokens.isEmpty() || targetTokens.isEmpty()) return false
    // Short single-word titles ("Low", "One", "Up") must never substring-match "Slow"/"Someone"/"Cupid"
    if (targetTokens.size == 1 && targetTokens[0].length <= 4) {
        return candTokens.first() == targetTokens[0] && candTokens.size <= 2
    }
    val candSet = candTokens.toSet()
    val sigTarget = targetTokens.filter { it.length >= 2 }.ifEmpty { targetTokens }
    val overlap = sigTarget.count { it in candSet }
    return (overlap == sigTarget.size && candTokens.size <= sigTarget.size + 3) ||
        (sigTarget.size >= 3 && overlap * 3 >= sigTarget.size * 2 && candTokens.size <= sigTarget.size + 3)
}

internal fun lyricsArtistMatches(candidateArtist: String, targetArtist: String): Boolean {
    val candClean = candidateArtist.artistForLyricsSearch().lowercase().trim()
    val targetClean = targetArtist.artistForLyricsSearch().lowercase().trim()
    if (targetClean.isEmpty() || THIRD_PARTY_LYRIC_CHANNEL.containsMatchIn(targetClean)) return true
    if (candClean.isEmpty()) return false
    val normCand = PUNCT_REGEX.replace(candClean, " ").replace(WHITESPACE, " ").trim()
    val normTarget = PUNCT_REGEX.replace(targetClean, " ").replace(WHITESPACE, " ").trim()
    if (normCand == normTarget) return true
    if ((normTarget.length >= 4 && normCand.contains(normTarget)) ||
        (normCand.length >= 4 && normTarget.contains(normCand))
    ) {
        return true
    }
    val candParts = candClean.split(MULTI_ARTIST_SPLIT).map {
        PUNCT_REGEX.replace(it, " ").replace(WHITESPACE, " ").trim()
    }.filter { it.isNotEmpty() }
    val targetParts = targetClean.split(MULTI_ARTIST_SPLIT).map {
        PUNCT_REGEX.replace(it, " ").replace(WHITESPACE, " ").trim()
    }.filter { it.isNotEmpty() }
    return candParts.any { cp -> targetParts.any { tp -> cp == tp || (cp.length >= 4 && tp.contains(cp)) || (tp.length >= 4 && cp.contains(tp)) } }
}

/** Extracts the primary billed artist for fallback lookups on multi-artist credits. */
internal fun leadLyricsArtist(raw: String): String {
    val clean = raw.artistForLyricsSearch().trim()
    if (clean.isEmpty()) return ""
    return clean.split(MULTI_ARTIST_SPLIT)
        .map { it.trim() }
        .firstOrNull { it.isNotEmpty() }
        ?: clean
}

/** Rejects remix/live/cover/sped-up/slowed variants when the listener is playing the studio version (and vice versa). */
internal fun isLyricsVersionCompatible(targetTitle: String, candidateTitle: String): Boolean {
    val tLower = targetTitle.lowercase()
    val cLower = candidateTitle.lowercase()
    for (tag in VERSION_MODIFIERS) {
        val word = Regex("""\b${Regex.escape(tag)}\b""")
        val targetHas = word.containsMatchIn(tLower)
        val candHas = word.containsMatchIn(cLower)
        if (candHas != targetHas && !(tag == "mix" && Regex("""\bremix\b""").containsMatchIn(tLower))) {
            return false
        }
    }
    return true
}

internal fun isGeniusNonLyricsText(title: String, artist: String): Boolean =
    NON_LYRICS_GENIUS_PAGE.containsMatchIn(title) || NON_LYRICS_GENIUS_PAGE.containsMatchIn(artist)

private val WHITESPACE = Regex("""\s+""")

private val CREDITS = listOf(
    // Bracketed credits: (feat. X), [ft. X], (with X).
    Regex("""\s*[(\[]\s*(feat|ft|featuring|with)\b[^)\]]*[)\]]""", RegexOption.IGNORE_CASE),
    // The same, unbracketed and running to the end of the title.
    Regex("""\s+(feat|ft|featuring)\.?\s+.*$""", RegexOption.IGNORE_CASE),
    // How the upload was labelled, not what was recorded.
    Regex(
        """\s*[(\[]\s*(official\s*)?(music\s*)?""" +
            """(video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m/?v|hd|hq|4k|full\s*song)""" +
            """\s*[)\]]""",
        RegexOption.IGNORE_CASE,
    ),
    Regex("""\s*[(\[]\s*official\s*[)\]]""", RegexOption.IGNORE_CASE),
)
