/**
 * OBS browser-source overlay for "Pet the Floof".
 *
 * A standalone, transparent 1600×200 strip meant to sit flush with the BOTTOM-RIGHT
 * corner of the canvas. It reads a read-only `?token=` and subscribes to the
 * `floof` WebSocket-hub room:
 *   spawn   -> fade a floof in and start it ping-ponging + rocking
 *   pet     -> stop, bloom pink, resolve into a heart, fade out
 *   despawn -> nobody pet it in time; just fade out
 *
 * Padding values (set in the admin panel) inset the travel area so the floof never
 * clips the edges of whatever the overlay is butted up against.
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
  html,body{ margin:0; width:1600px; height:200px; background:transparent; overflow:hidden;
    font-family:system-ui,'Segoe UI',sans-serif; }
  #floof{ position:absolute; width:128px; height:128px; left:0; top:0; opacity:0;
    transition:opacity .8s ease; will-change:transform; }
  #floof img{ width:128px; height:128px; display:block; border-radius:12px;
    filter:drop-shadow(0 4px 10px rgba(0,0,0,.55)); }
  #floof.in{ opacity:1; }
  /* Pink bloom once pet, then the heart takes over. */
  #floof.pet img{ animation:bloom 1s ease forwards; }
  @keyframes bloom{
    0%{ filter:drop-shadow(0 4px 10px rgba(0,0,0,.55)); }
    45%{ filter:drop-shadow(0 0 26px #ff6ec7) drop-shadow(0 0 60px #ff6ec7) brightness(1.35); }
    100%{ filter:drop-shadow(0 0 40px #ff6ec7) brightness(1.6); opacity:0; }
  }
  #heart{ position:absolute; width:128px; height:128px; left:0; top:0; opacity:0;
    display:flex; align-items:center; justify-content:center; font-size:86px; line-height:1;
    filter:drop-shadow(0 0 18px #ff6ec7); pointer-events:none; }
  #heart.go{ animation:heart 2.2s ease forwards; }
  @keyframes heart{
    0%{ opacity:0; transform:scale(.4); }
    25%{ opacity:1; transform:scale(1.15); }
    45%{ transform:scale(1); }
    100%{ opacity:0; transform:scale(1.3) translateY(-46px); }
  }
  /* Speech bubble shown when the floof has gone unpet for a while. */
  #bubble{ position:absolute; left:0; top:0; opacity:0; transition:opacity .35s ease;
    background:#fff; color:#1a1220; font-weight:800; font-size:22px; white-space:nowrap;
    padding:10px 16px; border-radius:14px; box-shadow:0 6px 18px rgba(0,0,0,.45); }
  #bubble::after{ content:''; position:absolute; left:-9px; top:50%; margin-top:-8px;
    border:8px solid transparent; border-right-color:#fff; }
  #bubble.show{ opacity:1; }
</style>
</head>
<body>
  <div id="floof"><img id="floof-img" alt="" /></div>
  <div id="heart">💖</div>
  <div id="bubble"></div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';

  var W = 1600, H = 200, SIZE = 128;
  var TAUNTS = ['!pet me', 'i can haz !pet?', 'i wants !pet'];
  var IDLE_MS = 10000;      // unpet time before a taunt
  var BUBBLE_MS = 2500;     // how long the bubble stays up
  var ROCK_DEG = 9;         // happy wiggle amplitude
  var ROCK_HZ = 1.6;

  var el = document.getElementById('floof');
  var img = document.getElementById('floof-img');
  var heart = document.getElementById('heart');
  var bubble = document.getElementById('bubble');

  var state = null;         // { x, y, vx, vy, pad } while a floof is on screen
  var raf = null, lastT = 0, idleTimer = null, bubbleTimer = null, paused = false;

  function clearTimers(){
    if(idleTimer) clearTimeout(idleTimer); idleTimer = null;
    if(bubbleTimer) clearTimeout(bubbleTimer); bubbleTimer = null;
  }
  function stopLoop(){ if(raf) cancelAnimationFrame(raf); raf = null; }

  // Speed slider (1..10) -> pixels/second.
  function pxPerSec(speed){ var s = Math.max(1, Math.min(10, Number(speed) || 5)); return 30 + s * 26; }

  function bounds(pad){
    return {
      minX: pad.left, maxX: W - SIZE - pad.right,
      minY: pad.top,  maxY: H - SIZE - pad.bottom
    };
  }

  function draw(){
    var rock = paused ? 0 : Math.sin(performance.now() / 1000 * Math.PI * 2 * ROCK_HZ) * ROCK_DEG;
    el.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) rotate(' + rock.toFixed(2) + 'deg)';
    // Keep the bubble pinned to the floof's right shoulder.
    bubble.style.transform = 'translate(' + (state.x + SIZE + 14) + 'px,' + (state.y + SIZE / 2 - 22) + 'px)';
  }

  function loop(t){
    if(!state){ return; }
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;
    if(!paused){
      var b = bounds(state.pad);
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
      bubble.textContent = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
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
    el.classList.remove('in','pet');
    bubble.classList.remove('show');
    heart.classList.remove('go');
  }

  function spawn(d){
    reset();
    var pad = (d && d.padding) || { left:0, right:0, top:0, bottom:0 };
    var b = bounds(pad);
    var speed = pxPerSec(d && d.speed);
    // Random start + a diagonal heading, so no two spawns look the same.
    var ang = (Math.random() * 0.6 + 0.2) * Math.PI * (Math.random() < 0.5 ? 1 : -1);
    state = {
      x: b.minX + Math.random() * Math.max(1, b.maxX - b.minX),
      y: b.minY + Math.random() * Math.max(1, b.maxY - b.minY),
      vx: Math.cos(ang) * speed * (Math.random() < 0.5 ? 1 : -1),
      vy: Math.sin(ang) * speed * 0.45,
      pad: pad
    };
    img.src = d.url;
    draw();
    requestAnimationFrame(function(){ el.classList.add('in'); });   // fade in
    raf = requestAnimationFrame(loop);
    scheduleTaunt();
  }

  function pet(){
    if(!state) return;
    clearTimers();
    paused = true;                 // stop ping-ponging immediately
    bubble.classList.remove('show');
    el.classList.add('pet');       // pink bloom, then the image fades out
    heart.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)';
    setTimeout(function(){ heart.classList.add('go'); }, 450);
    setTimeout(reset, 3000);
  }

  function despawn(){
    if(!state) return;
    clearTimers();
    el.classList.remove('in');     // just fade away
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

  if(!token) return;
  connect();
})();
</script>
</body>
</html>`;
}
