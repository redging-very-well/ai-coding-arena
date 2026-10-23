// The /setup checklist (plan §11.1, §15). DOM-free; ticks are kept per
// browser in localStorage by the page.

export interface ChecklistItem {
  id: string;
  title: string;
  detail?: string;
  /** Shell command to show (copyable). */
  command?: string;
}

export interface ChecklistSection {
  title: string;
  items: ChecklistItem[];
}

export const CHECKLIST: readonly ChecklistSection[] = [
  {
    title: 'Game server (this machine)',
    items: [
      { id: 'server-start', title: 'Start the server on the host OS (not the devcontainer)', command: 'npm run build && npm start' },
      { id: 'server-ivm', title: 'The startup banner says sandbox: isolated-vm (no red banner on /admin)' },
      { id: 'server-firewall', title: 'Firewall allows inbound TCP 8080; sleep is disabled' },
      { id: 'server-reach', title: 'A player laptop opens the /play address above (scan the QR)' },
    ],
  },
  {
    title: 'Claude box (sessions/)',
    items: [
      {
        id: 'box-env',
        title: 'Set the game server address in sessions/.env',
        detail: 'PIXEL_CLASH_URL is the address above (http://<ip>:8080), plus TTYD_PASS_1..8 for the seat cards (set all 8, even for a smaller game).',
      },
      {
        id: 'box-up',
        title: 'Start the seat containers (all 8, or only the seats in use)',
        detail: 'Fewer seats: docker compose up -d seat1 seat2 seat3 (one per player laptop, matching the seat cards).',
        command: 'docker compose up -d',
      },
      {
        id: 'box-login',
        title: 'Log in and trust each seat (seat1 … seat8)',
        detail: 'Run /login with the event account, then accept the folder-trust dialog for /kit.',
        command: 'docker compose run --rm seat1 claude',
      },
      {
        id: 'box-check',
        title: 'In each seat terminal ask "Are you connected to Pixel Clash?"',
        detail: 'Claude should call get_game_state with no approval prompts.',
      },
      { id: 'box-admin', title: 'Enter the Claude box address in /admin so the seat links below appear' },
      { id: 'box-firewall', title: 'Claude box allows inbound 7781-7788; sleep is disabled' },
    ],
  },
  {
    title: 'Player laptops',
    items: [
      { id: 'laptop-cards', title: 'Each laptop has its seat card: /play URL/QR, seat terminal URL and its password' },
      { id: 'laptop-tabs', title: 'Open two tabs per laptop: /play and the seat terminal' },
      { id: 'laptop-projector', title: 'Projector shows /screen in full screen (F11)' },
    ],
  },
  {
    title: 'After the event',
    items: [
      { id: 'wipe-server', title: 'Wipe the game server (admin Wipe, or npm run wipe)' },
      { id: 'wipe-box', title: 'Wipe the Claude box (kits, keys, chats, logins)', command: 'docker compose down -v' },
    ],
  },
];
