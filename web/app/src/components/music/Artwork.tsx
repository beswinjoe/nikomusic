import { useEffect, useState, type CSSProperties } from 'react';
import { artworkFallbackUrl, sizedArtwork } from '@/lib/artwork';

interface ArtworkProps {
  src: string | null;
  /** The CSS pixel width it renders at, so the CDN is asked for that size (prompt §3). */
  displayWidth: number;
  /** width / height. */
  aspect?: number;
  radius?: CSSProperties['borderRadius'];
  className?: string;
  /** Eager for above-the-fold heroes; lazy everywhere else. */
  eager?: boolean;
}

const frame = 'relative isolate w-full overflow-hidden bg-joe artwork-stroke';

/**
 * Fixed-aspect artwork: a neutral placeholder until the image decodes, then a
 * short fade (prompt §3). Supports ultra-HD posters up to 8K with graceful stepdown fallback.
 */
export function Artwork({ src, displayWidth, aspect = 1, radius, className, eager }: ArtworkProps) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  useEffect(() => {
    setFallbackUrl(null);
    setAttempt(0);
    setLoaded(false);
  }, [src]);
  const sized = src ? sizedArtwork(src, displayWidth, aspect) : null;
  const url = fallbackUrl ?? (attempt >= 2 || sized === src ? src : sized);
  return (
    <div
      className={className ? `${frame} ${className}` : frame}
      style={{ aspectRatio: String(aspect), borderRadius: radius }}
    >
      {url && (
        <img
          key={`${url}#${attempt}`}
          className="absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-250 ease-in data-loaded:opacity-100"
          data-loaded={loaded || undefined}
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => {
            const stepped = artworkFallbackUrl(url);
            if (stepped && stepped !== url) {
              setFallbackUrl(stepped);
              return;
            }
            if (attempt === 0) setTimeout(() => setAttempt(1), 1200);
            else if (attempt === 1 && url !== src) setAttempt(2);
          }}
        />
      )}
    </div>
  );
}
