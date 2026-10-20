// LAN addresses (plan §13 util/lan.ts): startup printout, /screen QR, and the
// /mcp Origin allowlist (§10.4).

import { networkInterfaces } from 'node:os';

/** Every non-internal IPv4 address of this machine. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return [...new Set(out)];
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
