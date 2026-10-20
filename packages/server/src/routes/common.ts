// Helpers shared by the REST routers: auth resolution and result → HTTP.

import type { NextFunction, Request, Response } from 'express';
import {
  ADMIN_COOKIE,
  SESSION_COOKIE,
  httpStatusFor,
  type ApiErrorBody,
  type Result,
  type ServiceError,
  type ValidationResult,
} from '@pixel-clash/shared';
import type { Game } from '../services/game.js';
import type { PlayerRecord } from '../services/store.js';

export const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax' as const, path: '/' };

/** `Authorization: Bearer pc_…` (case-insensitive scheme). */
export function bearerOf(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = req.headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  const m = v ? /^Bearer\s+(\S+)\s*$/i.exec(v) : null;
  return m?.[1];
}

export function cookieOf(req: Request, name: string): string | undefined {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : undefined;
}

export function sendError(res: Response, error: ServiceError): void {
  const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
  if (error.hint) body.error.hint = error.hint;
  if (error.details) body.error.details = error.details;
  if (error.code === 'RATE_LIMITED' && typeof error.details?.retryAfterMs === 'number') {
    res.setHeader('Retry-After', String(Math.ceil(error.details.retryAfterMs / 1000)));
  }
  res.status(httpStatusFor(error.code)).json(body);
}

/** 200 with the data, or the mapped error status. */
export function send<T>(res: Response, result: Result<T>): void {
  if (result.ok) res.json(result.data);
  else sendError(res, result.error);
}

/** §7 result: 200 on success, 422 with the §7 body on validation failure. */
export function sendValidation(res: Response, result: Result<ValidationResult>): void {
  if (!result.ok) return sendError(res, result.error);
  res.status(result.data.ok ? 200 : 422).json(result.data);
}

declare module 'express-serve-static-core' {
  interface Request {
    player?: PlayerRecord;
  }
}

/** Middleware: require a player (Bearer key or session cookie). */
export function requirePlayer(game: Game) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = game.auth.resolvePlayer(bearerOf(req), cookieOf(req, SESSION_COOKIE));
    if (!r.ok) return sendError(res, r.error);
    req.player = r.data;
    next();
  };
}

/** Middleware: require the admin cookie. */
export function requireAdmin(game: Game) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (game.auth.isAdmin(cookieOf(req, ADMIN_COOKIE))) return next();
    sendError(res, { code: 'ADMIN_REQUIRED', message: 'This needs the facilitator login.', hint: 'Log in on /admin.' });
  };
}

/** The player behind an optional key/cookie (GET /state works without auth). */
export function optionalPlayer(game: Game, req: Request): PlayerRecord | undefined {
  const r = game.auth.resolvePlayer(bearerOf(req), cookieOf(req, SESSION_COOKIE));
  return r.ok ? r.data : undefined;
}

export function body(req: Request): Record<string, unknown> {
  const b: unknown = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

/** Wrap an async handler so rejections reach the error middleware. */
export function wrap(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function roundParam(v: string | string[] | undefined): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined || s === 'latest') return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}
