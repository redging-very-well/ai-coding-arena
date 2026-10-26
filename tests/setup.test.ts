// /setup info and the facilitator's setup settings (plan §11 /setup page,
// §12.3 server info): join URL + QR, seat terminal links from the AI session host
// address (no seat cards: seats are auto-assigned), persistence across a restart,
// and admin-only updates.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SetupInfoDTO } from '@pixel-clash/shared';
import { normalizeBaseUrl, normalizeAiSessionHost } from '../packages/server/src/services/setup.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, adminClient, bootServer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;

describe('setup address normalisation', () => {
  it('accepts hosts and IPs, strips scheme/port/path, refuses junk', () => {
    expect(normalizeAiSessionHost('192.168.8.20')).toBe('192.168.8.20');
    expect(normalizeAiSessionHost(' http://Claude-Box.local:7781/ ')).toBe('claude-box.local');
    expect(normalizeAiSessionHost('bad host')).toBeNull();
    expect(normalizeAiSessionHost('<script>')).toBeNull();
    expect(normalizeBaseUrl('http://192.168.8.10:8080/')).toBe('http://192.168.8.10:8080');
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBaseUrl('http://x/play')).toBeNull();
  });
});

describe('GET /api/setup and PUT /api/admin/setup', () => {
  let srv: RunningServer;
  let dir: string;
  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('serves the join URL and QR without auth, with no terminals until the AI session host is set', async () => {
    const info = (await new Client(srv.url).get<SetupInfoDTO>('/setup')).body;
    expect(info.playUrl).toBe(`${info.baseUrl}/play`);
    expect(info.playQrSvg).toContain('<svg');
    expect(info.seatTerminals).toEqual([]);
    expect(info).not.toHaveProperty('seatCards');
    expect(info.settings).toEqual({ aiSessionHost: null, preferredUrl: null });
    expect(info.sandboxMode).toBe('ivm');
    expect(Array.isArray(info.lanUrls)).toBe(true);
  });

  it('is admin-only to change, validates input, and builds the seat terminal links', async () => {
    const anon = await new Client(srv.url).put('/admin/setup', { aiSessionHost: '10.0.0.5' });
    expect(anon.body.error.code).toBe('ADMIN_REQUIRED');

    const admin = await adminClient(srv.url);
    const bad = await admin.put('/admin/setup', { aiSessionHost: 'not a host!' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');

    const ok = await admin.put<SetupInfoDTO>('/admin/setup', { aiSessionHost: 'http://10.0.0.5:7781', preferredUrl: 'http://10.0.0.9:8080' });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ aiSessionHost: '10.0.0.5', preferredUrl: 'http://10.0.0.9:8080' });
    expect(ok.body.playUrl).toBe('http://10.0.0.9:8080/play');
    // All 8 Claude seats (ttyd runs under the /terminal/N base path, §11.1).
    expect(ok.body.seatTerminals.map((t) => t.url)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `http://10.0.0.5:778${n}/terminal/${n}/`));
    expect(ok.body.seatTerminals[0]!.qrSvg).toContain('<svg');

    // Public view matches; a partial update leaves the other field alone.
    const pub = (await new Client(srv.url).get<SetupInfoDTO>('/setup')).body;
    expect(pub.seatTerminals).toHaveLength(8);
    const cleared = await admin.put<SetupInfoDTO>('/admin/setup', { preferredUrl: null });
    expect(cleared.body.settings).toEqual({ aiSessionHost: '10.0.0.5', preferredUrl: null });
  });

  it('keeps the settings across a wipe and a restart', async () => {
    const admin = await adminClient(srv.url);
    expect((await admin.post('/admin/wipe', { confirm: 'WIPE' })).status).toBe(200);
    expect((await admin.get<SetupInfoDTO>('/setup')).body.settings.aiSessionHost).toBe('10.0.0.5');
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    expect((await new Client(srv.url).get<SetupInfoDTO>('/setup')).body.settings.aiSessionHost).toBe('10.0.0.5');
  }, T);
});
