// Tiny leveled logger. Tests set the level to 'silent' (or PC_LOG=silent).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let current: LogLevel = (process.env.PC_LOG as LogLevel | undefined) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: Exclude<LogLevel, 'silent'>, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = `[${new Date().toISOString().slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
