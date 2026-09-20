# Achievements — idea backlog

> **1.0 is implemented** — see [achievements.md](achievements.md) for the shipped
> feature (catalog, backfill, overlay, profile). This file is the original
> brainstorm, kept as the backlog for later expansion.

Ideas are split by cost:

- **Tier 1 — buildable now**: derivable from data the bot already stores. **All of
  Tier 1 below shipped in 1.0**, except where noted.
- **Tier 2 — needs new tracking/services**: requires capturing data we don't keep
  yet. This is the real backlog.

---

## Shipped in 1.0

The `!first`, Quotes, Subscriptions, Bits and Tenure groups are live. See
[achievements.md](achievements.md#the-catalog) for the exact catalog.

Two ideas from the original brainstorm were **cut** during the 1.0 build:

- **Three-peat** (win `!first` on 3 consecutive streams) — the only entry needing a
  sequence analysis over the global stream list rather than a single count/max/sum.
  Dropped on cost; revisit if it's worth a dedicated query.
- **Immortalized** (be quoted for the first time) — duplicated *Quotable I*.

---

## Tier 2 — needs new tracking (the backlog)

Each needs data the bot does not currently persist.

### Chat activity — *needs a per-user message counter*
- **Chatterbox I/II/III** — send 100 / 1k / 10k messages.
- **First Words** — send your very first message.
- **Regular** — chat on N distinct streams.

### Watch time / attendance — *needs per-stream presence tracking*
- **Showed Up / Regular / Ride or Die** — attend 5 / 25 / 100 streams.
- **Marathoner** — present for an entire long stream.
- **Streak** — attend N streams in a row.

### Command usage — *needs a per-user command-invocation log* (today `usageCount` is global)
- **Power User** — trigger commands N times.
- **Explorer** — use N distinct commands.

### Timing & behaviour — *needs message timestamps / keyword scanning*
- **Night Owl / Early Bird** — chat in a given hour window.
- **Punctual** — be the first message of the stream N times.

### Emotes & content — *needs emote parsing*
- **Emote Lord**, **Spammer**, **CAPS LOCK**, **Copypasta**.
  (The chat-stats overlay already parses Twitch-native emotes — that plumbing
  could be reused; note it does not see BTTV/FFZ/7TV.)

### Social graph — *needs mention/interaction tracking*
- **Matchmaker** — gift a sub to a specific person.
- **Social Butterfly** — @-mention N unique chatters.

### Points economy — *needs a spend/history log* (only the current balance is stored)
- **Big Spender** — spend N points.
- **Broke** — hit 0 after having held a large balance.

### Raids / follows — *needs attribution the bot doesn't have*
- Incoming **raiders** are stored as a login string, not a tracked user row, so a
  per-chatter "you raided us" badge isn't attributable yet.

---

## Deferred design ideas

- **Rarity** — compute the % of chatters holding each achievement (one group-by
  over `UserAchievement`) and colour-code the badge frame.
- **Secret achievements** — hidden (silhouette + "???") until unlocked.
- **Image badges** — 1.0 uses emoji; swap in real art via an asset pipeline.
- **TTS voice-over** — the `achievementUnlocked` bus event is already a clean hook
  for speaking the unlock aloud.
- **Admin tuning UI** — enable/disable/retune definitions from the dashboard
  (today the catalog is code + a backfill script).
