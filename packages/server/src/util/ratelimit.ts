// Per-key rate limits: login 5/min, validate 1/s, submit 1 per 3 s.

/** Sliding-window limiter: at most `max` hits per `windowMs` per key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  configure(max: number, windowMs: number): void {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Record a hit. Returns 0 when allowed, else the ms to wait. */
  hit(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, this.windowMs - (now - list[0]!));
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(now);
    return 0;
  }

  /** The ms to wait before `key` may hit again (0 = allowed). Records nothing. */
  check(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length < this.max) return 0;
    return Math.max(1, this.windowMs - (now - list[list.length - this.max]!));
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [k, list] of this.hits) {
      if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

/** Limits concurrent async jobs (e.g. validation sandboxes). */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
