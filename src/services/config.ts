import 'dotenv/config';
import { z } from 'zod';

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
  TWITCH_CHANNELS: z.string().min(1),
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
});

export interface AppConfig {
  twitch: {
    clientId: string;
    clientSecret: string;
    botUsername: string;
    botAccessToken: string;
    botRefreshToken: string;
    channels: string[];
    broadcasterUsername: string;
    broadcasterAccessToken: string;
    broadcasterRefreshToken: string;
    admins: string[];
  };
  databaseUrl: string;
  ws: { port: number; secret: string };
  disabledPlugins: string[];
  eventSim: { enabled: boolean };
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

  return {
    twitch: {
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
      botUsername: env.TWITCH_BOT_USERNAME.toLowerCase(),
      botAccessToken: env.TWITCH_BOT_ACCESS_TOKEN,
      botRefreshToken: env.TWITCH_BOT_REFRESH_TOKEN,
      channels: csv(env.TWITCH_CHANNELS),
      broadcasterUsername: broadcaster,
      broadcasterAccessToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN,
      broadcasterRefreshToken: env.TWITCH_BROADCASTER_REFRESH_TOKEN,
      admins: [...admins],
    },
    databaseUrl: env.DATABASE_URL,
    ws: { port: env.WS_HUB_PORT, secret: env.WS_HUB_SECRET },
    disabledPlugins: csv(env.DISABLED_PLUGINS),
    eventSim: { enabled: env.EVENT_SIM_ENABLED === 'true' },
  };
}
