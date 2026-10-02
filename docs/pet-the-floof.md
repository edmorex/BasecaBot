# Pet the Floof

A photo of one of the floofs appears on the overlay and the first chatter to type
**`!pet`** wins. Every spawn picks a random photo *and* a random animation style —
it might drift, roll, hop, peek up from the bottom edge, or fade in like a ghost.
Wins are tracked, ranked, and feed the **Floof Friend I/II/III** achievements.

> Group boss fights used to live here. They now have their own game — see
> [boss-battle.md](boss-battle.md).

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

The floof is drawn at 128×128 and moves inside whatever area it's given. The Roll,
Hop and Peek styles all work off the **bottom edge**, so give the source enough
height for them to read — a short strip suits Ping Pong and Ghost best.

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

> **Changes save as you make them.** There is no Save button: edits are written
> after a short pause (so dragging or typing is one write, not dozens) and the
> status line next to the action buttons shows *Unsaved changes… → Saving… →
> Saved*. If a save fails the error stays on screen rather than disappearing.

| Setting | Chat variable | Default | Notes |
|---|---|---|---|
| Enable the game | `enabled` | off | When off the timer never spawns |
| Base timer | `base` | 960s (16m) | |
| Random extra | `random` | 480s (8m) | Spawns land randomly in base … base+random (16–24m) |
| Despawn after | `despawn` | 120s | An un-pet floof gives up and fades out |
| Padding L/R/T/B | `pad-left`, `pad-right`, `pad-top`, `pad-bottom` | 0 | Pixels kept clear at each edge |

Each animation style has its own tuning:

| Style | Setting | Chat variable | Default |
|---|---|---|---|
| Ping Pong | Drift speed | `speed` | 5 (1 slow – 10 fast) |
| Ping Pong | Wag amount | `pingpong-wag` | 9° |
| Ping Pong | Wag speed | `pingpong-wag-seconds` | 0.63s |
| Roll | Roll speed | `roll-speed` | 5 (1 slow – 10 fast) |
| Hop | Hop distance | `hop-distance` | 220px |
| Hop | Hop height | `hop-height` | 120px |
| Hop | Hop duration | `hop-seconds` | 0.7s |
| Hop | Rest between hops | `hop-delay` | 0.5s |
| Peek | Peek height | `peek-height` | 96px |
| Peek | Slide time | `peek-rise` | 0.5s |
| Peek | Peek duration | `peek-hold` | 2.5s |
| Peek | Hidden between peeks | `peek-delay` | 0.8s |
| Peek | Wag amount | `peek-wag` | 5° |
| Peek | Wag speed | `peek-wag-seconds` | 0.63s |
| Ghost | Fade time | `ghost-fade` | 1.2s |
| Ghost | Visible for | `ghost-hold` | 1.6s |
| Ghost | Hidden between | `ghost-delay` | 0.6s |
| Ghost | Wag amount | `ghost-wag` | 12° |
| Ghost | Wag speed | `ghost-wag-seconds` | 1.4s |

**Floofs only spawn while the stream is live** (and only when enabled). The
**Spawn Floof** button bypasses *both*, so you can position and test the overlay
off-stream. Next to it are two dropdowns — **floof** and **animation** — each
defaulting to Random, so you can force a specific pairing while tuning it.

## Taunts

**Every floof has its own lines.** A newly-added photo starts with a single
`!pet me`, and you edit each one separately — hit the number in the **Taunts**
column of the photo table to fold out its editor.

The overlay picks one of that floof's lines at random every time a bubble appears,
and never shows the same line twice in a row.

In **Ghost** mode the bubble matches the floof's opacity frame by frame, so the
taunt fades in and out with it rather than hanging in the air on its own. If a
taunt is due while the ghost is fully invisible it waits for the floof to come
back, so the line is never spent on an empty screen.

> Remove **all** of a floof's taunts and it stays completely silent — useful for a
> photo where a speech bubble would spoil the shot. An emptied list is remembered
> as empty; it does not quietly revert to the default.

## Animation styles

Ping Pong, Peek and Ghost each wag, and each has its **own** wag amount and speed —
tuning one never moves another. (Roll's rotation comes from the rolling itself, and
Hop leans into its arc, so neither takes wag settings.)


Every spawn picks **two** things at random: which photo appears, and how it moves.

| Style | Behaviour |
|---|---|
| **Ping Pong** | Drifts in a straight line and bounces off the padded edges, wagging as it goes |
| **Roll** | Trundles along the bottom edge like a tyre, rotating in proportion to the distance travelled, and turning round at each end |
| **Hop** | Bounds left and right in arcs, sitting still for a beat between hops and turning round at the edges |
| **Peek** | Pops up from a random spot along the bottom edge, looks around, ducks back down, and reappears somewhere else, wagging while it watches |
| **Ghost** | Fades in on the spot, wags gently, fades out, and reappears elsewhere — never travelling. Its speech bubble fades with it, so the taunt comes and goes with the floof |

A **Hop** taller than the overlay is capped at the available headroom, so a short
strip will never launch a floof out of frame.

When a floof stops to taunt, Ping Pong, Roll and Hop freeze mid-motion to speak.
Peek and Ghost keep running their own appear/disappear cycles, since freezing
those mid-fade just looks broken.

## Floof photos

Upload **square PNGs** in the admin panel (max 2 MB). The server validates both
the PNG signature and squareness from the file's own header, so a non-square or
non-PNG upload is rejected up front. Images live in `public/assets/floofs/`.

Each photo has a **Name**, a **checkbox per animation style** (all ticked by
default) and its own **taunt list** (starting with `!pet me`).

Naming a floof is optional — the bot uses the name when it announces a win
(*"🐾 Mochi got a pet from Alice!"*). Leave it blank and the floof is simply
called **"The floof"**. Names are trimmed to 40 characters, and the Spawn Floof
dropdown shows a floof's name once it has one, which makes picking a specific one
much easier than hunting through filenames. Untick
one to stop that photo using it — handy when a pose only reads well one way (a
floof photographed lying down looks odd rolling like a tyre).

> A photo with **every** style unticked is never spawned at random — which doubles
> as a way to shelve a photo without deleting it. It can still be spawned by name
> from the **Spawn Floof** dropdowns.

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

1. The timer elapses (base + random) while enabled and live — or you hit **Spawn Floof**.
2. A random photo fades in and starts moving in one of the five animation styles,
   picked at random from the ones that photo allows.
3. After **10 seconds unpet** it shows a speech bubble with one of **its own**
   taunts, then fades the bubble and carries on. It keeps doing this until pet or
   until it despawns. (Ping Pong, Roll and Hop stop to speak; Peek and Ghost carry
   on with their cycle.)
4. The first `!pet` wins: the floof stops, blooms pink, resolves into a heart, and
   floats away. The bot congratulates the winner in chat and records the win.
5. If nobody pets it within **despawn** seconds it quietly fades out.

Only the *first* claim counts — the winner is locked in synchronously, so two
`!pet`s in the same instant can't both win. The "no floof right now" reply is
rate-limited per user so it can't be spammed.

For **15 seconds after a win** that reply is suppressed entirely. Chat carries on
typing `!pet` for a few seconds after someone has already won, and answering those
stragglers with "there is no floof right now" reads as though the bot had lost
track of the round it just announced. A floof that simply *despawned* unclaimed
gets no such grace period — there genuinely is nothing to pet.

## Testing without touching the scoreboard

**Spawn Floof** spawns on demand, ignoring the enable switch and the live check.
Its two dropdowns let you force a specific photo and/or animation style rather
than taking what you are given, which is what makes tuning a single style
practical.

**Simulate !pet** then stands in for a chatter and plays the win animation. It is
not scored: no win recorded, no chat announcement, no achievement.

## Upgrading from the shared taunt list

Taunts used to be one list shared by every floof. On first start after this
change, that list is **copied onto every photo you already have**, so nothing you
configured is lost. It happens once; later per-floof edits are never clobbered.

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

The winner line is `🐾 {floofName} got a pet from {user}! That is {wins} floof
{plural} for them.` — `{floofName}` is that floof's name, or "The floof" if it has
none. If you had already customised this string your version is kept as-is; add
`{floofName}` to it when you want the name included.
