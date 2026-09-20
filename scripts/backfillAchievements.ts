/**
 * One-off maintenance script: grant every achievement each user's EXISTING
 * history already satisfies, silently.
 *
 *   npm run backfill:achievements
 *
 * Run this ONCE before achievements start announcing, otherwise the first time a
 * long-time regular chats, the engine will unlock years of history at once and
 * announce all of it. Re-running is harmless — granting is idempotent.
 *
 * Only needs DATABASE_URL (it never announces, so no Twitch config is required).
 */
import { EventBus } from '../src/core/eventBus.js';
import { Storage } from '../src/services/storage/index.js';
import { AchievementService } from '../src/services/achievements.js';
import { scopedLogger } from '../src/services/logger.js';
import type { AppConfig } from '../src/services/config.js';

// Backfill is silent, so the channel (only used when publishing) is never read.
const config = { twitch: { channel: '' } } as unknown as AppConfig;

const storage = new Storage();
await storage.connect();

const svc = new AchievementService(storage, new EventBus(), config, scopedLogger('backfill'));
console.log('Backfilling achievements from existing history…');
const res = await svc.backfillAll((done, total) => {
  if (done === total || done % 50 === 0) console.log(`  ${done}/${total} users`);
});
console.log(`Done: granted ${res.granted} achievement(s) across ${res.users} user(s).`);

await storage.disconnect();
