/**
 * OBS browser-source overlay for Crowd Hype.
 *
 * Chat drawn as a concert audience along the bottom of the screen, silhouetted
 * MST3K-style and looking "forward" at whatever the overlay sits on top of. The
 * crowd's energy tracks how fast chat is moving.
 *
 * Authored against 1280x720 and scaled to whatever the Browser Source is set to,
 * so every number below is a design pixel.
 *
 * The crowd is built out of SEATS, not people. A seat owns its position, its
 * silhouette and its animation phase, and it keeps all three for as long as the
 * layout holds; a chatter is simply the occupant whose profile picture is showing.
 * So when activity reshuffles the crowd, only the icons move between seats — the
 * characters themselves stay put. (That is also what will let specific artwork be
 * pinned to specific positions later.)
 *
 * The bot owns the arithmetic — the rate, the excitement level, who stands in
 * which row — and sends it with the settings on every tick. This page only draws,
 * with two exceptions it is better placed to handle:
 *   - which slot within a row a chatter takes, kept sticky so a wobbling rank
 *     does not slide anyone sideways every tick;
 *   - each seat gets a random phase, so the crowd does not move in lockstep.
 *
 * Self-contained (inline CSS/JS, no bundler); because this string is a template
 * literal, the embedded script uses plain concatenation and avoids dollar-brace
 * and backtick characters.
 */
export function crowdHypeOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Crowd Hype — Overlay</title>
<style>
  html,body{ margin:0; width:100%; height:100%; background:transparent; overflow:hidden;
    font-family:system-ui,'Segoe UI',sans-serif; }
  /* Authored at 1280x720 and scaled to fit whatever OBS gives us. */
  #stage{ position:fixed; left:50%; top:50%; width:1280px; height:720px;
    transform:translate(-50%,-50%); transform-origin:50% 50%; }
  #crowd{ position:absolute; inset:0; pointer-events:none; }

  /* One audience member. The wrapper owns position + scale (set per frame); the
     inner body owns the hop and the rock, so the two never fight. */
  .member{ position:absolute; bottom:0; left:0; opacity:0;
    transition:opacity .45s ease; will-change:transform; }
  .member.in{ opacity:1; }
  /* Centred with flex, NOT with auto margins. The body box is a fixed 0.62 x height
     but the artwork is width:auto, so a silhouette wider than that overflows its
     box, and CSS 2.1 10.3.3 says a box wider than its container has its auto
     margins treated as ZERO. So margin:0 auto centred the narrow images and quietly
     left every wider one flush against the left edge, with the avatar centred on
     the box sitting off to the left of the artwork. Flex centring overflows both
     sides equally, so the two agree at every aspect ratio. */
  .body{ position:relative; display:flex; justify-content:center; align-items:flex-end;
    transform-origin:50% 100%; color:rgba(8,6,12,.96); }
  .sil{ display:block; height:100%; width:auto; flex:none; }
  /* The profile picture sits at the silhouette's bottom centre. */
  .av{ position:absolute; left:50%; bottom:0; border-radius:50%;
    transform:translate(-50%,28%); background:#241a2b center/cover no-repeat;
    border:2px solid rgba(255,255,255,.85); box-shadow:0 2px 8px rgba(0,0,0,.6);
    display:flex; align-items:center; justify-content:center;
    color:#fff; font-weight:800; text-shadow:0 1px 3px rgba(0,0,0,.9); }
  /* Fallback shape for before any silhouette has been uploaded: a plain
     head-and-shoulders, so the overlay is never simply blank. */
  .stand-in{ display:block; width:100%; height:100%; flex:none;
    background:currentColor;
    -webkit-mask:radial-gradient(circle at 50% 22%, #000 0 19%, transparent 20%) no-repeat,
      radial-gradient(ellipse 54% 44% at 50% 100%, #000 0 99%, transparent 100%) no-repeat;
    mask:radial-gradient(circle at 50% 22%, #000 0 19%, transparent 20%) no-repeat,
      radial-gradient(ellipse 54% 44% at 50% 100%, #000 0 99%, transparent 100%) no-repeat; }

  .spew{ position:absolute; left:0; bottom:0; pointer-events:none; }
  .spew img{ display:block; width:100%; height:100%; filter:drop-shadow(0 2px 6px rgba(0,0,0,.6)); }
</style>
</head>
<body>
<div id="stage"><div id="crowd"></div></div>
<script>
(function(){
  'use strict';
  var W = 1280, H = 720;
  var stage = document.getElementById('stage');
  var crowd = document.getElementById('crowd');

  function fit(){
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ── State ─────────────────────────────────────────────────────────────────
  var cfg = {
    rows:3, rowSpacing:46, perRow:6, rowScale:.86, silhouetteHeight:190, avatarSize:46,
    glow:18, glowColor:'#ff6ec7', mirrorMode:'off', silhouettes:[], seatArt:{},
    emoteSpew:true,
    spew:{ speed:260, speedVar:30, distance:300, distanceVar:60, size:44, seconds:2.2 },
    spewSlow:{ speed:110, speedVar:15, distance:140, distanceVar:30, size:40, seconds:2.8 },
    transitionSeconds:4,
    levels:[{ jumpPx:0, bounceHz:.5, swayDeg:2, jitterPx:0, driftPx:4 }],
    calm:{ jumpPx:0, bounceHz:.35, swayDeg:6, jitterPx:0, driftPx:10 }
  };
  var seats = {};         // "row:slot" -> a seat, which owns its art and phase
  var assign = {};        // userId -> "row:slot"
  var enabled = false;
  var started = performance.now();
  // Where the crowd's excitement actually is, as a fraction between levels, and
  // where it is heading. Snapping between levels made the animation visibly
  // glitch, so this eases instead — and because it walks the scale rather than
  // jumping, it can never skip a level on the way.
  var levelNow = 1, levelTarget = 1;
  // 0 = the level animation, 1 = fully in Slow Mode. Eased on the same clock.
  var slowMix = 0;
  var animNow = null;
  var lastFrame = 0;

  function num(v, d){ var n = Number(v); return isFinite(n) ? n : d; }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Seats ─────────────────────────────────────────────────────────────────
  function seatKey(row, slot){ return row + ':' + slot; }

  /**
   * Which silhouette a seat wears.
   *
   * A seat the broadcaster has pinned always uses that artwork. An unpinned seat
   * draws one at random — but only when it FILLS, which is what keeps a character
   * in place for as long as somebody is standing there. Re-rolling every frame, or
   * on every reshuffle, is the thing to avoid.
   */
  function artFor(seat){
    var pinned = (cfg.seatArt || {})[seatKey(seat.row, seat.slot)];
    if (pinned) return pinned;
    var list = cfg.silhouettes || [];
    if (!list.length) return null;
    if (!seat.rolled || list.indexOf(seat.rolled) === -1){
      seat.rolled = list[Math.floor(Math.random() * list.length)];
    }
    return seat.rolled;
  }

  function buildSeat(row, slot){
    var el = document.createElement('div');
    el.className = 'member';
    var body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    crowd.appendChild(el);
    return {
      el: el, body: body, row: row, slot: slot,
      // The phase belongs to the seat, so a chatter arriving mid-bounce drops into
      // the rhythm of the spot rather than restarting it. It accumulates frame by
      // frame -- see the hop in frame().
      beat: Math.random() * Math.PI * 2,
      rateJitter: 0.85 + Math.random() * 0.3,
      driftPhase: Math.random() * Math.PI * 2,
      driftRate: 0.18 + Math.random() * 0.22,
      jitter: { x:0, y:0 }, jitterAt: 0,
      art: null, sil: null, flipped: false, sig: '',
      // The random draw for an unpinned seat, taken when it fills.
      rolled: null,
      avatar: null, avatarUrl: undefined, user: null, name: ''
    };
  }

  function getSeat(row, slot){
    var key = seatKey(row, slot);
    var s = seats[key];
    if (!s){ s = buildSeat(row, slot); seats[key] = s; }
    return s;
  }

  /** Draw a seat's own artwork, and the avatar of whoever is in it. */
  function paint(seat){
    var art = artFor(seat);
    if (seat.sil !== art){
      seat.sil = art;
      seat.body.innerHTML = art
        ? '<img class="sil" src="' + esc(art) + '" alt="" />'
        : '<span class="stand-in"></span>';
      seat.art = seat.body.firstChild;
      seat.flipped = false;
      seat.avatar = null;         // the avatar node went with it
    }
    if (!seat.avatar){
      var av = document.createElement('div');
      av.className = 'av';
      seat.body.appendChild(av);
      seat.avatar = av;
      seat.avatarUrl = undefined;
      seat.sig = '';              // a fresh avatar node needs its sizing applied again
    }
    if (seat.avatarUrl !== seat.occupantAvatar){
      seat.avatarUrl = seat.occupantAvatar;
      if (seat.occupantAvatar){
        seat.avatar.style.backgroundImage = 'url("' + seat.occupantAvatar + '")';
        seat.avatar.textContent = '';
      } else {
        seat.avatar.style.backgroundImage = '';
        seat.avatar.textContent = String(seat.name || '?').charAt(0).toUpperCase();
      }
    }
  }

  /**
   * Seat everyone the bot sent.
   *
   * Rows come from the bot; the slot within a row is decided here and kept sticky,
   * so a chatter who holds their row keeps their exact spot. Only the occupancy
   * changes hands — the seats, and the characters sitting in them, stay where they
   * are.
   */
  function assignSeats(list){
    var taken = {};
    var next = {};
    var needs = [];
    var orders = {};

    for (var i = 0; i < list.length; i++){
      var m = list[i];
      var cur = assign[m.id];
      if (cur){
        var parts = cur.split(':');
        if (Number(parts[0]) === m.row && Number(parts[1]) < rowCapacity(m.row) && !taken[cur]){
          taken[cur] = m.id; next[m.id] = cur; continue;
        }
      }
      needs.push(m);
    }
    for (var j = 0; j < needs.length; j++){
      var who = needs[j];
      if (!orders[who.row]) orders[who.row] = slotOrder(rowCapacity(who.row));
      var order = orders[who.row];
      for (var k = 0; k < order.length; k++){
        var key = seatKey(who.row, order[k]);
        if (!taken[key]){ taken[key] = who.id; next[who.id] = key; break; }
      }
    }

    // Hand each seat its occupant, or none.
    var byKey = {};
    for (var n = 0; n < list.length; n++) if (next[list[n].id]) byKey[next[list[n].id]] = list[n];
    for (var key2 in byKey){
      var occ = byKey[key2];
      var bits = key2.split(':');
      var seat = getSeat(Number(bits[0]), Number(bits[1]));
      seat.user = occ.id;
      seat.name = occ.name;
      seat.occupantAvatar = occ.avatarUrl || null;
      paint(seat);
      seat.el.classList.add('in');
    }
    for (var key3 in seats){
      var s3 = seats[key3];
      if (byKey[key3]) continue;
      // Empty seats fade out rather than being torn down: the character belongs to
      // the position, so it is waiting for the next occupant.
      if (s3.user !== null){
        s3.user = null;
        s3.occupantAvatar = null;
        s3.rolled = null;        // next time it fills, an unpinned seat draws again
        s3.el.classList.remove('in');
      }
      // Drop a seat only once the layout no longer has room for it.
      if (s3.row >= Math.max(1, Math.round(cfg.rows)) || s3.slot >= rowCapacity(s3.row)){
        if (s3.el.parentNode) s3.el.parentNode.removeChild(s3.el);
        delete seats[key3];
      }
    }
    assign = next;
  }

  // ── Emote spew ────────────────────────────────────────────────────────────
  var SPEW_KEYS = ['speed', 'speedVar', 'distance', 'distanceVar', 'size', 'seconds'];

  /**
   * The launch settings to use right now: the normal set blended toward the slow
   * one by how far slow mode has eased in. Read once per burst rather than per
   * frame, since a launch is a one-shot animation.
   */
  function spewSettings(){
    var a = cfg.spew || {};
    var b = cfg.spewSlow || a;
    var k = Math.min(1, Math.max(0, slowMix));
    var out = {};
    for (var i = 0; i < SPEW_KEYS.length; i++){
      var key = SPEW_KEYS[i];
      var av = num(a[key], 0);
      out[key] = av + (num(b[key], av) - av) * k;
    }
    return out;
  }

  /** A value randomised by plus-or-minus its variability, never below a floor. */
  function vary(value, variability, floor){
    var v = num(value, floor) + (Math.random() * 2 - 1) * Math.max(0, num(variability, 0));
    return Math.max(floor, v);
  }

  function spew(id, urls){
    var p = seats[assign[id]];
    if (!p || !urls || !urls.length) return;
    if (crowd.querySelectorAll('.spew').length > 120) return;   // keep a lid on it
    var base = anchor(p);
    var sp = spewSettings();
    for (var i = 0; i < urls.length; i++){
      var size = Math.max(8, sp.size) * base.scale;
      var d = document.createElement('div');
      d.className = 'spew';
      d.style.width = size + 'px';
      d.style.height = size + 'px';
      d.style.left = (base.x - size / 2) + 'px';
      d.style.bottom = (base.y + base.height * 0.55) + 'px';
      d.innerHTML = '<img src="' + esc(urls[i]) + '" alt="" ' +
        'onerror="this.parentNode &amp;&amp; this.parentNode.remove()" />';
      crowd.appendChild(d);

      // Up and outward, with a little gravity on the way down. Distance is how far
      // it travels and speed is how fast, so the time it takes to get there is
      // distance/speed and the rest of its lifetime is spent floating and fading.
      // Both are scaled per row, so the ratio — and therefore the timing — is the
      // same wherever in the crowd it came from.
      var life = Math.max(0.3, num(sp.seconds, 2.2));
      var ms = life * 1000;
      var speed = vary(sp.speed, sp.speedVar, 20) * base.scale;
      var rise = vary(sp.distance, sp.distanceVar, 10) * base.scale;
      var apex = Math.min(0.85, Math.max(0.15, (rise / speed) / life));
      var spread = (Math.random() * 2 - 1) * rise * 0.55;
      var spin = (Math.random() * 2 - 1) * 90;
      var done = (function(node){ return function(){ if (node.parentNode) node.parentNode.removeChild(node); }; })(d);
      if (d.animate){
        d.animate([
          { transform:'translate(0px,0px) scale(.5) rotate(0deg)', opacity:0 },
          { transform:'translate(' + (spread * 0.5) + 'px,' + (-rise) + 'px) scale(1) rotate(' + (spin * 0.5) + 'deg)', opacity:1, offset:apex },
          { transform:'translate(' + spread + 'px,' + (-rise * 0.6) + 'px) scale(.9) rotate(' + spin + 'deg)', opacity:0 }
        ], { duration: ms, easing:'cubic-bezier(.25,.6,.4,1)', fill:'forwards' }).onfinish = done;
      }
      setTimeout(done, ms + 400);
    }
  }

  /** How many fit in a row: the odd rows behind the front hold one fewer. */
  function rowCapacity(row){
    var full = Math.max(2, Math.round(cfg.perRow));
    return row % 2 === 1 ? full - 1 : full;
  }

  /**
   * Slot order for a row, middle outward, so a sparse crowd gathers in the centre
   * instead of hugging the left edge. For six slots that is 2,3,1,4,0,5.
   */
  function slotOrder(n){
    var mid = (n - 1) / 2;
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    idx.sort(function(a, b){ return Math.abs(a - mid) - Math.abs(b - mid) || a - b; });
    return idx;
  }

  /** Where a member is standing, in design pixels. */
  function anchor(p){
    var rows = Math.max(1, Math.round(cfg.rows));
    var depth = Math.min(p.row, rows - 1);
    var scale = Math.pow(Math.max(.2, cfg.rowScale), depth);
    var lane = W / Math.max(2, Math.round(cfg.perRow));
    var slot = p.slot < 0 ? 0 : p.slot;
    // Short rows sit on the midpoints between the heads in front of them, which
    // fills the gaps rather than stacking everyone into columns.
    var offset = depth % 2 === 1 ? 1 : 0.5;
    return {
      x: lane * (slot + offset),
      y: depth * Math.max(0, cfg.rowSpacing),
      scale: scale,
      height: Math.max(10, cfg.silhouetteHeight) * scale
    };
  }

  // ── Static styles ─────────────────────────────────────────────────────────
  // Of the styles each member needs, only the two transforms actually change from
  // frame to frame. The rest are fixed until the config or the member's row
  // changes, and rewriting them 60 times a second was ~82% of the style writes
  // this overlay makes - every one a chance for the browser to re-run style and
  // layout. They go through applyStatic below, guarded by a signature.
  //
  // STATIC_DEPS is the single source of truth for that guard. Every input the
  // writes in applyStatic read MUST be listed here, or changing that setting in
  // the panel would silently do nothing until the member moved row:
  //
  //   zIndex ........................ rows, row
  //   body height/width/marginLeft .. silhouetteHeight, rowScale, rows, row
  //   body filter (the glow) ........ glow, glowColor
  //   avatar width/height/fontSize .. avatarSize, rowScale, rows, row
  //
  // (body color is a constant and lives in the stylesheet. perRow and rowSpacing
  // feed x/y only, which the per-frame transform rewrites anyway.)
  var STATIC_DEPS = ['row', 'rows', 'rowScale', 'silhouetteHeight', 'avatarSize', 'glow', 'glowColor'];

  /** Signature over every declared dependency; cheap enough to build per frame. */
  function staticSig(d){
    var out = '';
    for (var i = 0; i < STATIC_DEPS.length; i++) out += '|' + d[STATIC_DEPS[i]];
    return out;
  }

  /** The config-invariant writes. Anything read here must be in STATIC_DEPS. */
  function applyStatic(p, base, d){
    p.el.style.zIndex = String(100 + (d.rows - Math.min(p.row, d.rows - 1)));
    p.body.style.height = base.height + 'px';
    p.body.style.width = (base.height * 0.62) + 'px';
    p.body.style.marginLeft = (-base.height * 0.31) + 'px';
    // Two shadows of the same hue at different alphas, for a soft halo. The 8-digit
    // hex carries the alpha, so one colour setting drives both.
    p.body.style.filter = d.glow > 0
      ? 'drop-shadow(0 0 ' + d.glow + 'px ' + d.glowColor + 'bf) drop-shadow(0 0 ' + (d.glow * 2) + 'px ' + d.glowColor + '73)'
      : '';
    if (p.avatar){
      var av = Math.max(8, d.avatarSize) * base.scale;
      p.avatar.style.width = av + 'px';
      p.avatar.style.height = av + 'px';
      p.avatar.style.fontSize = (av * 0.52) + 'px';
    }
  }

  // One object reused every frame, so the guard allocates nothing per member.
  var deps = { row:0, rows:3, rowScale:.86, silhouetteHeight:190, avatarSize:46, glow:18, glowColor:'#ff6ec7' };

  /**
   * Should this member's artwork be mirrored right now?
   *
   * 'move' reads the sign of the drift's derivative rather than comparing frames:
   * the wander is a sine, so cos of the same phase gives the direction exactly,
   * with none of the jitter noise that a frame-to-frame comparison would pick up
   * (which would flap the silhouette back and forth at the turnaround).
   *
   * 'position' uses a deadband around the centre line for the same reason — a
   * member hovering on the midpoint must not flicker.
   */
  function wantsFlip(p, x, t, drift){
    if (cfg.mirrorMode === 'move'){
      if (drift <= 0) return false;                     // not moving, so no direction
      return Math.cos(t * Math.PI * 2 * p.driftRate + p.driftPhase) > 0;
    }
    if (cfg.mirrorMode === 'position'){
      if (x < W / 2 - 8) return true;                   // left half: mirrored
      if (x > W / 2 + 8) return false;                  // right half: as uploaded
      return p.flipped;                                 // inside the deadband, hold
    }
    return false;
  }

  // ── Excitement easing ─────────────────────────────────────────────────────
  var ANIM_KEYS = ['jumpPx', 'bounceHz', 'swayDeg', 'jitterPx', 'driftPx'];

  function lerpAnim(a, b, k){
    var out = {};
    for (var i = 0; i < ANIM_KEYS.length; i++){
      var key = ANIM_KEYS[i];
      var from = num(a && a[key], 0);
      var to = num(b && b[key], 0);
      out[key] = from + (to - from) * k;
    }
    return out;
  }

  /** Move a value toward a target at the given units per second. */
  function approach(value, target, rate, dt){
    if (rate <= 0) return target;                 // a zero transition snaps
    var step = rate * dt;
    if (target > value) return Math.min(target, value + step);
    if (target < value) return Math.max(target, value - step);
    return target;
  }

  /**
   * The animation values for right now: the current fractional level, blended
   * with Slow Mode by however far into it we are.
   */
  function easeAnim(dt){
    var levels = (cfg.levels && cfg.levels.length) ? cfg.levels : [cfg.calm];
    var span = Math.max(0, num(cfg.transitionSeconds, 4));
    var rate = span > 0 ? 1 / span : 0;

    levelTarget = Math.min(levels.length, Math.max(1, levelTarget));
    levelNow = approach(levelNow, levelTarget, rate, dt);
    slowMix = approach(slowMix, cfg.mode === 'slow' ? 1 : 0, rate, dt);

    var lo = Math.max(0, Math.floor(levelNow) - 1);
    var hi = Math.min(levels.length - 1, lo + 1);
    var blended = lerpAnim(levels[lo], levels[hi], levelNow - 1 - lo);
    return slowMix > 0 ? lerpAnim(blended, cfg.calm, slowMix) : blended;
  }

  // ── Animation ─────────────────────────────────────────────────────────────
  function frame(now){
    requestAnimationFrame(frame);
    if (!enabled) return;
    var t = (now - started) / 1000;
    var dt = Math.min(0.25, lastFrame ? (now - lastFrame) / 1000 : 0);
    lastFrame = now;
    var a = easeAnim(dt);
    var jump = Math.max(0, num(a.jumpPx, 0));
    var hz = Math.max(0, num(a.bounceHz, 0));
    var sway = Math.max(0, num(a.swayDeg, 0));
    var jit = Math.max(0, num(a.jitterPx, 0));
    var drift = Math.max(0, num(a.driftPx, 0));
    deps.rows = Math.max(1, Math.round(cfg.rows));
    deps.rowScale = cfg.rowScale;
    deps.silhouetteHeight = cfg.silhouetteHeight;
    deps.avatarSize = num(cfg.avatarSize, 46);
    deps.glow = Math.max(0, num(cfg.glow, 0));
    deps.glowColor = cfg.glowColor || '#ff6ec7';

    for (var key in seats){
      var p = seats[key];
      if (p.user === null) continue;   // an empty seat is mid fade-out
      var base = anchor(p);
      // Advance each member's own phase by this frame's worth, rather than
      // multiplying the elapsed time by the current rate. Changing hz must change
      // how fast the phase ADVANCES, not where the phase is: with beat = t * hz,
      // easing hz rescales the whole elapsed time, so a hair of a change jumps the
      // phase by whole cycles once t is large (five minutes in, one frame of the
      // ease moved it a cycle and a half) and the crowd shakes itself apart.
      p.beat += dt * hz * p.rateJitter * Math.PI;
      // Hop: abs(sin) so they spring off the floor rather than sinking through it.
      var lift = jump > 0 && hz > 0 ? Math.abs(Math.sin(p.beat)) * jump : 0;
      // Rock at half the hop rate, which reads as a sway rather than a shiver.
      var tilt = sway > 0 ? Math.sin(p.beat * 0.5) * sway : 0;
      if (jit > 0 && now - p.jitterAt > 90){
        p.jitterAt = now;
        p.jitter.x = (Math.random() * 2 - 1) * jit;
        p.jitter.y = (Math.random() * 2 - 1) * jit;
      } else if (jit === 0 && (p.jitter.x || p.jitter.y)) {
        p.jitter.x = 0; p.jitter.y = 0;
      }

      // Sideways wander. Nothing clamps it to a lane, so neighbours overlap and
      // the row reads as a crowd rubbing shoulders rather than a row of pegs.
      var wander = drift > 0
        ? Math.sin(t * Math.PI * 2 * p.driftRate + p.driftPhase) * drift
        : 0;
      // Overlapping a neighbour is the point; hanging half off the stage edge is
      // not, so the wander is clamped at the sides but nowhere in between.
      var halfBody = base.height * 0.31;
      var x = base.x + wander + p.jitter.x;
      if (x < halfBody) x = halfBody;
      else if (x > W - halfBody) x = W - halfBody;

      // The only two that genuinely move.
      p.el.style.transform = 'translate(' + x + 'px,' +
        (-(base.y + lift + p.jitter.y)) + 'px)';
      p.body.style.transform = 'rotate(' + tilt.toFixed(2) + 'deg)';

      // Mirroring changes rarely, so it is written on change rather than each
      // frame — the same reasoning as the static styles below.
      var flip = wantsFlip(p, x, t, drift);
      if (flip !== p.flipped && p.art){
        p.flipped = flip;
        p.art.style.transform = flip ? 'scaleX(-1)' : '';
      }

      // Everything else only when one of its declared inputs has changed.
      deps.row = p.row;
      var sig = staticSig(deps);
      if (p.sig !== sig){
        p.sig = sig;
        applyStatic(p, base, deps);
      }
    }
  }
  requestAnimationFrame(frame);

  // ── Messages ──────────────────────────────────────────────────────────────
  function onCrowd(d){
    enabled = !!(d && d.enabled);
    if (d && d.config) for (var k in d.config) cfg[k] = d.config[k];
    if (d && isFinite(d.level)) levelTarget = d.level;
    if (d && d.mode) cfg.mode = d.mode;
    if (!enabled){ assignSeats([]); return; }
    assignSeats((d && d.members) || []);
    var spews = (d && d.spews) || [];
    if (cfg.emoteSpew) for (var i = 0; i < spews.length; i++) spew(spews[i].id, spews[i].urls);
  }

  function onClear(){
    // Tear the seats down outright, so a cleared overlay is genuinely empty.
    for (var key in seats){
      if (seats[key].el.parentNode) seats[key].el.parentNode.removeChild(seats[key].el);
    }
    seats = {};
    assign = {};
    var nodes = crowd.querySelectorAll('.spew');
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  var token = new URLSearchParams(location.search).get('token') || '';
  function connect(){
    var url = (location.protocol === 'https:')
      ? 'wss://' + location.host + '/ws?room=crowd&secret=' + encodeURIComponent(token)
      : 'ws://' + location.hostname + ':8080?room=crowd&secret=' + encodeURIComponent(token);
    var ws;
    try { ws = new WebSocket(url); } catch(e){ setTimeout(connect, 3000); return; }
    ws.onmessage = function(ev){
      try {
        var m = JSON.parse(ev.data);
        if (!m) return;
        if (m.type === 'crowd') onCrowd(m.payload);
        else if (m.type === 'clear') onClear();
      } catch(_e){}
    };
    ws.onerror = function(){ try { ws.close(); } catch(_e){} };
    ws.onclose = function(ev){ if (!ev || ev.code !== 4001) setTimeout(connect, 2500); };
  }
  if (token) connect();
})();
</script>
</body>
</html>`;
}
