import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, downloadUrl, fetchPublished } from './useExtensionUpdate';

describe('useExtensionUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds canonical zip download URLs next to extension.json', () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });
    expect(downloadUrl('nikomusic-extension-chrome.zip')).toBe(
      'http://localhost:5173/downloads/nikomusic-extension-chrome.zip',
    );
    expect(downloadUrl('nikomusic-extension-firefox.zip')).toBe(
      'http://localhost:5173/downloads/nikomusic-extension-firefox.zip',
    );
  });

  it('compares dotted extension manifest versions', () => {
    expect(compareVersions('0.4.5', '0.4.4')).toBe(1);
    expect(compareVersions('0.4.4', '0.4.4')).toBe(0);
    expect(compareVersions('0.4.3', '0.4.4')).toBe(-1);
  });

  it('returns null when extension.json is missing or HTML instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 200 })));
    await expect(fetchPublished()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not found', { status: 404 })));
    await expect(fetchPublished()).resolves.toBeNull();
  });
});
