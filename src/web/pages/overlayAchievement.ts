/**
 * OBS browser-source overlay that pops a card when a viewer unlocks an
 * achievement.
 *
 * A standalone, transparent page (NOT the dashboard layout). It reads a read-only
 * `?token=` from its own URL and subscribes to the `achievements` WebSocket-hub
 * room; the achievements plugin broadcasts an `unlocked` payload per unlock.
 * Cards are QUEUED and shown one at a time, so a batch of unlocks plays as a
 * sequence instead of stacking on top of each other.
 *
 * Self-contained (inline CSS/JS, no bundler); because this string is a template
 * literal, the embedded script uses plain concatenation and avoids `${` / backticks.
 */
export function achievementOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Achievement — Overlay</title>
<style>
  :root{ --bronze:#cd7f32; --silver:#cfd3d8; --gold:#ffd24a; }
  html,body{ margin:0; width:100%; height:100%; background:transparent; overflow:hidden;
    font-family:system-ui,'Segoe UI',sans-serif; color:#fff; }
  #stage{ position:fixed; inset:0; display:flex; align-items:flex-end; justify-content:center; padding-bottom:9%; }
  #card{
    display:none; align-items:center; gap:22px; min-width:520px; max-width:70vw;
    padding:22px 34px 22px 26px; border-radius:18px;
    background:linear-gradient(135deg, rgba(18,18,24,.94), rgba(32,26,44,.94));
    border:2px solid var(--tier, var(--gold));
    box-shadow:0 18px 50px rgba(0,0,0,.6), 0 0 26px -6px var(--tier, var(--gold));
  }
  #card.show{ display:flex; animation:pop .45s cubic-bezier(.2,.9,.25,1.2) both; }
  #card.hide{ animation:fade .5s ease forwards; }
  @keyframes pop{ from{ opacity:0; transform:translateY(60px) scale(.94); } to{ opacity:1; transform:none; } }
  @keyframes fade{ to{ opacity:0; transform:translateY(-14px); } }
  #badge{ font-size:64px; line-height:1; filter:drop-shadow(0 3px 8px rgba(0,0,0,.7)); }
  #text{ display:flex; flex-direction:column; gap:3px; }
  #kicker{ font-size:15px; font-weight:800; letter-spacing:.22em; text-transform:uppercase; color:var(--tier, var(--gold)); }
  #name{ font-size:36px; font-weight:800; line-height:1.1; text-shadow:0 2px 6px rgba(0,0,0,.8); }
  #desc{ font-size:19px; color:#d6d6e0; }
  #who{ font-size:19px; font-weight:700; margin-top:4px; }
  #who .u{ color:#ff6ec7; }
</style>
</head>
<body>
  <div id="stage">
    <div id="card">
      <div id="badge">🏆</div>
      <div id="text">
        <div id="kicker">Achievement Unlocked</div>
        <div id="name"></div>
        <div id="desc"></div>
        <div id="who"></div>
      </div>
    </div>
  </div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';
  var HOLD_MS = 6000;   // how long a card stays up
  var GAP_MS = 400;     // breather between queued cards
  var TIER = { bronze:'var(--bronze)', silver:'var(--silver)', gold:'var(--gold)' };

  var queue = [];
  var busy = false;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;'; }); }

  function playNext(){
    if(!queue.length){ busy=false; return; }
    busy = true;
    var d = queue.shift();
    var card = document.getElementById('card');
    card.style.setProperty('--tier', TIER[d.tier] || TIER.gold);
    document.getElementById('badge').textContent = d.emoji || '🏆';
    document.getElementById('name').textContent = d.name || '';
    document.getElementById('desc').textContent = d.description || '';
    document.getElementById('who').innerHTML = '<span class="u">' + esc(d.user) + '</span>';

    card.classList.remove('hide');
    card.classList.add('show');
    setTimeout(function(){
      card.classList.add('hide');
      setTimeout(function(){
        card.classList.remove('show','hide');
        setTimeout(playNext, GAP_MS);
      }, 500); // matches the fade animation
    }, HOLD_MS);
  }

  function enqueue(d){ if(!d) return; queue.push(d); if(!busy) playNext(); }

  function connect(){
    var url = (location.protocol==='https:')
      ? 'wss://'+location.host+'/ws?room=achievements&secret='+encodeURIComponent(token)
      : 'ws://'+location.hostname+':8080?room=achievements&secret='+encodeURIComponent(token);
    var ws;
    try { ws=new WebSocket(url); } catch(e){ setTimeout(connect,3000); return; }
    ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data); if(m && m.type==='unlocked') enqueue(m.payload); }catch(_e){} };
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
