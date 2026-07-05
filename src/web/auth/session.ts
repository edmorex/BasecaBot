import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { SessionData } from './types.js';

export const SESSION_COOKIE = 'bcb_session';
export const OAUTH_STATE_COOKIE = 'bcb_oauth_state';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60; // 8 hours

interface SignedPayload extends SessionData {
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Produce a stateless, tamper-evident session token: `<payload>.<signature>`,
 * where payload is base64url(JSON) and signature is base64url(HMAC-SHA256).
 * No server-side store needed; integrity is guaranteed by the HMAC.
 */
export function signSession(data: SessionData, secret: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SignedPayload = { ...data, iat: now, exp: now + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac(secret, body));
  return `${body}.${sig}`;
}

/** Verify signature + expiry; returns the session data or null if invalid. */
export function verifySession(token: string | undefined, secret: string): SessionData | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = b64url(hmac(secret, body));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { user: payload.user, relationship: payload.relationship };
  } catch {
    return null;
  }
}

/** A random, URL-safe value for the OAuth `state` (CSRF) parameter. */
export function randomState(): string {
  return randomBytes(16).toString('hex');
}

// ── Cookie helpers (no external dependency) ──────────────────────────────────

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.httpOnly ?? true) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
