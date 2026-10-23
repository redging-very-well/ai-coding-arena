// REST wrappers for the /setup info (public) and the facilitator's setup
// settings (admin). Kept next to the setup page; /admin imports them too.

import type { SetupInfoDTO, SetupSettingsDTO } from '@pixel-clash/shared';
import { request } from '../common/api.js';

/** GET /api/setup: join URL + QR, LAN URLs, seat cards (no auth, never the seat password). */
export const getSetupInfo = () => request<SetupInfoDTO>('GET', '/setup');

/** The facilitator's settings: the public ones plus the seat password (§11.2 a, admin only). */
export type SetupSettingsPatch = Partial<SetupSettingsDTO> & { seatSecret?: string | null };

/** PUT /api/admin/setup: `null` or "" clears a field, a missing key leaves it. */
export const updateSetupSettings = (patch: SetupSettingsPatch) => request<SetupInfoDTO & { seatSecretSet: boolean }>('PUT', '/admin/setup', patch);
