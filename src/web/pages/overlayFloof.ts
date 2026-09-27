/**
 * OBS browser-source overlay for "Pet the Floof".
 *
 * A standalone, transparent surface that ADAPTS to whatever size the Browser
 * Source is set to. It reads a read-only `?token=` and subscribes to the `floof`
 * WebSocket-hub room:
 *   spawn   -> fade a floof in and run the movement style the bot picked
 *   pet     -> stop, bloom pink, resolve into a heart, fade out
 *   despawn -> nobody pet it in time; just fade out
 *
 * Five movement styles, chosen per spawn by the bot (each photo can opt out of
 * any of them in the admin panel):
 *   pingpong  drifts and bounces off the padded edges
 *   roll      trundles along the floor like a tyre, rotating as it travels
 *   hop       bounds left and right in arcs, resting between hops
 *   peek      pops up from random spots along the bottom edge, then ducks away
 *   ghost     fades in and out on the spot, wagging, without travelling
 *
 * Each style is a small object with start/step, so the animation loop itself
 * knows nothing about any particular behaviour.
 *
 * Padding values (set in the admin panel) do two things: they inset the travel
 * area the floof moves inside, AND they define a feather band. Everything is
 * drawn through a mask that is fully opaque inside the padded area and ramps to
 * transparent at the real render edge — so the win effects (which bloom well past
 * the floof's own box) fade out instead of hard-clipping in the final composite.
 *
 * Self-contained (inline CSS/JS, no bundler); because this string is a template
 * literal, the embedded script uses plain concatenation and avoids dollar-brace
 * and backtick characters.
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
</style>
</head>
<body>
  <div id="stage">
    <div id="floof"><img id="floof-img" alt="" /></div>
    <div id="burst"></div>
    <div id="heart">💖</div>
    <div id="bubble"></div>
  </div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';

  // The source can be any size — read it from the viewport and re-read on resize.
  var W = 0, H = 0, SIZE = 128;
  // Each floof carries its OWN taunt lines, which arrive with the spawn. An empty
  // list is meaningful: that floof stays silent.
  var TAUNTS = [];
  var IDLE_MS = 10000;      // unpet time before a taunt
  var BUBBLE_MS = 2500;     // how long the bubble stays up
  var PET_MS = 7600;        // full win sequence before the stage is torn down

  var stage = document.getElementById('stage');
  var el = document.getElementById('floof');
  var img = document.getElementById('floof-img');
  var heart = document.getElementById('heart');
  var burst = document.getElementById('burst');
  var bubble = document.getElementById('bubble');
  var lastTaunt = -1;  // so the bubble never shows the same line twice running
  var pad = { left: 0, right: 0, top: 0, bottom: 0 };
  var bubbleW = 0, bubbleH = 0, bubbleFlipped = null;
  // Animation tuning for every style, replaced wholesale by each spawn.
  var anim = {};

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
    var m = h + ', ' + v;
    stage.style.webkitMaskImage = m;
    stage.style.maskImage = m;
    // Intersect the two so corners feather on both axes.
    stage.style.webkitMaskComposite = 'source-in';
    stage.style.maskComposite = 'intersect';
  }

  var state = null;         // position + per-style scratch while a floof is on screen
  var raf = null, lastT = 0, idleTimer = null, bubbleTimer = null, paused = false;

  function clearTimers(){
    if(idleTimer) clearTimeout(idleTimer); idleTimer = null;
    if(bubbleTimer) clearTimeout(bubbleTimer); bubbleTimer = null;
  }

  /**
   * Hide the bubble AND hand its opacity back to the stylesheet.
   *
   * Ghost mode drives the bubble's opacity inline to match the floof; leaving that
   * inline value behind would override the .show rule and pin the bubble visible
   * for the rest of the round.
   */
  function hideBubble(){
    bubble.classList.remove('show');
    bubble.style.opacity = '';
    bubble.style.transition = '';
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
  function rand(lo, hi){ return lo + Math.random() * Math.max(0, hi - lo); }
  function num(v, fallback){ var n = Number(v); return isFinite(n) ? n : fallback; }
  /** Ease-out cubic, for the peek slide. */
  function ease(p){ var q = 1 - p; return 1 - q * q * q; }
  /**
   * The wiggle, as degrees off vertical right now. Every style that wags passes its
   * OWN amount and period, so they can be tuned independently.
   */
  function wag(deg, sec){
    var d = Math.max(0, num(deg, 9));
    var s = Math.max(0.2, num(sec, 0.63));
    return Math.sin(performance.now() / 1000 * Math.PI * 2 / s) * d;
  }

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

  // ── Movement styles ───────────────────────────────────────────────────────
  // Each has start(b, a) to place itself and step(dt, b, a) to advance one frame,
  // writing x / y / rot (and opacity, for the ghost) onto state.
  //   pausable  - whether stopping to taunt should freeze it. Peek and ghost run
  //               their own appear/disappear cycles, which look broken frozen.
  //   grounded  - whether the resize clamp may pull it back inside the travel
  //               area. Peek deliberately sits BELOW it while hidden.

  function beginHop(b, a){
    state.hopPhase = 'air';
    state.hopT = 0;
    state.hopFrom = state.x;
    var target = state.x + state.hopDir * Math.max(10, num(a.hopDistance, 220));
    // Turn round at the edges rather than piling into them.
    if(target < b.minX || target > b.maxX){
      state.hopDir *= -1;
      target = state.x + state.hopDir * Math.max(10, num(a.hopDistance, 220));
    }
    state.hopTo = Math.max(b.minX, Math.min(b.maxX, target));
  }

  var MOVERS = {
    pingpong: {
      pausable: true, grounded: true,
      start: function(b, a){
        var sp = pxPerSec(a.speed);
        // A shallow diagonal, in a random direction, so no two spawns match.
        var ang = (Math.random() * 0.6 + 0.2) * Math.PI * (Math.random() < 0.5 ? 1 : -1);
        state.x = rand(b.minX, b.maxX);
        state.y = rand(b.minY, b.maxY);
        state.vx = Math.cos(ang) * sp * (Math.random() < 0.5 ? 1 : -1);
        state.vy = Math.sin(ang) * sp * 0.45;
      },
      step: function(dt, b, a){
        state.x += state.vx * dt;
        state.y += state.vy * dt;
        if(state.x <= b.minX){ state.x = b.minX; state.vx = Math.abs(state.vx); }
        if(state.x >= b.maxX){ state.x = b.maxX; state.vx = -Math.abs(state.vx); }
        if(state.y <= b.minY){ state.y = b.minY; state.vy = Math.abs(state.vy); }
        if(state.y >= b.maxY){ state.y = b.maxY; state.vy = -Math.abs(state.vy); }
        state.rot = wag(a.pingpongWagDegrees, a.pingpongWagSeconds);
      }
    },

    roll: {
      pausable: true, grounded: true,
      start: function(b, a){
        state.x = rand(b.minX, b.maxX);
        state.y = b.maxY;
        state.vx = pxPerSec(a.rollSpeed) * (Math.random() < 0.5 ? 1 : -1);
        state.rot = 0;
      },
      step: function(dt, b){
        var dx = state.vx * dt;
        state.x += dx;
        state.y = b.maxY;                     // stays on the floor
        if(state.x <= b.minX){ state.x = b.minX; state.vx = Math.abs(state.vx); }
        if(state.x >= b.maxX){ state.x = b.maxX; state.vx = -Math.abs(state.vx); }
        // Rolling without slipping: the angle turned is distance / radius, which
        // is what makes it read as a tyre rather than a spinning sticker.
        state.rot += (dx / (SIZE / 2)) * (180 / Math.PI);
      }
    },

    hop: {
      pausable: true, grounded: true,
      start: function(b, a){
        state.x = rand(b.minX, b.maxX);
        state.y = b.maxY;
        state.hopDir = Math.random() < 0.5 ? -1 : 1;
        state.hopPhase = 'rest';              // a beat of stillness, then bound away
        state.hopT = 0;
        state.rot = 0;
      },
      step: function(dt, b, a){
        state.hopT += dt;
        if(state.hopPhase === 'rest'){
          state.y = b.maxY;
          state.rot = 0;
          if(state.hopT >= Math.max(0, num(a.hopDelaySeconds, 0.5))) beginHop(b, a);
          return;
        }
        var dur = Math.max(0.2, num(a.hopSeconds, 0.7));
        var p = Math.min(1, state.hopT / dur);
        state.x = state.hopFrom + (state.hopTo - state.hopFrom) * p;
        // Never hop out of the frame: on a short overlay the configured height can
        // exceed the headroom, so cap it at the top of the padded travel area.
        var peak = Math.min(Math.max(0, num(a.hopHeight, 120)), b.maxY - b.minY);
        // 4p(1-p) is a parabola peaking at exactly 1 halfway through the hop.
        state.y = b.maxY - peak * 4 * p * (1 - p);
        state.rot = state.hopDir * Math.sin(p * Math.PI) * 14;
        if(p >= 1){
          state.x = state.hopTo;
          state.y = b.maxY;
          state.hopPhase = 'rest';
          state.hopT = 0;
        }
      }
    },

    peek: {
      pausable: false, grounded: false,
      start: function(b, a){
        state.x = rand(b.minX, b.maxX);
        state.peekPhase = 'rise';
        state.peekT = 0;
        state.y = peekHidden();
        state.rot = 0;
      },
      step: function(dt, b, a){
        state.peekT += dt;
        var hidden = peekHidden();
        var shown = hidden - Math.max(16, num(a.peekHeight, 96));
        var rise = Math.max(0.1, num(a.peekRiseSeconds, 0.5));
        if(state.peekPhase === 'rise'){
          var p = Math.min(1, state.peekT / rise);
          state.y = hidden + (shown - hidden) * ease(p);
          state.rot = 0;
          if(p >= 1){ state.peekPhase = 'hold'; state.peekT = 0; }
        } else if(state.peekPhase === 'hold'){
          state.y = shown;
          state.rot = wag(a.peekWagDegrees, a.peekWagSeconds);   // wiggles while it watches
          if(state.peekT >= Math.max(0.2, num(a.peekHoldSeconds, 2.5))){ state.peekPhase = 'drop'; state.peekT = 0; }
        } else if(state.peekPhase === 'drop'){
          var q = Math.min(1, state.peekT / rise);
          state.y = shown + (hidden - shown) * ease(q);
          state.rot = 0;
          if(q >= 1){ state.peekPhase = 'wait'; state.peekT = 0; }
        } else {
          state.y = hidden;
          if(state.peekT >= Math.max(0, num(a.peekDelaySeconds, 0.8))){
            state.x = rand(b.minX, b.maxX);   // somewhere new
            state.peekPhase = 'rise';
            state.peekT = 0;
          }
        }
      }
    },

    ghost: {
      pausable: false, grounded: true,
      start: function(b, a){
        state.x = rand(b.minX, b.maxX);
        state.y = rand(b.minY, b.maxY);
        state.ghostPhase = 'in';
        state.ghostT = 0;
        state.opacity = 0;
      },
      step: function(dt, b, a){
        state.ghostT += dt;
        var fade = Math.max(0.2, num(a.ghostFadeSeconds, 1.2));
        // Wags on the spot without ever travelling — that is the whole effect.
        state.rot = wag(a.ghostWagDegrees, a.ghostWagSeconds);
        if(state.ghostPhase === 'in'){
          state.opacity = Math.min(1, state.ghostT / fade);
          if(state.ghostT >= fade){ state.ghostPhase = 'hold'; state.ghostT = 0; state.opacity = 1; }
        } else if(state.ghostPhase === 'hold'){
          state.opacity = 1;
          if(state.ghostT >= Math.max(0.2, num(a.ghostHoldSeconds, 1.6))){ state.ghostPhase = 'out'; state.ghostT = 0; }
        } else if(state.ghostPhase === 'out'){
          state.opacity = Math.max(0, 1 - state.ghostT / fade);
          if(state.ghostT >= fade){ state.ghostPhase = 'wait'; state.ghostT = 0; state.opacity = 0; }
        } else {
          state.opacity = 0;
          if(state.ghostT >= Math.max(0, num(a.ghostDelaySeconds, 0.6))){
            state.x = rand(b.minX, b.maxX);
            state.y = rand(b.minY, b.maxY);
            state.ghostPhase = 'in';
            state.ghostT = 0;
          }
        }
      }
    }
  };

  /** Y at which the floof sits wholly below the padded bottom edge. */
  function peekHidden(){ return H - pad.bottom; }

  function mover(){ return MOVERS[state && state.style] || MOVERS.pingpong; }

  function draw(){
    el.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) rotate(' + state.rot.toFixed(2) + 'deg)';
    // Only the ghost drives opacity directly; every other style uses the .in class.
    if(state.opacity !== null){
      el.style.opacity = String(state.opacity);
      // The bubble fades WITH the floof, so a ghost's speech comes and goes with
      // it instead of hanging in the air on its own.
      if(bubble.classList.contains('show')) bubble.style.opacity = String(state.opacity);
    }

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
  }

  function loop(t){
    if(!state) return;
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;
    if(!paused) mover().step(dt, bounds(), anim);
    draw();
    raf = requestAnimationFrame(loop);
  }

  function scheduleTaunt(){
    clearTimers();
    if(!TAUNTS.length) return;          // this floof has nothing to say
    idleTimer = setTimeout(showTaunt, IDLE_MS);
  }

  function showTaunt(){
    if(!state) return;
    // A ghost caught mid-blink would show a bubble nobody can see and the line
    // would be spent for nothing; wait for it to fade back in.
    if(state.opacity !== null && state.opacity < 0.05){
      idleTimer = setTimeout(showTaunt, 200);
      return;
    }
    // Styles with their own appear/disappear cycle keep moving while they talk.
    paused = mover().pausable;
    bubble.textContent = pickTaunt();
    // Measure once now the text is set; draw() reuses it instead of forcing a
    // layout every frame.
    bubbleW = bubble.offsetWidth;
    bubbleH = bubble.offsetHeight;
    if(state.opacity !== null){
      // Matched frame by frame, so the CSS fade would only smear it.
      bubble.style.transition = 'none';
      bubble.style.opacity = String(state.opacity);
    }
    draw();                       // reposition before it becomes visible
    bubble.classList.add('show');
    bubbleTimer = setTimeout(function(){
      hideBubble();
      paused = false;
      scheduleTaunt();                              // ...and taunt again later
    }, BUBBLE_MS);
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
    el.style.opacity = '';          // drop any ghost-driven opacity
    hideBubble();
    bubble.classList.remove('flip');
    bubbleFlipped = null;
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
    // Always replaced, never merged — otherwise a silent floof would inherit the
    // previous one's lines.
    TAUNTS = (d && Array.isArray(d.taunts)) ? d.taunts : [];
    anim = (d && d.anim) || {};

    var style = (d && d.style) || 'pingpong';
    if(!MOVERS[style]) style = 'pingpong';
    state = { style: style, x: 0, y: 0, rot: 0, opacity: null };

    var isGhost = style === 'ghost';
    if(isGhost){
      // The ghost owns its own opacity frame by frame, so the CSS fade would only
      // smear it. .in is left off for the same reason.
      el.style.transition = 'none';
      state.opacity = 0;
    }

    mover().start(bounds(), anim);
    img.src = d.url;
    draw();
    if(!isGhost) requestAnimationFrame(function(){ el.classList.add('in'); });   // fade in
    raf = requestAnimationFrame(loop);
    scheduleTaunt();
  }

  function pet(){
    if(!state) return;
    clearTimers();
    paused = true;                 // stop dead, whatever it was doing
    hideBubble();

    // Whatever the style was mid-way through, make sure the win is fully visible:
    // a ghost could be mid-fade and a peeking floof mostly below the edge.
    el.style.transition = '';
    el.style.opacity = '1';
    state.opacity = null;
    var b = bounds();
    if(state.y > b.maxY) state.y = b.maxY;
    state.rot = 0;
    draw();

    // Park the effects over the floof using left/top — the keyframes animate
    // transform, so setting transform here would be overridden by them.
    burst.style.left = state.x + 'px'; burst.style.top = state.y + 'px';
    heart.style.left = state.x + 'px'; heart.style.top = state.y + 'px';

    el.classList.add('in');                                         // in case of ghost
    el.classList.add('pet');                                        // bloom
    setTimeout(function(){ burst.classList.add('go'); }, 120);      // shockwave
    setTimeout(function(){ heart.classList.add('go'); }, 700);      // heart: in, pulse 5s, out
    setTimeout(reset, PET_MS);
  }

  function despawn(){
    if(!state) return;
    clearTimers();
    el.style.transition = '';       // a ghost may have had it switched off
    el.style.opacity = '';
    state.opacity = null;
    el.classList.remove('in');      // just fade away
    setTimeout(reset, 900);
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
      else if(m.type==='despawn') despawn();
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
      // A peeking floof lives below the travel area on purpose, so leave its Y be.
      if(mover().grounded) state.y = Math.max(b.minY, Math.min(b.maxY, state.y));
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
