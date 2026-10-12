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
 * The bot owns the arithmetic — the rate, the excitement level, who stands in
 * which row — and sends it with the settings on every tick. This page only draws,
 * with two exceptions it is better placed to handle:
 *   - horizontal slots within a row are kept sticky here, so a member whose rank
 *     wobbles does not slide sideways every tick;
 *   - each member gets a random phase, so the crowd does not move in lockstep.
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
  .body{ position:relative; transform-origin:50% 100%; color:rgba(8,6,12,.96); }
  .sil{ display:block; height:100%; width:auto; }
  /* The profile picture sits at the silhouette's bottom centre. */
  .av{ position:absolute; left:50%; bottom:0; border-radius:50%;
    transform:translate(-50%,28%); background:#241a2b center/cover no-repeat;
    border:2px solid rgba(255,255,255,.85); box-shadow:0 2px 8px rgba(0,0,0,.6);
    display:flex; align-items:center; justify-content:center;
    color:#fff; font-weight:800; text-shadow:0 1px 3px rgba(0,0,0,.9); }
  /* Fallback shape for before any silhouette has been uploaded: a plain
     head-and-shoulders, so the overlay is never simply blank. */
  .stand-in{ display:block; width:100%; height:100%;
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
    glow:18, emoteSpew:true, spewSpeed:260, spewSize:44, spewSeconds:2.2,
    anim:{ jumpPx:10, bounceHz:1.6, swayDeg:7, jitterPx:2 }
  };
  var people = {};        // id -> { el, body, row, slot, phase, jitter, jitterAt, name }
  var enabled = false;
  var started = performance.now();

  function num(v, d){ var n = Number(v); return isFinite(n) ? n : d; }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Roster ────────────────────────────────────────────────────────────────
  function build(m){
    var el = document.createElement('div');
    el.className = 'member';
    var body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    crowd.appendChild(el);
    var p = {
      el: el, body: body, row: m.row, slot: -1, name: m.name,
      // A random phase and rate wobble stop the whole crowd moving as one.
      phase: Math.random() * Math.PI * 2,
      rateJitter: 0.85 + Math.random() * 0.3,
      jitter: { x:0, y:0 }, jitterAt: 0,
      sil: null, avatar: null,
      // No signature yet, so applyStatic runs on this member's first frame.
      sig: ''
    };
    people[m.id] = p;
    requestAnimationFrame(function(){ el.classList.add('in'); });
    return p;
  }

  /** Redraw a member's artwork only when it has actually changed. */
  function paint(p, m){
    if (p.sil !== m.silhouette){
      p.sil = m.silhouette;
      p.body.innerHTML = m.silhouette
        ? '<img class="sil" src="' + esc(m.silhouette) + '" alt="" />'
        : '<span class="stand-in"></span>';
      p.avatar = null;   // the avatar node went with it
    }
    if (!p.avatar){
      var av = document.createElement('div');
      av.className = 'av';
      p.body.appendChild(av);
      p.avatar = av;
      p.avatarUrl = undefined;
      p.sig = '';   // a fresh avatar node needs its sizing applied again
    }
    if (p.avatarUrl !== m.avatarUrl){
      p.avatarUrl = m.avatarUrl;
      if (m.avatarUrl){
        p.avatar.style.backgroundImage = 'url("' + m.avatarUrl + '")';
        p.avatar.textContent = '';
      } else {
        p.avatar.style.backgroundImage = '';
        p.avatar.textContent = String(m.name || '?').charAt(0).toUpperCase();
      }
    }
  }

  function remove(id){
    var p = people[id];
    if (!p) return;
    delete people[id];
    p.el.classList.remove('in');
    setTimeout(function(){ if (p.el.parentNode) p.el.parentNode.removeChild(p.el); }, 500);
  }

  /**
   * Seat everyone. Rows come from the bot; the horizontal slot within a row is
   * decided here and kept sticky — a member who holds their row keeps their spot,
   * and only genuinely new arrivals take the gaps. Without that, a rank wobble
   * would slide the whole row sideways several times a second.
   */
  function seat(list){
    var perRow = Math.max(1, Math.round(cfg.perRow));
    var taken = {};     // "row:slot" -> id
    var needs = [];

    for (var i = 0; i < list.length; i++){
      var m = list[i];
      var p = people[m.id] || build(m);
      paint(p, m);
      p.name = m.name;
      if (p.row === m.row && p.slot >= 0 && p.slot < perRow && !taken[m.row + ':' + p.slot]){
        taken[m.row + ':' + p.slot] = m.id;
      } else {
        p.row = m.row;
        p.slot = -1;
        needs.push(m.id);
      }
      p.row = m.row;
    }
    for (var j = 0; j < needs.length; j++){
      var id = needs[j];
      var q = people[id];
      for (var s = 0; s < perRow; s++){
        if (!taken[q.row + ':' + s]){ q.slot = s; taken[q.row + ':' + s] = id; break; }
      }
    }
    // Anyone the bot no longer lists has left the crowd.
    var present = {};
    for (var k = 0; k < list.length; k++) present[list[k].id] = true;
    for (var existing in people) if (!present[existing]) remove(existing);
  }

  // ── Emote spew ────────────────────────────────────────────────────────────
  function spew(id, urls){
    var p = people[id];
    if (!p || !urls || !urls.length) return;
    if (crowd.querySelectorAll('.spew').length > 120) return;   // keep a lid on it
    var base = anchor(p);
    for (var i = 0; i < urls.length; i++){
      var size = Math.max(8, cfg.spewSize) * base.scale;
      var d = document.createElement('div');
      d.className = 'spew';
      d.style.width = size + 'px';
      d.style.height = size + 'px';
      d.style.left = (base.x - size / 2) + 'px';
      d.style.bottom = (base.y + base.height * 0.55) + 'px';
      d.innerHTML = '<img src="' + esc(urls[i]) + '" alt="" />';
      crowd.appendChild(d);

      // Up and outward, with a little gravity on the way down.
      var ms = Math.max(300, cfg.spewSeconds * 1000);
      var speed = Math.max(20, cfg.spewSpeed) * base.scale;
      var spread = (Math.random() * 2 - 1) * speed * 0.55;
      var rise = speed * (0.75 + Math.random() * 0.5);
      var spin = (Math.random() * 2 - 1) * 90;
      var done = (function(node){ return function(){ if (node.parentNode) node.parentNode.removeChild(node); }; })(d);
      if (d.animate){
        d.animate([
          { transform:'translate(0px,0px) scale(.5) rotate(0deg)', opacity:0 },
          { transform:'translate(' + (spread * 0.5) + 'px,' + (-rise) + 'px) scale(1) rotate(' + (spin * 0.5) + 'deg)', opacity:1, offset:.35 },
          { transform:'translate(' + spread + 'px,' + (-rise * 0.6) + 'px) scale(.9) rotate(' + spin + 'deg)', opacity:0 }
        ], { duration: ms, easing:'cubic-bezier(.25,.6,.4,1)', fill:'forwards' }).onfinish = done;
      }
      setTimeout(done, ms + 400);
    }
  }

  /** Where a member is standing, in design pixels. */
  function anchor(p){
    var rows = Math.max(1, Math.round(cfg.rows));
    var perRow = Math.max(1, Math.round(cfg.perRow));
    var depth = Math.min(p.row, rows - 1);
    var scale = Math.pow(Math.max(.2, cfg.rowScale), depth);
    var lane = W / perRow;
    var slot = p.slot < 0 ? 0 : p.slot;
    return {
      x: lane * (slot + 0.5),
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
  //   body filter (the glow) ........ glow
  //   avatar width/height/fontSize .. avatarSize, rowScale, rows, row
  //
  // (body color is a constant and lives in the stylesheet. perRow and rowSpacing
  // feed x/y only, which the per-frame transform rewrites anyway.)
  var STATIC_DEPS = ['row', 'rows', 'rowScale', 'silhouetteHeight', 'avatarSize', 'glow'];

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
    p.body.style.filter = d.glow > 0
      ? 'drop-shadow(0 0 ' + d.glow + 'px rgba(255,110,199,.75)) drop-shadow(0 0 ' + (d.glow * 2) + 'px rgba(169,112,255,.45))'
      : '';
    if (p.avatar){
      var av = Math.max(8, d.avatarSize) * base.scale;
      p.avatar.style.width = av + 'px';
      p.avatar.style.height = av + 'px';
      p.avatar.style.fontSize = (av * 0.52) + 'px';
    }
  }

  // One object reused every frame, so the guard allocates nothing per member.
  var deps = { row:0, rows:3, rowScale:.86, silhouetteHeight:190, avatarSize:46, glow:18 };

  // ── Animation ─────────────────────────────────────────────────────────────
  function frame(now){
    requestAnimationFrame(frame);
    if (!enabled) return;
    var t = (now - started) / 1000;
    var a = cfg.anim || {};
    var jump = Math.max(0, num(a.jumpPx, 0));
    var hz = Math.max(0, num(a.bounceHz, 0));
    var sway = Math.max(0, num(a.swayDeg, 0));
    var jit = Math.max(0, num(a.jitterPx, 0));
    deps.rows = Math.max(1, Math.round(cfg.rows));
    deps.rowScale = cfg.rowScale;
    deps.silhouetteHeight = cfg.silhouetteHeight;
    deps.avatarSize = num(cfg.avatarSize, 46);
    deps.glow = Math.max(0, num(cfg.glow, 0));

    for (var id in people){
      var p = people[id];
      var base = anchor(p);
      // Hop: abs(sin) so they spring off the floor rather than sinking through it.
      var beat = t * hz * p.rateJitter * Math.PI + p.phase;
      var lift = jump > 0 && hz > 0 ? Math.abs(Math.sin(beat)) * jump : 0;
      // Rock at half the hop rate, which reads as a sway rather than a shiver.
      var tilt = sway > 0 ? Math.sin(beat * 0.5) * sway : 0;
      if (jit > 0 && now - p.jitterAt > 90){
        p.jitterAt = now;
        p.jitter.x = (Math.random() * 2 - 1) * jit;
        p.jitter.y = (Math.random() * 2 - 1) * jit;
      } else if (jit === 0 && (p.jitter.x || p.jitter.y)) {
        p.jitter.x = 0; p.jitter.y = 0;
      }

      // The only two that genuinely move.
      p.el.style.transform = 'translate(' + (base.x + p.jitter.x) + 'px,' +
        (-(base.y + lift + p.jitter.y)) + 'px)';
      p.body.style.transform = 'rotate(' + tilt.toFixed(2) + 'deg)';

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
    if (!enabled){
      for (var id in people) remove(id);
      return;
    }
    if (d.config) for (var k in d.config) cfg[k] = d.config[k];
    seat((d && d.members) || []);
    var spews = (d && d.spews) || [];
    if (cfg.emoteSpew) for (var i = 0; i < spews.length; i++) spew(spews[i].id, spews[i].urls);
  }

  function onClear(){
    for (var id in people) remove(id);
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
