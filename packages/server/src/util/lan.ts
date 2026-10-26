// LAN addresses: startup printout, /screen QR, and the
// /mcp Origin allowlist.

import { networkInterfaces } from 'node:os';

// Interface names that are virtual bridges, tunnels or VM/container networks
// (OrbStack/Docker Desktop `bridge100`, Docker `docker0`/`br-*`/`veth*`, VPN
// `utun*`/`tun*`/`wg*`, VirtualBox/VMware/Hyper-V, Apple AWDL/hotspot). Their
// addresses are usually NOT reachable from other machines on the LAN, so they
// are listed last; the first address is what the banner, QR codes and kit use
// by default.
const VIRTUAL_IFACE = /^(bridge|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|zt|tailscale|orb|lxc|lxd|cni|flannel|awdl|llw|anpi|ap\d|vEthernet)/i;

/** Sort key: lower is more likely the address other LAN machines can reach. */
export function lanRank(iface: string, address: string): number {
  if (address.startsWith('169.254.')) return 3; // link-local, no DHCP
  if (VIRTUAL_IFACE.test(iface)) return 2;
  if (/^(en|eth|wlan|wl|Wi-?Fi|Ethernet)/i.test(iface)) return 0; // physical NICs
  return 1;
}

/**
 * Every non-internal IPv4 address of this machine, most-likely-reachable
 * first (physical NICs, then unknown, then virtual bridges/VPNs, then
 * link-local). `ifaces` is injectable for tests.
 */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found: { address: string; rank: number; order: number }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) found.push({ address: a.address, rank: lanRank(name, a.address), order: found.length });
    }
  }
  found.sort((x, y) => x.rank - y.rank || x.order - y.order);
  return [...new Set(found.map((f) => f.address))];
}

/** `http://<ip>:<port>` for every LAN address. */
export function lanUrls(port: number): string[] {
  return lanAddresses().map((ip) => `http://${ip}:${port}`);
}

/**
 * Allowed `Origin` values for /mcp: each LAN IPv4, localhost and 127.0.0.1 on
 * the server's port. Computed per request so a DHCP change is picked up.
 */
export function originAllowlist(port: number): Set<string> {
  return new Set([...lanUrls(port), `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}
