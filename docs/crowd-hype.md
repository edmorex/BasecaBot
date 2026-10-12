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

**How long they stay.** Being *loud* and being *present* are measured over
different spans. The **rate window** decides how active someone counts as right
now; **window survival** decides how long they stay on screen after going quiet —
`rate window × survival`, so the defaults keep a chatter for **five minutes** from
a single message. Their score still falls to zero as soon as the rate window
passes, so a lingering chatter sinks to the back and never outranks someone
talking now. Survival is not a reservation: once the rows are full, the quiet tail
is the first to be displaced by a busier chatter.

**Who appears.** Anyone who talks joins the crowd. The front row holds **Per row**
people and the rows behind alternate one fewer — 6, 5, 6, 5 at the default — with
the short rows sitting on the **midpoints** of the row in front so they fill the
gaps between heads rather than lining everyone up in columns. Seats fill from the
**middle of each row outwards**, so a quiet chat gathers in the centre instead of
hugging the left edge.

The **farthest row is the prime spot**: the loudest chatters fill it first and the
rows in front take the overflow, so a quiet chat appears at the back. The loudest
chatters take the back row — "loudest" being
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
| **Clear for** N | Empties the overlay and stops taking updates for N seconds |
| **Clear until resume** | The same, but held until you press Resume |
| **Quiesce for** N | Leaves everyone on screen but holds them at level 1 for N seconds, so they settle |
| **Quiesce until resume** | The same, but held until you press Resume |
| **Slow mode for** N | Swaps every excitement level for the Slow-mode movement — a gentle sway instead of hopping — for N seconds |
| **Slow mode until resume** | The same, but held until you press Resume |
| **Resume now** | Lifts any of the three holds, timed or endless |

All three holds work the same way: the timed ones lift on their own after the given
number of seconds, and the **until resume** ones stay put until Resume — useful when
you don't know yet how long you'll be away. Each has its own seconds box, whose
value is remembered as the default for next time.

Slow mode is a hold rather than a switch, so there is no way to leave it on by
accident: it either expires or you press Resume. It also eases in and out over the
**Transition time**, and while it is easing the emote spew blends between its two
sets of values, so nothing changes character in a single frame.

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
| Window survival | 50 | Silent rate windows a chatter survives before leaving |
| Transition time | 4s | Seconds to ease one excitement level (see below); 0 snaps |
| Emote spew | on | Throw spammed emotes out of the silhouettes (see *Emote spew* below) |

Plus, per excitement level: a **threshold** (the rate needed to reach it) and
**jump**, **bounce**, **sway**, **jitter** and **drift** values. Thresholds are forced
ascending on save — a level you could never reach because the one above it is
lower would just be a dead setting. **Slow mode** has its own set of the same four
values.

Defaults: level 1 from 0/s, level 2 from 0.5/s, level 3 from 1.5/s, level 4 from
3/s, level 5 from 6/s.

#### Easing between levels

The crowd does not apply a level the moment the chat rate crosses a threshold.
The level it animates at is a *continuous* value that walks toward the level the
rate currently calls for, and **Transition time** is how long one whole level step
takes — so at the 4s default a jump from level 2 to level 3 takes four seconds, and
chat going from silent to peak hype takes sixteen as the crowd climbs through 3 and
4 on the way. Because the value moves continuously it cannot skip a level: every
level in between is actually animated, which is what stops a burst of chat reading
as a glitch rather than as the crowd getting excited.

Lower it for a twitchier crowd, raise it for a slower swell, or set it to **0** for
the old behaviour where a threshold crossing snaps the whole crowd to the new level
between two frames. Slow mode fades in and out over the same duration.

### Emote spew

When somebody spams an emote it is thrown up out of their silhouette. There are two
sets of the same six values: one for **normal mode** and one for **slow mode**, so
the crowd's emotes calm down with the rest of it.

| Setting | Normal | Slow | What it does |
|---|---|---|---|
| Launch speed | 260px/s | 110px/s | How fast the emote travels |
| Launch variability | 30px/s | 15px/s | Plus-or-minus on the speed, so a launch of 260 ± 30 fires between 230 and 290 |
| Launch distance | 300px | 140px | How far it travels before it tops out |
| Distance variability | 60px | 30px | Plus-or-minus on the distance |
| Emote size | 44px | 40px | Rendered size |
| Emote lifetime | 2.2s | 2.8s | Total seconds on screen before it has faded |

Speed and distance are independent, which is what lets you ask for a fast short lob
or a slow high arc. An emote travels its distance at its speed, so it reaches the top
of its arc after **distance ÷ speed** seconds and then floats and fades for whatever
is left of its lifetime. At the normal defaults that is about 1.2s of flight and 1s
of float; the slow defaults give a shorter, lazier lob that lingers.

Both values are scaled down for the rows further back, so the *ratio* — and therefore
the timing — is the same wherever in the crowd the emote came from. If distance and
speed would take longer than the lifetime, the arc is compressed to fit rather than
cut off mid-flight.

Each launch rolls its own speed and distance inside the variability, but the whole
burst from one message is rolled once, so a five-emote spam reads as one burst.

### Seats, not people

The crowd is built out of **seats**. A seat owns its position, its character
artwork and its bounce rhythm, and keeps all three for as long as the layout
holds. A chatter is only ever the *occupant* — the profile picture showing on that
seat.

So when activity reshuffles the crowd, **only the icons move between positions**.
The characters stay exactly where they are, and a chatter dropping into a seat
mid-bounce joins that spot's rhythm rather than restarting it. (This is also the
groundwork for pinning specific artwork to specific positions.)

Which silhouette a seat wears is either **pinned** by you or **drawn at random**
when the seat fills — see *Assigning seats* below. Either way it is settled for as
long as somebody is standing there.

### Assigning seats

**Silhouettes → Assign Seats** opens a grid with one cell per seat, laid out the
way the crowd appears on screen: the farthest row at the top, the front row at the
bottom, and the short rows inset half a cell because that is where they actually
sit. Each cell previews the character pinned to that seat (on the glow colour, so
all-black artwork is still visible) with a **Change** button underneath that opens
a picker of the whole library plus *Random*.

| Choice | Behaviour |
|---|---|
| **Random** (the default) | The seat draws a character from the library whenever somebody new stands there |
| A specific file | That character is used every single time the seat fills |

| Button | Does |
|---|---|
| **Save** | Keeps the assignments and returns to the panel |
| **Cancel** | Returns without saving — nothing is written until you press Save |
| **Randomize** | Pins every seat to a specific character picked at random, so the crowd is fixed but varied |
| **Default** | Puts every seat back to Random |

Note the difference between *Random* and *Randomize*: a Random seat re-draws each
time it fills, while Randomize pins a one-off random choice that then never
changes.

Two details worth knowing. Assignments for rows or slots that do not currently
exist are **kept**, so shrinking the layout and growing it again does not lose the
work. And deleting a silhouette **frees any seat pinned to it** back to Random,
rather than leaving that seat pointing at a file that is gone.

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
