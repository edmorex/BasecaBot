# Pet the Floof

A photo of one of the floofs drifts across a strip at the bottom of the screen;
the first chatter to type **`!pet`** wins. Wins are tracked, ranked, and feed the
**Floof Friend I/II/III** achievements.

| Command | Who | What |
|---|---|---|
| `!pet` | everyone | Claim the floof currently on screen (or hear that there isn't one) |
| `!pet stats [user]` | everyone | Wins + rank (aliases: `!pet rank`) |
| `!pet set <variable> <value>` | broadcaster | Change a setting from chat (`!pet set` lists the variables) |

---

## OBS setup

Add **Pet the Floof** from **Admin → Overlays** as a Browser Source:

- **Suggested size: 1600 × 200**, positioned flush with the **bottom-right** corner.
- The overlay **adapts to whatever size you set** — it reads the Browser Source's
  own dimensions and re-reads them if you resize it, so you can give it a taller
  or full-screen area later without changing anything.

The floof is drawn at 128×128 and ping-pongs inside whatever area it's given.

### Padding does two jobs

The four **padding** values (in pixels, per edge) define an inset "safe area":

1. **A hard boundary** the floof bounces off, so it never drifts into an edge.
2. **A feather band.** The win effects — the bloom, the shockwave ring and the
   heart — expand well past the floof's own 128px box and would otherwise be
   sliced off by the edge of the source. Everything is drawn through a mask that
   is fully opaque inside the safe area and ramps to transparent at the real
   render border, so anything crossing the padding line **fades out smoothly
   instead of hard-clipping** in the final composite.

So set padding to roughly how far you want the glow to be able to bleed. Padding
of `0` on an edge leaves that edge unfeathered (the old behaviour).

## Settings (Admin → Pet the Floof)

| Setting | Chat variable | Default | Notes |
|---|---|---|---|
| Enable the game | `enabled` | off | When off the timer never spawns |
| Base timer | `base` | 960s (16m) | |
| Random extra | `random` | 480s (8m) | Spawns land randomly in base … base+random (16–24m) |
| Despawn after | `despawn` | 120s | An un-pet floof gives up and fades out |
| Speed | `speed` | 5 | 1 (slow) – 10 (fast) |
| Padding L/R/T/B | `pad-left`, `pad-right`, `pad-top`, `pad-bottom` | 0 | Pixels kept clear at each edge |
| Pets to defeat | `boss-pets` | 20 | Chatters needed to bring down a Boss Floof |
| Boss chance | `boss-chance` | 10 | % of scheduled spawns that are a boss |
| Boss escapes after | `boss-despawn` | 180s | Bosses get longer than a normal floof |

**Floofs only spawn while the stream is live** (and only when enabled). The
**Fire a floof now** button bypasses *both*, so you can position and test the
overlay off-stream.

## Taunts

The speech-bubble lines are edited in the admin panel — add or remove them
freely. The overlay picks one at random every time a bubble appears (and never
shows the same line twice in a row). If you delete them all, the floof simply
stays quiet.

## Boss Floof battles

Some spawns are a **Boss Floof**: a group fight for the whole chat.

1. A flashing red **"A BOSS FLOOF APPROACHES!"** alert plays for a few seconds,
   and the bot warns chat.
2. The boss arrives with an angry red aura and a **life bar** underneath, which
   drains from green through yellow to red as chat wears it down.
3. Chat attacks it with `!pet`. Each hit **drains the boss's life bar**; it goes
   down when the bar empties (default **20** hits). A chatter can hit it more than
   once, but only every **30 seconds** — so one person *can* solo a boss, but
   realistically lands only a few blows before it escapes.
4. On defeat, everyone who took part is credited and gets the **Defeat Boss
   Floof** achievement.
5. If chat runs out of time the boss fades and mocks them:
   **"FAILURE! BOSS FLOOF ESCAPED!"**

Bosses fire on a **percentage of scheduled spawns** (`boss-chance`, default 10%),
or on demand with the **Fire a BOSS now** button. If no boss photos are marked,
that spawn falls back to a normal floof.

> **Note:** everyone who lands at least one hit is credited on a win, however
> many hits they got in. Lower `boss-pets` if your chat is small.

## Floof photos

Upload **square PNGs** in the admin panel (max 2 MB). Tick **Boss only** on a
photo to reserve it for Boss Floof battles — boss and normal pools are kept
separate, so a boss never shows an ordinary floof (or vice versa). Both live in
the same folder, so there is nothing extra to mount. The server validates both
the PNG signature and squareness from the file's own header, so a non-square or
non-PNG upload is rejected up front. Images live in `public/assets/floofs/`.

> ### ⚠️ One-time server setup
> `public/` is baked into the Docker image, so **without a bind mount every
> uploaded photo is wiped on `docker compose up --build`.** The compose file
> mounts the host directory `/opt/floofs`, so create it once on the server:
>
> ```bash
> mkdir -p /opt/floofs
> ```
>
> Uploads then land on the host, survive redeploys, and can be backed up by
> copying that folder (or topped up over SSH — files dropped in are picked up
> immediately, no restart needed).

## How a round plays out

1. The timer elapses (base + random) while enabled and live — or you hit **Fire now**.
2. A random photo fades in and starts ping-ponging, rocking happily as it goes.
3. After **10 seconds unpet** it pauses and shows a speech bubble — *"!pet me"*,
   *"i can haz !pet?"*, *"i wants !pet"* — then fades the bubble and carries on.
   It keeps doing this until pet or until it despawns.
4. The first `!pet` wins: the floof stops, blooms pink, resolves into a heart, and
   floats away. The bot congratulates the winner in chat and records the win.
5. If nobody pets it within **despawn** seconds it quietly fades out.

Only the *first* claim counts — the winner is locked in synchronously, so two
`!pet`s in the same instant can't both win. The "no floof right now" reply is
rate-limited per user so it can't be spammed.

## Testing without touching the scoreboard

**Fire a floof now** / **Fire a BOSS now** spawn on demand, ignoring the enable
switch and the live check. **Simulate !pet** then stands in for a chatter:

- against a normal floof, one click plays the win animation;
- against a boss, each click lands one hit — click through to watch the life bar
  drain and the defeat fire.

None of it is scored: no wins recorded, no chat announcement, no achievements, and
a simulated boss kill credits nobody.

## Achievements

Wins are persisted per user, so the achievements engine thresholds on them
directly and the standard backfill picks them up:

- 🐾 **Floof Friend I** — win once
- 🐱 **Floof Friend II** — win 10 times
- 💖 **Floof Friend III** — win 50 times
- ⚔️ **Defeat Boss Floof** — take part in a winning Boss Floof battle

## Chat messages

Every line the game says is editable under **Admin → Text Strings** (feature
`floof`) — winner announcement, the idle reply, stats, the setter confirmation,
and the three boss lines (incoming, defeated, escaped). Blanking a string
disables it.
