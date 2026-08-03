/**
 * OBS browser-source overlay for the "!first" game.
 *
 * A standalone, transparent HTML page (NOT the dashboard layout). It reads a
 * read-only `?token=` from its own URL, fetches the current standings once
 * (`GET /api/overlay/first`), then subscribes to the `first` WebSocket-hub room
 * for live check-ins (and a `clear` when the stream goes offline).
 *
 * Single-column portrait layout for a 500×1000 OBS source: the ~400px content
 * column is centred, leaving ~50px gutters each side so the big text glows can
 * bleed out without hitting the hard edge of the source. Top 50% = title + the
 * first-10 list (rank / name / time), filling in live. Bottom 50% = big
 * "WAS FIRST!" text over a top-3 podium with each winner's circular Twitch
 * avatar + name. Stays reactive if resized; sizes use `min(vh, vw, px)` so
 * nothing overflows the narrow width AND nothing balloons in a large preview
 * window (the px cap keeps the podium from overrunning the names).
 *
 * The whole page is self-contained (inline CSS/JS, no bundler). Because this
 * string is a template literal, the embedded script uses plain concatenation and
 * avoids `${` / backticks.
 */
export function firstOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>First — Overlay</title>
<style>
  :root{
    --gold:#ffd54a; --silver:#d7dbe4; --bronze:#e39b54;
    --pink:#ff4fa3; --purple:#8b5cf6;
    --panel:rgba(18,14,26,.72); --border:rgba(255,255,255,.14); --text:#f4f1fb; --muted:#c7c0da;
  }
  *{ box-sizing:border-box; }
  html,body{ margin:0; height:100%; background:transparent; overflow:hidden; }
  body{ font-family:'Inter','Segoe UI',system-ui,-apple-system,sans-serif; color:var(--text);
    -webkit-font-smoothing:antialiased; }

  /* Single tall column, centred at ~80% width (≈400px in a 500px source) so the
     ~50px gutters each side catch the glow bleed. Top half = title + list,
     bottom half = winner + podium. */
  #stage{ position:absolute; top:0; bottom:0; left:50%; transform:translateX(-50%);
    width:80%; display:flex; flex-direction:column; padding:1.6vh 4%; }
  #top{ height:50%; display:flex; flex-direction:column; min-height:0; }
  #bottom{ height:50%; display:flex; flex-direction:column; min-height:0; }

  /* ── Title + first-10 list ──────────────────────────────────────────── */
  .col-title{ font-weight:900; letter-spacing:.03em; font-size:min(3.2vh,7vw,32px); line-height:1.06;
    text-transform:uppercase; color:#fff; margin:0 0 1vh; text-align:center;
    /* Dark halo for separation on any background + a big, bold pink theme glow. */
    text-shadow:0 0 3px #10030a, 0 0 8px #10030a, 0 3px 7px rgba(0,0,0,.7),
      0 0 16px rgba(255,79,163,1), 0 0 34px rgba(255,79,163,.95), 0 0 56px rgba(255,79,163,.6); }
  #list{ list-style:none; margin:0; padding:0; flex:1; display:flex; flex-direction:column; gap:.7vh; min-height:0; }
  #list li{ flex:1; display:flex; align-items:center; gap:3%; background:var(--panel);
    border:1px solid var(--border); border-left:.9vh solid rgba(255,255,255,.14);
    border-radius:1vh; padding:0 4%; backdrop-filter:blur(3px); min-height:0; overflow:hidden; }
  #list li.empty{ opacity:.3; }
  #list li:nth-child(1){ border-left-color:var(--gold); }
  #list li:nth-child(2){ border-left-color:var(--silver); }
  #list li:nth-child(3){ border-left-color:var(--bronze); }
  .rank{ font-weight:900; font-size:min(2.6vh,6vw,26px); width:2.2em; text-align:center; color:#fff;
    font-variant-numeric:tabular-nums; flex:none; }
  .who{ flex:1; font-weight:700; font-size:min(2.4vh,5.6vw,24px); white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; }
  .time{ font-weight:800; font-size:min(2.1vh,5vw,22px); color:var(--pink); flex:none;
    font-variant-numeric:tabular-nums; }

  /* ── Winner text + podium ───────────────────────────────────────────── */
  /* The winner takes all the room between the list and the podium and centers
     itself in it (grows from its own centre when it breathes). */
  #winner{ flex:1; min-height:0; display:flex; flex-direction:column; align-items:center;
    justify-content:center; text-align:center; line-height:1.02; transition:opacity .3s;
    transform-origin:center; }
  #winner.hidden{ opacity:0; }
  #winner-name{ font-weight:900; font-size:min(5.5vh,14vw,58px); text-transform:uppercase; letter-spacing:.01em;
    background:linear-gradient(180deg,#ffffff 0%,var(--gold) 72%,#ffb020 100%);
    -webkit-background-clip:text; background-clip:text; color:transparent;
    /* Dark drop for separation + a big, bold gold glow (drop-shadows compound). */
    filter:drop-shadow(0 3px 5px rgba(0,0,0,.8)) drop-shadow(0 0 16px rgba(255,213,74,1))
      drop-shadow(0 0 34px rgba(255,180,20,.9)) drop-shadow(0 0 56px rgba(255,150,0,.6));
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #winner-sub{ font-weight:900; font-size:min(3.2vh,8.5vw,34px); letter-spacing:.12em; text-transform:uppercase;
    color:#fff; text-shadow:0 0 3px #10030a, 0 0 9px #10030a, 0 3px 8px rgba(0,0,0,.7),
      0 0 18px rgba(255,79,163,1), 0 0 38px rgba(255,79,163,.95), 0 0 62px rgba(139,92,246,.7); }
  /* Entrance pop, then a slow "breathing" scale that grows the winner text down
     into the free space above the podium and shrinks back to ~half of it. */
  #winner.show{ animation:pop .6s ease, winnerBreathe 3.6s ease-in-out .6s infinite alternate; }
  #winner.show #winner-sub{ animation:flash 1.1s ease-in-out infinite alternate; }

  #podium{ display:flex; align-items:flex-end; justify-content:center; gap:3%; width:100%; flex:none; }
  .pod{ display:flex; flex-direction:column; align-items:center; justify-content:flex-end;
    width:31%; opacity:.4; transition:opacity .35s; }
  .pod.has{ opacity:1; }
  .ava{ width:min(9.5vh,22vw,92px); height:min(9.5vh,22vw,92px); border-radius:50%; background-size:cover;
    background-position:center; background-color:#241c36; border:.5vh solid #fff; display:flex;
    align-items:center; justify-content:center; font-weight:900; font-size:min(3.6vh,9vw,40px); color:#fff;
    box-shadow:0 .6vh 2.4vh rgba(0,0,0,.45); margin-bottom:.7vh; flex:none; }
  .pod-1 .ava{ width:min(11.5vh,26vw,112px); height:min(11.5vh,26vw,112px); border-color:var(--gold);
    box-shadow:0 0 3vh rgba(255,213,74,.7); }
  .pod-2 .ava{ border-color:var(--silver); }
  .pod-3 .ava{ border-color:var(--bronze); }
  .pod.has .ava{ animation:float 3s ease-in-out infinite; }
  .pod-name{ font-weight:800; font-size:min(2vh,4.6vw,20px); max-width:100%; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; text-align:center; margin-bottom:1vh; color:#0a0a0a;
    /* Black text with a crisp white outline + halo so it reads on any background. */
    text-shadow:-1.5px -1.5px 0 #fff, 1.5px -1.5px 0 #fff, -1.5px 1.5px 0 #fff, 1.5px 1.5px 0 #fff,
      0 0 3px #fff, 0 0 7px #fff; }
  .block{ width:100%; border-radius:1vh 1vh 0 0; display:flex; align-items:flex-start;
    justify-content:center; padding-top:.8vh; font-weight:900; font-size:min(2.8vh,7vw,30px);
    color:rgba(0,0,0,.55); flex:none; }
  .block-1{ height:min(15vh,150px); background:linear-gradient(180deg,var(--gold),#c99a18); }
  .block-2{ height:min(10vh,100px); background:linear-gradient(180deg,var(--silver),#98a0b0); }
  .block-3{ height:min(7vh,70px); background:linear-gradient(180deg,var(--bronze),#a86a2f); }

  .pop{ animation:pop .55s ease; }
  @keyframes pop{ 0%{ transform:scale(.6); opacity:0; } 60%{ transform:scale(1.08); opacity:1; }
    100%{ transform:scale(1); } }
  /* Keep the dark outline constant in both states so "WAS FIRST!" stays legible
     on light backgrounds while only the pink/purple glow pulses. */
  @keyframes flash{
    from{ text-shadow:0 0 3px #10030a, 0 0 9px #10030a, 0 3px 8px rgba(0,0,0,.7),
      0 0 14px rgba(255,79,163,.85), 0 0 30px rgba(255,79,163,.7); }
    to{ text-shadow:0 0 3px #10030a, 0 0 9px #10030a, 0 3px 8px rgba(0,0,0,.7),
      0 0 26px rgba(255,79,163,1), 0 0 54px rgba(255,79,163,1), 0 0 82px rgba(139,92,246,.9); } }
  @keyframes float{ 0%,100%{ transform:translateY(0); } 50%{ transform:translateY(-.9vh); } }
  /* Half-fill (scale 1.18) → fill the free space (scale 1.5), from the centre. */
  @keyframes winnerBreathe{ from{ transform:scale(1.18); } to{ transform:scale(1.5); } }

  #status{ position:absolute; left:2%; bottom:.5vh; font-size:1.4vh; color:rgba(255,255,255,.35); }
</style>
</head>
<body>
  <div id="stage">
    <div id="top">
      <div class="col-title">Cool Cats Who Said&nbsp;!first</div>
      <ol id="list"></ol>
    </div>
    <div id="bottom">
      <div id="winner" class="hidden">
        <div id="winner-name">&nbsp;</div>
        <div id="winner-sub">Was First!</div>
      </div>
      <div id="podium">
        <div class="pod pod-2"><div class="ava" id="ava-2"></div><div class="pod-name" id="name-2"></div><div class="block block-2">2</div></div>
        <div class="pod pod-1"><div class="ava" id="ava-1"></div><div class="pod-name" id="name-1"></div><div class="block block-1">1</div></div>
        <div class="pod pod-3"><div class="ava" id="ava-3"></div><div class="pod-name" id="name-3"></div><div class="block block-3">3</div></div>
      </div>
    </div>
  </div>
  <div id="status">connecting…</div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';
  var LIMIT = 10;
  var entries = {};      // place -> { name, avatarUrl, timeSeconds }
  var streamKey = null;

  function status(t){ var el=document.getElementById('status'); if(el) el.textContent=t||''; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;'; }); }
  function initial(name){ var t=String(name||'').trim(); return t ? t.charAt(0).toUpperCase() : '?'; }
  function fmtTime(s){ s=Math.max(0, s|0); if(s<60) return s+'s'; var m=Math.floor(s/60), r=s%60;
    return m+':'+(r<10?'0':'')+r; }
  function flash(el){ if(!el) return; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

  // Shrink a single-line element's font so its (optionally scaled) text fits
  // maxWidth, never growing past the CSS-defined size. Used so long names don't
  // overflow: the winner fits the overlay width at its breathing peak, and each
  // podium name fits its own podium column.
  var BREATHE_MAX = 1.5; // matches the winnerBreathe keyframe's peak scale
  function fitText(el, maxWidth, scale){
    if(!el || !(maxWidth > 0)) return;
    scale = scale || 1;
    el.style.fontSize = '';                                 // revert to the CSS max
    var maxFs = parseFloat(getComputedStyle(el).fontSize) || 16;
    var w = el.scrollWidth;                                 // natural (unclipped) text width
    if(w > 0 && w * scale > maxWidth){
      el.style.fontSize = Math.max(6, (maxFs * maxWidth) / (w * scale)) + 'px';
    }
  }
  function fitNames(){
    // Fit the winner to the content column (not the full viewport) so it fills
    // the ~400px content at its breathing peak and the glow bleeds into the gutter.
    var wrap = document.getElementById('winner');
    if(wrap) fitText(document.getElementById('winner-name'), wrap.clientWidth * 0.98, BREATHE_MAX);
    for(var p=1;p<=3;p++){
      var nm = document.getElementById('name-'+p);
      if(nm && nm.parentElement) fitText(nm, nm.parentElement.clientWidth * 0.98, 1);
    }
  }

  function renderList(){
    var html='';
    for(var p=1;p<=LIMIT;p++){
      var e=entries[p];
      html += '<li class="'+(e?'filled':'empty')+'">'
        + '<span class="rank">'+p+'</span>'
        + '<span class="who">'+(e?esc(e.name):'')+'</span>'
        + '<span class="time">'+(e?fmtTime(e.timeSeconds):'')+'</span>'
        + '</li>';
    }
    document.getElementById('list').innerHTML=html;
  }

  function setAvatar(el, e){
    if(!el) return;
    if(e && e.avatarUrl){ el.style.backgroundImage='url("'+e.avatarUrl+'")'; el.textContent=''; }
    else if(e){ el.style.backgroundImage='none'; el.textContent=initial(e.name); }
    else { el.style.backgroundImage='none'; el.textContent=''; }
  }

  function renderPodium(){
    for(var p=1;p<=3;p++){
      var e=entries[p];
      setAvatar(document.getElementById('ava-'+p), e);
      var nm=document.getElementById('name-'+p); if(nm) nm.textContent = e?e.name:'';
      var pod=document.querySelector('.pod-'+p); if(pod){ if(e) pod.classList.add('has'); else pod.classList.remove('has'); }
    }
    var w=document.getElementById('winner'), first=entries[1];
    if(first){ document.getElementById('winner-name').textContent=first.name; w.classList.remove('hidden'); w.classList.add('show'); }
    else { w.classList.add('hidden'); w.classList.remove('show'); }
    fitNames(); // re-fit after names change so nothing overflows its width
  }

  function renderAll(){ renderList(); renderPodium(); }

  function reset(){ entries={}; streamKey=null; renderAll(); }

  function apply(d, animate){
    if(!d) return;
    if(d.streamKey && d.streamKey!==streamKey){ entries={}; streamKey=d.streamKey; }
    if(d.place>=1 && d.place<=LIMIT){
      entries[d.place]={ name:d.name, avatarUrl:d.avatarUrl||null, timeSeconds:d.timeSeconds };
    }
    renderAll();
    if(animate){
      var li=document.querySelectorAll('#list li')[d.place-1]; flash(li);
      if(d.place<=3) flash(document.querySelector('.pod-'+d.place));
      if(d.place===1){ var w=document.getElementById('winner'); w.classList.remove('show'); void w.offsetWidth; w.classList.add('show'); }
    }
  }

  function loadSnapshot(){
    fetch('/api/overlay/first?token='+encodeURIComponent(token), { cache:'no-store' })
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(d){
        streamKey = d.streamKey || null; entries={};
        (d.entries||[]).forEach(function(e){ entries[e.place]={ name:e.name, avatarUrl:e.avatarUrl||null, timeSeconds:e.timeSeconds }; });
        renderAll();
      })
      .catch(function(e){ status('data error: '+e.message); });
  }

  function connect(){
    var url = (location.protocol==='https:')
      ? 'wss://'+location.host+'/ws?room=first&secret='+encodeURIComponent(token)
      : 'ws://'+location.hostname+':8080?room=first&secret='+encodeURIComponent(token);
    var ws;
    try { ws=new WebSocket(url); } catch(e){ status('ws error'); setTimeout(connect,3000); return; }
    ws.onopen=function(){ status(''); };
    ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data);
      if(m && m.type==='checkin') apply(m.payload, true);
      else if(m && m.type==='clear') reset();
    }catch(_e){} };
    ws.onerror=function(){ try{ ws.close(); }catch(_e){} };
    ws.onclose=function(ev){ if(ev && ev.code===4001) status('bad overlay token'); else { status('reconnecting…'); setTimeout(connect,2500); } };
  }

  renderAll();
  window.addEventListener('resize', fitNames); // re-fit if the OBS source is resized
  if(!token){ status('missing ?token='); return; }
  loadSnapshot();
  connect();
})();
</script>
</body>
</html>`;
}
