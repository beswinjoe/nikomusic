import type { BrowsePage, MusicItem, Shelf, Track } from '@/data/music/types';
import type { TasteProfileData } from '@/data/music/tasteProfile';
import { artistLine, artistSet, isSameRecording, normalisedTitle } from '@/playback/queue/builder';

/**
 * Browser Recommendation & Mood Discovery engine — TypeScript counterpart to
 * `shared/src/commonMain/.../RecommendationEngine.kt`.
 *
 * Ranks candidate tracks & mood playlists using local taste signals, skip/repeat
 * fatigue, artist diversity caps, contradiction filtering, and cold-start safety.
 */

export type MoodId =
  | 'love'
  | 'sad'
  | 'energy'
  | 'chill'
  | 'focus'
  | 'party'
  | 'happy'
  | 'late-night'
  | 'road-trip'
  | 'nostalgia'
  | 'feel-good'
  | 'relax'
  | 'feeling-blue'
  | 'heartbreak'
  | 'after-hours'
  | 'alone-time'
  | 'commuting'
  | 'eating-cooking'
  | 'evening'
  | 'fitness'
  | 'gaming'
  | 'home'
  | 'morning'
  | 'motivation'
  | 'outdoors'
  | 'sleep'
  | 'social'
  | 'sports'
  | 'summertime'
  | 'holiday'
  | 'weekend'
  | 'wellbeing'
  | 'work';

export type CoreMoodId =
  | 'love'
  | 'sad'
  | 'energy'
  | 'chill'
  | 'focus'
  | 'party'
  | 'happy'
  | 'late-night'
  | 'road-trip'
  | 'nostalgia';

export type RankingMode = 'top-pick' | 'mood' | 'supermix' | 'discovery' | 'new-release';

export interface MoodDefinition {
  id: MoodId;
  title: string;
  tagline: string;
  /** YTM `FEmusic_moods_and_genres_category` params token. */
  params: string;
  /** Subtle gradient colors preserving Liquid Glass dark/light contrast. */
  accentFrom: string;
  accentTo: string;
  positiveKeywords: string[];
  preferredGenres: string[];
  contradictoryKeywords: string[];
  fallbackQueries: string[];
}

export const MOOD_CATEGORIES_BROWSE_ID = 'FEmusic_moods_and_genres_category';

const CONTRA_CALM = [
  'gym',
  'workout',
  'beast mode',
  'hardstyle',
  'earrape',
  'death metal',
  'thrash metal',
  'dubstep',
  'phonk',
  'pre-workout',
  'hiit',
  'cardio',
];

const CONTRA_HIGH_ENERGY = [
  'sleep',
  'white noise',
  'rain sounds',
  'asmr',
  'lullaby',
  'meditation',
  'guided sleep',
  'brown noise',
  'podcast',
];

export const CORE_MOODS: readonly MoodDefinition[] = [
  {
    id: 'love',
    title: 'Love',
    tagline: 'Romantic, soft & intimate songs.',
    params: 'ggMPOg1uX0FzQ2FhZWtUY211',
    accentFrom: '#f34ca0',
    accentTo: '#9e1c5e',
    positiveKeywords: ['love', 'romance', 'romantic', 'intimate', 'slow jam', 'r&b', 'soul', 'ballad', 'duet', 'tender'],
    preferredGenres: ['r&b', 'soul', 'pop', 'acoustic', 'singer-songwriter', 'jazz'],
    contradictoryKeywords: [...CONTRA_CALM, 'breakup', 'heartbreak', 'heartache', 'revenge', 'diss track', 'rage'],
    fallbackQueries: ['romantic love songs playlist', 'soft r&b love ballads'],
  },
  {
    id: 'sad',
    title: 'Sad',
    tagline: 'Heartbreak, lonely & emotional songs.',
    params: 'ggMPOg1uX0JLQ0gySWZKZVY1',
    accentFrom: '#2846b8',
    accentTo: '#162564',
    positiveKeywords: ['sad', 'heartbreak', 'breakup', 'melanchol', 'lonely', 'heartache', 'cry', 'tears', 'emotional', 'blue'],
    preferredGenres: ['indie', 'acoustic', 'emo', 'r&b', 'soul', 'singer-songwriter'],
    contradictoryKeywords: ['party', 'club', 'festival', 'workout', 'gym', 'hype', 'cheerful', 'happy', 'banger', 'hiit'],
    fallbackQueries: ['sad heartbreak songs playlist', 'melancholic emotional songs'],
  },
  {
    id: 'energy',
    title: 'Energy',
    tagline: 'Upbeat, workout & hype anthems.',
    params: 'ggMPOg1uX2lRZUZiMnNrQnJW',
    accentFrom: '#1ebd38',
    accentTo: '#0e6924',
    positiveKeywords: ['energy', 'energetic', 'workout', 'hype', 'pump', 'adrenaline', 'power', 'boost', 'upbeat', 'running', 'gym'],
    preferredGenres: ['hip-hop', 'rap', 'edm', 'electronic', 'rock', 'trap', 'phonk', 'drum and bass'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'heartbreak', 'crying', 'slow ambient', 'study piano', 'yoga'],
    fallbackQueries: ['high energy workout hype songs', 'upbeat energetic hits playlist'],
  },
  {
    id: 'chill',
    title: 'Chill',
    tagline: 'Relaxing, peaceful & mellow sounds.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#138a86',
    accentTo: '#0c4e59',
    positiveKeywords: ['chill', 'relax', 'unwind', 'peaceful', 'acoustic', 'mellow', 'laidback', 'laid-back', 'soft', 'lofi', 'sunset'],
    preferredGenres: ['chillout', 'lo-fi', 'indie', 'acoustic', 'dream pop', 'bossa nova', 'folk'],
    contradictoryKeywords: [...CONTRA_CALM, 'heavy metal', 'metalcore', 'drill', 'festival', 'club banger'],
    fallbackQueries: ['chill acoustic mellow songs playlist', 'laid back relaxing vibes'],
  },
  {
    id: 'focus',
    title: 'Focus',
    tagline: 'Instrumental, ambient & study flow.',
    params: 'ggMPOg1uX0NvNGNhWThMYWRh',
    accentFrom: '#f28400',
    accentTo: '#9e4700',
    positiveKeywords: ['focus', 'instrumental', 'ambient', 'concentration', 'study', 'deep focus', 'work', 'piano', 'classical', 'lofi'],
    preferredGenres: ['ambient', 'lo-fi', 'classical', 'instrumental', 'soundtrack', 'post-rock', 'jazz'],
    contradictoryKeywords: [...CONTRA_CALM, 'party', 'club', 'karaoke', 'live concert', 'festival', 'dj mix', 'podcast'],
    fallbackQueries: ['deep focus instrumental ambient music', 'lo-fi study instrumental focus'],
  },
  {
    id: 'party',
    title: 'Party',
    tagline: 'Dance, electronic, pop & club hits.',
    params: 'ggMPOg1uX0pmQ0s2V0JRclZs',
    accentFrom: '#c2287a',
    accentTo: '#6b124d',
    positiveKeywords: ['party', 'dance', 'club', 'electronic', 'pop', 'disco', 'remix', 'nightlife', 'banger', 'dj', 'festival', 'house'],
    preferredGenres: ['electronic', 'house', 'pop', 'edm', 'hip-hop', 'disco', 'reggaeton', 'afrobeats'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'sad', 'heartbreak', 'crying', 'melanchol', 'study', 'lofi'],
    fallbackQueries: ['party dance electronic pop hits playlist', 'club dancefloor hits'],
  },
  {
    id: 'happy',
    title: 'Happy',
    tagline: 'Cheerful, uplifting & feel-good tracks.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#f4ad0a',
    accentTo: '#b36b00',
    positiveKeywords: ['happy', 'feel good', 'feel-good', 'cheerful', 'uplifting', 'sunny', 'joy', 'good vibes', 'summer', 'funk'],
    preferredGenres: ['pop', 'funk', 'disco', 'indie pop', 'afrobeats', 'soul', 'synthpop'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'sad', 'heartbreak', 'breakup', 'depressing', 'lonely', 'grief', 'crying', 'death metal'],
    fallbackQueries: ['happy feel good uplifting songs', 'cheerful good vibes hits playlist'],
  },
  {
    id: 'late-night',
    title: 'Late Night',
    tagline: 'Atmospheric, dreamy & after-hours grooves.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#3a1f78',
    accentTo: '#1c103d',
    positiveKeywords: ['late night', 'after hours', 'midnight', 'dreamy', 'atmospheric', 'night drive', 'nocturnal', 'slow jam', 'moody', 'neon'],
    preferredGenres: ['r&b', 'dream pop', 'shoegaze', 'synthpop', 'lo-fi', 'downtempo', 'deep house', 'ambient'],
    contradictoryKeywords: ['morning workout', 'fitness', 'cardio', 'nursery', 'kids', 'hardstyle', 'pre-workout'],
    fallbackQueries: ['late night dreamy atmospheric r&b synth', 'midnight after hours drive music'],
  },
  {
    id: 'road-trip',
    title: 'Road Trip',
    tagline: 'Travel-friendly & sing-along favourites.',
    params: 'ggMPOg1uX044Z2o5WERLckpU',
    accentFrom: '#158c68',
    accentTo: '#0c4f3d',
    positiveKeywords: ['road trip', 'driving', 'drive', 'commute', 'highway', 'travel', 'cruise', 'sing-along', 'open road', 'car', 'anthem'],
    preferredGenres: ['pop', 'rock', 'indie rock', 'alternative', 'classic rock', 'synthpop', 'country'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'yoga', 'study focus'],
    fallbackQueries: ['road trip sing along driving songs', 'highway cruise hits playlist'],
  },
  {
    id: 'nostalgia',
    title: 'Nostalgia',
    tagline: 'Throwbacks, classics & old favourites.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#b8522e',
    accentTo: '#632613',
    positiveKeywords: ['nostalgia', 'nostalgic', 'throwback', 'classic', 'retro', '90s', '2000s', '80s', '00s', 'oldies', 'gold', 'rewind', 'timeless'],
    preferredGenres: ['rock', 'pop', 'r&b', 'hip-hop', 'soul', 'classic rock', 'motown', 'disco'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'hyperpop', 'phonk', 'study white noise'],
    fallbackQueries: ['90s 2000s throwback nostalgia classics', 'timeless retro old favourites playlist'],
  },
];

export const EXTENDED_MOODS: readonly MoodDefinition[] = [
  {
    id: 'feel-good',
    title: 'Feel Good',
    tagline: 'Bright, upbeat songs to lift the day.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#f2a900',
    accentTo: '#a86f00',
    positiveKeywords: ['feel good', 'feel-good', 'upbeat', 'sunny', 'cheerful', 'good vibes', 'happy'],
    preferredGenres: ['pop', 'funk', 'indie pop', 'soul', 'disco'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'sad', 'heartbreak', 'grief', 'funeral'],
    fallbackQueries: ['feel good upbeat songs playlist', 'good vibes pop hits'],
  },
  {
    id: 'relax',
    title: 'Relax',
    tagline: 'Easy, soothing sounds to slow things down.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#31aff3',
    accentTo: '#16659e',
    positiveKeywords: ['relax', 'unwind', 'peaceful', 'relaxing', 'laidback', 'easy', 'calm', 'acoustic'],
    preferredGenres: ['chillout', 'acoustic', 'ambient', 'folk', 'bossa nova'],
    contradictoryKeywords: CONTRA_CALM,
    fallbackQueries: ['relaxing peaceful chill songs playlist', 'unwind acoustic easy listening'],
  },
  {
    id: 'feeling-blue',
    title: 'Feeling Blue',
    tagline: 'Sad songs for when you need them.',
    params: 'ggMPOg1uX0JLQ0gySWZKZVY1',
    accentFrom: '#253ab2',
    accentTo: '#141f66',
    positiveKeywords: ['sad', 'melanchol', 'lonely', 'blue', 'down', 'rainy', 'tears'],
    preferredGenres: ['indie', 'singer-songwriter', 'acoustic', 'emo'],
    contradictoryKeywords: ['party', 'club', 'workout', 'gym', 'banger'],
    fallbackQueries: ['feeling blue melancholic sad songs', 'lonely acoustic sad playlist'],
  },
  {
    id: 'heartbreak',
    title: 'Heartbreak',
    tagline: 'Breakup anthems, one tear at a time.',
    params: 'ggMPOg1uX0JLQ0gySWZKZVY1',
    accentFrom: '#ea3520',
    accentTo: '#8f170b',
    positiveKeywords: ['heartbreak', 'breakup', 'break-up', 'broken', 'heartache', 'ex'],
    preferredGenres: ['pop', 'r&b', 'singer-songwriter', 'soul'],
    contradictoryKeywords: ['party', 'workout', 'gym', 'hiit', 'club banger'],
    fallbackQueries: ['heartbreak breakup songs playlist', 'emotional breakup ballads'],
  },
  {
    id: 'after-hours',
    title: 'After Hours',
    tagline: 'Late-night grooves for when the city goes quiet.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#3a1f78',
    accentTo: '#1b0d42',
    positiveKeywords: ['after hours', 'late night', 'midnight', 'slow jam', 'r&b', 'dark', 'moody'],
    preferredGenres: ['r&b', 'synthpop', 'downtempo', 'deep house', 'dream pop'],
    contradictoryKeywords: ['morning workout', 'nursery', 'pre-workout', 'march'],
    fallbackQueries: ['after hours late night r&b playlist', 'midnight city grooves'],
  },
  {
    id: 'alone-time',
    title: 'Alone Time',
    tagline: 'Mellow songs for time to yourself.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#2c6e8c',
    accentTo: '#153a4d',
    positiveKeywords: ['alone', 'solitude', 'quiet', 'introspective', 'mellow', 'unplug'],
    preferredGenres: ['indie', 'acoustic', 'lo-fi', 'folk', 'dream pop'],
    contradictoryKeywords: [...CONTRA_CALM, 'party', 'club'],
    fallbackQueries: ['alone time mellow indie acoustic', 'quiet introspective songs playlist'],
  },
  {
    id: 'commuting',
    title: 'Commuting',
    tagline: 'The right soundtrack for the road.',
    params: 'ggMPOg1uX044Z2o5WERLckpU',
    accentFrom: '#17855f',
    accentTo: '#0c4733',
    positiveKeywords: ['commute', 'drive', 'driving', 'road', 'traffic', 'train', 'morning commute'],
    preferredGenres: ['pop', 'indie pop', 'alternative', 'hip-hop', 'rock'],
    contradictoryKeywords: [...CONTRA_HIGH_ENERGY, 'sleep'],
    fallbackQueries: ['daily commute music playlist', 'driving indie pop hits'],
  },
  {
    id: 'eating-cooking',
    title: 'Eating & Cooking',
    tagline: 'Warm, easy music for the kitchen and the table.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#d9621a',
    accentTo: '#7d3409',
    positiveKeywords: ['dinner', 'kitchen', 'cooking', 'jazz', 'bossa', 'soul', 'warm', 'acoustic'],
    preferredGenres: ['jazz', 'bossa nova', 'soul', 'acoustic', 'funk'],
    contradictoryKeywords: CONTRA_CALM,
    fallbackQueries: ['cooking dinner jazz soul playlist', 'kitchen acoustic warm music'],
  },
  {
    id: 'evening',
    title: 'Evening',
    tagline: 'Gentle songs to wind the day down.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#2a3a8c',
    accentTo: '#151e4f',
    positiveKeywords: ['evening', 'sunset', 'dusk', 'chill', 'wind down', 'soft', 'mellow'],
    preferredGenres: ['r&b', 'indie', 'soul', 'chillout', 'acoustic'],
    contradictoryKeywords: CONTRA_CALM,
    fallbackQueries: ['evening chill wind down songs', 'sunset acoustic mellow playlist'],
  },
  {
    id: 'fitness',
    title: 'Fitness',
    tagline: 'Hard-hitting tracks to push you further.',
    params: 'ggMPOg1uX09LWkhnTjRGRUJh',
    accentFrom: '#8db014',
    accentTo: '#4f6608',
    positiveKeywords: ['fitness', 'workout', 'gym', 'hiit', 'cardio', 'training', 'running', 'pump'],
    preferredGenres: ['hip-hop', 'edm', 'electronic', 'trap', 'rock', 'phonk'],
    contradictoryKeywords: CONTRA_HIGH_ENERGY,
    fallbackQueries: ['gym fitness workout hits playlist', 'cardio running pump up songs'],
  },
  {
    id: 'gaming',
    title: 'Gaming',
    tagline: 'Soundtracks to level up to.',
    params: 'ggMPOg1uX3NmUVV4Vzl3WGQ0',
    accentFrom: '#239a2a',
    accentTo: '#115416',
    positiveKeywords: ['gaming', 'gamer', 'phonk', 'synthwave', 'electronic', 'edm', 'soundtrack'],
    preferredGenres: ['electronic', 'phonk', 'hip-hop', 'synthwave', 'edm', 'rock'],
    contradictoryKeywords: CONTRA_HIGH_ENERGY,
    fallbackQueries: ['gaming playlist electronic phonk synthwave', 'epic gaming hype music'],
  },
  {
    id: 'home',
    title: 'Home',
    tagline: 'Easy listening for a slow day in.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#0e8a6c',
    accentTo: '#064a39',
    positiveKeywords: ['home', 'cozy', 'sunday', 'easy', 'chill', 'coffee', 'indoor'],
    preferredGenres: ['indie', 'acoustic', 'lo-fi', 'folk', 'soul'],
    contradictoryKeywords: CONTRA_CALM,
    fallbackQueries: ['cozy sunday morning home playlist', 'easy listening acoustic chill'],
  },
  {
    id: 'morning',
    title: 'Morning',
    tagline: 'Bright songs to start the day right.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#f08c1a',
    accentTo: '#8f4d08',
    positiveKeywords: ['morning', 'coffee', 'sunrise', 'wake up', 'fresh', 'bright', 'acoustic'],
    preferredGenres: ['pop', 'indie pop', 'acoustic', 'soul', 'folk'],
    contradictoryKeywords: ['death metal', 'sad heartbreak', 'sleep'],
    fallbackQueries: ['morning coffee bright feel good music', 'wake up happy acoustic hits'],
  },
  {
    id: 'motivation',
    title: 'Motivation',
    tagline: 'Anthems to get you up and going.',
    params: 'ggMPOg1uX2lRZUZiMnNrQnJW',
    accentFrom: '#c01e4a',
    accentTo: '#6b0d27',
    positiveKeywords: ['motivation', 'hype', 'hustle', 'focus', 'power', 'win', 'rise', 'anthem'],
    preferredGenres: ['hip-hop', 'rap', 'rock', 'pop', 'edm'],
    contradictoryKeywords: CONTRA_HIGH_ENERGY,
    fallbackQueries: ['motivation hustle hype anthems playlist', 'inspirational pump up music'],
  },
  {
    id: 'outdoors',
    title: 'Outdoors',
    tagline: 'Music for fresh air and open skies.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#4c8a1e',
    accentTo: '#284d0e',
    positiveKeywords: ['outdoors', 'nature', 'hike', 'sunshine', 'folk', 'acoustic', 'campfire'],
    preferredGenres: ['folk', 'indie', 'country', 'americana', 'acoustic'],
    contradictoryKeywords: ['club', 'hardstyle', 'earrape'],
    fallbackQueries: ['outdoors acoustic indie folk playlist', 'nature hike campfire songs'],
  },
  {
    id: 'sleep',
    title: 'Sleep',
    tagline: 'Soft, calming sounds to drift off to.',
    params: 'ggMPOg1uX1MxaFQ3Z0JMZkN4',
    accentFrom: '#26266e',
    accentTo: '#12123d',
    positiveKeywords: ['sleep', 'slumber', 'ambient', 'piano', 'calm', 'soft', 'dream', 'night'],
    preferredGenres: ['ambient', 'classical', 'instrumental'],
    contradictoryKeywords: [...CONTRA_CALM, 'party', 'club', 'rap', 'rock'],
    fallbackQueries: ['deep sleep ambient piano calm music', 'peaceful soothing sleep sounds'],
  },
  {
    id: 'social',
    title: 'Social',
    tagline: 'Songs everyone in the room will know.',
    params: 'ggMPOg1uX0pmQ0s2V0JRclZs',
    accentFrom: '#e0507a',
    accentTo: '#802340',
    positiveKeywords: ['party', 'friends', 'hits', 'sing-along', 'pop', 'crowd', 'hangout'],
    preferredGenres: ['pop', 'hip-hop', 'dance', 'r&b', 'afrobeats'],
    contradictoryKeywords: CONTRA_HIGH_ENERGY,
    fallbackQueries: ['dinner party hangout crowd pleasers playlist', 'popular sing along pop hits'],
  },
  {
    id: 'sports',
    title: 'Sports',
    tagline: 'Game-day energy, start to finish.',
    params: 'ggMPOg1uX2lRZUZiMnNrQnJW',
    accentFrom: '#1c6cd0',
    accentTo: '#0e3c78',
    positiveKeywords: ['sports', 'stadium', 'game day', 'hype', 'rock', 'hip-hop', 'pump'],
    preferredGenres: ['hip-hop', 'rock', 'edm', 'rap'],
    contradictoryKeywords: CONTRA_HIGH_ENERGY,
    fallbackQueries: ['stadium sports hype anthems playlist', 'game day pump up tracks'],
  },
  {
    id: 'summertime',
    title: 'Summertime Sounds',
    tagline: 'Sunny songs for long, warm days.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#ff8c00',
    accentTo: '#9e5200',
    positiveKeywords: ['summer', 'sunny', 'beach', 'poolside', 'tropical', 'warm', 'sunshine'],
    preferredGenres: ['pop', 'house', 'afrobeats', 'reggaeton', 'funk'],
    contradictoryKeywords: ['sad', 'heartbreak', 'depression', 'funeral'],
    fallbackQueries: ['summer vibes poolside sunny hits playlist', 'warm weather pop dance songs'],
  },
  {
    id: 'holiday',
    title: 'Holiday',
    tagline: 'Festive favourites for the season.',
    params: 'ggMPOg1uXzZQbDB5eThLRTQ3',
    accentFrom: '#c62828',
    accentTo: '#701212',
    positiveKeywords: ['holiday', 'festive', 'christmas', 'winter', 'classic', 'celebration'],
    preferredGenres: ['pop', 'jazz', 'classic', 'soul'],
    contradictoryKeywords: CONTRA_CALM,
    fallbackQueries: ['holiday festive classics hits playlist', 'winter seasonal favourites'],
  },
  {
    id: 'weekend',
    title: 'Weekend',
    tagline: 'Feel-good music for your days off.',
    params: 'ggMPOg1uX0pmQ0s2V0JRclZs',
    accentFrom: '#7a3cc2',
    accentTo: '#421d70',
    positiveKeywords: ['weekend', 'friday', 'saturday', 'sunday', 'feel good', 'dance', 'party'],
    preferredGenres: ['pop', 'house', 'funk', 'r&b', 'indie pop'],
    contradictoryKeywords: CONTRA_HIGH_ENERGY,
    fallbackQueries: ['weekend vibes feel good hits playlist', 'friday night dance pop'],
  },
  {
    id: 'wellbeing',
    title: 'Wellbeing',
    tagline: 'Calm music for mindfulness and yoga.',
    params: 'ggMPOg1uX1JOQWZFeDByc2Jm',
    accentFrom: '#36a98a',
    accentTo: '#195c4a',
    positiveKeywords: ['mindfulness', 'meditation', 'yoga', 'calm', 'wellness', 'breath', 'ambient'],
    preferredGenres: ['ambient', 'instrumental', 'chillout', 'classical'],
    contradictoryKeywords: CONTRA_CALM,
    fallbackQueries: ['mindfulness yoga calm ambient music', 'wellness meditation peaceful playlist'],
  },
  {
    id: 'work',
    title: 'Work',
    tagline: 'Steady instrumentals to get things done.',
    params: 'ggMPOg1uX0NvNGNhWThMYWRh',
    accentFrom: '#3e63c9',
    accentTo: '#1f3678',
    positiveKeywords: ['work', 'productivity', 'instrumental', 'flow', 'focus', 'coding', 'reading'],
    preferredGenres: ['lo-fi', 'ambient', 'instrumental', 'electronic', 'classical'],
    contradictoryKeywords: [...CONTRA_CALM, 'party', 'karaoke'],
    fallbackQueries: ['deep work coding focus instrumental playlist', 'steady productivity flow music'],
  },
];

export const ALL_MOODS: readonly MoodDefinition[] = [...CORE_MOODS, ...EXTENDED_MOODS];

export function moodById(id: MoodId): MoodDefinition {
  return ALL_MOODS.find((m) => m.id === id) ?? CORE_MOODS[0]!;
}

export interface ScoredCandidate {
  track: Track;
  sourcePlaylistTitle?: string;
  sourcePlaylistSubtitle?: string;
  isNewRelease?: boolean;
  isFamiliarSeed?: boolean;
}

export interface AudioFeatureHint {
  bpm: number | null;
  energy: number;
  camelot?: string | null;
}

export interface AudioTasteSignature {
  avgBpm: number | null;
  avgEnergy: number | null;
  topKeys?: readonly string[];
  avoidedArtists?: readonly string[];
  preferredScripts?: readonly string[];
}

export interface RankTracksOptions {
  mode: RankingMode;
  mood?: MoodDefinition | null;
  recentOpeners?: readonly string[];
  nowMs?: number;
  limit?: number;
  seed?: number;
  /** Listener's background acoustic & script signature (from cached analyses + behaviour). */
  audioSignature?: AudioTasteSignature | null;
  /** Per-track acoustic features indexed by videoId when cached locally. */
  audioFeatures?: ReadonlyMap<string, AudioFeatureHint>;
  /** Unheard candidate videoIds surfaced by background AI discovery. */
  aiRecommendedIds?: ReadonlySet<string>;
}

/** Deterministic fast PRNG for controlled variety across visits. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAN_REUPLOAD_NOISE =
  /\b(?:7clouds|shadow\s*music|koala\s*kontrol|taz\s*network|vibe\s*music|syrebralvibes|uniq\s*vibes|aura\s*melodic|chill\s*only|cloudkid|xefox|nightblue|wave\s*music|latin\s*hype|rap\s*city|trap\s*nation|bass\s*nation|lyrics?\s*hub|lyric(?:s|al)?\s*video|lyrics\s+video|fan\s*made|sped\s*up|slowed(?:\s*\+\s*reverb)?|nightcore|8d\s*audio)\b/i;

export function isFanReuploadTrack(title: string, artist: string): boolean {
  return FAN_REUPLOAD_NOISE.test(artist) || FAN_REUPLOAD_NOISE.test(title);
}

function matchesScript(text: string, script: string): boolean {
  switch (script) {
    case 'devanagari':
      return /[\u0900-\u097F]/.test(text);
    case 'tamil':
      return /[\u0B80-\u0BFF]/.test(text);
    case 'hangul':
      return /[\uAC00-\uD7AF\u1100-\u11FF]/.test(text);
    case 'kana':
      return /[\u3040-\u30FF]/.test(text);
    case 'cjk':
      return /[\u4E00-\u9FFF]/.test(text);
    case 'arabic':
      return /[\u0600-\u06FF]/.test(text);
    case 'cyrillic':
      return /[\u0400-\u04FF]/.test(text);
    case 'latin':
      return /[A-Za-z]/.test(text);
    default:
      return false;
  }
}

function computeAvoidedArtists(profile: TasteProfileData, extra?: readonly string[]): Set<string> {
  const skipped = new Map<string, { earlySkips: number; positive: number }>();
  const likedSet = new Set(profile.likedIds);
  for (const sig of Object.values(profile.tracks)) {
    const pos = sig.completions + (sig.liked || likedSet.has(sig.videoId) ? 1 : 0);
    for (const a of artistSet(sig.artist)) {
      const prev = skipped.get(a) ?? { earlySkips: 0, positive: 0 };
      skipped.set(a, { earlySkips: prev.earlySkips + sig.earlySkips, positive: prev.positive + pos });
    }
  }
  const out = new Set<string>(extra ?? []);
  for (const [artist, st] of skipped) {
    if (st.earlySkips >= 2 && st.positive === 0) out.add(artist);
  }
  return out;
}

function trackRecordingKey(track: Track): string {
  const title = normalisedTitle(track.title);
  const lead = [...artistSet(artistLine(track))].sort()[0] ?? '';
  return title ? `${title}::${lead}` : track.videoId;
}

export function isContradictoryForMood(candidate: ScoredCandidate, mood: MoodDefinition): boolean {
  const titleLower = candidate.track.title.toLowerCase();
  const albumLower = (candidate.track.album?.name ?? '').toLowerCase();
  const metaLower = `${candidate.sourcePlaylistTitle ?? ''} ${candidate.sourcePlaylistSubtitle ?? ''}`.toLowerCase();
  const fullText = `${titleLower} ${albumLower} ${artistLine(candidate.track).toLowerCase()}`;

  for (const contra of mood.contradictoryKeywords) {
    if (fullText.includes(contra)) {
      const literalNoise = ['white noise', 'rain sounds', 'asmr', 'lullaby', 'podcast'].includes(contra);
      if (literalNoise || titleLower.includes(contra)) return true;
      if (!mood.positiveKeywords.some((kw) => metaLower.includes(kw))) return true;
    }
  }
  return false;
}

interface ComputedArtistScore {
  affinity: number;
  recentlyDiscovered: boolean;
}

function computeArtistScores(profile: TasteProfileData, nowMs: number): Map<string, ComputedArtistScore> {
  const raw = new Map<string, number>();
  const fourteenDays = 14 * 86_400_000;

  for (const sig of Object.values(profile.tracks)) {
    const net = Math.max(0, sig.plays + sig.completions * 0.6 + (sig.liked ? 2.5 : 0) - sig.earlySkips * 1.4);
    if (net <= 0) continue;
    for (const a of artistSet(sig.artist)) {
      raw.set(a, (raw.get(a) ?? 0) + net);
    }
  }
  const maxVal = Math.max(1, ...raw.values());
  const out = new Map<string, ComputedArtistScore>();
  for (const [artist, weight] of raw) {
    const firstSeen = profile.artistFirstSeen[artist] ?? 0;
    const recentlyDiscovered = firstSeen > 0 && nowMs - firstSeen <= fourteenDays && weight >= 1;
    out.set(artist, {
      affinity: Math.min(1, weight / maxVal),
      recentlyDiscovered,
    });
  }
  return out;
}

function isProfileEmpty(profile: TasteProfileData): boolean {
  return (
    Object.keys(profile.tracks).length === 0 &&
    profile.recentTrackIds.length === 0 &&
    profile.likedIds.length === 0
  );
}

/**
 * Multi-factor queue ranking & diversification:
 * - Personal artist & track affinity (plays, completions, likes)
 * - Skip behavior (drops chronically early-skipped tracks, penalizes recent skips)
 * - Recency fatigue (avoids refilling queues with tracks just played repeatedly)
 * - Mood relevance & anti-contradiction gate
 * - Discovery potential & artist spread caps
 */
export function rankTracks(
  candidates: readonly ScoredCandidate[],
  profile: TasteProfileData,
  options: RankTracksOptions,
): Track[] {
  if (!candidates.length) return [];
  const limit = options.limit ?? 50;
  const nowMs = options.nowMs ?? Date.now();
  const rng = mulberry32(options.seed ?? nowMs);
  const mood = options.mood ?? null;
  const emptyTaste = isProfileEmpty(profile);
  const artistScores = computeArtistScores(profile, nowMs);
  const avoidedArtists = computeAvoidedArtists(profile, options.audioSignature?.avoidedArtists);
  const audioSig = options.audioSignature ?? null;
  const audioMap = options.audioFeatures ?? null;
  const aiIds = options.aiRecommendedIds ?? null;
  const likedSet = new Set(profile.likedIds);
  const recentSet = new Set(profile.recentTrackIds.slice(0, 35));
  const openerSet = new Set(options.recentOpeners ?? []);

  // 1. De-duplicate same recording (audio vs official video) and exclude third-party fan/lyric channels (e.g. 7clouds)
  const deduped = new Map<string, ScoredCandidate>();
  for (const c of candidates) {
    if (!c.track.videoId || !c.track.title || c.track.unavailable) continue;
    if (isFanReuploadTrack(c.track.title, artistLine(c.track))) continue;
    const key = trackRecordingKey(c.track);
    if (!deduped.has(key)) deduped.set(key, c);
  }
  if (!deduped.size) {
    for (const c of candidates) {
      if (!c.track.videoId || !c.track.title || c.track.unavailable) continue;
      const key = trackRecordingKey(c.track);
      if (!deduped.has(key)) deduped.set(key, c);
    }
  }

  const threeHoursMs = 3 * 3_600_000;
  const twentyFourHoursMs = 24 * 3_600_000;

  interface RankedEntry {
    track: Track;
    score: number;
    isFamiliar: boolean;
    isDiscovery: boolean;
    leadArtist: string;
  }

  const scored: RankedEntry[] = [];

  for (const candidate of deduped.values()) {
    const t = candidate.track;
    if (mood && isContradictoryForMood(candidate, mood)) continue;

    const sig = profile.tracks[t.videoId];
    const plays = sig?.plays ?? 0;
    const earlySkips = sig?.earlySkips ?? 0;
    const skips = sig?.skips ?? 0;
    const liked = likedSet.has(t.videoId) || sig?.liked === true;
    const skipRatio = plays + earlySkips > 0 ? earlySkips / (plays + earlySkips) : 0;

    if (earlySkips >= 2 && skipRatio >= 0.65 && !liked) continue;
    if (earlySkips >= 1 && plays === 0 && options.mode === 'top-pick') continue;

    const sixHoursMs = 6 * 3_600_000;
    const isRecent = sig?.lastPlayedAt
      ? nowMs - sig.lastPlayedAt < sixHoursMs
      : recentSet.has(t.videoId);
    const isKnown = plays > 0 || liked || isRecent;

    if (options.mode === 'discovery' && isKnown) continue;

    let score = 0.25;
    const credits = [...artistSet(artistLine(t))];
    let maxArtistAffinity = 0;
    let discoveredBoost = false;
    let avoidedHit = false;

    for (const a of credits) {
      const aff = artistScores.get(a);
      if (aff) {
        if (aff.affinity > maxArtistAffinity) maxArtistAffinity = aff.affinity;
        if (aff.recentlyDiscovered) discoveredBoost = true;
      }
      if (avoidedArtists.has(a)) avoidedHit = true;
    }

    if (options.mode === 'discovery') {
      score += maxArtistAffinity <= 0.05 ? 0.24 : 0.08;
    } else {
      score += maxArtistAffinity * 0.34;
    }
    if (discoveredBoost) score += 0.08;
    if (avoidedHit && !liked) score -= 0.45;
    if (!isKnown && aiIds?.has(t.videoId) && !avoidedHit) score += 0.16;

    // Acoustic similarity & language/script coherence learned silently in the background.
    if (audioSig) {
      const feat = audioMap?.get(t.videoId);
      if (feat) {
        if (audioSig.avgBpm && feat.bpm) {
          const bpmDiff = Math.min(Math.abs(feat.bpm - audioSig.avgBpm), Math.abs(feat.bpm * 2 - audioSig.avgBpm), Math.abs(feat.bpm / 2 - audioSig.avgBpm));
          if (bpmDiff <= 20) score += 0.09 * (1 - bpmDiff / 20);
        }
        if (audioSig.avgEnergy !== null) {
          const eDiff = Math.abs(feat.energy - audioSig.avgEnergy);
          if (eDiff <= 0.35) score += 0.07 * (1 - eDiff / 0.35);
        }
        if (feat.camelot && audioSig.topKeys?.includes(feat.camelot)) {
          score += 0.05;
        }
      }
      if (audioSig.preferredScripts?.length) {
        const sampleText = `${t.title} ${artistLine(t)}`;
        if (audioSig.preferredScripts.some((s) => matchesScript(sampleText, s))) {
          score += 0.04;
        }
      }
    }

    if (liked) score += options.mode === 'mood' || options.mode === 'supermix' ? 0.32 : 0.26;
    if (plays > 0) {
      const completionRate = Math.min(1, (sig?.completions ?? 0) / plays);
      score += Math.min(0.22, Math.log1p(plays) * 0.09) + completionRate * 0.14;
      if (plays >= 8) score -= Math.min(0.18, (plays - 7) * 0.025);
    }

    const isUnheardArtist = maxArtistAffinity === 0;
    const isDiscovery = !isKnown && (isUnheardArtist || plays === 0);
    if (options.mode === 'new-release') {
      if (!isKnown) score += 0.22;
      if (candidate.isNewRelease) score += 0.2;
      if (maxArtistAffinity > 0.1 && !isKnown) score += 0.22;
    } else if (options.mode === 'mood' || options.mode === 'supermix') {
      if (!isKnown && maxArtistAffinity > 0.15) score += 0.15;
      if (isUnheardArtist) score += 0.08;
    }

    if (mood) {
      const text = `${t.title} ${t.album?.name ?? ''} ${candidate.sourcePlaylistTitle ?? ''} ${candidate.sourcePlaylistSubtitle ?? ''}`.toLowerCase();
      let moodMatch = 0;
      for (const kw of mood.positiveKeywords) {
        if (text.includes(kw)) moodMatch += 0.07;
      }
      for (const g of mood.preferredGenres) {
        if (text.includes(g)) moodMatch += 0.07;
      }
      score += Math.min(0.32, moodMatch);
    }

    if (isRecent) {
      score -= options.mode === 'mood' || options.mode === 'supermix' ? 0.34 : 0.3;
    } else if (sig?.lastPlayedAt && nowMs - sig.lastPlayedAt < twentyFourHoursMs) {
      score -= 0.12;
    }

    if (openerSet.has(t.videoId)) score -= 0.22;

    if (earlySkips > 0 || skips > 0) {
      const recentSkipMult = sig?.lastSkippedAt && nowMs - sig.lastSkippedAt < twentyFourHoursMs * 3 ? 1.3 : 0.9;
      const penalty = (earlySkips * 0.28 + Math.max(0, skips - earlySkips) * 0.12) * recentSkipMult;
      score -= Math.min(0.85, penalty);
    }

    score += rng() * 0.08;

    scored.push({
      track: t,
      score,
      isFamiliar: isKnown && !isRecent,
      isDiscovery,
      leadArtist: credits.sort()[0] ?? '',
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const pool = [...scored];
  const out: Track[] = [];
  const artistTotal = new Map<string, number>();
  const artistWindow: string[] = [];
  const windowGap = 3;
  const maxPerArtist = Math.max(2, Math.floor(limit / 12));
  const minHealthyQueue = Math.min(limit, 8);
  let consecFamiliar = 0;
  let consecDiscovery = 0;

  while (out.length < limit && pool.length) {
    const interleave = (options.mode === 'mood' || options.mode === 'supermix') && !emptyTaste && out.length > 0;
    let pickIdx = -1;

    // Pass 0: enforce strict per-artist cap, spacing window, and familiar/discovery balance.
    // Pass 1: relax spacing window and interleaving, still respecting per-artist cap.
    // Pass 2: only if queue is critically short (< minHealthyQueue), allow exceeding per-artist cap.
    const maxPass = out.length < minHealthyQueue ? 2 : 1;
    for (let pass = 0; pass <= maxPass && pickIdx < 0; pass++) {
      for (let i = 0; i < pool.length; i++) {
        const entry = pool[i]!;
        const artist = entry.leadArtist;
        if (artist) {
          if (pass < 2 && (artistTotal.get(artist) ?? 0) >= maxPerArtist) continue;
          if (pass === 0 && artistWindow.includes(artist)) continue;
        }
        if (pass === 0 && interleave) {
          if (consecFamiliar >= 2 && entry.isFamiliar) continue;
          if (consecDiscovery >= 3 && entry.isDiscovery) continue;
        }
        pickIdx = i;
        break;
      }
    }

    if (pickIdx < 0) break;
    const chosen = pool.splice(pickIdx, 1)[0]!;
    out.push(chosen.track);
    if (chosen.leadArtist) {
      artistTotal.set(chosen.leadArtist, (artistTotal.get(chosen.leadArtist) ?? 0) + 1);
      artistWindow.push(chosen.leadArtist);
      if (artistWindow.length > windowGap) artistWindow.shift();
    }
    if (chosen.isFamiliar) {
      consecFamiliar++;
      consecDiscovery = 0;
    } else if (chosen.isDiscovery) {
      consecDiscovery++;
      consecFamiliar = 0;
    } else {
      consecFamiliar = 0;
      consecDiscovery = 0;
    }
  }

  return out;
}

/**
 * Selects playlists from a YTM mood browse page tailored to [mood] and [profile],
 * using weighted sampling from top-matching playlists so successive selections
 * deliver fresh sets instead of the exact same songs every time.
 */
export function selectMoodPlaylists(
  page: BrowsePage,
  mood: MoodDefinition,
  profile: TasteProfileData,
  limit = 4,
  seed = Date.now(),
): { item: MusicItem; shelfTitle: string }[] {
  const rng = mulberry32(seed);
  const topArtists = Object.values(profile.tracks)
    .filter((t) => t.plays > 0 || t.liked)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 12)
    .flatMap((t) => [...artistSet(t.artist)]);

  const scored: { item: MusicItem; shelfTitle: string; score: number }[] = [];

  for (const shelf of page.shelves) {
    const shelfText = `${shelf.title} ${shelf.strapline ?? ''}`.toLowerCase();
    if (mood.contradictoryKeywords.some((c) => shelfText.includes(c))) continue;

    let shelfBonus = 0;
    for (const kw of mood.positiveKeywords) {
      if (shelfText.includes(kw)) shelfBonus += 2.0;
    }
    for (const item of shelf.items) {
      if (item.kind !== 'playlist' && item.kind !== 'album') continue;
      const itemText = `${item.title} ${item.subtitle}`.toLowerCase();
      if (mood.contradictoryKeywords.some((c) => itemText.includes(c))) continue;

      let score = 1.0 + shelfBonus;
      for (const kw of mood.positiveKeywords) if (itemText.includes(kw)) score += 2.2;
      for (const g of mood.preferredGenres) if (itemText.includes(g)) score += 1.4;
      for (const a of topArtists) if (a.length >= 3 && itemText.includes(a)) score += 2.0;
      score += rng() * 2.4;
      scored.push({ item, shelfTitle: shelf.title, score });
    }
  }

  for (const item of page.grid) {
    if (item.kind !== 'playlist' && item.kind !== 'album') continue;
    const itemText = `${item.title} ${item.subtitle}`.toLowerCase();
    if (mood.contradictoryKeywords.some((c) => itemText.includes(c))) continue;
    let score = 1.0;
    for (const kw of mood.positiveKeywords) if (itemText.includes(kw)) score += 2.2;
    for (const g of mood.preferredGenres) if (itemText.includes(g)) score += 1.4;
    score += rng() * 2.4;
    scored.push({ item, shelfTitle: page.title, score });
  }

  const seenIds = new Set<string>();
  const unique = scored
    .filter((entry) => {
      if (seenIds.has(entry.item.id)) return false;
      seenIds.add(entry.item.id);
      return true;
    })
    .sort((a, b) => b.score - a.score);

  if (unique.length <= limit) return unique.map(({ item, shelfTitle }) => ({ item, shelfTitle }));

  const pool = unique.slice(0, Math.max(limit * 3, 10));
  const picked: { item: MusicItem; shelfTitle: string }[] = [];
  while (picked.length < limit && pool.length) {
    const minS = pool.reduce((m, e) => Math.min(m, e.score), pool[0]!.score);
    const weights = pool.map((e) => (e.score - minS + 1) ** 2);
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rng() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    const chosen = pool.splice(idx, 1)[0]!;
    picked.push({ item: chosen.item, shelfTitle: chosen.shelfTitle });
  }
  return picked;
}

/**
 * Differentiates Home recommendation shelves so adjacent shelves do not show the
 * same playlists or duplicate tracks across Top Picks, Supermix, Discover, New Releases, etc.
 */
export function differentiateHomeShelves(shelves: readonly Shelf[], profile: TasteProfileData): Shelf[] {
  if (!shelves.length) return [];
  const seenCollectionIds = new Set<string>();
  const seenTrackKeys = new Set<string>();
  const recentSet = new Set(profile.recentTrackIds.slice(0, 20));
  const likedSet = new Set(profile.likedIds);
  const out: Shelf[] = [];

  for (const shelf of shelves) {
    const lower = shelf.title.toLowerCase();
    const isPersonalHistory = lower.includes('recent') || lower.includes('listen again') || lower.includes('history');
    const isDiscover = lower.includes('discover');
    const isNewRelease = lower.includes('new release') || lower.includes('new albums');

    if (isPersonalHistory) {
      for (const item of shelf.items) {
        if (item.kind !== 'song' && item.kind !== 'video') seenCollectionIds.add(item.id);
      }
      out.push(shelf);
      continue;
    }

    const perArtist = new Map<string, number>();
    const filtered = shelf.items.filter((item) => {
      const isTrack = item.kind === 'song' || item.kind === 'video';
      if (isTrack && isFanReuploadTrack(item.title, item.subtitle)) return false;
      const sig = profile.tracks[item.id];
      if (isTrack && sig && sig.earlySkips >= 2 && sig.earlySkips >= sig.plays) return false;

      if (isDiscover && isTrack) {
        if (recentSet.has(item.id) || likedSet.has(item.id) || (sig?.plays ?? 0) >= 2) return false;
      }

      if (!isTrack) {
        if (!isNewRelease && seenCollectionIds.has(item.id)) return false;
        seenCollectionIds.add(item.id);
      } else {
        const leadArtist = [...artistSet(item.subtitle)].sort()[0] ?? '';
        const key = `${normalisedTitle(item.title)}::${leadArtist}`;
        if (seenTrackKeys.has(key)) return false;
        if (leadArtist && shelf.items.length >= 8) {
          const cnt = perArtist.get(leadArtist) ?? 0;
          if (cnt >= 2) return false;
          perArtist.set(leadArtist, cnt + 1);
        }
        seenTrackKeys.add(key);
      }
      return true;
    });

    if (filtered.length >= (shelf.items.length >= 4 ? 3 : 1)) {
      out.push({ ...shelf, items: filtered });
    }
  }
  return out;
}

/** Lightweight musical metadata used to order AutoPlay picks cleanly under AutoMix. */
export interface SmoothMixTrackHint {
  bpm: number | null;
  camelot?: { num: number; letter: 'A' | 'B' } | null;
  energy?: number | null;
}

export interface EnhanceAutoplayOptions {
  automix?: boolean;
  hints?: ReadonlyMap<string, SmoothMixTrackHint>;
}

/** Filters & re-orders AutoPlay candidates to respect skips, recent repeats, optional active mood, and AutoMix smoothness. */
export function enhanceAutoplayTracks(
  existing: readonly Track[],
  candidates: readonly Track[],
  profile: TasteProfileData,
  limit = 10,
  mood?: MoodDefinition | null,
  options?: EnhanceAutoplayOptions,
): Track[] {
  const ranked = rankTracks(
    candidates.map((track) => ({ track })),
    profile,
    { mode: mood ? 'mood' : 'supermix', mood, limit: candidates.length },
  );
  const out: Track[] = [];
  const perArtist = new Map<string, number>();
  const last = existing.at(-1);
  const lastLead = last ? [...artistSet(artistLine(last))].sort()[0] ?? '' : '';
  const seedArtists = last ? artistSet(artistLine(last)) : new Set<string>();
  let prevLead = lastLead;
  const deferred: Track[] = [];
  const poolLimit = options?.automix ? Math.min(ranked.length, Math.max(limit * 2, limit)) : limit;

  for (const track of ranked) {
    if (out.length >= poolLimit) break;
    if (existing.some((e) => isSameRecording(e, track))) continue;
    const credits = [...artistSet(artistLine(track))];
    const key = credits.sort()[0] ?? '';
    if (key) {
      const cap = credits.some((a) => seedArtists.has(a)) ? 2 : 2;
      const count = perArtist.get(key) ?? 0;
      if (count >= cap) continue;
      // Avoid back-to-back tracks by the exact same lead artist when diverse options exist
      if (key === prevLead && ranked.length > 4) {
        deferred.push(track);
        continue;
      }
      perArtist.set(key, count + 1);
    }
    prevLead = key;
    out.push(track);
  }
  for (const track of deferred) {
    if (out.length >= poolLimit) break;
    out.push(track);
  }
  if (!options?.automix || out.length <= 1) return out.slice(0, limit);

  return orderTracksForSmoothMix(last ?? null, out, options.hints, limit);
}

function inferTrackCluster(track: Track): string {
  const text = `${track.title} ${track.album?.name ?? ''} ${artistLine(track)}`.toLowerCase();
  let bestId = '';
  let bestHits = 0;
  for (const mood of CORE_MOODS) {
    let hits = 0;
    for (const kw of mood.positiveKeywords) {
      if (text.includes(kw)) hits += 1;
    }
    for (const genre of mood.preferredGenres) {
      if (text.includes(genre)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestId = mood.id;
    }
  }
  return bestId;
}

function orderTracksForSmoothMix(
  anchor: Track | null,
  tracks: readonly Track[],
  hints: ReadonlyMap<string, SmoothMixTrackHint> | undefined,
  limit: number,
): Track[] {
  const pool = [...tracks];
  const ordered: Track[] = [];
  const perGenre = new Map<string, number>();
  const perArtist = new Map<string, number>();
  let current = anchor;
  let prevLead = anchor ? [...artistSet(artistLine(anchor))].sort()[0] ?? '' : '';
  let prevMood = anchor ? inferTrackCluster(anchor) : '';

  while (ordered.length < limit && pool.length > 0) {
    const curHint = current ? hints?.get(current.videoId) : undefined;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const cand = pool[i]!;
      const candHint = hints?.get(cand.videoId);
      const lead = [...artistSet(artistLine(cand))].sort()[0] ?? '';
      const mood = inferTrackCluster(cand);
      let score = -i * 0.04;
      if (curHint?.bpm && candHint?.bpm && curHint.bpm > 0 && candHint.bpm > 0) {
        const dist = Math.min(
          Math.abs(candHint.bpm - curHint.bpm) / curHint.bpm,
          Math.abs(candHint.bpm * 2 - curHint.bpm) / curHint.bpm,
          Math.abs(candHint.bpm / 2 - curHint.bpm) / curHint.bpm,
        );
        score += dist <= 0.06 ? 2.4 - dist * 10 : dist <= 0.14 ? 1.2 - (dist - 0.06) * 6 : -1.5 - dist;
      }
      if (curHint?.camelot && candHint?.camelot) {
        const a = curHint.camelot;
        const b = candHint.camelot;
        const numDiff = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
        if (a.num === b.num && a.letter === b.letter) score += 1.1;
        else if (a.num === b.num && a.letter !== b.letter) score += 0.85;
        else if (numDiff === 1 && a.letter === b.letter) score += 0.75;
        else if (numDiff === 1) score += 0.3;
        else if (numDiff >= 4) score -= 0.8;
      }
      if (curHint?.energy != null && candHint?.energy != null) {
        score += Math.max(-1, 0.8 - Math.abs(candHint.energy - curHint.energy) * 2.2);
      }
      if (lead) {
        if (lead === prevLead) score -= 2.4;
        score -= (perArtist.get(lead) ?? 0) * 0.7;
      }
      // Genre/mood variety penalty keeps sequential AutoMix diverse.
      if (mood) {
        if (mood === prevMood && pool.length > 3) score -= 0.85;
        score -= (perGenre.get(mood) ?? 0) * 0.35;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0]!;
    ordered.push(chosen);
    current = chosen;
    prevLead = [...artistSet(artistLine(chosen))].sort()[0] ?? '';
    if (prevLead) perArtist.set(prevLead, (perArtist.get(prevLead) ?? 0) + 1);
    prevMood = inferTrackCluster(chosen);
    if (prevMood) perGenre.set(prevMood, (perGenre.get(prevMood) ?? 0) + 1);
  }
  return ordered;
}

/** Suggests the most fitting core mood for the current hour weighted by user preferences. */
export function featuredMoodForHour(hour: number, profile: TasteProfileData, seed = Date.now()): MoodDefinition {
  let poolIds: MoodId[];
  if (hour >= 5 && hour <= 8) poolIds = ['energy', 'happy', 'road-trip', 'focus'];
  else if (hour >= 9 && hour <= 11) poolIds = ['focus', 'happy', 'energy'];
  else if (hour >= 12 && hour <= 16) poolIds = ['happy', 'road-trip', 'chill', 'focus'];
  else if (hour >= 17 && hour <= 19) poolIds = ['road-trip', 'energy', 'nostalgia', 'party'];
  else if (hour >= 20 && hour <= 22) poolIds = ['love', 'chill', 'late-night', 'sad'];
  else poolIds = ['late-night', 'chill', 'sad', 'nostalgia', 'love'];

  const rng = mulberry32(seed);
  const weighted = poolIds.map((id) => ({
    id,
    w: 1 + Math.max(0, profile.moods[id] ?? 0) * 2.2,
  }));
  const total = weighted.reduce((s, e) => s + e.w, 0);
  let pick = rng() * total;
  for (const entry of weighted) {
    pick -= entry.w;
    if (pick <= 0) return moodById(entry.id);
  }
  return moodById(poolIds[0]!);
}
