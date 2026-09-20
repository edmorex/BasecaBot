# Achievements

Console-style achievements for chatters. Viewers unlock them through normal
activity, see everything they've earned (and how close they are to the rest) on
their **profile page**, and an **on-stream overlay** pops a card while the bot
congratulates them in chat.

**1.0 scope:** every achievement is backed by data the bot *already* persists, so
the whole catalog can be **backfilled from existing history**. Achievements that
need new tracking (message counts, watch time, emotes) are deliberately deferred —
see [achievements-ideas.md](achievements-ideas.md).

---

## How it works

Every 1.0 achievement is a **threshold over a live query**, which is the idea the
whole feature rests on: one evaluator per achievement serves *all three* needs —
live unlocking, the historical backfill, and the profile's progress bars.

```
something happens (check-in / quote / sub / cheer / chat)
  → ctx.achievements.evaluate(userId, group)
      → compute that group's metrics (each DISTINCT metric queried once)
      → grant anything newly at/over target  → INSERT UserAchievement
      → publish `achievementUnlocked` on the bus
            → achievements plugin: chat announcement + overlay card
```

Only **unlocks** are persisted (`UserAchievement`, unique on `(userId, key)`).
Progress is always derived, so granting is idempotent and a re-run can never
double-award.

Files: engine `src/services/achievements.ts`, catalog
`src/services/achievementCatalog.ts`, surfacing `src/plugins/achievements/`,
overlay `src/web/pages/overlayAchievement.ts`.

### When evaluation runs

| Group | Runs when | Why |
|---|---|---|
| `first` | after a successful `!first` check-in | hooked in the first plugin |
| `quote` | after `!quote add` (for **both** the adder and the person quoted) | hooked in the quotes plugin |
| `sub` | after a sub / resub / gift-sub is logged | hooked in the events plugin |
| `bits` | after a cheer is logged | hooked in the events plugin |
| `daily` | when the user next chats (throttled, 6h) | time-based; see below |

Activity groups are triggered by the code that **writes the row**, not by
subscribing to the same bus event — bus handlers run concurrently, so evaluating
off the event could read `EventLog` before the write lands.

Time-based (tenure) achievements are checked **when the user chats** rather than by
a nightly sweep over every user. That's cheaper, and it means the celebration
fires while they're actually present instead of at 4am.

---

## The catalog

| Group | Achievements |
|---|---|
| **!first** | First Blood · Champion I/II/III (10/50/100 wins) · Podium Regular I/II/III (10/50/100 top-10s) · Speed Demon (check in under 10s) |
| **Quotes** | Quotable I/II/III (quoted 1/10/50) · Scribe I/II/III (added 1/10/50) |
| **Subs** | Welcome to the Club · Loyal I–IV (3/6/12/24 months) · Santa I/II/III (gifted 1/5/25) |
| **Bits** | First Cheer · Sparkler (100) · Fireworks (1k) · Supernova (10k) |
| **Tenure** | Foster Fam I/II/III (6/12/24 months known) · Anniversary (repeatable yearly) · Person of Many Names (set an alias) |

Badges are **emoji** in 1.0 (no asset pipeline). Each has a tier (bronze/silver/gold).

**Anniversary is repeatable**: its unlock key carries the occurrence
(`tenure.anniversary:2`), so each completed year is its own unlock and its own
on-stream pop. The backfill grants only the most recent year, not one per year.

To add or retune an achievement, edit `ACHIEVEMENTS` in
`src/services/achievementCatalog.ts` — add a `METRICS` entry if it needs a new
measurement. Nothing else changes.

---

## Backfill

Grant everything each user's existing history already satisfies, **silently**:

```bash
npm run backfill:achievements
```

> **Run this once before achievements go live.** Otherwise the first time a
> long-time regular chats, the engine unlocks years of history at once and
> announces all of it. Re-running is harmless (granting is idempotent). The script
> only needs `DATABASE_URL` — it never announces, so no Twitch config is required.

### What backfill can and cannot recover

- ✅ **!first, Quotes, Tenure** backfill perfectly — they live in `FirstStat`,
  `FirstCheckin`, `Quote` and `User.firstSeenAt`, which are complete.
- ✅ **Loyal is accurate.** Twitch sends *cumulative* months on every resub and we
  store it, so a single observed resub establishes the right tier.
- ⚠️ **Bits totals, First Cheer and Welcome to the Club only count what the bot
  has observed.** `EventLog` starts the day the bot started logging; cheers and
  subs from before that are invisible.
- ⚠️ **Anonymous cheers and gift-subs are stored with no user id** and can never be
  attributed to anyone.

---

## Surfaces

**Profile page** (`/user`) — a badge grid: unlocked entries are lit with their
unlock date; locked ones are dimmed with a progress bar (`12 / 50`). The header
shows `unlocked / total`. Served by `GET /api/me/achievements`.

**On-stream overlay** — copy the URL from **Admin → Overlays**
("Achievement — unlock pop") and add it as a Browser Source. Cards are **queued**,
so a batch of unlocks plays as a sequence instead of stacking. Requires
`OVERLAY_TOKEN` (see `.env.example`).

**Admin → Achievements** — browse the catalog with how many users hold each, and
fire a **simulated unlock** to validate the OBS overlay without waiting for a real
one (nothing is written to the database). Leave *"Also announce in chat"* off to
test the overlay card alone; tick it to exercise the full path (card **and** the
chat announcement) exactly as a genuine unlock would. The same page has a **Run
backfill** button, equivalent to the CLI script below.

**Chat announcement** — editable under **Admin → Text Strings** (feature
`achievements`). Unlocks are buffered ~1.5s so several landing together become one
line (`unlockedMulti`) instead of a burst. Blanking a string disables it.
