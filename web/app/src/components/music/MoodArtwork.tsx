import { LogoMark } from '@/components/icons/LogoMark';
import type { MoodId } from '@/data/music/recommendations';

export interface MoodVisual {
  bg: string;
  bgInner: string;
  stroke: string;
}

export const MOOD_VISUALS: Record<MoodId, MoodVisual> = {
  love: { bg: '#f33d93', bgInner: '#ff69b0', stroke: '#ffd6ec' },
  sad: { bg: '#213ab5', bgInner: '#2e52db', stroke: '#7dd3fc' },
  energy: { bg: '#16b534', bgInner: '#24d946', stroke: '#e0ffa1' },
  chill: { bg: '#199fe3', bgInner: '#3cc0ff', stroke: '#ccf2ff' },
  focus: { bg: '#ef7d00', bgInner: '#ffa024', stroke: '#ffe3ba' },
  party: { bg: '#c9207b', bgInner: '#eb3d9b', stroke: '#ffc7e6' },
  happy: { bg: '#eb9d00', bgInner: '#ffbf24', stroke: '#fff7ad' },
  'late-night': { bg: '#371e7d', bgInner: '#5232ab', stroke: '#d2c7ff' },
  'road-trip': { bg: '#11805b', bgInner: '#1aad7c', stroke: '#b5f7dc' },
  nostalgia: { bg: '#c94c24', bgInner: '#e66c40', stroke: '#ffd6bf' },
  // Extended moods & everyday moments
  'feel-good': { bg: '#e83e7c', bgInner: '#ff669d', stroke: '#ffd6e6' },
  relax: { bg: '#179ce6', bgInner: '#3ebdff', stroke: '#bae6fd' },
  'feeling-blue': { bg: '#1d36b8', bgInner: '#2c4ee0', stroke: '#7dd3fc' },
  heartbreak: { bg: '#e5311c', bgInner: '#ff523d', stroke: '#ffd2cc' },
  'after-hours': { bg: '#381e78', bgInner: '#5230a8', stroke: '#d8c9ff' },
  'alone-time': { bg: '#286c8c', bgInner: '#3c91b8', stroke: '#bae6fd' },
  commuting: { bg: '#14825c', bgInner: '#22ab7b', stroke: '#b5f7dc' },
  'eating-cooking': { bg: '#d65e18', bgInner: '#f07c37', stroke: '#fed7aa' },
  evening: { bg: '#28388a', bgInner: '#3d53bd', stroke: '#c7d2fe' },
  fitness: { bg: '#7da310', bgInner: '#9ec91c', stroke: '#ecfccb' },
  gaming: { bg: '#1f9626', bgInner: '#32ba3a', stroke: '#bbf7d0' },
  home: { bg: '#0c8568', bgInner: '#16ad88', stroke: '#a7f3d0' },
  morning: { bg: '#eb8613', bgInner: '#ffa438', stroke: '#fef08a' },
  motivation: { bg: '#bd1a46', bgInner: '#e02d5e', stroke: '#fecdd3' },
  outdoors: { bg: '#48851a', bgInner: '#63ad2a', stroke: '#d9f99d' },
  sleep: { bg: '#22226b', bgInner: '#363694', stroke: '#c7d2fe' },
  social: { bg: '#de4a75', bgInner: '#f76c94', stroke: '#fbcfe8' },
  sports: { bg: '#1967cc', bgInner: '#2d84f0', stroke: '#bfdbfe' },
  summertime: { bg: '#f28200', bgInner: '#ffa22b', stroke: '#fef08a' },
  holiday: { bg: '#c22323', bgInner: '#e33b3b', stroke: '#fecaca' },
  weekend: { bg: '#7638bf', bgInner: '#9554e3', stroke: '#e9d5ff' },
  wellbeing: { bg: '#2fa384', bgInner: '#47c4a2', stroke: '#a7f3d0' },
  work: { bg: '#375cc4', bgInner: '#4f78e8', stroke: '#c7d2fe' },
};

function BrandCorner() {
  return (
    <span className="pointer-events-none absolute top-2.5 right-2.5 z-2 flex items-center gap-1 text-[11px] font-semibold tracking-tight text-white/90 drop-shadow-xs select-none">
      <LogoMark size={13} />
      <span>Music</span>
    </span>
  );
}

/**
 * Custom single-stroke geometric line-art artwork for Niko's 10 core moods.
 * Original vector motifs styled cleanly on bold vibrant square plates.
 */
export function MoodVectorArt({ moodId }: { moodId: MoodId }) {
  const v = MOOD_VISUALS[moodId];
  return (
    <div
      className="relative aspect-square w-full overflow-hidden rounded-artwork-md"
      style={{
        background: `radial-gradient(circle at 50% 42%, ${v.bgInner} 0%, ${v.bg} 78%)`,
        color: v.stroke,
      }}
    >
      <BrandCorner />
      <svg
        viewBox="0 0 120 120"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-full w-full p-3.5 transition-transform duration-300 ease-out group-hover/card:scale-[1.04]"
      >
        {renderMoodGlyph(moodId)}
      </svg>
    </div>
  );
}

/** Reusable SVG glyph path set for Niko's 10 custom mood icons. */
export function MoodGlyphSvg({
  moodId,
  className,
  strokeWidth = 3.2,
}: {
  moodId: MoodId;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {renderMoodGlyph(moodId)}
    </svg>
  );
}

function renderMoodGlyph(moodId: MoodId) {
  switch (moodId) {
    case 'love':
      // Twin-petal geometric heart framing an inner acoustic pulse line
      return (
        <>
          <path d="M60 98 C34 80 18 62 18 42 C18 28 29 19 42 19 C51 19 57 24 60 31 C63 24 69 19 78 19 C91 19 102 28 102 42 C102 62 86 80 60 98 Z" />
          <path d="M35 52 H46 L52 40 L59 64 L66 47 L71 52 H85" opacity="0.88" />
        </>
      );
    case 'sad':
      // Raindrop prism with drifting horizon waves & tear accents
      return (
        <>
          <path d="M60 16 C60 16 88 50 88 70 C88 86 75.5 98 60 98 C44.5 98 32 86 32 70 C32 50 60 16 60 16 Z" />
          <path d="M44 69 Q52 63 60 69 T76 69" opacity="0.85" />
          <path d="M47 81 Q54 76 60 81 T73 81" opacity="0.6" />
          <line x1="23" y1="30" x2="18" y2="41" opacity="0.7" />
          <line x1="97" y1="33" x2="92" y2="44" opacity="0.7" />
        </>
      );
    case 'energy':
      // Signature high-voltage bolt flanked by kinetic velocity rays
      return (
        <>
          <polygon points="68,14 27,63 57,63 50,106 93,55 62,55" />
          <line x1="21" y1="28" x2="33" y2="28" opacity="0.7" />
          <line x1="17" y1="42" x2="27" y2="42" opacity="0.55" />
          <line x1="90" y1="78" x2="103" y2="78" opacity="0.7" />
          <line x1="84" y1="90" x2="95" y2="90" opacity="0.55" />
        </>
      );
    case 'chill':
      // Smooth parallel horizon frequency waves under a still crescent dot
      return (
        <>
          <circle cx="84" cy="28" r="7" />
          <path d="M16 50 Q31 39 46 50 T76 50 T104 50" />
          <path d="M16 68 Q31 57 46 68 T76 68 T104 68" opacity="0.88" />
          <path d="M16 86 Q31 75 46 86 T76 86 T104 86" opacity="0.7" />
        </>
      );
    case 'focus':
      // Precision acoustic aperture: nested concentric rings around a crisp diamond core
      return (
        <>
          <circle cx="60" cy="60" r="41" />
          <circle cx="60" cy="60" r="28" opacity="0.88" />
          <circle cx="60" cy="60" r="15" opacity="0.76" />
          <polygon points="60,52 67,60 60,68 53,60" />
        </>
      );
    case 'party':
      // Geometric disco diamond starburst & orbiting confetti arcs
      return (
        <>
          <path d="M60 18 L68 46 L96 54 L68 62 L60 90 L52 62 L24 54 L52 46 Z" />
          <path d="M24 26 L31 33 M93 26 L86 33 M28 89 L35 82 M92 87 L85 80" />
          <circle cx="24" cy="72" r="4.5" />
          <circle cx="96" cy="40" r="4.5" />
          <circle cx="77" cy="96" r="4" />
        </>
      );
    case 'happy':
      // Buoyant geometric sun bloom with uplifting arc smile
      return (
        <>
          <circle cx="60" cy="56" r="22" />
          <path d="M49 58 Q60 69 71 58" />
          <line x1="60" y1="16" x2="60" y2="25" />
          <line x1="60" y1="87" x2="60" y2="96" />
          <line x1="20" y1="56" x2="29" y2="56" />
          <line x1="91" y1="56" x2="100" y2="56" />
          <line x1="32" y1="28" x2="38" y2="34" />
          <line x1="82" y1="78" x2="88" y2="84" />
          <line x1="88" y1="28" x2="82" y2="34" />
          <line x1="38" y1="78" x2="32" y2="84" />
        </>
      );
    case 'late-night':
      // Nocturnal crescent horizon with twinkling stars & slow diagonal rain trails
      return (
        <>
          <path d="M67 24 A28 28 0 1 0 92 78 A22 22 0 1 1 67 24 Z" />
          <path d="M84 30 L86 36 L92 38 L86 40 L84 46 L82 40 L76 38 L82 36 Z" />
          <line x1="26" y1="84" x2="20" y2="98" opacity="0.7" />
          <line x1="48" y1="88" x2="42" y2="102" opacity="0.55" />
          <line x1="72" y1="88" x2="66" y2="100" opacity="0.7" />
        </>
      );
    case 'road-trip':
      // Open-highway perspective lines rushing toward a sunset horizon crest
      return (
        <>
          <line x1="14" y1="42" x2="106" y2="42" />
          <path d="M40 42 A20 20 0 0 1 80 42" />
          <line x1="16" y1="100" x2="48" y2="42" />
          <line x1="104" y1="100" x2="72" y2="42" />
          <line x1="60" y1="50" x2="60" y2="59" />
          <line x1="60" y1="68" x2="60" y2="79" />
          <line x1="60" y1="88" x2="60" y2="100" />
        </>
      );
    case 'nostalgia':
      // Warm analog vinyl disc grooves with angled turntable stylus arm
      return (
        <>
          <circle cx="56" cy="62" r="37" />
          <circle cx="56" cy="62" r="14" />
          <circle cx="56" cy="62" r="3.5" fill="currentColor" stroke="none" />
          <path d="M31 62 A25 25 0 0 1 56 37" opacity="0.7" />
          <path d="M81 62 A25 25 0 0 1 56 87" opacity="0.7" />
          <circle cx="95" cy="24" r="5" />
          <polyline points="95,29 93,60 76,77" />
        </>
      );
    case 'feel-good':
      // Uplifted radiant rainbow bridge & cheerful glow arc
      return (
        <>
          <path d="M22 76 A38 38 0 0 1 98 76" />
          <path d="M34 76 A26 26 0 0 1 86 76" />
          <path d="M46 76 A14 14 0 0 1 74 76" />
          <path d="M44 86 C52 94, 68 94, 76 86" />
        </>
      );
    case 'relax':
      // Three balanced zen stone ellipses stacked lightly
      return (
        <>
          <ellipse cx="60" cy="30" rx="18" ry="11" />
          <ellipse cx="60" cy="56" rx="28" ry="14" />
          <ellipse cx="60" cy="86" rx="38" ry="16" />
        </>
      );
    case 'feeling-blue':
      // Original descending blue cyclone spiral
      return (
        <>
          <ellipse cx="60" cy="32" rx="34" ry="11" />
          <ellipse cx="60" cy="50" rx="27" ry="9" />
          <ellipse cx="60" cy="67" rx="20" ry="7.5" />
          <ellipse cx="60" cy="82" rx="13" ry="5.5" />
          <path d="M53 93 Q60 99 67 93" />
        </>
      );
    case 'heartbreak':
      // Dashed fragile heart outline
      return (
        <path
          d="M60 94 C60 94 20 68 20 43 C20 29 31 20 43 20 C51 20 57 25 60 31 C63 25 69 20 77 20 C89 20 100 29 100 43 C100 68 60 94 60 94 Z"
          strokeDasharray="9 7"
        />
      );
    case 'after-hours':
      // Crescent moon beside quiet late-night city skyline towers
      return (
        <>
          <path d="M38 22 A15 15 0 1 0 54 44 A11 11 0 1 1 38 22 Z" />
          <polyline points="22,94 22,64 38,64 38,94" />
          <polyline points="44,94 44,50 64,50 64,94" />
          <polyline points="70,94 70,38 94,38 94,94" />
          <line x1="16" y1="94" x2="104" y2="94" />
        </>
      );
    case 'alone-time':
      // Minimal quiet window arch framing a calm star & horizon
      return (
        <>
          <path d="M32 94 L32 54 A28 28 0 0 1 88 54 L88 94 Z" />
          <line x1="32" y1="74" x2="88" y2="74" />
          <line x1="60" y1="54" x2="60" y2="94" />
          <circle cx="60" cy="40" r="3" fill="currentColor" stroke="none" />
        </>
      );
    case 'commuting':
      // Sweeping transit route S-curve with origin and destination rings
      return (
        <>
          <circle cx="30" cy="86" r="8" />
          <circle cx="90" cy="34" r="8" />
          <path d="M38 86 C72 86, 48 34, 82 34" />
          <line x1="22" y1="30" x2="54" y2="30" opacity="0.65" />
          <line x1="66" y1="90" x2="98" y2="90" opacity="0.65" />
        </>
      );
    case 'eating-cooking':
      // Deep soup bowl & rising organic steam wisps
      return (
        <>
          <path d="M24 58 L96 58 C96 82 78 94 60 94 C42 94 24 82 24 58 Z" />
          <line x1="44" y1="94" x2="76" y2="94" />
          <path d="M44 46 Q39 36 45 26" />
          <path d="M60 44 Q55 33 61 22" />
          <path d="M76 46 Q71 36 77 26" />
        </>
      );
    case 'evening':
      // Dusk dome setting behind soft twilight ripples
      return (
        <>
          <path d="M34 64 A26 26 0 0 1 86 64" />
          <line x1="18" y1="64" x2="102" y2="64" />
          <line x1="28" y1="78" x2="92" y2="78" />
          <line x1="40" y1="92" x2="80" y2="92" />
          <circle cx="88" cy="30" r="3" fill="currentColor" stroke="none" />
        </>
      );
    case 'fitness':
      // Geometric paired weight plates & kinetic tempo bar
      return (
        <>
          <rect x="20" y="42" width="12" height="36" rx="4" />
          <rect x="34" y="34" width="10" height="52" rx="4" />
          <line x1="44" y1="60" x2="76" y2="60" />
          <rect x="76" y="34" width="10" height="52" rx="4" />
          <rect x="88" y="42" width="12" height="36" rx="4" />
        </>
      );
    case 'gaming':
      // Minimal D-pad & dual action button console contour
      return (
        <>
          <rect x="18" y="36" width="84" height="48" rx="22" />
          <line x1="36" y1="52" x2="36" y2="68" />
          <line x1="28" y1="60" x2="44" y2="60" />
          <circle cx="76" cy="55" r="3.5" fill="currentColor" stroke="none" />
          <circle cx="87" cy="65" r="3.5" fill="currentColor" stroke="none" />
        </>
      );
    case 'home':
      // Open geometric house silhouette with warm inner hearth frame
      return (
        <>
          <polyline points="20,56 60,24 100,56" />
          <polyline points="30,50 30,94 90,94 90,50" />
          <rect x="50" y="64" width="20" height="30" rx="2" />
        </>
      );
    case 'morning':
      // Rising dawn sun crest above calm morning line with geometric beams
      return (
        <>
          <path d="M36 74 A24 24 0 0 1 84 74" />
          <line x1="18" y1="74" x2="102" y2="74" />
          <line x1="28" y1="88" x2="92" y2="88" opacity="0.65" />
          <line x1="60" y1="24" x2="60" y2="38" />
          <line x1="32" y1="36" x2="41" y2="45" />
          <line x1="88" y1="36" x2="79" y2="45" />
        </>
      );
    case 'motivation':
      // Rising double summit chevrons pushing upward
      return (
        <>
          <polyline points="22,86 48,50 68,70 96,30" />
          <polyline points="78,30 96,30 96,48" />
          <line x1="22" y1="96" x2="98" y2="96" opacity="0.6" />
        </>
      );
    case 'outdoors':
      // Crisp overlapping mountain ridge & pine crest
      return (
        <>
          <polygon points="18,90 48,34 78,90" />
          <polyline points="62,64 78,44 102,90 78,90" />
          <circle cx="84" cy="28" r="7" />
        </>
      );
    case 'sleep':
      // Closed peaceful lashes arc & quiet night diamonds
      return (
        <>
          <path d="M24 58 C38 74, 82 74, 96 58" />
          <line x1="36" y1="70" x2="32" y2="82" />
          <line x1="60" y1="74" x2="60" y2="88" />
          <line x1="84" y1="70" x2="88" y2="82" />
          <path d="M78 24 L80 30 L86 32 L80 34 L78 40 L76 34 L70 32 L76 30 Z" strokeWidth="3.5" />
        </>
      );
    case 'social':
      // Interlocking shared circles representing togetherness
      return (
        <>
          <circle cx="46" cy="60" r="24" />
          <circle cx="74" cy="60" r="24" />
          <path d="M48 24 Q60 16 72 24" opacity="0.75" />
          <path d="M48 96 Q60 104 72 96" opacity="0.75" />
        </>
      );
    case 'sports':
      // Minimal geometric champion chalice contour
      return (
        <>
          <path d="M38 26 L82 26 L80 54 C79 68 70 76 60 76 C50 76 41 68 40 54 Z" />
          <path d="M38 32 L24 32 L24 44 C24 52 31 56 40 56" />
          <path d="M82 32 L96 32 L96 44 C96 52 89 56 80 56" />
          <line x1="60" y1="76" x2="60" y2="94" />
          <line x1="42" y1="94" x2="78" y2="94" />
        </>
      );
    case 'summertime':
      // Bright sun disc dipping above lively coastal waves
      return (
        <>
          <circle cx="60" cy="44" r="19" />
          <path d="M20 76 Q30 66 40 76 T60 76 T80 76 T100 76" />
          <path d="M20 92 Q30 82 40 92 T60 92 T80 92 T100 92" />
        </>
      );
    case 'holiday':
      // Crisp crystalline 6-axis winter star
      return (
        <>
          <line x1="60" y1="18" x2="60" y2="102" />
          <line x1="24" y1="39" x2="96" y2="81" />
          <line x1="96" y1="39" x2="24" y2="81" />
          <circle cx="60" cy="60" r="14" />
        </>
      );
    case 'weekend':
      // Open breezeway sail / kite diamond with joyful streamers
      return (
        <>
          <polygon points="60,20 94,52 60,84 26,52" />
          <line x1="60" y1="20" x2="60" y2="84" />
          <path d="M60 84 Q74 94 56 102" />
        </>
      );
    case 'wellbeing':
      // Symmetrical breathing lotus petals
      return (
        <>
          <path d="M60 22 C74 42, 74 68, 60 88 C46 68, 46 42, 60 22 Z" />
          <path d="M26 48 C44 48, 56 62, 58 86 C38 82, 24 68, 26 48 Z" />
          <path d="M94 48 C76 48, 64 62, 62 86 C82 82, 96 68, 94 48 Z" />
          <line x1="28" y1="94" x2="92" y2="94" opacity="0.7" />
        </>
      );
    case 'work':
      // Clean geometric isometric cube for structured focus
      return (
        <>
          <polygon points="60,22 94,41 94,79 60,98 26,79 26,41" />
          <polyline points="26,41 60,60 94,41" />
          <line x1="60" y1="60" x2="60" y2="98" />
        </>
      );
  }
}
