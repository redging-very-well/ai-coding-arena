// The code editor chunk loader (packages/client/src/play/editorLoad.ts):
// one automatic retry, then offline / game updated / other.

import { describe, expect, it } from 'vitest';
import { LOAD_FAILURE_TEXT, classifyLoadFailure, entryScripts, loadWithRetry, pathOf, retryUrl } from '../packages/client/src/play/editorLoad.js';

const BUILT = (hash: string) => `<!doctype html>
<html lang="en"><head>
    <script type="module" crossorigin src="/assets/play-${hash}.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/maps-h2Te_c8E.js">
    <script>window.x = 1</script>
</head><body><div id="app"></div></body></html>`;
const DEV = `<script type="module" src="/@vite/client"></script><script type="module" src="/src/play/main.tsx"></script>`;
const noWait = async () => {};

describe('editor chunk retry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    await expect(loadWithRetry(async () => ++calls, 0, noWait)).resolves.toBe(1);
    expect(calls).toBe(1);
  });
  it('retries once after a failure, handing the retry the first error', async () => {
    const seen: unknown[] = [];
    const first = new TypeError('Failed to fetch dynamically imported module');
    const load = async (prev: unknown) => {
      seen.push(prev);
      if (seen.length === 1) throw first;
      return 'mod';
    };
    await expect(loadWithRetry(load, 0, noWait)).resolves.toBe('mod');
    expect(seen).toEqual([undefined, first]);
  });
  it('gives up after the second failure, waiting the delay in between', async () => {
    let calls = 0;
    const waits: number[] = [];
    const load = async () => {
      calls++;
      throw new TypeError('boom');
    };
    await expect(loadWithRetry(load, 600, async (ms) => void waits.push(ms))).rejects.toThrow('boom');
    expect(calls).toBe(2);
    expect(waits).toEqual([600]);
  });
});

describe('retry URL (browsers remember a failed import of the same URL)', () => {
  it("reads the chunk URL from Chrome's and Firefox's errors and adds a fresh query", () => {
    const chrome = new TypeError('Failed to fetch dynamically imported module: http://10.0.0.2:8080/assets/UnitEditor-DEhvoLva.js');
    expect(retryUrl(chrome, 1)).toBe('http://10.0.0.2:8080/assets/UnitEditor-DEhvoLva.js?retry=1');
    const firefox = new TypeError('error loading dynamically imported module: http://localhost:5173/src/play/editor/UnitEditor.tsx?t=1');
    expect(retryUrl(firefox, 2)).toBe('http://localhost:5173/src/play/editor/UnitEditor.tsx?t=1&retry=2');
  });
  it('replaces the query of an earlier retry', () => {
    expect(retryUrl(new TypeError('Failed to fetch dynamically imported module: http://h/assets/U.js?retry=1'), 2)).toBe('http://h/assets/U.js?retry=2');
  });
  it('gives null when the error names no URL (Safari), so the plain import runs again', () => {
    expect(retryUrl(new TypeError('Importing a module script failed.'), 1)).toBeNull();
    expect(retryUrl(undefined, 1)).toBeNull();
  });
});

describe('entry scripts', () => {
  it('reads the module entry of a built page, not preloads or inline scripts', () => {
    expect(entryScripts(BUILT('CvczWRU7'))).toEqual(['/assets/play-CvczWRU7.js']);
  });
  it('reads the dev server page', () => {
    expect(entryScripts(DEV)).toEqual(['/@vite/client', '/src/play/main.tsx']);
  });
  it('normalises absolute script URLs to paths', () => {
    expect(pathOf('http://192.168.1.5:8080/assets/play-A.js', 'http://192.168.1.5:8080/play')).toBe('/assets/play-A.js');
  });
});

describe('why the editor did not load', () => {
  const loaded = ['/assets/play-CvczWRU7.js'];
  it('says updated when the server now serves another build (the old chunk is gone)', () => {
    expect(classifyLoadFailure({ online: true, page: { ok: true, html: BUILT('NEWHASH1') }, loaded })).toBe('updated');
  });
  it('says offline when the page cannot be fetched or the browser is offline', () => {
    expect(classifyLoadFailure({ online: true, page: null, loaded })).toBe('offline');
    expect(classifyLoadFailure({ online: false, page: { ok: true, html: BUILT('CvczWRU7') }, loaded })).toBe('offline');
  });
  it('says other when the same build is still served, or the page fetch errors', () => {
    expect(classifyLoadFailure({ online: true, page: { ok: true, html: BUILT('CvczWRU7') }, loaded })).toBe('other');
    expect(classifyLoadFailure({ online: true, page: { ok: false, html: 'Not found' }, loaded })).toBe('other');
    expect(classifyLoadFailure({ online: true, page: { ok: true, html: DEV }, loaded: ['/@vite/client', '/src/play/main.tsx'] })).toBe('other');
  });
  it('has a message for every case that names its button', () => {
    expect(LOAD_FAILURE_TEXT.updated).toMatch(/Reload/);
    expect(LOAD_FAILURE_TEXT.offline).toMatch(/Wi-Fi/);
    expect(LOAD_FAILURE_TEXT.other).toMatch(/Try again/);
    for (const t of Object.values(LOAD_FAILURE_TEXT)) expect(t).not.toMatch(/\bkids?\b/i);
  });
});
