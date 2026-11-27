package com.music.nikomusic.playback.smart

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SmartAutomixUpgradeTest {

    private fun track(
        id: String,
        bpm: Double,
        duration: Double = 200.0,
        confidence: Double = 0.9,
        key: String = "C major",
        vocal: Double = 0.05,
        energy: Double = 0.5,
    ): TrackAnalysis {
        val beat = 60.0 / bpm
        val beats = generateSequence(0.5) { it + beat }.takeWhile { it < duration - 0.5 }.toList()
        val downbeats = beats.filterIndexed { index, _ -> index % 4 == 0 }
        val vocalCurve = FloatArray(100) { vocal.toFloat() }
        val energySamples = (0..duration.toInt() step 2).map { EnergySample(it.toDouble(), energy) }
        return TrackAnalysis(
            trackId = id,
            status = TrackAnalysis.STATUS_READY,
            duration = duration,
            bpm = bpm,
            beatInterval = beat,
            beatConfidence = confidence,
            firstBeat = 0.5,
            downbeats = downbeats,
            key = key,
            keyConfidence = 0.9,
            energyCurve = energySamples,
            vocalWindows = listOf(CurveWindow(0.0, 0.5, vocalCurve)),
            contentEndTime = duration - 1.0,
        )
    }

    @Test
    fun zeroBeatConfidenceTrackDropsToPlainCrossfade() {
        val measured = track("a", 120.0, confidence = 0.9)
        val unmeasured = track("b", 120.0, confidence = 0.0)
        val verdict = assessTransitionTier(measured, unmeasured, advanced = false)
        assertEquals(TransitionTier.PLAIN_CROSSFADE, verdict.tier)
        assertTrue("beat-confidence" in verdict.reasons)
    }

    @Test
    fun shortMusicalInterludeUsesCompactCrossfadeWhileVeryShortIsBlocked() {
        val interlude = track("short", 120.0, duration = 26.0)
        val next = track("next", 122.0, duration = 180.0)
        val interludePlan = planTransition(
            analysis = interlude,
            nextAnalysis = next,
            currentTrack = TransitionTrackInfo(id = "short", duration = 26.0, title = "Interlude", artist = "A"),
            nextTrack = TransitionTrackInfo(id = "next", duration = 180.0, title = "Main", artist = "B"),
            duration = 26.0,
            mode = CrossfadeMode.SMART,
        )
        assertFalse(interludePlan.blocked)
        assertEquals(TransitionStyle.EQUAL_POWER, interludePlan.transitionStyle)
        assertTrue(interludePlan.fadeSeconds in 1.0..6.0)
        assertTrue(interludePlan.transitionStart >= 13.0)

        val skit = track("skit", 120.0, duration = 10.0)
        val skitPlan = planTransition(
            analysis = skit,
            nextAnalysis = next,
            currentTrack = TransitionTrackInfo(id = "skit", duration = 10.0, title = "Tag", artist = "A"),
            duration = 10.0,
            mode = CrossfadeMode.SMART,
        )
        assertTrue(skitPlan.blocked)
        assertEquals("short-duration-guard", skitPlan.reason)
    }

    @Test
    fun clampToMixWindowKeepsCueAndHandoffAligned() {
        val longIntroNext = track("in", 120.0, duration = 240.0).copy(
            mixInTime = 42.0,
            downbeats = (0..120).map { it * 2.0 },
        )
        val out = track("out", 120.0, duration = 200.0)
        val plan = planTransition(
            analysis = out,
            nextAnalysis = longIntroNext,
            currentTrack = TransitionTrackInfo(id = "out", duration = 200.0),
            nextTrack = TransitionTrackInfo(id = "in", duration = 240.0),
            duration = 200.0,
            mode = CrossfadeMode.SMART,
            mixWindow = true,
        )
        assertFalse(plan.blocked)
        assertTrue(plan.transitionStart >= 200.0 - 45.0)
        assertTrue(plan.incomingCueTime <= 45.0)
        assertTrue(plan.incomingHandoffTime >= plan.incomingCueTime)
    }

    @Test
    fun loopMixRejectsTooSteepTempoRampsAndSilentEnergyTails() {
        val out = track("out", 120.0, duration = 200.0, vocal = 0.02, energy = 0.5).copy(
            energyCurve = (0..200).map { sec ->
                EnergySample(sec.toDouble(), if (sec >= 182) 0.002 else 0.6)
            },
            contentEndTime = 182.0,
        )
        val inn = track("in", 120.0, duration = 180.0, vocal = 0.02, energy = 0.5)
        val plan = LoopMix.plan(out, 200.0, inn, 180.0, 0.0, emptyList(), emptyList())
        assertNotNull(plan)
        assertTrue(plan.out.loopEnd <= 182.5, "loop must stay out of silent outro tail")

        // 75 -> 139 BPM folds via half/double to 75 -> 69.5 (ok) or 140 -> 212? Let's use 140 -> 212 -> folded 140 -> 106 (34 BPM)
        // True steep folded gap: 100 -> 141 => folded 141/2=70.5 (29.5) or 180 -> 252 => folded 252/2=126 (54 BPM, 22 bars);
        // 190 -> 270 => min |270-190|=80, |135-190|=55, 55/2.5=22; use 200 -> 290 => 200 vs 290/2=145 (55), 220 -> 320 (220 vs 160 = 60 -> 24);
        // 230 -> 335 => |167.5 - 230| = 62.5 > 60 BPM (25 bars > MAX_RAMP_BARS = 24)
        val steepOut = track("steep-out", 230.0, duration = 200.0, vocal = 0.02)
        val steepIn = track("steep-in", 335.0, duration = 200.0, vocal = 0.02)
        assertNull(LoopMix.plan(steepOut, 200.0, steepIn, 200.0, 0.0, emptyList(), emptyList()))
    }
}
