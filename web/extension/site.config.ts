/** The Vite dev server (web/app/vite.config.ts pins the port). */
const DEV_ORIGIN = 'http://localhost:5173';

const STORE_BUILD = process.env.NIKOMUSIC_STORE_BUILD === '1';
const CONFIGURED_ORIGINS = process.env.NIKOMUSIC_SITE_ORIGINS?.trim();

if (STORE_BUILD && !CONFIGURED_ORIGINS) {
  throw new Error('NIKOMUSIC_SITE_ORIGINS must be set when NIKOMUSIC_STORE_BUILD=1.');
}

/**
 * The web app origins this extension serves. Every message is checked against
 * this list, and it becomes externally_connectable (Chromium), the relay's
 * content-script matches (Firefox) and the DNR rules' initiatorDomains.
 *
 * Defaults to http://localhost:5173 in local development. Store builds require
 * NIKOMUSIC_SITE_ORIGINS (comma-separated) so a published extension never
 * answers localhost or an unintended third-party domain. The first origin is
 * the one the popup links to.
 */
export const SITE_ORIGINS: string[] = (CONFIGURED_ORIGINS || (STORE_BUILD ? '' : DEV_ORIGIN))
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/**
 * Match patterns can't carry a port, so `http://localhost:5173` becomes
 * `http://localhost/*`. The exact origin, port included, is still enforced at
 * runtime against SITE_ORIGINS.
 */
export function matchPatternsFor(origins: string[]): string[] {
  return [...new Set(origins.map((o) => {
    const url = new URL(o);
    return `${url.protocol}//${url.hostname}/*`;
  }))];
}
