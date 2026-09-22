/**
 * OBS browser-source overlay for "Pet the Floof".
 *
 * A standalone, transparent strip that ADAPTS to whatever size the Browser Source
 * is set to (1600×200 is just the suggested layout). It reads a read-only
 * `?token=` and subscribes to the `floof` WebSocket-hub room:
 *   spawn   -> fade a floof in and start it ping-ponging + rocking
 *   pet     -> stop, bloom pink, resolve into a heart, fade out
 *   despawn -> nobody pet it in time; just fade out
 *
 * Padding values (set in the admin panel) do two things: they inset the travel
 * area the floof bounces inside, AND they define a feather band. Everything is
 * drawn through a mask that is fully opaque inside the padded area and ramps to
 * transparent at the real render edge — so the win effects (which bloom well past
 * the floof's own box) fade out instead of hard-clipping in the final composite.
 *
 * Self-contained (inline CSS/JS, no bundler); because this string is a template
 * literal, the embedded script uses plain concatenation and avoids `${` / backticks.
 */
export function floofOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pet the Floof — Overlay</title>
<style>
  html,body{ margin:0; width:100%; height:100%; background:transparent; overflow:hidden;
    font-family:system-ui,'Segoe UI',sans-serif; }
  /* Everything renders inside this stage so one mask can feather the padded
     edges. The mask itself is built in JS from the current padding values. */
  #stage{ position:fixed; inset:0; }
  #floof{ position:absolute; width:128px; height:128px; left:0; top:0; opacity:0;
    transition:opacity .8s ease; will-change:transform; }
  #floof img{ width:128px; height:128px; display:block; border-radius:12px;
    filter:drop-shadow(0 4px 10px rgba(0,0,0,.55)); }
  #floof.in{ opacity:1; }
  /* ── Win sequence: bloom -> burst ring -> a heart that lingers and pulses ── */
  #floof.pet img{ animation:bloom 1.2s cubic-bezier(.2,.8,.3,1) forwards; }
  @keyframes bloom{
    0%{ transform:scale(1); filter:drop-shadow(0 4px 10px rgba(0,0,0,.55)); }
    28%{ transform:scale(1.2); filter:drop-shadow(0 0 30px #ff6ec7) drop-shadow(0 0 70px #ff6ec7) brightness(1.5); }
    62%{ transform:scale(1.28); filter:drop-shadow(0 0 55px #ff8ad4) drop-shadow(0 0 120px #ff6ec7) brightness(2); opacity:1; }
    100%{ transform:scale(1.5); filter:drop-shadow(0 0 70px #ff8ad4) brightness(2.4); opacity:0; }
  }
  /* Expanding pink shockwave, for a bit of ceremony. */
  #burst{ position:absolute; left:0; top:0; width:128px; height:128px; border-radius:50%;
    border:6px solid #ff6ec7; opacity:0; pointer-events:none;
    box-shadow:0 0 30px #ff6ec7, inset 0 0 30px #ff6ec7; }
  #burst.go{ animation:burst 1.3s cubic-bezier(.15,.75,.3,1) forwards; }
  @keyframes burst{
    0%{ opacity:.95; transform:scale(.45); }
    100%{ opacity:0; transform:scale(3.6); }
  }
  /* Positioned with left/top (NOT transform) so these keyframes can own transform. */
  #heart{ position:absolute; left:0; top:0; width:128px; height:128px; opacity:0;
    display:flex; align-items:center; justify-content:center; font-size:86px; line-height:1;
    filter:drop-shadow(0 0 22px #ff6ec7) drop-shadow(0 0 48px #ff6ec7); pointer-events:none; }
  /* Pop in, pulse for 5s, then drift away. */
  #heart.go{ animation:
      heartIn .6s cubic-bezier(.2,.9,.25,1.5) forwards,
      heartPulse 1s ease-in-out .6s 5 both,
      heartOut .9s ease 5.6s forwards; }
  @keyframes heartIn{ 0%{ opacity:0; transform:scale(.3) rotate(-12deg); } 100%{ opacity:1; transform:scale(1.1) rotate(0); } }
  @keyframes heartPulse{ 0%,100%{ opacity:1; transform:scale(1.04); } 50%{ opacity:1; transform:scale(1.3); } }
  @keyframes heartOut{ 0%{ opacity:1; transform:scale(1.15); } 100%{ opacity:0; transform:scale(1.6) translateY(-70px); } }
  /* Speech bubble shown when the floof has gone unpet for a while. */
  #bubble{ position:absolute; left:0; top:0; opacity:0; transition:opacity .35s ease;
    background:#fff; color:#1a1220; font-weight:800; font-size:22px; white-space:nowrap;
    padding:10px 16px; border-radius:14px; box-shadow:0 6px 18px rgba(0,0,0,.45); }
  /* Tail points RIGHT at the floof by default (bubble sits to its right). */
  #bubble::after{ content:''; position:absolute; left:-9px; top:50%; margin-top:-8px;
    border:8px solid transparent; border-right-color:#fff; }
  /* ...and swaps to the bubble's right edge when it sits to the floof's LEFT. */
  #bubble.flip::after{ left:auto; right:-9px; border-right-color:transparent; border-left-color:#fff; }
  #bubble.show{ opacity:1; }

  /* ── Boss battle ───────────────────────────────────────────────────────── */
  /* Full-width flashing red alert that precedes a boss. */
  #alert{ position:absolute; inset:0; display:none; align-items:center; justify-content:center;
    text-align:center; font-weight:900; letter-spacing:.06em; color:#fff;
    font-size:clamp(28px, 7vh, 72px); text-shadow:0 0 18px #f00, 0 3px 10px rgba(0,0,0,.9);
    background:radial-gradient(ellipse at center, rgba(190,0,0,.55), rgba(120,0,0,0) 70%); }
  #alert.go{ display:flex; animation:alertFlash .55s steps(1,end) infinite; }
  @keyframes alertFlash{ 0%,49%{ opacity:1; } 50%,100%{ opacity:.25; } }
  /* Boss floofs get an aura that cools from red -> yellow -> green as their life
     drains (the exact colour is set inline by setBossGlow). */
  #floof.boss img{ filter:drop-shadow(0 0 16px #ff2d2d) drop-shadow(0 0 40px #b00) saturate(1.3);
    transition:filter .45s ease; }
  /* Chat's progress against the boss, pinned under it. */
  #hp{ position:absolute; left:0; top:0; width:128px; opacity:0; transition:opacity .3s ease;
    font:800 15px system-ui,sans-serif; color:#fff; text-align:center;
    text-shadow:0 2px 5px rgba(0,0,0,.9); }
  #hp.show{ opacity:1; }
  #hp .track{ height:9px; border-radius:5px; background:rgba(0,0,0,.6);
    border:1px solid rgba(255,255,255,.35); overflow:hidden; margin-top:3px; }
  /* Boss life: starts full and drains as chat lands hits. */
  #hp .fill{ height:100%; width:100%; background:linear-gradient(90deg,#3fb950,#7ee787);
    transition:width .3s ease, background .3s ease; }
  /* Shake lives on an INNER element: #hp itself carries the positioning
     transform, and an animation on it would fight that and snap the bar to 0,0. */
  #hp-inner.shake{ animation:hpShake .34s ease; }
  @keyframes hpShake{
    0%,100%{ transform:translateX(0); }
    15%{ transform:translateX(-5px); } 35%{ transform:translateX(4px); }
    55%{ transform:translateX(-3px); } 75%{ transform:translateX(2px); }
  }
  /* Damage / miss numbers that float off the bar, like a game. */
  .float{ position:absolute; font:900 24px system-ui,sans-serif; pointer-events:none;
    text-shadow:0 2px 6px rgba(0,0,0,.95); animation:floatUp 1s ease-out forwards; }
  .float.hit{ color:#ff3b3b; }
  .float.miss{ color:#b9b9c2; font-size:19px; letter-spacing:.06em; }
  @keyframes floatUp{
    0%{ opacity:0; transform:translate(-50%, 6px) scale(.8); }
    18%{ opacity:1; transform:translate(-50%, 0) scale(1.15); }
    100%{ opacity:0; transform:translate(-50%, -38px) scale(1); }
  }
  /* Mocking line after the boss gets away. */
  #escape{ position:absolute; inset:0; display:none; align-items:center; justify-content:center;
    text-align:center; font-weight:900; color:#ff5a5a; font-size:clamp(24px, 6vh, 60px);
    text-shadow:0 0 16px #900, 0 3px 10px rgba(0,0,0,.9); }
  #escape.go{ display:flex; animation:escapeFade 3.2s ease forwards; }
  @keyframes escapeFade{ 0%{ opacity:0; transform:scale(.9); } 18%{ opacity:1; transform:scale(1.04); }
    70%{ opacity:1; } 100%{ opacity:0; transform:scale(1.02); } }
</style>
</head>
<body>
  <div id="stage">
    <div id="floof"><img id="floof-img" alt="" /></div>
    <div id="burst"></div>
    <div id="heart">💖</div>
    <div id="bubble"></div>
    <div id="hp"><div id="hp-inner"><span id="hp-text"></span><div class="track"><div class="fill" id="hp-fill"></div></div></div></div>
    <div id="alert">A BOSS FLOOF APPROACHES!</div>
    <div id="escape">FAILURE! BOSS FLOOF ESCAPED!</div>
  </div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';

  // The source can be any size — read it from the viewport and re-read on resize.
  var W = 0, H = 0, SIZE = 128;
  // Taunt lines are configured in the admin panel and arrive with each spawn.
  var TAUNTS = ['!pet me', 'i can haz !pet?', 'i wants !pet'];
  var IDLE_MS = 10000;      // unpet time before a taunt
  var BUBBLE_MS = 2500;     // how long the bubble stays up
  var ROCK_DEG = 9;         // happy wiggle amplitude
  var ROCK_HZ = 1.6;

  var stage = document.getElementById('stage');
  var el = document.getElementById('floof');
  var img = document.getElementById('floof-img');
  var heart = document.getElementById('heart');
  var burst = document.getElementById('burst');
  var bubble = document.getElementById('bubble');
  var PET_MS = 7600;   // full win sequence before the stage is torn down
  var lastTaunt = -1;  // so the bubble never shows the same line twice running
  var pad = { left: 0, right: 0, top: 0, bottom: 0 };
  var bubbleW = 0, bubbleH = 0, bubbleFlipped = null;
  var isBoss = false;
  var alertEl = document.getElementById('alert');
  var escapeEl = document.getElementById('escape');
  var hp = document.getElementById('hp');
  var hpInner = document.getElementById('hp-inner');
  var hpText = document.getElementById('hp-text');
  var hpFill = document.getElementById('hp-fill');
  var bossNeeded = 1, bossSpeedStart = 9, bossSpeedEnd = 2;

  function syncSize(){
    W = document.documentElement.clientWidth || window.innerWidth || 0;
    H = document.documentElement.clientHeight || window.innerHeight || 0;
  }

  /**
   * Feather the padded edges. The mask is fully opaque across the padded (safe)
   * area and ramps to transparent at the real render border, so any part of the
   * win animation that spills past the padding fades out rather than being cut
   * off by the edge of the source. Padding of 0 leaves that side unfeathered.
   */
  function applyMask(){
    var h = 'linear-gradient(to right, transparent 0px, #000 ' + pad.left + 'px, #000 calc(100% - ' + pad.right + 'px), transparent 100%)';
    var v = 'linear-gradient(to bottom, transparent 0px, #000 ' + pad.top + 'px, #000 calc(100% - ' + pad.bottom + 'px), transparent 100%)';
    var img = h + ', ' + v;
    stage.style.webkitMaskImage = img;
    stage.style.maskImage = img;
    // Intersect the two so corners feather on both axes.
    stage.style.webkitMaskComposite = 'source-in';
    stage.style.maskComposite = 'intersect';
  }

  var state = null;         // { x, y, vx, vy, pad } while a floof is on screen
  var raf = null, lastT = 0, idleTimer = null, bubbleTimer = null, paused = false;

  function clearTimers(){
    if(idleTimer) clearTimeout(idleTimer); idleTimer = null;
    if(bubbleTimer) clearTimeout(bubbleTimer); bubbleTimer = null;
  }
  function stopLoop(){ if(raf) cancelAnimationFrame(raf); raf = null; }

  /** A random taunt that is never the same as the previous one. */
  function pickTaunt(){
    if(TAUNTS.length < 2) return TAUNTS[0] || '';
    var i;
    do { i = Math.floor(Math.random() * TAUNTS.length); } while(i === lastTaunt);
    lastTaunt = i;
    return TAUNTS[i];
  }

  // Speed slider (1..10) -> pixels/second.
  function pxPerSec(speed){ var s = Math.max(1, Math.min(10, Number(speed) || 5)); return 30 + s * 26; }

  function bounds(){
    var b = {
      minX: pad.left, maxX: W - SIZE - pad.right,
      minY: pad.top,  maxY: H - SIZE - pad.bottom
    };
    // If the source is smaller than the sprite + padding, pin rather than jitter.
    if(b.maxX < b.minX) b.maxX = b.minX = Math.max(0, (W - SIZE) / 2);
    if(b.maxY < b.minY) b.maxY = b.minY = Math.max(0, (H - SIZE) / 2);
    return b;
  }

  function draw(){
    var rock = paused ? 0 : Math.sin(performance.now() / 1000 * Math.PI * 2 * ROCK_HZ) * ROCK_DEG;
    el.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) rotate(' + rock.toFixed(2) + 'deg)';

    // Put the bubble on the side with room: floof in the right half -> bubble to
    // its LEFT, and vice versa, so the bubble is never pushed off the edge. The
    // tail swaps sides with it (.flip).
    var onRight = (state.x + SIZE / 2) > (W / 2);
    if(onRight !== bubbleFlipped){
      bubbleFlipped = onRight;
      bubble.classList.toggle('flip', onRight);
    }
    var bx = onRight ? (state.x - 14 - bubbleW) : (state.x + SIZE + 14);
    var by = state.y + SIZE / 2 - bubbleH / 2;
    // Belt and braces: never let it leave the rendered area.
    bx = Math.max(0, Math.min(W - bubbleW, bx));
    by = Math.max(0, Math.min(H - bubbleH, by));
    bubble.style.transform = 'translate(' + bx + 'px,' + by + 'px)';
    if(isBoss) hp.style.transform = 'translate(' + state.x + 'px,' + (state.y + SIZE + 6) + 'px)';
  }

  function loop(t){
    if(!state){ return; }
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;
    if(!paused){
      var b = bounds();
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      // Ping-pong off the padded edges.
      if(state.x <= b.minX){ state.x = b.minX; state.vx = Math.abs(state.vx); }
      if(state.x >= b.maxX){ state.x = b.maxX; state.vx = -Math.abs(state.vx); }
      if(state.y <= b.minY){ state.y = b.minY; state.vy = Math.abs(state.vy); }
      if(state.y >= b.maxY){ state.y = b.maxY; state.vy = -Math.abs(state.vy); }
    }
    draw();
    raf = requestAnimationFrame(loop);
  }

  function scheduleTaunt(){
    clearTimers();
    idleTimer = setTimeout(function(){
      if(!state) return;
      paused = true;                                  // pause mid-drift to "speak"
      bubble.textContent = pickTaunt();
      // Measure once now the text is set; draw() reuses it instead of forcing a
      // layout every frame.
      bubbleW = bubble.offsetWidth;
      bubbleH = bubble.offsetHeight;
      draw();                       // reposition before it becomes visible
      bubble.classList.add('show');
      bubbleTimer = setTimeout(function(){
        bubble.classList.remove('show');
        paused = false;
        scheduleTaunt();                              // ...and taunt again later
      }, BUBBLE_MS);
    }, IDLE_MS);
  }

  function reset(){
    clearTimers(); stopLoop();
    state = null; paused = false; lastT = 0;
    // Tear down with the fade DISABLED. The bloom keyframes end on opacity:0 for
    // the <img>; dropping .pet snaps it back to opaque, and if #floof were still
    // transitioning its own opacity the floof would visibly pop back for ~0.8s
    // before disappearing. Killing the transition for this frame avoids that.
    el.style.transition = 'none';
    el.classList.remove('in', 'pet');
    bubble.classList.remove('show', 'flip');
    bubbleFlipped = null;
    isBoss = false;
    el.classList.remove('boss');
    img.style.filter = '';                // drop the inline boss aura
    hpInner.classList.remove('shake');
    Array.prototype.forEach.call(stage.querySelectorAll('.float'), function(f){ f.remove(); });
    hp.classList.remove('show');
    alertEl.classList.remove('go');
    escapeEl.classList.remove('go');
    heart.classList.remove('go');
    burst.classList.remove('go');
    void el.offsetWidth;        // flush the change while the transition is off
    el.style.transition = '';   // restore it for the next spawn's fade-in
  }

  function spawn(d){
    reset();
    syncSize();
    pad = (d && d.padding) || { left:0, right:0, top:0, bottom:0 };
    applyMask();
    if(d && Array.isArray(d.taunts) && d.taunts.length) TAUNTS = d.taunts;
    isBoss = !!(d && d.boss);
    if(isBoss){
      el.classList.add('boss');
      bossNeeded = Math.max(1, Number(d.needed) || 1);
      bossSpeedStart = Number(d.speedStart) || 9;
      bossSpeedEnd = Number(d.speedEnd) || 2;
      setHp(bossNeeded, bossNeeded);            // starts at full life
      setBossGlow(bossNeeded, bossNeeded);      // ...and full anger
      hp.classList.add('show');
    }
    var b = bounds();
    var speed = pxPerSec(d && d.speed);
    // Random start + a diagonal heading, so no two spawns look the same.
    var ang = (Math.random() * 0.6 + 0.2) * Math.PI * (Math.random() < 0.5 ? 1 : -1);
    state = {
      x: b.minX + Math.random() * Math.max(1, b.maxX - b.minX),
      y: b.minY + Math.random() * Math.max(1, b.maxY - b.minY),
      vx: Math.cos(ang) * speed * (Math.random() < 0.5 ? 1 : -1),
      vy: Math.sin(ang) * speed * 0.45
    };
    img.src = d.url;
    draw();
    requestAnimationFrame(function(){ el.classList.add('in'); });   // fade in
    if(isBoss) applyBossSpeed(bossNeeded);   // start fast and angry
    raf = requestAnimationFrame(loop);
    scheduleTaunt();
  }

  /** Rescale the current heading to a new pixels-per-second speed. */
  function setSpeed(px){
    if(!state) return;
    var cur = Math.sqrt(state.vx * state.vx + state.vy * state.vy) || 1;
    var k = px / cur;
    state.vx *= k; state.vy *= k;
  }

  /**
   * Bosses charge about at full health and calm right down as chat wears them
   * out: speed is interpolated from speedStart (full life) to speedEnd (1 left).
   */
  function applyBossSpeed(remaining){
    if(bossNeeded <= 1) return setSpeed(pxPerSec(bossSpeedEnd));
    var t = (bossNeeded - remaining) / (bossNeeded - 1);
    t = Math.max(0, Math.min(1, t));
    setSpeed(pxPerSec(bossSpeedStart + (bossSpeedEnd - bossSpeedStart) * t));
  }

  /** Aura cools red -> yellow -> green across the three thirds of its life. */
  function setBossGlow(remaining, needed){
    var r = needed > 0 ? remaining / needed : 0;
    var c = r > 2 / 3 ? ['#ff2d2d', '#b00000']
          : r > 1 / 3 ? ['#ffd24a', '#c98a00']
                      : ['#3fb950', '#1f7a33'];
    img.style.filter = 'drop-shadow(0 0 16px ' + c[0] + ') drop-shadow(0 0 40px ' + c[1] + ') saturate(1.3)';
  }

  /** Float a damage number (or MISS) off the health bar. */
  function floatText(text, cls){
    if(!state) return;
    if(stage.querySelectorAll('.float').length >= 6) return; // don't let spam flood the screen
    var d = document.createElement('div');
    d.className = 'float ' + cls;
    d.textContent = text;
    d.style.left = (state.x + SIZE / 2) + 'px';
    d.style.top = (state.y + SIZE + 2) + 'px';
    stage.appendChild(d);
    setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 1100);
  }

  function shakeHp(){
    hpInner.classList.remove('shake');
    void hpInner.offsetWidth;          // restart the animation even on rapid hits
    hpInner.classList.add('shake');
  }

  /** Draw the boss's REMAINING life; it drains toward zero as chat lands hits. */
  function setHp(remaining, needed){
    var pct = Math.max(0, Math.min(100, (remaining / needed) * 100));
    hpText.textContent = remaining + ' / ' + needed;
    hpFill.style.width = pct + '%';
    // Healthy -> hurt -> nearly dead, like a game health bar.
    hpFill.style.background = pct > 50 ? 'linear-gradient(90deg,#3fb950,#7ee787)'
      : pct > 25 ? 'linear-gradient(90deg,#d2a106,#f0c000)'
      : 'linear-gradient(90deg,#b00,#ff2d2d)';
  }

  /** Red flashing warning shown just before a boss lands. */
  function bossAlert(d){
    reset();
    alertEl.classList.add('go');
    var ms = ((d && Number(d.seconds)) || 4) * 1000;
    setTimeout(function(){ alertEl.classList.remove('go'); }, ms);
  }

  function bossHit(d){
    if(!isBoss || !state) return;
    var remaining = Math.max(0, Number(d && d.remaining) || 0);
    var needed = Math.max(1, Number(d && d.needed) || bossNeeded);
    bossNeeded = needed;
    setHp(remaining, needed);
    setBossGlow(remaining, needed);
    applyBossSpeed(remaining);
    shakeHp();
    floatText('-1', 'hit');
  }

  /** A pet that bounced off because the chatter is still on cooldown. */
  function bossMiss(){
    if(!isBoss || !state) return;
    floatText('MISS', 'miss');
  }

  function pet(){
    if(!state) return;
    clearTimers();
    paused = true;                 // stop ping-ponging immediately
    bubble.classList.remove('show');

    // Park the effects over the floof using left/top — the keyframes animate
    // transform, so setting transform here would be overridden by them.
    burst.style.left = state.x + 'px'; burst.style.top = state.y + 'px';
    heart.style.left = state.x + 'px'; heart.style.top = state.y + 'px';

    el.classList.add('pet');                                        // bloom
    setTimeout(function(){ burst.classList.add('go'); }, 120);      // shockwave
    setTimeout(function(){ heart.classList.add('go'); }, 700);      // heart: in, pulse 5s, out
    setTimeout(reset, PET_MS);
  }

  function despawn(d){
    if(!state) return;
    var wasBoss = isBoss || !!(d && d.boss);
    clearTimers();
    hp.classList.remove('show');
    el.classList.remove('in');     // just fade away
    if(wasBoss){
      // Let it fade out first, then mock chat for letting it escape.
      setTimeout(function(){ escapeEl.classList.add('go'); }, 900);
      setTimeout(reset, 4300);
    } else {
      setTimeout(reset, 900);
    }
  }

  function connect(){
    var url = (location.protocol==='https:')
      ? 'wss://'+location.host+'/ws?room=floof&secret='+encodeURIComponent(token)
      : 'ws://'+location.hostname+':8080?room=floof&secret='+encodeURIComponent(token);
    var ws;
    try { ws=new WebSocket(url); } catch(e){ setTimeout(connect,3000); return; }
    ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data);
      if(!m) return;
      if(m.type==='spawn') spawn(m.payload);
      else if(m.type==='pet') pet();
      else if(m.type==='despawn') despawn(m.payload);
      else if(m.type==='boss-alert') bossAlert(m.payload);
      else if(m.type==='boss-hit') bossHit(m.payload);
      else if(m.type==='boss-miss') bossMiss();
      else if(m.type==='boss-defeated') pet();
    }catch(_e){} };
    ws.onerror=function(){ try{ ws.close(); }catch(_e){} };
    ws.onclose=function(ev){ if(!ev || ev.code!==4001) setTimeout(connect,2500); };
  }

  // OBS can resize the Browser Source at any time: re-read the viewport, rebuild
  // the mask, and pull the floof back inside the new bounds.
  window.addEventListener('resize', function(){
    syncSize();
    applyMask();
    if(state){
      var b = bounds();
      state.x = Math.max(b.minX, Math.min(b.maxX, state.x));
      state.y = Math.max(b.minY, Math.min(b.maxY, state.y));
      draw();
    }
  });

  syncSize();
  applyMask();
  if(!token) return;
  connect();
})();
</script>
</body>
</html>`;
}
