// Simple pixel confetti for the MATCH_RESULTS podium (plan §12.2/§12.4):
// square flakes in the seat colours falling and swaying on a canvas.
// Respects prefers-reduced-motion (a few static flakes instead).

import { useEffect, useRef } from 'preact/hooks';
import { SEATS } from '../common/seats.js';

const COLORS = [...SEATS.map((s) => s.color), '#FFD447', '#F2F3FA'];

interface Flake {
  x: number;
  y: number;
  vy: number;
  sway: number;
  phase: number;
  size: number;
  color: string;
}

export function Confetti({ count = 160 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = (canvas.width = 1920);
    const H = (canvas.height = 1080);
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const flakes: Flake[] = Array.from({ length: count }, () => ({
      x: rnd(0, W),
      y: rnd(-H, 0),
      vy: rnd(80, 200),
      sway: rnd(20, 60),
      phase: rnd(0, Math.PI * 2),
      size: Math.round(rnd(6, 14)),
      color: COLORS[Math.floor(rnd(0, COLORS.length))]!,
    }));
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, W, H);
      for (const f of flakes) {
        if (!still) {
          f.y += f.vy * dt;
          f.phase += dt * 2;
          if (f.y > H + 20) {
            f.y = -20;
            f.x = rnd(0, W);
          }
        }
        const x = Math.round(f.x + Math.sin(f.phase) * f.sway);
        // Flip between full and half height for a cheap "tumbling" look.
        const h = Math.cos(f.phase * 2) > 0 ? f.size : Math.max(2, f.size >> 1);
        ctx.fillStyle = f.color;
        ctx.fillRect(x, Math.round(still ? (f.y + H) % H : f.y), f.size, h);
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [count]);
  return <canvas ref={ref} class="confetti" aria-hidden="true" />;
}
