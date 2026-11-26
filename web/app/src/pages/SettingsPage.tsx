import { ChevronRight, Users } from 'lucide-react';
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { MdOutlineExtension } from 'react-icons/md';
import { SiApplemusic, SiDiscord, SiSpotify, SiYoutubemusic } from 'react-icons/si';
import { PageHeader } from '@/components/PageHeader';
import { PrefetchLink } from '@/components/PrefetchLink';
import { useDiscord } from '@/extension/useDiscord';
import { useExtension } from '@/extension/useExtension';
import { useYtAuth } from '@/extension/useYtAuth';
import { useParty } from '@/party/useParty';
import { useHistorySettings } from '@/playback/historyReporting';
import { Select } from '@/components/Select';
import { AUTOMIX_BARS } from '@/playback/automix/choices';
import {
  AUDIO_QUALITY_OPTIONS,
  audioQualityOption,
  browserSupportsDolbyAtmos,
  isDolbyCodec,
  type AudioQualityTier,
} from '@/playback/audioQuality';
import { useSleepTimer } from '@/playback/sleepTimer';
import { CROSSFADE_CHOICES, usePlayer } from '@/state/player';
import { SleepTimerSettingsRowStatus } from '@/shell/SleepTimerMenu';
import { AppleMusicIntegration, AppleMusicToggles, CanvasToggle, DiscordIntegration, LyricSourcesAccess, SpotifyIntegration, Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

const LyricsSettings = lazy(() => import('@/shell/LyricsSettings').then((m) => ({ default: m.LyricsSettings })));

/** An integration's coloured glyph, as on the Extension page. */
function Glyph({ Icon, color, ink }: { Icon: ComponentType<{ size?: number }>; color: string; ink?: string }) {
  return (
    <span className={settingsUi.integrationIcon} style={{ backgroundColor: color, ...(ink && { color: ink }) }}>
      <Icon size={15} />
    </span>
  );
}

/** A row that opens a page of its own. */
function LinkRow({ to, icon, title, value }: { to: string; icon?: ReactNode; title: string; value?: string | null }) {
  return (
    <PrefetchLink to={to} className={`${icon ? settingsUi.integration : settingsUi.integrationPlain} ${settingsUi.linkRow}`}>
      {icon}
      <span className={settingsUi.integrationName}>{title}</span>
      <span className={settingsUi.value}>
        {value}
        <ChevronRight size={16} />
      </span>
    </PrefetchLink>
  );
}

function youtubeText(auth: ReturnType<typeof useYtAuth>): string {
  if (auth.state === 'checking') return 'Checking…';
  if (auth.state === 'unavailable') return 'Needs the extension';
  const { browserSignedIn, connected, active } = auth.auth;
  if (!browserSignedIn) return 'Not signed in';
  if (!connected) return 'Disconnected';
  return active ? active.name : 'Signed in';
}

/**
 * Settings (SettingsSheet on the phone): the account and its integrations,
 * Listen Together, playback and lyrics, in the same grouped rows.
 */
export default function SettingsPage() {
  const extension = useExtension();
  const yt = useYtAuth();
  const discord = useDiscord();
  const party = useParty();
  const autoplay = usePlayer((s) => s.autoplay);
  const crossfadeSec = usePlayer((s) => s.crossfadeSec);
  const automix = usePlayer((s) => s.automix);
  const automixBars = usePlayer((s) => s.automixBars);
  const showNerdStats = usePlayer((s) => s.showNerdStats);
  const audioQuality = usePlayer((s) => s.audioQuality);
  const dolbyAtmos = usePlayer((s) => s.dolbyAtmos);
  const spatialAudio = usePlayer((s) => s.spatialAudio);
  const playingStream = usePlayer((s) => s.nowPlaying?.stream);
  const sleepFadeOut = useSleepTimer((s) => s.fadeOut);
  const sleepAfterTrack = useSleepTimer((s) => s.afterTrack);
  const sleepMinutes = useSleepTimer((s) => s.minutes);
  const { start: startSleepTimer, startAfterTrack: startSleepAfterTrack, cancel: cancelSleepTimer, setFadeOut: setSleepFadeOut } =
    useSleepTimer.getState();
  const sleepStatus = SleepTimerSettingsRowStatus();
  const shareHistory = useHistorySettings((s) => s.share);
  const setShareHistory = useHistorySettings((s) => s.setShare);
  const { setAutoplay, setCrossfade, setAutomix, setAutomixBars, setShowNerdStats, setAudioQuality, setDolbyAtmos, setSpatialAudio } =
    usePlayer.getState();
  const atmosSupport = browserSupportsDolbyAtmos();
  const playingNativeAtmos = isDolbyCodec(playingStream?.codec, playingStream?.channels);
  const selectedQualityInfo = audioQualityOption(audioQuality);
  const [lyrics, setLyrics] = useState(false);
  const present = extension.state === 'present';
  const discordText =
    discord.state === 'ready' && discord.discord.connected
      ? discord.discord.enabled
        ? 'On'
        : 'Off'
      : discord.state === 'ready' && discord.discord.available
        ? 'Not connected'
        : null;

  return (
    <div className={settingsUi.centered}>
      <PageHeader title="Settings" />
      <div className={settingsUi.body}>
        <h2 className={settingsUi.sectionHeader}>Account & Integrations</h2>
        <section className={settingsUi.group}>
          <div className={settingsUi.integration}>
            <Glyph Icon={SiYoutubemusic} color="#ffffff" ink="#ff0033" />
            <span className={settingsUi.integrationName}>YouTube Music</span>
            <span className={settingsUi.value}>{youtubeText(yt)}</span>
          </div>
          <div className={settingsUi.integration}>
            <Glyph Icon={SiSpotify} color="#1ed760" />
            <span className={settingsUi.integrationName}>Spotify</span>
            {present ? <SpotifyIntegration /> : <span className={settingsUi.value}>Needs the extension</span>}
          </div>
          {present && discord.state === 'ready' && discord.discord.available && (
            <LinkRow to="/settings/discord" icon={<Glyph Icon={SiDiscord} color="#5865f2" />} title="Discord" value={discordText} />
          )}
          <LinkRow
            to="/extension"
            icon={<Glyph Icon={MdOutlineExtension} color="#636366" />}
            title="Niko Music Extension"
            value={present ? `v${extension.extension.info.version}` : 'Not installed'}
          />
        </section>
        <section className={`${settingsUi.group} mt-3 empty:hidden`}>
          <Toggle
            label="Share Listening Activity to YouTube"
            detail={
              present && !extension.extension.info.capabilities.includes('yt.stats')
                ? 'Update the Niko Music extension to share: this version can’t send plays to YouTube.'
                : 'Songs you play here go to your YouTube Music history and shape its recommendations.'
            }
            checked={shareHistory}
            onChange={setShareHistory}
          />
          <CanvasToggle />
        </section>

        <h2 className={settingsUi.sectionHeader}>Apple Music</h2>
        <section className={settingsUi.group}>
          <div className={settingsUi.integration}>
            <Glyph Icon={SiApplemusic} color="#fa2d48" />
            <span className={settingsUi.integrationName}>Extension Access</span>
            {present ? <AppleMusicIntegration /> : <span className={settingsUi.value}>Needs the extension</span>}
          </div>
          <AppleMusicToggles />
        </section>
        <p className={settingsUi.footer}>From Apple Music’s public pages. No Apple Music account or sign-in needed.</p>

        <h2 className={settingsUi.sectionHeader}>Listen Together</h2>
        <section className={settingsUi.group}>
          <LinkRow
            to="/settings/listen-together"
            icon={<Glyph Icon={Users} color="#1db954" />}
            title="Listen Together"
            value={party.code ? `In party ${party.code}` : 'Listen in sync with friends'}
          />
        </section>

        <h2 className={settingsUi.sectionHeader}>Audio Quality</h2>
        <section className={settingsUi.group}>
          <label className={settingsUi.controlRow}>
            <span>Streaming Quality</span>
            <Select<AudioQualityTier>
              label="Streaming Quality"
              value={audioQuality}
              options={AUDIO_QUALITY_OPTIONS.map((q) => ({ value: q.id, label: `${q.label} (${q.hourly})` }))}
              onChange={setAudioQuality}
            />
          </label>
          <Toggle
            label="Dolby Atmos"
            detail={
              atmosSupport.eac3 || atmosSupport.ac3
                ? 'Prefer the immersive E-AC-3 surround mix when supported by the track.'
                : 'Prefers surround streams when available; this browser currently decodes stereo Opus/AAC.'
            }
            checked={dolbyAtmos}
            onChange={setDolbyAtmos}
          />
        </section>
        <p className={settingsUi.footer}>{selectedQualityInfo.detail}. Changes apply cleanly from the next track.</p>

        <h2 className={settingsUi.sectionHeader}>Playback</h2>
        <section className={settingsUi.group}>
          <Toggle
            label="AutoPlay"
            detail="When the queue ends, keep playing similar music."
            checked={autoplay}
            onChange={setAutoplay}
          />
          <Toggle
            label="Spatial Audio"
            detail={
              playingNativeAtmos
                ? 'Paused for this track — native Dolby Atmos surround is already active.'
                : 'Widens stereo soundstage with subtle binaural acoustic crossfeed DSP.'
            }
            checked={spatialAudio}
            onChange={setSpatialAudio}
          />
          <label className={settingsUi.controlRow}>
            <span>Sleep Timer</span>
            <Select<string>
              label="Sleep Timer"
              value={sleepAfterTrack ? 'end' : sleepMinutes !== null ? String(sleepMinutes) : 'off'}
              options={[
                { value: 'off', label: sleepStatus === 'Off' ? 'Off' : `Cancel (${sleepStatus})` },
                { value: 'end', label: 'End of Current Track' },
                { value: '15', label: '15 minutes' },
                { value: '30', label: '30 minutes' },
                { value: '45', label: '45 minutes' },
                { value: '60', label: '60 minutes' },
              ]}
              onChange={(val) => {
                if (val === 'off') cancelSleepTimer();
                else if (val === 'end') startSleepAfterTrack();
                else startSleepTimer(Number(val));
              }}
            />
          </label>
          <Toggle
            label="Sleep Timer Fade Out"
            detail="Smoothly fade volume out over the final 30 seconds before pausing."
            checked={sleepFadeOut}
            onChange={setSleepFadeOut}
          />
          <Toggle
            label="AutoMix"
            detail="Beat-matched, phrase-aligned DJ transitions with smooth visual blends."
            checked={automix}
            onChange={setAutomix}
          />
          {automix ? (
            <label className={settingsUi.controlRow}>
              <span>AutoMix Blend Length</span>
              <Select
                label="AutoMix Blend Length"
                value={automixBars}
                options={AUTOMIX_BARS.map((bars) => ({ value: bars, label: `Up to ${bars} bars` }))}
                onChange={setAutomixBars}
              />
            </label>
          ) : (
            <label className={settingsUi.controlRow}>
              <span>Crossfade</span>
              <Select<number>
                label="Crossfade"
                value={crossfadeSec}
                options={CROSSFADE_CHOICES.map((seconds) => ({ value: seconds, label: seconds === 0 ? 'Off' : `${seconds} seconds` }))}
                onChange={setCrossfade}
              />
            </label>
          )}
          <Toggle
            label="Show Stats for Nerds"
            detail="Codec, bitrate and sample rate under the artist in the full-screen player, and what Automix is doing."
            checked={showNerdStats}
            onChange={setShowNerdStats}
          />
        </section>
        {automix && (
          <p className={settingsUi.footer}>
            Automix finds each song’s tempo, key and phrases, then blends on the beat: the next song is time-stretched to match, and
            the bass swaps over halfway. Where it can, it loops a few instrumental bars of each song and ramps the tempo between
            them. Songs it can’t read in time play to the end and crossfade. Based on AutoMix by David Finnegan (AGPL-3.0).
          </p>
        )}

        <h2 className={settingsUi.sectionHeader}>Lyrics</h2>
        <section className={settingsUi.group}>
          <button className={`${settingsUi.integrationPlain} ${settingsUi.linkRow}`} onClick={() => setLyrics(true)}>
            <span className={settingsUi.integrationName}>Lyric Sources</span>
            <span className={settingsUi.value}>
              Order, sources, syllable timing
              <ChevronRight size={16} />
            </span>
          </button>
          <div className={settingsUi.integrationPlain}>
            <span className={settingsUi.integrationName}>Lyric Sources Access</span>
            {present ? <LyricSourcesAccess /> : <span className={settingsUi.value}>Needs the extension</span>}
          </div>
        </section>
      </div>
      {lyrics && (
        <Suspense fallback={null}>
          <LyricsSettings onClose={() => setLyrics(false)} />
        </Suspense>
      )}
    </div>
  );
}
