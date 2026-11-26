/**
 * The square sizes YouTube Music's own pages request. googleusercontent
 * resizes on demand, and answers bursts of uncached sizes with 429 (measured:
 * 68 of 73 artwork requests on Home refused when each asked for its exact
 * displayed size). Snapping to these keeps requests on cached variants.
 */
const SQUARE_SIZES = [60, 120, 226, 544, 1200, 2160, 4096, 7680];

const RESIZABLE_GOOGLE = /googleusercontent\.com|ggpht\.com/;
const RESIZABLE_APPLE = /mzstatic\.com/;
const RESIZABLE_YT = /i\.ytimg\.com|img\.youtube\.com/;

/**
 * Asks the image CDN for a sharp size covering [cssPx * dpr] (snapped to cached tiers up to 8K).
 */
export function sizedArtwork(url: string, cssPx: number, aspect = 1): string {
  if (Math.abs(aspect - 1) > 0.01) {
    return RESIZABLE_YT.test(url) ? upgradeYtThumbnail(url, cssPx) : url;
  }
  if (!RESIZABLE_GOOGLE.test(url) && !RESIZABLE_APPLE.test(url)) {
    return RESIZABLE_YT.test(url) ? upgradeYtThumbnail(url, cssPx) : url;
  }
  const dpr = Math.min(typeof window === 'undefined' ? 2 : window.devicePixelRatio || 1, 3);
  const needed = cssPx * dpr;
  const size = SQUARE_SIZES.find((s) => s >= needed) ?? SQUARE_SIZES[SQUARE_SIZES.length - 1]!;
  return artworkAtPixels(url, size);
}

/** Upgrades full-bleed hero/poster artwork up to 8K master resolution (7680px) cleanly. */
export function heroArtwork(url: string, maxPx = 7680): string {
  if (RESIZABLE_GOOGLE.test(url) || RESIZABLE_APPLE.test(url)) {
    return artworkAtPixels(url, maxPx);
  }
  if (RESIZABLE_YT.test(url)) return upgradeYtThumbnail(url, maxPx);
  return url;
}

/** A square artwork at an exact pixel size (up to 8K / 7680px). */
export function artworkAtPixels(url: string, px: number): string {
  if (RESIZABLE_GOOGLE.test(url)) {
    return `${url.replace(/=[^/=]*$/, '')}=w${px}-h${px}-l95-rj`;
  }
  if (RESIZABLE_APPLE.test(url)) {
    return url.replace(/\/\d+x\d+[^/.]*\./, `/${px}x${px}bb.`);
  }
  return url;
}

/** Steps down resolution smoothly on 404/error so high-res requests (up to 8K) never leave a broken poster. */
export function artworkFallbackUrl(url: string): string | null {
  if (RESIZABLE_GOOGLE.test(url)) {
    const match = /=w(\d+)-h\d+/.exec(url);
    const current = match ? Number(match[1]) : 0;
    const step = [4096, 2160, 1200, 544].find((s) => current === 0 || s < current);
    return step ? artworkAtPixels(url, step) : null;
  }
  if (RESIZABLE_APPLE.test(url)) {
    const match = /\/(\d+)x\d+[^/.]*\./.exec(url);
    const current = match ? Number(match[1]) : 0;
    const step = [4096, 2160, 1200, 600].find((s) => current === 0 || s < current);
    return step ? artworkAtPixels(url, step) : null;
  }
  if (RESIZABLE_YT.test(url)) {
    if (url.includes('maxresdefault')) return url.replace('maxresdefault', 'sddefault');
    if (url.includes('sddefault')) return url.replace('sddefault', 'hqdefault');
  }
  return null;
}

function upgradeYtThumbnail(url: string, cssPx: number): string {
  if (cssPx >= 480) {
    return url.replace(/\/(default|mqdefault|hqdefault|sddefault|hq720)\./, '/maxresdefault.');
  }
  return url;
}
