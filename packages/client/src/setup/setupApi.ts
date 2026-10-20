// REST wrappers for the /setup info (public) and the facilitator's setup
// settings (admin). Kept next to the setup page; /admin imports them too.

import type { SetupInfoDTO, SetupSettingsDTO } from '@pixel-clash/shared';
import { request } from '../common/api.js';

/** GET /api/setup: join URL + QR, LAN URLs, seat terminal links (no auth). */
export const getSetupInfo = () => request<SetupInfoDTO>('GET', '/setup');

/** PUT /api/admin/setup: `null` or "" clears a field, a missing key leaves it. */
export const updateSetupSettings = (patch: Partial<SetupSettingsDTO>) => request<SetupInfoDTO>('PUT', '/admin/setup', patch);

/** "Seat 1" … "Seat 4" (seats are 0-based on the wire). */
export const seatLabel = (seat: number) => `Seat ${seat + 1}`;
