import type { networkInterfaces } from 'node:os';
import { describe, expect, it } from 'vitest';
import { lanAddresses, lanRank } from '../packages/server/src/util/lan.js';

type Ifaces = ReturnType<typeof networkInterfaces>;
const v4 = (address: string, internal = false) => ({
  address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: `${address}/24`,
});

describe('LAN address ranking', () => {
  it('puts the Wi-Fi/Ethernet address before OrbStack/Docker bridges and VPNs (macOS host)', () => {
    // The order macOS can report: OrbStack's bridge first, the real LAN later.
    const ifaces: Ifaces = {
      lo0: [v4('127.0.0.1', true)],
      bridge100: [v4('192.168.139.3')],
      utun4: [v4('100.64.0.7')],
      en0: [v4('10.0.0.42')],
    };
    expect(lanAddresses(ifaces)).toEqual(['10.0.0.42', '192.168.139.3', '100.64.0.7']);
  });

  it('ranks Linux and Windows interface names too', () => {
    const ifaces: Ifaces = {
      docker0: [v4('172.17.0.1')],
      'br-1a2b': [v4('172.18.0.1')],
      wlp2s0: [v4('10.0.0.5')],
      'vEthernet (WSL)': [v4('172.20.0.1')],
      'Wi-Fi': [v4('10.0.0.6')],
    };
    expect(lanAddresses(ifaces).slice(0, 2)).toEqual(['10.0.0.5', '10.0.0.6']);
  });

  it('puts link-local last and keeps unknown names between physical and virtual', () => {
    expect(lanRank('en0', '169.254.1.2')).toBe(3);
    expect(lanRank('bridge100', '192.168.139.3')).toBe(2);
    expect(lanRank('mystery0', '10.1.1.1')).toBe(1);
    expect(lanRank('en0', '10.0.0.42')).toBe(0);
  });
});
