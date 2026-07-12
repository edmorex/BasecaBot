import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { scopedLogger } from './logger.js';

const cfgLog = scopedLogger('config');

/** Split a comma-separated env var into a trimmed, non-empty, lowercased list. */
function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const EnvSchema = z.object({
  TWITCH_CLIENT_ID: z.string().min(1, 'TWITCH_CLIENT_ID is required'),
  TWITCH_CLIENT_SECRET: z.string().min(1, 'TWITCH_CLIENT_SECRET is required'),
  TWITCH_BOT_USERNAME: z.string().min(1),
  TWITCH_BOT_ACCESS_TOKEN: z.string().min(1, 'TWITCH_BOT_ACCESS_TOKEN is required'),
  TWITCH_BOT_REFRESH_TOKEN: z.string().min(1, 'TWITCH_BOT_REFRESH_TOKEN is required'),
  TWITCH_BROADCASTER_USERNAME: z.string().min(1),
  TWITCH_BROADCASTER_ACCESS_TOKEN: z.string().min(1, 'TWITCH_BROADCASTER_ACCESS_TOKEN is required'),
  TWITCH_BROADCASTER_REFRESH_TOKEN: z.string().min(1, 'TWITCH_BROADCASTER_REFRESH_TOKEN is required'),
  BOT_ADMINS: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  WS_HUB_PORT: z.coerce.number().int().positive().default(8080),
  WS_HUB_SECRET: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
  DISABLED_PLUGINS: z.string().optional(),
  // Dev-only: when 'true', enables the eventSimulator plugin that injects fake
  // events from the WebSocket hub. Keep OFF in production (it can fabricate
  // subs/donations that award points).
  EVENT_SIM_ENABLED: z.string().optional(),
  // ── Web dashboard / "Login with Twitch" ──────────────────────────────────
  // Port for the bot's HTTP server (dashboard + auth + API). Behind Caddy.
  HTTP_PORT: z.coerce.number().int().positive().default(8090),
  // Public base URL the dashboard is reached at (no trailing slash). Used to
  // build the OAuth redirect URI and to decide Secure-cookie flags.
  PUBLIC_URL: z.string().url().default('http://localhost:8090'),
  // Secret used to sign session cookies (HMAC). If unset, an ephemeral random
  // one is generated (sessions won't survive restarts — set it in production).
  SESSION_SECRET: z.string().optional(),
});

export interface AppConfig {
  twitch: {
    clientId: string;
    clientSecret: string;
    botUsername: string;
    botAccessToken: string;
    botRefreshToken: string;
    /**
     * The single channel the bot operates in — always the broadcaster's own
     * channel. (The bot may temporarily join other "guest" channels at runtime,
     * e.g. for BasecaWheel, but only this channel is tracked/persisted.)
     */
    channel: string;
    broadcasterUsername: string;
    broadcasterAccessToken: string;
    broadcasterRefreshToken: string;
    admins: string[];
  };
  databaseUrl: string;
  ws: { port: number; secret: string };
  disabledPlugins: string[];
  eventSim: { enabled: boolean };
  web: {
    httpPort: number;
    publicUrl: string;
    sessionSecret: string;
    /** Absolute OAuth redirect URI, derived from publicUrl. */
    oauthRedirectUri: string;
    /** Whether cookies should be marked Secure (publicUrl is https). */
    secureCookies: boolean;
  };
}

/**
 * Parse & validate process.env into a typed config object.
 * Throws with a readable message if required vars are missing.
 */
export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nDid you copy .env.example to .env?`);
  }
  const env = parsed.data;

  const broadcaster = env.TWITCH_BROADCASTER_USERNAME.toLowerCase();
  const admins = new Set(csv(env.BOT_ADMINS));
  admins.add(broadcaster); // broadcaster is always an admin

  const publicUrl = env.PUBLIC_URL.replace(/\/+$/, ''); // strip trailing slash
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex');
    cfgLog.warn('SESSION_SECRET not set — using an ephemeral secret; logins will not survive restarts. Set SESSION_SECRET in production.');
  }

  return {
    twitch: {
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
      botUsername: env.TWITCH_BOT_USERNAME.toLowerCase(),
      botAccessToken: env.TWITCH_BOT_ACCESS_TOKEN,
      botRefreshToken: env.TWITCH_BOT_REFRESH_TOKEN,
      channel: broadcaster, // the bot's single primary channel = the broadcaster's channel
      broadcasterUsername: broadcaster,
      broadcasterAccessToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN,
      broadcasterRefreshToken: env.TWITCH_BROADCASTER_REFRESH_TOKEN,
      admins: [...admins],
    },
    databaseUrl: env.DATABASE_URL,
    ws: { port: env.WS_HUB_PORT, secret: env.WS_HUB_SECRET },
    disabledPlugins: csv(env.DISABLED_PLUGINS),
    eventSim: { enabled: env.EVENT_SIM_ENABLED === 'true' },
    web: {
      httpPort: env.HTTP_PORT,
      publicUrl,
      sessionSecret,
      oauthRedirectUri: `${publicUrl}/auth/callback`,
      secureCookies: publicUrl.startsWith('https://'),
    },
  };
}
