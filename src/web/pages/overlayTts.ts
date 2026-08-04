/**
 * OBS browser-source overlay that acts as an AUDIO source for Text-to-Speech.
 *
 * A standalone, transparent page (NOT the dashboard layout). It reads a read-only
 * `?token=` from its own URL, subscribes to the `tts` WebSocket-hub room, and for
 * each `speak` message plays the synthesized clip fetched same-origin from
 * `/overlays/tts/audio/<id>?token=…`. Clips are played one at a time (a queue with
 * `onended`) so they never overlap, and each clip's volume comes from the payload
 * so the admin's Volume knob takes effect on the next line without a reload.
 *
 * Add it as a Browser Source in OBS — it renders nothing (audio only) unless you
 * append `&caption=1` to show a subtle subtitle of the current line. OBS autoplays
 * audio; in a normal browser tab a click may be needed first (a hint appears only
 * if playback is actually blocked, so it never shows on stream in OBS).
 *
 * Self-contained (inline CSS/JS, no bundler). Because this is a template literal,
 * the embedded script uses plain concatenation and avoids `${` / backticks.
 */
export function ttsOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TTS — Overlay</title>
<style>
  html,body{ margin:0; height:100%; background:transparent; overflow:hidden;
    font-family:system-ui,sans-serif; color:#fff; }
  #status{ position:fixed; top:6px; left:8px; font-size:12px; opacity:.6;
    text-shadow:0 1px 2px rgba(0,0,0,.8); }
  #cap{ position:fixed; left:50%; bottom:8%; transform:translateX(-50%);
    max-width:90vw; text-align:center; font-size:min(6vw,34px); font-weight:800;
    line-height:1.2; opacity:0; transition:opacity .15s;
    text-shadow:0 2px 6px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9); }
  #hint{ display:none; position:fixed; inset:0; place-items:center;
    background:rgba(0,0,0,.45); font-size:min(5vw,26px); font-weight:700;
    cursor:pointer; text-shadow:0 2px 4px rgba(0,0,0,.9); }
  #hint span{ padding:.6em 1em; border:2px solid #fff; border-radius:12px; }
</style>
</head>
<body>
  <div id="status">connecting…</div>
  <div id="cap"></div>
  <div id="hint"><span>🔊 Click to enable sound</span></div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';
  var showCaption = qs.get('caption') === '1';
  var queue = [];        // { id, text, volume }
  var playing = false;

  function status(t){ var el=document.getElementById('status'); if(el) el.textContent=t||''; }
  function caption(t){ if(!showCaption) return; var el=document.getElementById('cap');
    if(el){ el.textContent=t||''; el.style.opacity=t?'1':'0'; } }
  function showHint(){ var h=document.getElementById('hint'); if(h) h.style.display='grid'; }
  function hideHint(){ var h=document.getElementById('hint'); if(h) h.style.display='none'; }
  function clampVol(v){ v=(v==null)?1:Number(v); if(!(v>=0))v=0; if(v>1)v=1; return v; }
  function audioUrl(id){ return '/overlays/tts/audio/'+encodeURIComponent(id)+'?token='+encodeURIComponent(token); }

  function enqueue(item){ if(!item || !item.id) return; queue.push(item); if(!playing) playNext(); }

  function playNext(){
    if(!queue.length){ playing=false; caption(''); return; }
    playing=true;
    var item=queue[0];               // stays at the front until it finishes
    caption(item.text);
    var a=new Audio(audioUrl(item.id));
    a.volume=clampVol(item.volume);
    a.onended=function(){ queue.shift(); playNext(); };
    a.onerror=function(){ status('audio error'); queue.shift(); playNext(); };
    var pr=a.play();
    if(pr && pr.then){ pr.then(function(){ hideHint(); }).catch(function(){
      // Autoplay blocked (normal browser tab) — wait for a click, then retry.
      playing=false; showHint();
    }); }
  }

  var hint=document.getElementById('hint');
  if(hint) hint.addEventListener('click', function(){ hideHint(); if(!playing) playNext(); });

  function connect(){
    var url = (location.protocol==='https:')
      ? 'wss://'+location.host+'/ws?room=tts&secret='+encodeURIComponent(token)
      : 'ws://'+location.hostname+':8080?room=tts&secret='+encodeURIComponent(token);
    var ws;
    try { ws=new WebSocket(url); } catch(e){ status('ws error'); setTimeout(connect,3000); return; }
    ws.onopen=function(){ status(''); };
    ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data);
      if(m && m.type==='speak') enqueue(m.payload);
    }catch(_e){} };
    ws.onerror=function(){ try{ ws.close(); }catch(_e){} };
    ws.onclose=function(ev){ if(ev && ev.code===4001) status('bad overlay token');
      else { status('reconnecting…'); setTimeout(connect,2500); } };
  }

  if(!token){ status('missing ?token='); return; }
  connect();
})();
</script>
</body>
</html>`;
}
