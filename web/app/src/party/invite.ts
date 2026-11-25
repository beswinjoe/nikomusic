import { config } from '@/config';

/**
 * Party invites (JamInviteLink.kt): `<origin>/invite/<CODE>`,
 * optionally `?server=<custom server>`, and `nikomusic://party/<CODE>`. On the
 * web the first is a route of this app (`/invite/:code`).
 */

export const INVITE_ORIGIN = config.inviteOrigin;
export const CODE_LENGTH = 6;

function runtimeInviteOrigin(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : '';
}

/** Letters and digits only, upper case; null unless it's six of them. */
export function cleanCode(raw: string): string | null {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.length === CODE_LENGTH ? cleaned : null;
}

export function sanitizeServerUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).host ? withScheme : null;
  } catch {
    return null;
  }
}

export function parseInvite(value: string): { code: string; serverUrl: string | null } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const server = sanitizeServerUrl(url.searchParams.get('server'));
  if (url.protocol === 'nikomusic:' && url.host.toLowerCase() === 'party') {
    const code = cleanCode(url.pathname.replace(/^\/+|\/+$/g, '') || url.searchParams.get('code') || '');
    return code ? { code, serverUrl: server } : null;
  }
  const match = url.pathname.match(/^\/invite\/([A-Za-z0-9]{6})$/);
  if ((url.protocol === 'https:' || url.protocol === 'http:') && match) return { code: match[1]!.toUpperCase(), serverUrl: server };
  return null;
}

/** The link to share (JamInviteLink.url): a custom server's own invite page, else the configured/current web origin. */
export function inviteUrl(
  code: string,
  customServer: string | null,
  defaultOrigin = INVITE_ORIGIN || runtimeInviteOrigin(),
): string {
  const normalizedCode = code.toUpperCase();
  const base = customServer?.trim().replace(/\/+$/, '');
  const cleanDefault = defaultOrigin.trim().replace(/\/+$/, '');
  const origin = base && base.toLowerCase() !== cleanDefault.toLowerCase() ? base : cleanDefault;
  return origin ? `${origin}/invite/${normalizedCode}` : `nikomusic://party/${normalizedCode}`;
}
