/**
 * OBS browser-source overlay for the Boss Battle raid.
 *
 * Designed against a fixed 1920x1080 coordinate space and scaled to whatever the
 * Browser Source is actually set to, so every layout number below is a design
 * pixel and an arbitrary source size just scales the whole composition.
 *
 * It reads a read-only `?token=` and subscribes to the `boss` WebSocket room,
 * rendering whichever phase the bot tells it about:
 *   alert     -> full-screen pulsing red klaxon warning
 *   intel     -> boss portrait + a dossier typed out like a military terminal
 *   spawn     -> fade in centre stage, fill the health bar, opening taunt
 *   combat    -> a frame of hits/misses/heals/dupes: lasers, arcs, floats, bar
 *   cannon    -> the communal mega cannon discharges into the boss
 *   defeated  -> explosion, victory sting
 *   escaped   -> a quiet fade and a sad sting
 *   clear     -> tear everything down
 *
 * All combat arithmetic happens in the bot; this page never decides anything
 * about damage, it only draws what it is told. Sound URLs and volumes arrive in
 * the `alert` payload, so replacing a sound in the admin panel takes effect on
 * the next battle without refreshing the Browser Source.
 *
 * Self-contained (inline CSS/JS, no bundler); because this string is a template
 * literal, the embedded script uses plain concatenation and avoids dollar-brace
 * and backtick characters.
 */
export function bossBattleOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Boss Battle — Overlay</title>
<style>
  html,body{ margin:0; width:100%; height:100%; background:transparent; overflow:hidden;
    font-family:'Segoe UI',system-ui,sans-serif; }
  /* The whole composition is authored at 1920x1080 and scaled to fit. */
  #stage{ position:fixed; left:50%; top:50%; width:1920px; height:1080px;
    transform:translate(-50%,-50%); transform-origin:50% 50%; }
  .layer{ position:absolute; inset:0; pointer-events:none; }
  .hide{ display:none !important; }

  /* ── Red alert ──────────────────────────────────────────────────────────── */
  #alert{ display:flex; align-items:center; justify-content:center; }
  #alert .wash{ position:absolute; inset:0;
    background:radial-gradient(ellipse at center, rgba(255,0,0,.18) 0%, rgba(150,0,0,.55) 70%, rgba(90,0,0,.85) 100%);
    animation:klaxon 1s ease-in-out infinite; }
  #alert .bars{ position:absolute; inset:0;
    background:linear-gradient(to bottom, rgba(255,0,0,.9) 0 14px, transparent 14px calc(100% - 14px), rgba(255,0,0,.9) calc(100% - 14px) 100%);
    animation:klaxon 1s ease-in-out infinite; }
  #alert .msg{ position:relative; text-align:center; color:#fff; font-weight:900;
    font-size:104px; letter-spacing:.06em; line-height:1.1;
    text-shadow:0 0 18px #ff2d2d, 0 0 54px #ff0000, 0 6px 10px rgba(0,0,0,.7);
    animation:klaxonText 1s ease-in-out infinite; }
  @keyframes klaxon{ 0%,100%{ opacity:.25 } 50%{ opacity:1 } }
  @keyframes klaxonText{ 0%,100%{ transform:scale(.97); opacity:.75 } 50%{ transform:scale(1.03); opacity:1 } }

  /* ── Incoming boss dossier ──────────────────────────────────────────────── */
  #intel{ display:flex; align-items:center; }
  #intel .portrait{ width:46%; height:100%; display:flex; align-items:center; justify-content:center; }
  #intel .portrait img{ max-width:88%; max-height:82%; object-fit:contain;
    filter:drop-shadow(0 0 40px rgba(255,60,60,.55)) drop-shadow(0 18px 30px rgba(0,0,0,.6));
    animation:reveal .8s ease both; }
  @keyframes reveal{ from{ opacity:0; transform:scale(.88) } to{ opacity:1; transform:scale(1) } }
  #intel .dossier{ flex:1; height:100%; padding:80px 90px 80px 20px; box-sizing:border-box;
    display:flex; flex-direction:column; justify-content:center;
    font-family:'Courier New',ui-monospace,monospace; color:#8dff9b;
    text-shadow:0 0 10px rgba(80,255,120,.55); }
  #intel .frame{ border:3px solid rgba(120,255,150,.45); border-radius:6px; padding:34px 38px;
    background:linear-gradient(180deg, rgba(0,30,10,.72), rgba(0,18,6,.82));
    box-shadow:0 0 50px rgba(0,255,90,.18), inset 0 0 60px rgba(0,255,90,.07); }
  #intel .tag{ font-size:22px; letter-spacing:.34em; color:#4fe07a; opacity:.85; margin:0 0 14px }
  #intel .bname{ font-size:68px; font-weight:700; margin:0 0 18px; line-height:1.05; color:#d6ffdd; }
  #intel .bdesc{ font-size:28px; line-height:1.45; margin:0 0 26px; min-height:2.9em; }
  #intel .vuln{ font-size:30px; display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
  #intel .vuln img{ width:56px; height:56px; vertical-align:middle;
    filter:drop-shadow(0 0 10px rgba(255,255,255,.35)); }
  #intel .vuln .q{ font-size:34px; font-weight:700; color:#ffe37a; text-shadow:0 0 12px rgba(255,200,60,.6) }
  /* Every character is in the DOM from the start and merely HIDDEN, so the frame
     is already at its final size and nothing reflows as the text arrives. */
  #intel .ch{ visibility:hidden; }
  #intel .ch.on{ visibility:visible; }
  /* The next cell to fill doubles as the cursor: a blinking block that occupies
     the character's own space, so the caret costs no layout either. */
  #intel .ch.next{ visibility:visible; color:transparent; background:#8dff9b;
    animation:blink .8s step-end infinite; }
  /* Held open while the dossier types, then revealed. */
  #intel .vuln.pending{ visibility:hidden; }
  @keyframes blink{ 0%,100%{ opacity:1 } 50%{ opacity:0 } }

  /* ── Health bar ─────────────────────────────────────────────────────────── */
  #hud{ position:absolute; left:0; right:0; top:42px; display:flex; flex-direction:column;
    align-items:center; gap:10px; opacity:0; transition:opacity .5s ease; }
  #hud.show{ opacity:1 }
  #hud .title{ font-size:44px; font-weight:800; color:#fff; letter-spacing:.04em;
    text-shadow:0 0 14px rgba(255,80,80,.8), 0 4px 8px rgba(0,0,0,.75); }
  #bar{ position:relative; width:1560px; height:52px; border:4px solid rgba(255,255,255,.85);
    border-radius:10px; background:rgba(0,0,0,.55); overflow:hidden;
    box-shadow:0 0 26px rgba(0,0,0,.6), inset 0 0 18px rgba(0,0,0,.6); }
  #fill{ position:absolute; left:0; top:0; bottom:0; width:100%;
    background:linear-gradient(180deg,#63f27a,#1f9e3a);
    transition:width .32s cubic-bezier(.2,.8,.3,1), background .45s ease; }
  #bar .ticks{ position:absolute; inset:0;
    background:repeating-linear-gradient(to right, rgba(0,0,0,.28) 0 2px, transparent 2px 52px); }
  #hpnum{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    font-size:30px; font-weight:800; color:#fff; text-shadow:0 2px 6px rgba(0,0,0,.9); }
  #bar.shake{ animation:shake .26s ease }
  @keyframes shake{
    0%,100%{ transform:translateX(0) } 20%{ transform:translateX(-7px) }
    45%{ transform:translateX(6px) } 70%{ transform:translateX(-3px) } }

  /* ── The boss ───────────────────────────────────────────────────────────── */
  #boss{ position:absolute; left:0; top:0; opacity:0; transition:opacity .9s ease; }
  #boss.in{ opacity:1 }
  #boss img{ width:100%; height:100%; display:block; border-radius:14px;
    transition:filter .5s ease; }
  #boss.dying img{ animation:explode 1.1s ease-out forwards }
  @keyframes explode{
    0%{ transform:scale(1); filter:brightness(1) }
    18%{ transform:scale(1.22); filter:brightness(3.4) drop-shadow(0 0 60px #fff) }
    50%{ transform:scale(1.5) rotate(6deg); filter:brightness(5) drop-shadow(0 0 120px #ffb347) }
    100%{ transform:scale(2.1) rotate(-4deg); opacity:0; filter:brightness(6) drop-shadow(0 0 160px #ff5722) }
  }
  /* Death throes: the boss rattles itself apart while it gets its last word in.
     Safe to animate transform on #boss because movement uses left/top. */
  #boss.shaking{ animation:deathShake .16s linear infinite; }
  @keyframes deathShake{
    0%{ transform:translate(0,0) rotate(0deg) }
    25%{ transform:translate(-7px,3px) rotate(-1.6deg) }
    50%{ transform:translate(6px,-4px) rotate(1.4deg) }
    75%{ transform:translate(-4px,-2px) rotate(-.8deg) }
    100%{ transform:translate(5px,3px) rotate(1deg) }
  }
  .mini{ position:absolute; border-radius:50%; pointer-events:none; opacity:0;
    background:radial-gradient(circle, #fff 0%, #ffe066 35%, #ff8a34 60%, rgba(255,80,0,0) 72%);
    animation:mini .5s ease-out forwards; }
  @keyframes mini{
    0%{ opacity:0; transform:scale(.2) }
    25%{ opacity:1; transform:scale(1.1) }
    100%{ opacity:0; transform:scale(1.7) }
  }
  #shock{ position:absolute; left:0; top:0; border-radius:50%; opacity:0; pointer-events:none;
    border:10px solid #ffd166; box-shadow:0 0 60px #ff8a34, inset 0 0 60px #ffd166; }
  #shock.go{ animation:shock 1.2s cubic-bezier(.15,.75,.3,1) forwards }
  @keyframes shock{ 0%{ opacity:.95; transform:scale(.3) } 100%{ opacity:0; transform:scale(4.2) } }

  /* ── Taunt bubble ───────────────────────────────────────────────────────── */
  #bubble{ position:absolute; left:0; top:0; max-width:620px; padding:18px 26px; opacity:0;
    background:#fff; color:#161616; border-radius:20px; font-size:34px; font-weight:700;
    line-height:1.25; box-shadow:0 10px 30px rgba(0,0,0,.5); transition:opacity .25s ease;
    white-space:pre-wrap; }
  #bubble.show{ opacity:1 }
  #bubble::after{ content:''; position:absolute; bottom:-16px; left:34px; width:0; height:0;
    border:16px solid transparent; border-top-color:#fff; border-bottom:0; }
  /* Flipped when the boss sits on the right, so the bubble never leaves the frame. */
  #bubble.flip::after{ left:auto; right:34px; }

  /* ── Crowd + lasers + floats ────────────────────────────────────────────── */
  #crowd{ position:absolute; left:0; right:0; bottom:26px; height:128px; }
  .fighter{ position:absolute; bottom:0; width:84px; height:84px; margin-left:-42px;
    border-radius:50%; border:4px solid #ff4d6d; background:#241a2b center/cover no-repeat;
    box-shadow:0 0 16px rgba(255,77,109,.5), 0 6px 14px rgba(0,0,0,.6);
    display:flex; align-items:center; justify-content:center;
    color:#fff; font-size:34px; font-weight:800; text-shadow:0 2px 4px rgba(0,0,0,.8);
    transition:left .35s cubic-bezier(.2,.8,.3,1), width .35s ease, height .35s ease;
    animation:joinPop .45s cubic-bezier(.2,1.4,.4,1) both; }
  @keyframes joinPop{ from{ transform:translateY(26px) scale(.5); opacity:0 } to{ transform:none; opacity:1 } }
  .fighter.firing{ box-shadow:0 0 30px #ff2d55, 0 0 60px rgba(255,45,85,.7), 0 6px 14px rgba(0,0,0,.6) }
  /* The wrapper owns the aim (a static inline rotate) and the inner bar owns the
     animation. They MUST be separate elements: a CSS animation overrides inline
     styles for the properties it animates, so animating transform on the same
     element would silently discard the rotation and fire every beam due east. */
  .beam-wrap{ position:absolute; height:6px; transform-origin:0 50%; pointer-events:none; }
  .beam{ position:absolute; inset:0; transform-origin:0 50%; border-radius:3px;
    background:linear-gradient(to right, rgba(255,40,80,0), #ff2d55 30%, #fff 92%);
    box-shadow:0 0 14px #ff2d55, 0 0 26px rgba(255,45,85,.8);
    animation:beam .34s ease-out forwards; }
  @keyframes beam{ 0%{ opacity:0; transform:scaleX(.2) } 22%{ opacity:1; transform:scaleX(1) }
    100%{ opacity:0; transform:scaleX(1) } }
  .float{ position:absolute; font-size:54px; font-weight:900; pointer-events:none;
    transform:translate(-50%,0); animation:floatUp 1.15s ease-out forwards; }
  .float.hit{ color:#ff3b3b; text-shadow:0 0 14px rgba(255,60,60,.9), 0 3px 6px rgba(0,0,0,.8) }
  .float.miss{ color:#c9c9c9; font-size:40px; text-shadow:0 0 10px rgba(0,0,0,.6), 0 3px 6px rgba(0,0,0,.8) }
  .float.heal{ color:#5bff8a; text-shadow:0 0 14px rgba(70,255,130,.9), 0 3px 6px rgba(0,0,0,.8) }
  @keyframes floatUp{
    0%{ opacity:0; transform:translate(-50%,10px) scale(.7) }
    18%{ opacity:1; transform:translate(-50%,-6px) scale(1.15) }
    100%{ opacity:0; transform:translate(-50%,-92px) scale(1) }
  }

  /* ── Mega cannon: shared battery in the bottom centre ──────────────────── */
  #cannon{ position:absolute; left:50%; bottom:14px; width:150px; height:132px;
    margin-left:-75px; opacity:0; transition:opacity .5s ease; }
  #cannon.show{ opacity:1 }
  /* The pulse lives on its own element: #cannon carries no transform of its own,
     but keeping them separate means the glow animation can never fight the
     layout, and the pulse rate is set inline per frame. */
  /* The pulse. Its SIZE is set inline from the charge (growing from a modest
     halo to something that swamps the cannon) and its PERIOD shortens as it
     fills, so "nearly full" is unmistakable from across the room. */
  #cannon-glow{ position:absolute; left:50%; top:30px; border-radius:50%; pointer-events:none;
    width:240px; height:240px; margin:-120px 0 0 -120px;
    background:radial-gradient(circle, rgba(255,110,110,.95) 0%, rgba(255,40,40,.55) 34%, rgba(255,0,0,.2) 58%, rgba(255,0,0,0) 74%);
    animation:cannonPulse 1.7s ease-in-out infinite; }
  @keyframes cannonPulse{
    0%,100%{ opacity:.14; transform:scale(.6) }
    50%{ opacity:1; transform:scale(1.22) }
  }
  /* A shockwave ring emitted on every beat — the visual metronome. */
  #cannon-ring{ position:absolute; left:50%; top:30px; width:150px; height:150px; margin:-75px 0 0 -75px;
    border-radius:50%; border:7px solid rgba(255,70,70,.95); opacity:0; pointer-events:none;
    box-shadow:0 0 26px rgba(255,50,50,.8); }
  #cannon-ring.on{ animation:cannonRing 1.7s linear infinite; }
  @keyframes cannonRing{ 0%{ opacity:.95; transform:scale(.3) } 100%{ opacity:0; transform:scale(2.1) } }
  /* Nearly full: the whole battery rattles and the terminal runs white-hot. */
  #cannon.hot{ animation:cannonRattle .11s linear infinite; }
  @keyframes cannonRattle{
    0%,100%{ transform:translate(0,0) } 25%{ transform:translate(-3px,1px) }
    50%{ transform:translate(3px,-2px) } 75%{ transform:translate(-2px,-1px) }
  }
  #cannon.hot #cannon-coil{ background:radial-gradient(circle at 35% 30%, #fff 0%, #fff 42%, #ff8a8a 70%, #c31010 100%);
    box-shadow:0 0 34px #fff, 0 0 80px rgba(255,60,60,.95); }
  #cannon.hot #cannon-windings{ opacity:1; filter:brightness(1.7) }
  /* A tesla-coil tower rather than a barrel: a discharge terminal can plausibly
     throw a bolt in ANY direction, which a fixed gun barrel cannot. */
  #cannon-mast{ position:absolute; left:50%; margin-left:-17px; top:26px; width:34px; height:44px;
    background:linear-gradient(90deg,#2a2f3a,#6b7484 45%,#333a47);
    clip-path:polygon(30% 0, 70% 0, 100% 100%, 0 100%); }
  /* Stacked windings, purely decorative. */
  #cannon-windings{ position:absolute; left:50%; margin-left:-14px; top:38px; width:28px; height:30px;
    background:repeating-linear-gradient(to bottom, rgba(255,190,120,.85) 0 2px, rgba(90,50,20,.7) 2px 5px);
    border-radius:3px; opacity:.85; }
  /* The terminal the bolt leaves from. Its live position is read from the DOM, so
     restyling the tower cannot desync the beam's origin. */
  #cannon-coil{ position:absolute; left:50%; margin-left:-19px; top:0; width:38px; height:38px;
    border-radius:50%; background:radial-gradient(circle at 35% 30%, #fff 0%, #ffd2d2 30%, #ff5555 62%, #8d0b0b 100%);
    box-shadow:0 0 18px rgba(255,80,80,.9), 0 0 42px rgba(255,40,40,.55); }
  /* Crackle around the terminal, wound up by charge. */
  #cannon-arc{ position:absolute; left:50%; top:19px; width:70px; height:70px; margin:-35px 0 0 -35px;
    border-radius:50%; opacity:0; pointer-events:none;
    background:conic-gradient(from 0deg, rgba(255,255,255,0) 0deg, rgba(255,210,210,.95) 24deg, rgba(255,255,255,0) 48deg,
      rgba(255,255,255,0) 160deg, rgba(255,190,190,.9) 188deg, rgba(255,255,255,0) 214deg); }
  #cannon-arc.on{ animation:coilArc .5s linear infinite; }
  @keyframes coilArc{ 0%{ opacity:.25; transform:rotate(0deg) } 50%{ opacity:.95; transform:rotate(180deg) }
    100%{ opacity:.25; transform:rotate(360deg) } }
  #cannon-base{ position:absolute; left:0; right:0; bottom:0; height:78px; border-radius:14px;
    background:linear-gradient(180deg,#464f60,#20252f); border:3px solid #10131a;
    box-shadow:0 8px 18px rgba(0,0,0,.6), inset 0 4px 10px rgba(255,255,255,.1); }
  /* Vertical meter, centred on the cannon, filling bottom to top. */
  #cannon-meter{ position:absolute; left:50%; margin-left:-19px; bottom:12px; width:38px; height:56px;
    border-radius:6px; border:3px solid #0d1016; background:rgba(0,0,0,.6); overflow:hidden; }
  #cannon-fill{ position:absolute; left:0; right:0; bottom:0; height:0%;
    background:linear-gradient(180deg,#ff6b6b,#c1121f);
    box-shadow:0 0 14px rgba(255,60,60,.9); transition:height .25s ease-out; }
  #cannon.firing #cannon-glow{ animation:none; opacity:1; transform:scale(1.7) }
  #cannon.firing #cannon-coil{ background:#fff; box-shadow:0 0 60px #fff, 0 0 140px rgba(255,120,120,1) }
  #cannon.firing #cannon-base, #cannon.firing #cannon-mast{ animation:cannonKick .32s ease-out }
  @keyframes cannonKick{ 0%{ transform:translateY(0) } 35%{ transform:translateY(12px) } 100%{ transform:translateY(0) } }

  /* A dupe's grey shot, lobbed at the cannon instead of wasted on the boss.
     Positioned here; the arc itself is scripted, since every shot has its own
     start point and no CSS keyframe could know it. */
  .arc{ position:absolute; width:20px; height:20px; border-radius:50%; pointer-events:none;
    background:radial-gradient(circle,#f2f2f2 0%,#9aa0a6 55%,rgba(120,120,120,0) 72%);
    box-shadow:0 0 12px rgba(200,200,200,.75); }
  /* The cannon's own shot: thick, bright, and unmistakably not a laser. */
  .beam-wrap.mega{ height:26px }
  .mega .beam{ border-radius:13px;
    background:linear-gradient(to right, rgba(255,80,80,0), #ff3b3b 25%, #fff 88%);
    box-shadow:0 0 34px #ff2d2d, 0 0 80px rgba(255,45,45,.85);
    animation:beam .5s ease-out forwards; }
  .float.mega{ font-size:104px; }

  /* ── Outro banners ──────────────────────────────────────────────────────── */
  #outro{ display:flex; align-items:center; justify-content:center; }
  #outro .banner{ text-align:center; font-weight:900; line-height:1.1; opacity:0;
    animation:bannerIn .6s cubic-bezier(.2,1.5,.4,1) both; }
  #outro .banner .big{ display:block; font-size:110px; letter-spacing:.04em }
  #outro .banner .sub{ display:block; font-size:44px; font-weight:700; margin-top:18px; opacity:.95 }
  #outro.win .banner{ color:#ffe066; text-shadow:0 0 22px #ffb703, 0 0 70px rgba(255,183,3,.7), 0 6px 12px rgba(0,0,0,.8) }
  #outro.lose .banner{ color:#cfd6ff; text-shadow:0 0 20px rgba(120,140,255,.7), 0 6px 12px rgba(0,0,0,.85) }
  @keyframes bannerIn{ from{ opacity:0; transform:scale(.7) } to{ opacity:1; transform:scale(1) } }
</style>
</head>
<body>
<div id="stage">
  <div class="layer hide" id="alert"><div class="wash"></div><div class="bars"></div>
    <div class="msg">WARNING!<br />A BOSS IS APPROACHING!</div></div>

  <div class="layer hide" id="intel">
    <div class="portrait"><img id="intel-img" alt="" /></div>
    <div class="dossier"><div class="frame">
      <p class="tag">INCOMING HOSTILE // THREAT ASSESSMENT</p>
      <div class="bname" id="intel-name"></div>
      <div class="bdesc" id="intel-desc"></div>
      <div class="vuln" id="intel-vuln"></div>
    </div></div>
  </div>

  <div class="layer" id="field">
    <div id="hud"><div class="title" id="hud-name"></div>
      <div id="bar"><div id="fill"></div><div class="ticks"></div><div id="hpnum"></div></div></div>
    <div id="shock"></div>
    <div id="boss"><img id="boss-img" alt="" /></div>
    <div id="bubble"></div>
    <div id="crowd"></div>
    <div id="cannon">
      <div id="cannon-glow"></div>
      <div id="cannon-ring"></div>
      <div id="cannon-base"></div>
      <div id="cannon-mast"></div>
      <div id="cannon-windings"></div>
      <div id="cannon-arc"></div>
      <div id="cannon-coil"></div>
      <div id="cannon-meter"><div id="cannon-fill"></div></div>
    </div>
  </div>

  <div class="layer hide" id="outro"></div>
</div>
<script>
(function(){
  'use strict';
  var W = 1920, H = 1080;
  var stage = document.getElementById('stage');

  // ── Scale the 1920x1080 design space into whatever OBS gives us ───────────
  function fit(){
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  var elAlert = document.getElementById('alert');
  var elIntel = document.getElementById('intel');
  var elOutro = document.getElementById('outro');
  var hud = document.getElementById('hud');
  var bar = document.getElementById('bar');
  var fill = document.getElementById('fill');
  var hpnum = document.getElementById('hpnum');
  var hudName = document.getElementById('hud-name');
  var boss = document.getElementById('boss');
  var bossImg = document.getElementById('boss-img');
  var shock = document.getElementById('shock');
  var bubble = document.getElementById('bubble');
  var crowd = document.getElementById('crowd');
  var field = document.getElementById('field');
  var cannon = document.getElementById('cannon');
  var cannonGlow = document.getElementById('cannon-glow');
  var cannonFill = document.getElementById('cannon-fill');
  var cannonRing = document.getElementById('cannon-ring');
  var cannonArc = document.getElementById('cannon-arc');
  var cannonCoil = document.getElementById('cannon-coil');

  // ── Audio ─────────────────────────────────────────────────────────────────
  // Sound urls + volumes arrive with each battle's 'alert', so swapping a sound
  // in the admin panel applies to the next battle with no OBS refresh.
  var sounds = {}, volSfx = 0.8, volBgm = 0.5;
  var loops = {};   // slot -> looping Audio element
  var live = [];    // one-shot Audio elements still playing

  function playOnce(slot, scale){
    var url = sounds[slot];
    if(!url) return;
    try{
      var a = new Audio(url);
      a.volume = volSfx * (scale == null ? 1 : scale);
      // Overlapping one-shots need their own element; cap it so a chat burst
      // can't spawn hundreds of decoders.
      live = live.filter(function(x){ return !x.ended; });
      if(live.length > 12) return;
      live.push(a);
      var p = a.play();
      if(p && p.catch) p.catch(function(){});
    }catch(e){}
  }
  function playLoop(slot, volume){
    var url = sounds[slot];
    if(!url || loops[slot]) return;
    try{
      var a = new Audio(url);
      a.loop = true;
      a.volume = volume;
      loops[slot] = a;
      var p = a.play();
      if(p && p.catch) p.catch(function(){});
    }catch(e){}
  }
  function stopLoop(slot){
    var a = loops[slot];
    if(!a) return;
    try{ a.pause(); a.currentTime = 0; }catch(e){}
    delete loops[slot];
  }
  function stopAllAudio(){
    for(var k in loops) if(Object.prototype.hasOwnProperty.call(loops, k)) stopLoop(k);
    live.forEach(function(a){ try{ a.pause(); }catch(e){} });
    live = [];
  }

  // ── Phase plumbing ────────────────────────────────────────────────────────
  var state = null;      // the live boss: position, velocity, style, hp
  var fighters = {};     // userId -> { el, name, order }
  var order = 0;
  var raf = null;
  var timers = [];

  function later(fn, ms){ var t = setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers(){ timers.forEach(clearTimeout); timers = []; }
  function show(el){ el.classList.remove('hide'); }
  function hide(el){ el.classList.add('hide'); }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function reset(){
    clearTimers();
    if(raf){ cancelAnimationFrame(raf); raf = null; }
    stopAllAudio();
    state = null;
    fighters = {}; order = 0;
    crowd.innerHTML = '';
    hide(elAlert); hide(elIntel); hide(elOutro);
    elOutro.className = 'layer hide';
    hud.classList.remove('show');
    boss.classList.remove('in','dying','shaking');
    bossImg.removeAttribute('src');
    bubble.classList.remove('show','flip');
    shock.classList.remove('go');
    cannon.classList.remove('show','firing','hot');
    cannonRing.classList.remove('on');
    cannonArc.classList.remove('on');
    cannonFill.style.height = '0%';
  }

  // ── Red alert ─────────────────────────────────────────────────────────────
  function onAlert(d){
    reset();
    sounds = (d && d.sounds) || {};
    volSfx = clamp01(((d && d.volumeSfx) != null ? d.volumeSfx : 80) / 100);
    volBgm = clamp01(((d && d.volumeBgm) != null ? d.volumeBgm : 50) / 100);
    show(elAlert);
    playLoop('alert', volSfx);
  }
  function clamp01(n){ n = Number(n); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }

  // ── Intel dossier ─────────────────────────────────────────────────────────
  function onIntel(d){
    stopLoop('alert');
    hide(elAlert);
    show(elIntel);
    var img = document.getElementById('intel-img');
    if(d && d.imageUrl) img.src = d.imageUrl; else img.removeAttribute('src');

    var nameEl = document.getElementById('intel-name');
    var descEl = document.getElementById('intel-desc');
    var vulnEl = document.getElementById('intel-vuln');
    nameEl.textContent = ''; descEl.textContent = '';
    // Drawn now but held invisible, so it reserves its height instead of shoving
    // the frame open when the typing finishes.
    renderVulns(vulnEl, d);
    vulnEl.classList.add('pending');

    // Type the dossier out, name first then description, like a slow terminal.
    var name = String((d && d.name) || '').toUpperCase();
    var desc = String((d && d.description) || '');
    var hold = Math.max(1, Number(d && d.seconds) || 5) * 1000;
    // Budget the typing so it always finishes with time left to read.
    var chars = name.length + desc.length || 1;
    var per = Math.max(12, Math.min(45, (hold * 0.62) / chars));
    // Loops for the WHOLE dossier phase, not just while text is still arriving:
    // the typing budget is capped per character, so a short dossier finishes well
    // before the hold does and the clip would otherwise cut out mid-screen.
    // Stopped in onSpawn (or by reset), when the dossier actually leaves.
    playLoop('intel', volSfx * 0.6);

    typeInto(nameEl, name, per, function(){
      typeInto(descEl, desc, per, function(){
        vulnEl.classList.remove('pending');
      });
    });
  }

  /**
   * Reveal text one character at a time WITHOUT the box growing as it goes.
   *
   * The whole string is laid out up front with every character hidden, so the
   * frame settles at its final height immediately (and line wrapping is decided
   * once, rather than re-flowing on every keystroke). Typing then just flips
   * characters visible, which cannot affect layout at all.
   */
  function typeInto(el, text, per, done){
    el.textContent = '';
    var chars = [];
    for(var n = 0; n < text.length; n++){
      var sp = document.createElement('span');
      sp.className = 'ch';
      sp.textContent = text.charAt(n);
      el.appendChild(sp);
      chars.push(sp);
    }
    // The caret waits on the first cell before anything is revealed.
    if(chars[0]) chars[0].classList.add('next');
    var i = 0;
    (function step(){
      if(i >= chars.length) return done && done();
      // Clear the caret off this cell BEFORE revealing it, or the character would
      // stay masked by its own cursor for a tick and read one behind.
      chars[i].classList.remove('next');
      chars[i].classList.add('on');
      if(chars[i + 1]) chars[i + 1].classList.add('next');
      i++;
      later(step, per);
    })();
  }

  /**
   * "Vulnerabilities:" followed by the PUBLIC emotes. Secret vulnerabilities are
   * never named, only teased with "???" — which is also the whole list when the
   * boss has no public weaknesses at all.
   */
  function renderVulns(el, d){
    var list = (d && d.vulnerabilities) || [];
    var parts = ['<span>Vulnerabilities:</span>'];
    for(var i = 0; i < list.length; i++){
      var v = list[i];
      if(v && v.url) parts.push('<img src="' + esc(v.url) + '" alt="' + esc(v.name) + '" title="' + esc(v.name) + '" />');
      else parts.push('<span>' + esc(v && v.name) + '</span>');
    }
    if(d && d.hasSecret) parts.push('<span class="q">' + (list.length ? 'and ???' : '???') + '</span>');
    else if(!list.length) parts.push('<span class="q">???</span>');
    el.innerHTML = parts.join(' ');
  }

  // ── Spawn + the fight ─────────────────────────────────────────────────────
  function onSpawn(d){
    stopLoop('intel');
    hide(elIntel);
    var cfg = (d && d.config) || {};
    var size = Number(d && d.size) || 256;

    state = {
      size: size,
      hp: Number(d && d.hp) || 1,
      maxHp: Math.max(1, Number(d && d.maxHp) || 1),
      speedFull: Number(d && d.speedFull) || 5,
      speedNear: Number(d && d.speedNearDeath) || 5,
      styles: (d && d.styles && d.styles.length) ? d.styles : ['pingpong'],
      taunts: (d && d.taunts) || [],
      style: 'pingpong',
      // Position: centre stage, which is also where it fades in.
      x: (W - size) / 2, y: (H - size) / 2,
      vx: 0, vy: 0,
      paused: true,
      lastTaunt: '',
      // darting
      tx: 0, ty: 0,
      // spin
      cx: 0, cy: 0, angle: 0,
      spinRadius: Number(cfg.spinRadius) || 180,
      spinSeconds: Number(cfg.spinSeconds) || 6,
      dartSeconds: Number(cfg.dartSeconds) || 0.6,
      tauntEvery: Number(cfg.tauntEverySeconds) || 12,
      tauntHold: Number(cfg.tauntHoldSeconds) || 3,
      crowdMax: Number(cfg.crowdMax) || 60,
      outroTaunt: cfg.outroTauntSeconds == null ? 3 : Number(cfg.outroTauntSeconds),
      charge: 0,
      chargeMax: Math.max(1, Number(cfg.cannonFull) || 15),
      chargeRate: Math.max(0, Number(cfg.cannonDischarge) || 0),
      cannonDamage: Math.max(1, Number(cfg.cannonDamage) || 10),
      last: 0
    };

    boss.style.width = size + 'px';
    boss.style.height = size + 'px';
    shock.style.width = size + 'px';
    shock.style.height = size + 'px';
    if(d && d.imageUrl) bossImg.src = d.imageUrl;
    place();

    hudName.textContent = String((d && d.name) || '');
    setHp(state.hp, state.maxHp);
    hud.classList.add('show');
    // Force a reflow so the opacity transition actually runs from 0.
    void boss.offsetWidth;
    boss.classList.add('in');
    cannon.classList.add('show');
    paintCannon();
    playOnce('spawn');
    playLoop('bgm', volBgm);

    // Opening taunt, then it starts moving.
    var opening = String((d && d.openingTaunt) || '');
    if(opening){
      sayBubble(opening);
      later(function(){ hideBubble(); startMoving(); }, Math.max(1600, state.tauntHold * 1000));
    }else{
      later(startMoving, 700);
    }
    startLoop();
  }

  function startMoving(){
    if(!state) return;
    state.paused = false;
    pickStyle();
    scheduleTaunt();
  }

  /** Pause to taunt, then re-roll the movement style — as specified. */
  function scheduleTaunt(){
    if(!state) return;
    later(function(){
      if(!state) return;
      state.paused = true;
      var list = state.taunts;
      if(list.length){
        // Avoid repeating the previous line when there is another to pick.
        var line = list[Math.floor(Math.random() * list.length)];
        if(list.length > 1){
          var guard = 0;
          while(line === state.lastTaunt && guard++ < 8) line = list[Math.floor(Math.random() * list.length)];
        }
        state.lastTaunt = line;
        sayBubble(line);
      }
      later(function(){
        if(!state) return;
        hideBubble();
        state.paused = false;
        pickStyle();
        scheduleTaunt();
      }, state.tauntHold * 1000);
    }, state.tauntEvery * 1000);
  }

  function pickStyle(){
    if(!state) return;
    var s = state.styles[Math.floor(Math.random() * state.styles.length)];
    state.style = s;
    var px = speedPx();
    if(s === 'pingpong'){
      var a = Math.random() * Math.PI * 2;
      state.vx = Math.cos(a) * px;
      state.vy = Math.sin(a) * px;
    }else if(s === 'darting'){
      newDartTarget();
    }else if(s === 'spin'){
      // Circle around wherever it currently is, kept fully on screen.
      state.cx = clamp(state.x + state.size / 2, bounds().minX + state.spinRadius, bounds().maxX + state.size / 2 - state.spinRadius);
      state.cy = clamp(state.y + state.size / 2, bounds().minY + state.spinRadius, bounds().maxY + state.size / 2 - state.spinRadius);
      state.angle = Math.random() * Math.PI * 2;
    }
  }

  /** Travel area: clear of the health bar at the top and the crowd at the bottom. */
  function bounds(){
    var s = state ? state.size : 256;
    return { minX: 40, minY: 170, maxX: W - s - 40, maxY: H - s - 190 };
  }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  /** Map the 1..10 speed dial to design pixels per second. */
  function speedPx(){
    if(!state) return 0;
    var lerped = lerpSpeed();
    return 60 + lerped * 55;
  }
  /**
   * Interpolate between the full-health and near-death dials. The direction is
   * not assumed: a boss may be configured to start slow and get frantic.
   */
  function lerpSpeed(){
    if(!state) return 5;
    if(state.maxHp <= 1) return state.speedNear;
    var hp = clamp(state.hp, 1, state.maxHp);
    var t = (state.maxHp - hp) / (state.maxHp - 1);
    return state.speedFull + (state.speedNear - state.speedFull) * t;
  }

  function newDartTarget(){
    var b = bounds();
    state.tx = b.minX + Math.random() * Math.max(1, b.maxX - b.minX);
    state.ty = b.minY + Math.random() * Math.max(1, b.maxY - b.minY);
  }

  function startLoop(){
    if(raf) cancelAnimationFrame(raf);
    state.last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function tick(now){
    raf = requestAnimationFrame(tick);
    if(!state) return;
    var dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    if(!state.paused) move(dt);
    dischargeCannon(dt);
    place();
  }

  function move(dt){
    var b = bounds();
    var px = speedPx();
    if(state.style === 'pingpong'){
      // Re-normalise so a health change retunes the speed without changing heading.
      var mag = Math.sqrt(state.vx * state.vx + state.vy * state.vy) || 1;
      state.vx = state.vx / mag * px;
      state.vy = state.vy / mag * px;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      if(state.x <= b.minX){ state.x = b.minX; state.vx = Math.abs(state.vx); }
      if(state.x >= b.maxX){ state.x = b.maxX; state.vx = -Math.abs(state.vx); }
      if(state.y <= b.minY){ state.y = b.minY; state.vy = Math.abs(state.vy); }
      if(state.y >= b.maxY){ state.y = b.maxY; state.vy = -Math.abs(state.vy); }
      bossImg.style.transform = '';
    }else if(state.style === 'darting'){
      // Zig-zag: sprint to a random point, then immediately pick another.
      var dx = state.tx - state.x, dy = state.ty - state.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var step = (px * 2.4) * dt; // darting is deliberately snappier than drifting
      if(dist <= step || dist < 4){
        state.x = state.tx; state.y = state.ty;
        newDartTarget();
      }else{
        state.x += dx / dist * step;
        state.y += dy / dist * step;
      }
      bossImg.style.transform = '';
    }else{
      // Spin: orbit a centre point AND rotate the art.
      state.angle += (Math.PI * 2 / Math.max(1, state.spinSeconds)) * dt * (px / 300 + 0.6);
      state.x = clamp(state.cx + Math.cos(state.angle) * state.spinRadius - state.size / 2, b.minX, b.maxX);
      state.y = clamp(state.cy + Math.sin(state.angle) * state.spinRadius - state.size / 2, b.minY, b.maxY);
      bossImg.style.transform = 'rotate(' + (state.angle * 180 / Math.PI) + 'deg)';
    }
  }

  function place(){
    if(!state) return;
    boss.style.left = state.x + 'px';
    boss.style.top = state.y + 'px';
    shock.style.left = state.x + 'px';
    shock.style.top = state.y + 'px';
    if(bubble.classList.contains('show')) placeBubble();
  }

  // ── Taunt bubble (flips to whichever side has room) ───────────────────────
  function sayBubble(text){
    bubble.textContent = String(text || '');
    bubble.classList.add('show');
    placeBubble();
  }
  function hideBubble(){ bubble.classList.remove('show'); }
  function placeBubble(){
    if(!state) return;
    var bw = bubble.offsetWidth || 260;
    var bh = bubble.offsetHeight || 80;
    var onRight = (state.x + state.size / 2) > W / 2;
    var x = onRight ? state.x - bw + 40 : state.x + state.size - 40;
    bubble.classList.toggle('flip', onRight);
    bubble.style.left = clamp(x, 20, W - bw - 20) + 'px';
    bubble.style.top = clamp(state.y - bh - 26, 150, H - bh - 20) + 'px';
  }

  // ── Health bar ────────────────────────────────────────────────────────────
  function setHp(hp, maxHp){
    var pct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    fill.style.width = (pct * 100) + '%';
    hpnum.textContent = Math.max(0, hp) + ' / ' + maxHp;
    // Green while healthy, yellow through the middle third, red for the last —
    // the reverse of Pet the Floof, because here the colour tracks OUR progress.
    var g = pct > 2/3 ? ['#63f27a','#1f9e3a'] : pct > 1/3 ? ['#ffd24a','#c98a00'] : ['#ff5d5d','#a80f0f'];
    fill.style.background = 'linear-gradient(180deg,' + g[0] + ',' + g[1] + ')';
    var aura = pct > 2/3 ? ['#3fb950','#1f7a33'] : pct > 1/3 ? ['#ffd24a','#c98a00'] : ['#ff2d2d','#b00000'];
    bossImg.style.filter = 'drop-shadow(0 0 18px ' + aura[0] + ') drop-shadow(0 0 46px ' + aura[1] + ') saturate(1.2)';
  }
  function shakeBar(){
    bar.classList.remove('shake');
    void bar.offsetWidth; // restart the animation for back-to-back hits
    bar.classList.add('shake');
  }

  // ── Mega cannon ───────────────────────────────────────────────────────────
  /**
   * Draw the meter and set the pulse rate. The pulse speeds up as the cannon
   * fills — from a slow idle throb to a frantic flash just before it goes off.
   */
  function paintCannon(){
    if(!state) return;
    var f = Math.max(0, Math.min(1, state.charge / state.chargeMax));
    cannonFill.style.height = (f * 100) + '%';

    // One period drives the glow and the ring together so they beat as one.
    var period = (1.7 - f * 1.45).toFixed(2) + 's';
    cannonGlow.style.animationDuration = period;
    cannonRing.style.animationDuration = period;

    // The halo GROWS with charge as well as quickening. Size is set inline
    // because the keyframes own opacity and transform.
    var halo = Math.round(150 + f * 290);
    cannonGlow.style.width = halo + 'px';
    cannonGlow.style.height = halo + 'px';
    cannonGlow.style.margin = (-halo / 2) + 'px 0 0 ' + (-halo / 2) + 'px';

    // Ring and coil crackle only once there is something worth advertising.
    cannonRing.classList.toggle('on', f > 0.12);
    cannonArc.classList.toggle('on', f > 0.3);
    cannon.classList.toggle('hot', f >= 0.75);
  }

  /**
   * Bleed the meter between authoritative updates. The bot sends the true charge
   * with every combat frame, so this only has to look right in the quiet gaps —
   * and any drift is corrected the moment somebody types.
   */
  function dischargeCannon(dt){
    if(!state || state.chargeRate <= 0 || state.charge <= 0) return;
    state.charge = Math.max(0, state.charge - state.chargeRate * dt);
    paintCannon();
  }

  /**
   * The discharge terminal's centre in design pixels.
   *
   * Read from offsetLeft/offsetTop rather than hardcoded: those are LAYOUT pixels
   * (unaffected by the stage's scale transform), so they are already in the same
   * coordinate space as everything else here — and restyling the tower in CSS can
   * never leave the bolt firing from the wrong spot.
   */
  function coilTip(){
    return {
      x: cannon.offsetLeft + cannonCoil.offsetLeft + cannonCoil.offsetWidth / 2,
      y: cannon.offsetTop + cannonCoil.offsetTop + cannonCoil.offsetHeight / 2
    };
  }

  /** A dupe: a grey shot lobbed at the cannon rather than wasted on the boss. */
  function arcToCannon(fromEl){
    if(!state) return;
    if(field.querySelectorAll('.arc').length > 24) return;
    var fx = parseFloat(fromEl.style.left || '0');
    var fy = H - 26 - (parseFloat(fromEl.style.height || '84') / 2);
    var tip = coilTip();                // fed in at the terminal, same place it fires from
    var dx = tip.x - fx, dy = tip.y - fy;
    var dot = document.createElement('div');
    dot.className = 'arc';
    dot.style.left = (fx - 10) + 'px';
    dot.style.top = (fy - 10) + 'px';
    field.appendChild(dot);
    // Scripted rather than a CSS keyframe: the arc depends on where the chatter
    // is standing, which no static keyframe could know.
    var peak = 130 + Math.random() * 70;
    var done = function(){ if(dot.parentNode) dot.parentNode.removeChild(dot); };
    if(dot.animate){
      var anim = dot.animate([
        { transform:'translate(0px,0px) scale(.6)', opacity:0 },
        { transform:'translate(' + (dx * .5) + 'px,' + (dy * .5 - peak) + 'px) scale(1)', opacity:1, offset:.5 },
        { transform:'translate(' + dx + 'px,' + dy + 'px) scale(.5)', opacity:.9 }
      ], { duration:560, easing:'linear', fill:'forwards' });
      anim.onfinish = done;
      setTimeout(done, 900); // belt and braces if onfinish never lands
    }else{
      setTimeout(done, 100);
    }
  }

  /** The cannon discharges: kick, a fat beam into the boss, and a big number. */
  function onCannon(d){
    var damage = Math.max(0, Number(d && d.damage) || 0);
    var hp = Number(d && d.hp);
    var maxHp = Number(d && d.maxHp) || (state ? state.maxHp : 1);

    if(state){
      state.charge = 0;
      paintCannon();
      cannon.classList.add('firing');
      setTimeout(function(){ cannon.classList.remove('firing'); }, 420);
      megaBeam();
      restartShock();
      floatText('-' + damage, 'hit mega');
    }
    playOnce('cannon');
    if(isFinite(hp) && state){
      state.hp = hp; state.maxHp = maxHp;
      setHp(hp, maxHp);
      shakeBar();
    }
  }

  /** The cannon's shot, fired from the barrel at the boss. */
  function megaBeam(){
    if(!state) return;
    var tip = coilTip();
    var fx = tip.x, fy = tip.y;
    var dx = state.x + state.size / 2 - fx;
    var dy = state.y + state.size / 2 - fy;
    var wrap = document.createElement('div');
    wrap.className = 'beam-wrap mega';
    wrap.style.left = fx + 'px';
    wrap.style.top = fy + 'px';
    wrap.style.width = Math.sqrt(dx * dx + dy * dy) + 'px';
    wrap.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
    var beam = document.createElement('div');
    beam.className = 'beam';
    wrap.appendChild(beam);
    field.appendChild(wrap);
    setTimeout(function(){ if(wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 600);
  }

  /** Re-trigger the shockwave ring, which the death sequence also uses. */
  function restartShock(){
    shock.classList.remove('go');
    void shock.offsetWidth;
    shock.classList.add('go');
  }

  // ── Crowd ─────────────────────────────────────────────────────────────────
  /**
   * Fighters accrete outward from the centre and squeeze together as the crowd
   * grows, so a busy chat packs the bottom of the screen shoulder to shoulder.
   */
  /** Half the width kept clear in the middle for the cannon. */
  var CANNON_GAP = 130;

  function layoutCrowd(){
    var ids = Object.keys(fighters);
    var n = ids.length;
    if(!n) return;
    var size = n > 18 ? Math.max(48, 84 - (n - 18) * 1.2) : 84;
    // Fighters fall in either side of the cannon, so each flank only has to hold
    // half of them — and the spacing is squeezed to fit whatever room is left.
    var perSide = Math.ceil(n / 2);
    var room = W / 2 - 70 - CANNON_GAP;
    var spacing = Math.min(size + 10, room / perSide);
    ids.sort(function(a, b){ return fighters[a].order - fighters[b].order; });
    for(var i = 0; i < n; i++){
      var f = fighters[ids[i]];
      var k = Math.floor(i / 2);
      var sign = (i % 2 === 0) ? -1 : 1;   // first arrival to the left, next to the right
      f.el.style.left = (W / 2 + sign * (CANNON_GAP + k * spacing + size / 2)) + 'px';
      f.el.style.width = size + 'px';
      f.el.style.height = size + 'px';
      f.el.style.marginLeft = (-size / 2) + 'px';
      f.el.style.zIndex = String(200 - k); // innermost stays on top as they overlap
    }
  }

  function addFighter(id, name){
    if(fighters[id]) return fighters[id];
    if(!state || Object.keys(fighters).length >= state.crowdMax) return null;
    var el = document.createElement('div');
    el.className = 'fighter';
    el.textContent = String(name || '?').charAt(0).toUpperCase();
    crowd.appendChild(el);
    fighters[id] = { el: el, name: name, order: order++ };
    layoutCrowd();
    return fighters[id];
  }

  function onCrowd(d){
    var list = (d && d.fighters) || [];
    for(var i = 0; i < list.length; i++){
      var f = fighters[list[i].id];
      if(f && list[i].avatarUrl){
        f.el.style.backgroundImage = 'url("' + list[i].avatarUrl + '")';
        f.el.textContent = '';
      }
    }
  }

  // ── Combat frame ──────────────────────────────────────────────────────────
  function onCombat(d){
    if(!state) return;
    var events = (d && d.events) || [];
    var hp = Number(d && d.hp);
    var maxHp = Number(d && d.maxHp) || state.maxHp;
    var before = state.hp;

    for(var i = 0; i < events.length; i++) renderShot(events[i]);

    // The bot's figure is authoritative; local decay just fills the gaps.
    var charge = Number(d && d.charge);
    if(isFinite(charge)){ state.charge = charge; paintCannon(); }

    if(isFinite(hp)){
      state.hp = hp; state.maxHp = maxHp;
      setHp(hp, maxHp);
      if(hp < before){ shakeBar(); playOnce('hit'); }
      else if(hp > before) playOnce('heal');
    }
  }

  /** One chatter's contribution: lasers from their icon, then the damage floats. */
  function renderShot(e){
    var f = addFighter(e.id, e.name);
    if(f){
      f.el.classList.add('firing');
      setTimeout(function(){ f.el.classList.remove('firing'); }, 260);
      var shots = Math.min(4, Math.max(1, (e.damage || 0) + (e.heal || 0) + (e.misses ? 1 : 0)));
      for(var i = 0; i < shots; i++) fireBeam(f.el, i * 45);
      // Dupes go to the cannon instead of the boss — one lob per point earned,
      // capped so a huge cap cannot bury the screen in grey.
      var lobs = Math.min(6, e.dupes || 0);
      for(var j = 0; j < lobs; j++) arcToCannon(f.el);
    }
    if(e.damage) floatText('-' + e.damage, 'hit');
    if(e.heal) floatText('+' + e.heal, 'heal');
    if(e.misses) floatText('MISS', 'miss');
  }

  function fireBeam(fromEl, delay){
    if(!state) return;
    if(field.querySelectorAll('.beam-wrap').length > 40) return;
    var fx = parseFloat(fromEl.style.left || '0');
    var fy = H - 26 - (parseFloat(fromEl.style.height || '84') / 2);
    var tx = state.x + state.size / 2;
    var ty = state.y + state.size / 2;
    var dx = tx - fx, dy = ty - fy;
    var len = Math.sqrt(dx * dx + dy * dy);
    var wrap = document.createElement('div');
    wrap.className = 'beam-wrap';
    wrap.style.left = fx + 'px';
    wrap.style.top = fy + 'px';
    wrap.style.width = len + 'px';
    wrap.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
    var beam = document.createElement('div');
    beam.className = 'beam';
    if(delay) beam.style.animationDelay = delay + 'ms';
    wrap.appendChild(beam);
    field.appendChild(wrap);
    setTimeout(function(){ if(wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 400 + (delay || 0));
  }

  function floatText(text, cls){
    if(!state) return;
    if(field.querySelectorAll('.float').length >= 10) return;
    var d = document.createElement('div');
    d.className = 'float ' + cls;
    d.textContent = text;
    // Scatter them a little so simultaneous hits don't stack into one blob.
    d.style.left = (state.x + state.size / 2 + (Math.random() * 90 - 45)) + 'px';
    d.style.top = (state.y - 10 + (Math.random() * 40 - 20)) + 'px';
    field.appendChild(d);
    setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 1200);
  }

  // ── Outro ─────────────────────────────────────────────────────────────────
  /** How long the dying/fleeing boss gets to speak before the banner lands. */
  function outroHold(){
    var s = state ? state.outroTaunt : 3;
    return Math.max(0, (isFinite(s) ? s : 3)) * 1000;
  }

  /**
   * Scatter little blasts over the boss for the given duration, building towards
   * the real
   * explosion. Positions are re-read each time so they track the shaking body.
   */
  function miniExplosions(ms){
    var every = 170;
    var n = Math.max(1, Math.floor(ms / every));
    for(var i = 0; i < n; i++){
      later(function(){
        if(!state) return;
        var size = 40 + Math.random() * (state.size * 0.45);
        var d = document.createElement('div');
        d.className = 'mini';
        d.style.width = size + 'px';
        d.style.height = size + 'px';
        d.style.left = (state.x + Math.random() * state.size - size / 2) + 'px';
        d.style.top = (state.y + Math.random() * state.size - size / 2) + 'px';
        field.appendChild(d);
        // Under the victory sting, so the finale still reads as the big moment.
        playOnce('hit', 0.45);
        setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 600);
      }, i * every + Math.random() * 90);
    }
  }

  function onDefeated(d){
    stopLoop('bgm');
    clearTimers();
    hideBubble();
    setHp(0, state ? state.maxHp : 1);
    var hold = outroHold();

    if(state){
      state.paused = true;              // it has bigger problems than patrolling
      var taunt = String((d && d.taunt) || '');
      if(taunt) sayBubble(taunt);
      boss.classList.add('shaking');
      miniExplosions(hold);
    }

    later(function(){
      hideBubble();
      if(state){
        boss.classList.remove('shaking');
        shock.classList.add('go');
        boss.classList.add('dying');
      }
      playOnce('victory');
      var killer = (d && d.killer) ? esc(d.killer) : '';
      banner('win', 'BOSS DEFEATED!', killer ? 'Killing blow: ' + killer : '');
      later(function(){ if(state) boss.classList.remove('in'); }, 1200);
    }, hold);
  }

  function onEscaped(d){
    stopLoop('bgm');
    clearTimers();
    hideBubble();
    var hold = outroHold();

    if(state){
      state.paused = true;
      var taunt = String((d && d.taunt) || '');
      if(taunt) sayBubble(taunt);
    }

    later(function(){
      hideBubble();
      playOnce('escape');
      boss.classList.remove('in');
      banner('lose', 'THE BOSS ESCAPED', 'It got away with ' + Math.max(0, Number(d && d.hp) || 0) + ' HP');
    }, hold);
  }

  function banner(kind, big, sub){
    elOutro.className = 'layer ' + kind;
    elOutro.innerHTML = '<div class="banner"><span class="big">' + esc(big) + '</span>' +
      (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div>';
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var ws = null, retry = 1000;

  function connect(){
    if(!token) return;
    // Behind the edge proxy the hub is reachable at /ws; locally it is the bare
    // hub port, matching the other overlays.
    var url = location.protocol === 'https:'
      ? 'wss://' + location.host + '/ws?room=boss&secret=' + encodeURIComponent(token)
      : 'ws://' + location.hostname + ':8080?room=boss&secret=' + encodeURIComponent(token);
    try{ ws = new WebSocket(url); }catch(e){ return later(connect, retry); }
    ws.onopen = function(){ retry = 1000; };
    ws.onclose = function(){ retry = Math.min(15000, retry * 1.7); setTimeout(connect, retry); };
    ws.onerror = function(){ try{ ws.close(); }catch(e){} };
    ws.onmessage = function(ev){
      var msg;
      try{ msg = JSON.parse(ev.data); }catch(e){ return; }
      var d = msg.payload || {};
      if(msg.type === 'alert') onAlert(d);
      else if(msg.type === 'intel') onIntel(d);
      else if(msg.type === 'spawn') onSpawn(d);
      else if(msg.type === 'combat') onCombat(d);
      else if(msg.type === 'cannon') onCannon(d);
      else if(msg.type === 'crowd') onCrowd(d);
      else if(msg.type === 'defeated') onDefeated(d);
      else if(msg.type === 'escaped') onEscaped(d);
      else if(msg.type === 'clear') reset();
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}
