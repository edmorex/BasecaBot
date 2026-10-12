# Crowd Hype

Chat drawn as a concert audience along the bottom of the screen — silhouettes
looking "forward" at whatever the overlay sits on top of, MST3K-style, with each
chatter's profile picture on them. The crowd gets more excited the faster chat
moves, and throws the emotes people are spamming up into the air.

It works in **guest channels**: while the bot is connected to one with
`!connect`, the crowd is driven by *that* channel's chat, so the overlay can
front a collab. See [guest-channels.md](guest-channels.md).

There are **no chat commands** — people join the crowd simply by talking.

---

## OBS setup

Add **Crowd Hype** from **Admin → Overlays** as a Browser Source:

- **Size it 1280 × 720.** The overlay is authored at that resolution and scales to
  whatever you give it, so a bigger or smaller source still composes correctly.
- Place it over the bottom of your scene. The crowd is anchored to the bottom
  edge; the rest of the frame is transparent.

The overlay renders nothing until chat moves, so it is safe to leave in a scene.

---

## How the crowd behaves

**Who appears.** Anyone who talks joins the crowd. The front row holds **Per row**
people and the rows behind alternate one fewer — 6, 5, 6, 5 at the default — with
the short rows sitting on the **midpoints** of the row in front so they fill the
gaps between heads rather than lining everyone up in columns. Seats fill from the
**middle of each row outwards**, so a quiet chat gathers in the centre instead of
hugging the left edge. The loudest chatters take the front row — "loudest" being
messages plus emotes over the rate window, with ties going to whoever spoke most
recently. Rows behind sit higher and smaller to fake distance.

**Row hold.** Chat rankings churn constantly, so a chatter is pinned to their row
for **Row hold** seconds after arriving in it. Without that, people would
teleport between rows several times a second. A newly-loud chatter waits for a
gap rather than shoving someone aside mid-animation.

**Excitement.** Five levels, chosen from how many **messages plus emotes per
second** chat is producing over the rate window. Each level has its own jump
height, bounce rate, sway, jitter and **drift**, so the crowd goes from barely
nodding to genuinely bouncing. Every member gets a random phase so they don't move
as one.

**Drift** is the sideways wander, and it runs on its own slower clock than the
bouncing. At the higher levels it is deliberately wide enough that neighbours
**overlap** — a crowd rubbing shoulders rather than a row of pegs. How much drift
it takes to overlap depends on your layout: a 6-wide row on a 1280-wide overlay
gives ~213px lanes against a ~118px silhouette, so shoulders start meeting around
46px of drift. Narrower lanes (more per row) overlap far sooner. Members at the
far left and right are clamped so they never hang half off the stage.

**Emote spew.** When someone spams emotes, those same emotes are thrown up and
outward from their silhouette. The art comes straight from the message's own
Twitch tags, so there is nothing to configure per emote — and it is capped at six
per chatter per frame so one spammer cannot bury the screen.

**Glow.** A back-light behind each silhouette, which is what keeps the layered
rows readable against each other. Set it to 0 to switch it off.

---

## Admin panel

**Admin → Crowd Hype.** Settings save as you change them; the three sections are
Live control, Simulation and Configuration.

### Live control

Overrides for while you are on air. **None of these are saved** — the crowd comes
back in regular mode after a restart, which is what you want from a live switch.

| Control | What it does |
|---|---|
| **Overlay enabled** | When off the overlay draws nothing at all, whatever chat is doing |
| **Slow mode** | Swaps every excitement level for the Slow-mode movement — a gentle sway instead of hopping |
| **Clear and pause** | Empties the overlay and stops taking updates for N seconds |
| **Clear and wait** | The same, but held until you press Resume |
| **Quiesce and pause** | Leaves everyone on screen but holds them at level 1 for N seconds, so they settle |
| **Quiesce and wait** | The same, but held until you press Resume |
| **Resume now** | Lifts either hold, timed or endless |

The **pause** variants lift on their own after the given number of seconds; the
**wait** variants stay put until Resume — useful when you don't know yet how long
you'll be away.

A quiesce holds the *excitement level*, not the roster: chatters who go quiet
still drift off the screen as their activity ages out of the rate window. A clear
empties it outright and takes no updates at all until the hold lifts.

The panel prints whichever hold is in force underneath, so a paused overlay is
never a mystery.

### Simulation

Feeds the overlay invented chat so the settings can be judged without an
audience: a number of fake chatters, a messages-per-second rate and an
emotes-per-second rate. Arrival is bursty rather than metronomic, which looks far
more like real chat.

The fake chatters throw **real Twitch global emotes**, so the spew is visible
while you tune it. Nothing is recorded, fake chatters never trigger a
profile-picture lookup, and real chat still counts while the simulation runs.

### Configuration

| Setting | Default | What it does |
|---|---|---|
| Rows | 3 | Rows of silhouettes |
| Per row | 6 | Front-row silhouettes (minimum 2); rows behind alternate one fewer |
| Space between rows | 46px | How much higher each row sits |
| Row scale | 0.86 | Size multiplier per row back |
| Silhouette height | 190px | Front-row height |
| Avatar size | 46px | Profile-picture diameter |
| Glow | 18 | Back-light strength; 0 turns it off |
| Glow colour | `#ff6ec7` | The back-light hue |
| Mirror silhouettes | Never flip | When to flip the artwork horizontally (see below) |
| Row hold | 4s | Before a chatter may change row |
| Rate window | 6s | Seconds of chat the rate is measured over |
| Emote spew | on | Throw spammed emotes out of the silhouettes |
| Launch speed / size / lifetime | 260px/s, 44px, 2.2s | How the spewed emotes fly |

Plus, per excitement level: a **threshold** (the rate needed to reach it) and
**jump**, **bounce**, **sway**, **jitter** and **drift** values. Thresholds are forced
ascending on save — a level you could never reach because the one above it is
lower would just be a dead setting. **Slow mode** has its own set of the same four
values.

Defaults: level 1 from 0/s, level 2 from 0.5/s, level 3 from 1.5/s, level 4 from
3/s, level 5 from 6/s.

### Mirroring

Silhouettes can be flipped horizontally so a crowd built from one or two shapes
does not look like a row of clones:

| Mode | Behaviour |
|---|---|
| **Never flip** | The uploaded artwork, always. The default, so nothing changes until you ask for it |
| **Flip while drifting right** | As-uploaded while a member drifts left, mirrored while they drift right — they appear to turn into the direction they are moving |
| **Flip on the left half** | Mirrored on the left of the screen, as-uploaded on the right, so the whole crowd faces inward |

The flip is applied to the silhouette only — never to the profile picture, which
would mirror any text or logo in someone's avatar.

### Silhouettes

Upload PNGs, up to 2MB each. They need **not** be square — taller than wide suits
a person — and each chatter keeps the same shape for as long as they are on
screen. With none uploaded the crowd falls back to a plain head-and-shoulders
shape, so the overlay is never simply blank.

---

## Profile pictures

Avatars come from stored user records where we have them, and from Twitch in one
batched call otherwise, cached in memory so a chatter is only ever looked up once.

> **In a guest channel, avatars are fetched but not kept.** Those are somebody
> else's viewers, and quietly creating user records for them is not this overlay's
> business. In the broadcaster's own channel the results are cached to the user
> records as usual.

---

## Deployment

> **⚠️ One-time host setup.** `public/` is baked into the Docker image, so
> silhouettes uploaded from the panel would be wiped on every `up --build`
> without a bind mount. Create the directory on the host once:
>
> ```sh
> mkdir -p /opt/crowd
> ```
>
> `docker-compose.yml` mounts it at `/app/public/assets/crowd`.
