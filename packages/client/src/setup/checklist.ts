// The /setup checklist. DOM-free; ticks are kept per
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
    title: 'AI session host (sessions/)',
    items: [
      {
        id: 'box-env',
        title: 'Run the AI session host setup command from /admin → AI seats in the repo folder on the AI session host',
        detail: 'make seats PIXEL_CLASH_URL=… SEAT_SECRET=…: it writes this server\'s address and the seat password (made up by this server; players never see it) into sessions/.env and starts the seats.',
      },
      {
        id: 'box-up',
        title: 'Start the seat containers (all 8, or only the seats in use)',
        detail: 'Fewer seats: docker compose up -d seat1 seat2 seat3 (one per player laptop).',
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
        detail: 'The AI helper should call get_game_state with no approval prompts (test through the AI helper pane in /play).',
      },
      {
        id: 'box-admin',
        title: 'In /admin → AI seats, enter the AI session host address',
        detail: 'Turn on Show details first (not on the projector). Every running seat should turn green (up).',
      },
      {
        id: 'box-firewall',
        title: 'AI session host allows inbound 7781-7788 from the game server; sleep is disabled',
        detail: 'Optional hardening: allow 7781-7788 only from the game server IP (sessions/README.md).',
      },
    ],
  },
  {
    title: 'Player laptops',
    items: [
      {
        id: 'laptop-tabs',
        title: 'One tab per laptop: open /play, join, and the AI helper pane shows the terminal (a free AI seat is given automatically)',
        detail: '"Open in new tab" in the AI helper pane also works; the newest tab takes over the seat.',
      },
      { id: 'laptop-projector', title: 'Projector shows /screen in full screen (F11)' },
    ],
  },
  {
    title: 'After the event',
    items: [
      { id: 'wipe-server', title: 'Wipe the game server (admin Wipe, or npm run wipe)' },
      { id: 'wipe-box', title: 'Wipe the AI session host (kits, keys, chats, logins)', command: 'docker compose down -v' },
    ],
  },
];
