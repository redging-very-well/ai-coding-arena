// Identity (plan §4): scrypt PIN hashes, web sessions (cookie pc_session),
// API keys (`pc_<24 base32>`), and the facilitator password + admin sessions.

import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, ok, type Result } from '@pixel-clash/shared';
import { RateLimiter } from '../util/ratelimit.js';
import type { Game } from './game.js';
import type { PlayerRecord } from './store.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const API_KEY_RE = /^pc_[a-z2-7]{24}$/;

/** `pc_` + 24 random base32 chars. */
export function newApiKey(): string {
  const bytes = randomBytes(24);
  let s = 'pc_';
  for (const b of bytes) s += BASE32[b & 31];
  return s;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 400 kid-friendly words: 3 words give 400^3 = 64,000,000 passwords (~26 bits),
 * which together with the admin login rate limit makes guessing infeasible.
 */
export const PASSWORD_WORDS: readonly string[] = [
  'acorn actor adobe agent alarm album alien alley alpha amber anchor angle ankle apple apron arcade arch arena',
  'armor arrow artist aspen atlas attic autumn avocado badge bagel baker balloon bamboo banana banjo barn barrel',
  'basket beach beacon beard beaver bell bench berry bicycle bison blanket blaze blender blossom boat bongo bonus',
  'boulder bracket branch brave bread breeze brick bridge broom bubble bucket buddy bugle bundle bunny burger',
  'button cabin cactus camel camera canal candle candy canoe canyon captain carpet carrot castle cedar cello',
  'chalk cheese cherry chess chimney chorus cider cinema circus citrus clam clay cliff clock cloud clover coach',
  'coast cobalt cocoa coconut comet compass cookie copper coral cosmos cotton cowboy coyote crab crane crayon',
  'cricket crown crystal cupcake curtain cymbal dagger daisy dancer dawn denim desert diamond dingo dinner',
  'dolphin domino donkey donut dragon drum duck dune eagle easel echo eclipse elbow elder elephant elk ember',
  'emerald engine falcon feather fence ferry fiddle field fig finch fjord flag flame flute fossil fountain fox',
  'frog frost fudge galaxy garden garlic gecko geyser ginger giraffe glacier glider globe goat gold gopher grape',
  'gravel guitar gumbo hammer harbor harp hawk hazel helmet heron hippo honey hornet horse husky igloo iguana',
  'island ivory jacket jaguar jam jelly jester jigsaw jungle kangaroo kayak kettle kitten kiwi koala ladder',
  'ladybug lagoon lake lantern laser lava lemon leopard lettuce lilac lime lion lizard llama lobster locket lotus',
  'lunar lynx magnet mango maple marble meadow melon mermaid meteor mint mitten monkey moose mosaic moth muffin',
  'mushroom nectar nest noodle nugget oak oasis ocean octopus olive onion orbit orchid otter owl oyster paddle',
  'panda papaya parade parrot pasta peach peanut pebble pelican pencil penguin pepper piano pickle pigeon pillow',
  'pilot pine pirate pixel pizza planet plum pocket polar pony popcorn poppy potato prism puffin pumpkin puppy',
  'puzzle python quail quartz quest quill rabbit raccoon radar radio rainbow raven reef rhino ribbon river robin',
  'robot rocket rodeo rooster ruby saddle safari salmon sandal saturn scarf scooter seal shadow shark shell',
  'sherbet ship silver skate sled sloth snail snow socks sonar spark sphinx spider sponge spruce squid stamp',
  'starfish stone storm sugar summit sunset swan taco tango tiger timber toast tomato topaz torch tortoise toucan',
  'tractor trail tuba tulip tuna tundra turtle unicorn valley velvet violet violin volcano waffle wagon walnut',
  'walrus water whale whistle willow window wizard wombat yacht yak yogurt yoyo zebra zephyr zigzag zinc zipper',
]
  .join(' ')
  .split(' ');

/** Three random words joined by '-' (plan §4). */
export function generatePassword(): string {
  return Array.from({ length: 3 }, () => PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]).join('-');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Who a request is (resolved by the adapters). */
export type Identity = { kind: 'player'; player: PlayerRecord } | { kind: 'none' };

export class AuthService {
  /** apiKey → playerId */
  private keys = new Map<string, string>();
  adminPassword = '';
  adminPasswordGenerated = false;
  /**
   * Failed admin logins per client address: 10 per minute, and (escalating)
   * 30 per 15 minutes. Only failures count, so the facilitator is never
   * locked out by their own successful logins.
   */
  private readonly adminFailShort = new RateLimiter(10, 60_000);
  private readonly adminFailLong = new RateLimiter(30, 15 * 60_000);

  constructor(private readonly game: Game) {}

  init(): void {
    const store = this.game.store;
    this.rebuildKeys();
    if (this.game.options.adminPassword) {
      this.adminPassword = this.game.options.adminPassword;
    } else {
      store.adminPassword ??= generatePassword();
      this.adminPassword = store.adminPassword;
      this.adminPasswordGenerated = true;
    }
  }

  rebuildKeys(): void {
    this.keys.clear();
    for (const p of this.game.store.players.values()) if (!p.kicked) this.keys.set(p.apiKey, p.id);
  }

  registerKey(player: PlayerRecord): void {
    this.keys.set(player.apiKey, player.id);
  }

  revokeKey(apiKey: string): void {
    this.keys.delete(apiKey);
  }

  /** The (non-kicked) player for an API key. */
  playerForKey(apiKey: string | undefined): PlayerRecord | undefined {
    if (!apiKey) return undefined;
    const id = this.keys.get(apiKey);
    const p = id ? this.game.store.players.get(id) : undefined;
    return p && !p.kicked ? p : undefined;
  }

  // -------------------------------------------------------------------------
  // Web sessions
  // -------------------------------------------------------------------------

  createSession(playerId: string): string {
    const token = newToken();
    this.game.store.sessions.set(token, playerId);
    this.game.store.save();
    return token;
  }

  playerForSession(token: string | undefined): PlayerRecord | undefined {
    if (!token) return undefined;
    const id = this.game.store.sessions.get(token);
    const p = id ? this.game.store.players.get(id) : undefined;
    return p && !p.kicked ? p : undefined;
  }

  endSession(token: string | undefined): void {
    if (token && this.game.store.sessions.delete(token)) this.game.store.save();
  }

  /** Kill every web session of a player (PIN reset, kick). */
  endSessionsOf(playerId: string): void {
    for (const [t, id] of this.game.store.sessions) if (id === playerId) this.game.store.sessions.delete(t);
    this.game.store.save();
  }

  /**
   * Resolve a player from a Bearer key or a session cookie (REST). A key that
   * is present but unknown is KEY_INVALID; nothing at all is AUTH_REQUIRED.
   */
  resolvePlayer(bearer: string | undefined, sessionToken: string | undefined): Result<PlayerRecord> {
    if (bearer) {
      const p = this.playerForKey(bearer);
      return p ? ok(p) : keyInvalid();
    }
    const p = this.playerForSession(sessionToken);
    if (p) return ok(p);
    return authRequired();
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  /** `client` is the caller's address (the rate-limit key). */
  adminLogin(password: unknown, client = '?'): Result<string> {
    const wait = Math.max(this.adminFailShort.check(client), this.adminFailLong.check(client));
    if (wait > 0) {
      return fail('RATE_LIMITED', 'Too many wrong admin passwords. Wait and try again.', {
        details: { retryAfterMs: wait },
      });
    }
    if (typeof password !== 'string' || !safeEqual(password.trim(), this.adminPassword)) {
      this.adminFailShort.hit(client);
      this.adminFailLong.hit(client);
      return fail('BAD_LOGIN', 'Wrong admin password.', { hint: 'The password is printed in the server terminal at startup.' });
    }
    const token = newToken();
    this.game.store.adminSessions.add(token);
    this.game.store.save();
    return ok(token);
  }

  isAdmin(token: string | undefined): boolean {
    return !!token && this.game.store.adminSessions.has(token);
  }

  adminLogout(token: string | undefined): void {
    if (token && this.game.store.adminSessions.delete(token)) this.game.store.save();
  }
}

export function authRequired(): Result<never> {
  return fail('AUTH_REQUIRED', 'You are not logged in to Pixel Clash.', {
    hint: 'Ask the kid for their player name and 4-digit PIN and call login, then pass the apiKey it returns.',
  });
}

export function keyInvalid(): Result<never> {
  return fail('KEY_INVALID', 'This Pixel Clash key is not valid (it may have been reset).', {
    hint: "Call login again with the kid's name and PIN. If that fails, ask a grown-up.",
  });
}
