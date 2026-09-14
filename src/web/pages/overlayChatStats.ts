/**
 * OBS browser-source overlay showing live chat-activity statistics as a grid.
 *
 * A standalone, transparent page (NOT the dashboard layout). It reads a read-only
 * `?token=` from its own URL and subscribes to the `chat-stats` WebSocket-hub
 * room; the chatStats plugin pushes a `stats` payload (~1/s) for the focus channel
 * (the active guest if connected, else the primary). Rows are the tracked stats,
 * columns are the rolling windows (10s / 30s / 1m / 5m).
 *
 * Sized for a full-screen 1080p source. Self-contained (inline CSS/JS, no
 * bundler); because this string is a template literal, the embedded script uses
 * plain concatenation and avoids `${` / backticks.
 */
export function chatStatsOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chat Stats — Overlay</title>
<style>
  :root{ --fg:#fff; --muted:#c9c9d4; --line:rgba(255,255,255,.18); --cell:rgba(12,12,16,.55); --accent:#ff6ec7; }
  html,body{ margin:0; width:1920px; height:1080px; background:transparent; overflow:hidden;
    font-family:system-ui,'Segoe UI',sans-serif; color:var(--fg);
    -webkit-font-smoothing:antialiased; text-shadow:0 2px 6px rgba(0,0,0,.85); }
  #wrap{ box-sizing:border-box; width:100%; height:100%; padding:48px 64px; display:flex; flex-direction:column; }
  h1{ margin:0 0 6px; font-size:40px; font-weight:800; letter-spacing:.5px; }
  h1 .ch{ color:var(--accent); }
  #status{ font-size:20px; color:var(--muted); margin-bottom:18px; min-height:24px; }
  table{ width:100%; height:100%; border-collapse:separate; border-spacing:10px; table-layout:fixed; }
  th,td{ background:var(--cell); border:1px solid var(--line); border-radius:14px; padding:14px 20px; vertical-align:middle; }
  thead th{ font-size:30px; font-weight:800; text-align:center; }
  thead th.corner{ background:transparent; border:none; }
  tbody th{ font-size:30px; font-weight:700; text-align:left; width:26%; color:var(--fg); }
  tbody td{ font-size:44px; font-weight:800; text-align:center; font-variant-numeric:tabular-nums; }
  td.list{ font-size:26px; font-weight:700; text-align:left; line-height:1.35; }
  td.list ol{ margin:0; padding:0; list-style:none; }
  td.list .rank{ color:var(--accent); font-weight:800; margin-right:8px; }
  td.list .n{ color:var(--muted); font-weight:700; }
  td.emote{ font-size:34px; }
</style>
</head>
<body>
  <div id="wrap">
    <h1>Chat Activity<span id="chan"></span></h1>
    <div id="status">connecting…</div>
    <table>
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
  </div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var token = qs.get('token') || '';
  // Row order + how to render each window's cell for that row.
  var ROWS = [
    { label:'Messages',                 cell:function(s){ return num(s.messages); } },
    { label:'Unique chatters',          cell:function(s){ return num(s.uniqueChatters); } },
    { label:'Emotes used',              cell:function(s){ return num(s.totalEmotes); } },
    { label:'Unique emotes',            cell:function(s){ return num(s.uniqueEmotes); } },
    { label:'Most used emote',          kind:'emote', cell:function(s){ return s.topEmote ? esc(s.topEmote.name)+' <span class="n">('+num(s.topEmote.count)+')</span>' : '—'; } },
    { label:'Top chatters (messages)',  kind:'list',  cell:function(s){ return list(s.topByMessages); } },
    { label:'Top chatters (emotes)',    kind:'list',  cell:function(s){ return list(s.topByEmotes); } }
  ];
  var WINDOWS = ['10s','30s','1m','5m']; // fallback labels until first payload

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;'; }); }
  function num(n){ return String(n==null?0:n); }
  function list(arr){
    if(!arr || !arr.length) return '<span class="n">—</span>';
    return '<ol>'+arr.map(function(x,i){
      return '<li><span class="rank">'+(i+1)+'.</span>'+esc(x.name)+' <span class="n">('+num(x.count)+')</span></li>';
    }).join('')+'</ol>';
  }
  function status(t){ var el=document.getElementById('status'); if(el) el.textContent=t||''; }

  function renderHead(labels){
    var html='<th class="corner"></th>';
    for(var i=0;i<labels.length;i++) html+='<th>'+esc(labels[i])+'</th>';
    document.getElementById('head').innerHTML=html;
  }
  function renderBody(windows){
    var html='';
    for(var r=0;r<ROWS.length;r++){
      var row=ROWS[r];
      var cls = row.kind==='list' ? ' class="list"' : (row.kind==='emote' ? ' class="emote"' : '');
      html+='<tr><th>'+esc(row.label)+'</th>';
      for(var c=0;c<windows.length;c++) html+='<td'+cls+'>'+row.cell(windows[c].stats)+'</td>';
      html+='</tr>';
    }
    document.getElementById('body').innerHTML=html;
  }

  // Initial empty grid so the layout shows immediately (real data replaces it).
  var EMPTY = { messages:0, uniqueChatters:0, totalEmotes:0, uniqueEmotes:0, topEmote:null, topByMessages:[], topByEmotes:[] };
  renderHead(WINDOWS);
  renderBody(WINDOWS.map(function(w){ return { label:w, stats:EMPTY }; }));

  function apply(d){
    if(!d || !d.windows) return;
    document.getElementById('chan').textContent = d.channel ? ' — #'+d.channel : '';
    renderHead(d.windows.map(function(w){ return w.label; }));
    renderBody(d.windows);
  }

  function connect(){
    var url = (location.protocol==='https:')
      ? 'wss://'+location.host+'/ws?room=chat-stats&secret='+encodeURIComponent(token)
      : 'ws://'+location.hostname+':8080?room=chat-stats&secret='+encodeURIComponent(token);
    var ws;
    try { ws=new WebSocket(url); } catch(e){ status('ws error'); setTimeout(connect,3000); return; }
    ws.onopen=function(){ status(''); };
    ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data); if(m && m.type==='stats') apply(m.payload); }catch(_e){} };
    ws.onerror=function(){ try{ ws.close(); }catch(_e){} };
    ws.onclose=function(ev){ if(ev && ev.code===4001) status('bad overlay token'); else { status('reconnecting…'); setTimeout(connect,2500); } };
  }

  if(!token){ status('missing ?token='); return; }
  connect();
})();
</script>
</body>
</html>`;
}
