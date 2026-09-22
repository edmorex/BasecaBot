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

**Floofs only spawn while the stream is live** (and only when enabled). The
**Fire a floof now** button bypasses *both*, so you can position and test the
overlay off-stream.

## Floof photos

Upload **square PNGs** in the admin panel (max 2 MB). The server validates both
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

## Achievements

Wins are persisted per user, so the achievements engine thresholds on them
directly and the standard backfill picks them up:

- 🐾 **Floof Friend I** — win once
- 🐱 **Floof Friend II** — win 10 times
- 💖 **Floof Friend III** — win 50 times

## Chat messages

Every line the game says is editable under **Admin → Text Strings** (feature
`floof`) — winner announcement, the idle reply, stats, and the setter
confirmation. Blanking a string disables it.
