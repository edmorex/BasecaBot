# Boss Battle

A boss takes over the whole screen and chat fights it **with emotes**. Every boss
is built in the admin panel with its own art, health, weaknesses and taunts, so
two bosses need not play alike.

There are **no chat commands** — chat plays simply by using emotes. The bot only
reads messages in the broadcaster's own channel, never in a guest channel.

---

## OBS setup

Add **Boss Battle** from **Admin → Overlays** as a Browser Source:

- **Size it 1920 × 1080** and position it over the full screen. The overlay is
  authored at that resolution and scales to whatever you actually give it, so a
  smaller or larger source still composes correctly — it just scales.
- Tick **Control audio via OBS** on the source, or the sound effects and music
  play out of your desktop instead of into your stream.
- Add it **once**. Two copies of the source means two copies of every sound.

The overlay renders nothing until a battle starts, so it is safe to leave in a
scene permanently.

---

## How a battle plays out

**1. Red alert (≈3s).** The screen pulses red with `WARNING! A BOSS IS
APPROACHING!` over a klaxon, and the bot warns chat.

**2. Incoming boss dossier (≈5s).** The boss looms on the left while its file
types itself out on the right like an old military terminal: name, description,
then `Vulnerabilities:` followed by the **public** emotes as images. If the boss
also has secret weaknesses, the line ends with `and ???` — or is just `???` when
every weakness is a secret.

**3. Spawn.** The boss fades in centre screen, a giant health bar fills across the
top, and it delivers its opening taunt.

**4. The fight.** The battle music loops. The boss drifts, darts or spins, pausing
every so often to taunt — and it re-rolls its movement style at each pause. As
chatters join, their Twitch profile pictures pile in along the bottom of the
screen, starting at the centre and squeezing together as the crowd grows. Every
message that throws emotes fires red laser beams from that chatter's icon at the
boss, with the damage floating off it.

**5. Defeat or escape.** At 0 HP the boss stops dead, shakes itself apart while
delivering its death taunt as mini-explosions burst across it, and then goes up in
one final blast with a victory sting — after which the bot congratulates chat. If
the escape timer runs out first, it gets its escape taunt in, fades away with a
sad sting, and the bot reports the failure.

How long the dying words linger before the banner lands is the **Outro taunt
holds** setting.

---

## Combat rules

| Situation | Result |
|---|---|
| A message contains one of the boss's **hurt** emotes | **1 HP of damage** |
| A message contains *several different* hurt emotes | **1 HP each** — three different weaknesses in one message is 3 damage |
| The same hurt emote repeated | **1 hit, the rest are misses** — variety beats spam |
| An emote the boss is immune to | **miss** |
| A **heal** emote | **+1 HP**, never above the boss's starting health |
| Anything sent while the sender is on cooldown | **all misses** |

Damage counts **distinct** emotes per message, so `Kappa Kappa Kappa` does one
point of damage and two misses, while `Kappa PogChamp LUL` (against a boss weak
to all three) does three.

### The cooldown

After a message **lands** — dealing damage *or* healing — that chatter is on
cooldown for `Emote cooldown` seconds. Everything they send in the meantime shows
as a grey `MISS`, so the audience can see who is landing blows and who is
reloading. Healers are held to exactly the same clock, so defending the boss is
never easier than attacking it.

A miss does **not** start the cooldown, so someone who guesses wrong is free to
guess again immediately.

### Colour tells

The health bar and the boss's own aura run **green → yellow → red** across the
three thirds of its health, so a glance at the screen says how the fight is
going. (This is the reverse of the Boss Floof in Pet the Floof, where the colour
tracks danger to the floof rather than chat's progress.)

---

## Admin panel

**Admin → Boss Battle.**

### Game enabled
A master switch. The buttons in the panel always work regardless, so you can
always test; the switch exists to gate any automatic trigger.

### Start a battle
Pick a boss (or leave it on **Random** to draw from the enabled ones), set the
**delay** slider, and press **Start Boss Battle**. The delay is the point: hit
start before you get up for a break and the boss arrives once you're away.
**Cancel** stops a battle that is still counting down.

### Simulate
**Spawn** runs a complete mock battle — every phase, every sound — but **records
nothing**: no scoreboard rows, no achievements, no chat messages. **Hit**,
**Miss** and **Heal** stand in for a chatter and run through exactly the same
combat code as a real message, so you can step a boss down to zero and watch the
whole death sequence without touching the database.

Real chat *can* still join a simulated battle (useful for checking that your
emote names actually match what viewers type) and is likewise never recorded.

### Settings

| Setting | Default | What it does |
|---|---|---|
| Emote cooldown | 30s | How long after a landed hit before that chatter's emotes count again |
| Red alert holds | 3s | Length of the klaxon warning |
| Dossier holds | 5s | Length of the intel screen (the typing speed adapts to fit) |
| Taunt every | 12s | Seconds of movement between taunt pauses |
| Taunt holds | 3s | How long the boss stops to speak |
| Dart leg | 0.6s | Seconds per zig-zag leg in the darting style |
| Spin radius | 180px | Size of the circular path in the spin style |
| Spin lap | 6s | Seconds for one full circle |
| Max fighters shown | 60 | Avatars drawn along the bottom (everyone still counts for credit) |
| Outro taunt holds | 3s | How long the death/escape taunt lingers before the final banner |
| Sound effects / Battle music | 80% / 50% | Playback volumes |

### Sounds

Eight slots — red alert klaxon, terminal typing, boss arrival, hit, heal,
victory, escape, and the looping battle music. Upload **MP3, OGG or WAV**;
effects up to **2MB**, music up to **8MB**.

**Nothing ships by default.** An empty slot simply plays silence and the game
works fine without it. Replacing a sound takes effect on the **next battle** —
no need to refresh the Browser Source.

---

## Building a boss

**Create New Boss** opens the editor.

| Field | Notes |
|---|---|
| **Name** | Used on the dossier and in the bot's chat announcements |
| **Description** | Typed out under the name on the intel screen |
| **Portrait** | A **square PNG under 2MB**, uploaded here and shared by all bosses |
| **Health (HP)** | How many distinct vulnerable emotes it takes to kill it |
| **Escapes after** | Seconds the fight lasts before it gets away |
| **Size** | 128, 256, 384 or 512 px, as drawn on a 1920×1080 overlay |
| **Speed at full health / near death** | 1 (slow) to 10 (fast), interpolated as health drains |
| **Include in the random pool** | Untick to keep a boss out of **Random** while still spawning it by name |
| **Emotes that hurt — public** | Damage it, and are **shown** on the intel screen |
| **Emotes that hurt — private** | Damage it, but appear only as `???` |
| **Emotes that heal** | Heal it, and are never revealed |
| **Opening / Death / Escape taunt** | Spoken at the start, on death and on escape |
| **Battle taunts** | One picked at random at each pause |
| **Movement styles** | Ping Pong, Darting, Spin — see below |

### ⚠️ Emote names are case-sensitive

Twitch treats `Kappa` and `kappa` as different emotes, so the bot does too. A
weakness typed with the wrong capitalisation will simply never trigger, and there
is no error to tell you — the boss just feels invincible. Copy names exactly as
they appear in chat.

### ⚠️ Twitch emotes only

Weaknesses are matched against Twitch's own emote tags: **global, channel and
subscriber emotes work** — including subscriber emotes from other channels, since
viewers bring those into your chat. Third-party emotes (7TV, BTTV, FFZ) are not
carried in those tags and **cannot be used** as weaknesses or heals.

### Where the dossier art comes from

Twitch can list your channel's emotes and the global ones, but offers **no way to
look up an arbitrary emote by name** — so a subscriber emote from somebody else's
channel has no discoverable image.

The bot works around this by banking the emote ids carried in every chat message
it sees: once an emote has been **used in your chat at least once**, its picture
is available to the dossier forever. Until then that vulnerability is listed by
**name as plain text**, which still reads fine — it just isn't as pretty.

In practice this sorts itself out: emotes your viewers actually use are exactly
the ones the bot will have banked. If you want a weakness to show its art on day
one, have someone post it in chat before the first battle.

### Movement styles

| Style | Behaviour |
|---|---|
| **Ping Pong** | Drifts in a straight line and bounces off the edges, like the floofs |
| **Darting** | Zig-zags, sprinting to random points around the screen |
| **Spin** | Orbits a point in a circle while the art itself rotates |

Tick as many as you like: one is re-rolled from the ticked set every time the
boss pauses to taunt. Ticking none falls back to Ping Pong, since a boss with no
style would stand perfectly still.

### Speeds run either way

`Speed at full health` and `Speed near death` are just the two ends of a line. Set
the first higher for a boss that starts frantic and tires; set the second higher
for one that grows more desperate as chat wears it down.

---

## Achievements

| Achievement | Earned by |
|---|---|
| 🦸 **Basecamp Hero** | Landing the killing blow on a boss (one time only) |
| 🛡️ **Basecamp Protector I / II / III** | Helping chat defeat 1 / 25 / 50 bosses |

Only chatters who actually **took health off** the boss are credited. Pure
healers were fighting for the other side, and someone who only ever missed never
landed a blow.

---

## Chat messages

Editable under **Admin → Text Strings → boss**.

| Key | Default |
|---|---|
| `warning` | 🚨 WARNING! A BOSS IS APPROACHING! Ready your emotes — hit it with what it fears! |
| `defeated` | ⚔️ {boss} has been DEFEATED by {count} chatters! Killing blow: {killer}. 🎉 {names} |
| `escaped` | 💀 {boss} ESCAPED with {hp} HP left! Chat was not strong enough… |

As everywhere else, blanking a string disables that message.

---

## Deployment

> **⚠️ One-time host setup.** `public/` is baked into the Docker image, so boss
> art and sounds uploaded from the admin panel would be wiped on every
> `up --build` without a bind mount. Create the directory on the host once:
>
> ```sh
> mkdir -p /opt/boss
> ```
>
> `docker-compose.yml` mounts it at `/app/public/assets/boss`.

Uploaded files are served from `/assets/boss/…`; sounds are stored under a
per-slot name (`sfx-hit.mp3` and friends) so a slot can never hold two files at
once.
