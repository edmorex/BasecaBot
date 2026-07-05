import { describe, it, expect } from 'vitest';
import { signSession, verifySession, parseCookies, serializeCookie } from './session.js';
import type { SessionData } from './types.js';

const SECRET = 'test-secret-please-change';
const data: SessionData = {
  user: { id: '123', login: 'alice', displayName: 'Alice', avatar: 'https://x/a.png' },
  relationship: { broadcaster: false, botAdmin: true, moderator: true, subscriber: false, follower: true },
};

describe('session sign/verify', () => {
  it('round-trips valid session data', () => {
    const token = signSession(data, SECRET);
    expect(verifySession(token, SECRET)).toEqual(data);
  });

  it('rejects a tampered payload', () => {
    const token = signSession(data, SECRET);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...data, relationship: { ...data.relationship, broadcaster: true } })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(body).toBeTruthy();
  });

  it('rejects a wrong secret', () => {
    const token = signSession(data, SECRET);
    expect(verifySession(token, 'other-secret')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signSession(data, SECRET, -1); // exp in the past
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession('not-a-token', SECRET)).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; b=hello%20world; c=')).toEqual({ a: '1', b: 'hello world', c: '' });
  });

  it('serializes with security flags', () => {
    const c = serializeCookie('bcb_session', 'v', { maxAgeSeconds: 60, secure: true, sameSite: 'Lax' });
    expect(c).toContain('bcb_session=v');
    expect(c).toContain('Max-Age=60');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
  });

  it('omits Secure when not requested', () => {
    expect(serializeCookie('x', 'y', {})).not.toContain('Secure');
  });
});
