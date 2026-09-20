import { renderLayout } from '../layout.js';

/**
 * User profile page: a compact two-column layout — identity (name, display name,
 * aliases) on the left, achievements on the right. The viewer's standing in the
 * channel is shown as badges beside their name rather than a separate table.
 *
 * Identity data comes from /api/me (via window.onMe) and edits call /api/me/*;
 * achievements come from /api/me/achievements.
 */
export function userPage(): string {
  const body = /* html */ `
    <div class="profile-grid">
      <div class="pcol">
        <div class="card">
          <div class="who">
            <h1 id="u-name">Your profile</h1>
            <span class="badges" id="u-badges"></span>
          </div>
          <div class="muted" id="u-canon"></div>

          <h2 class="sub">Display name</h2>
          <p class="muted">The name the bot uses whenever it refers to you.</p>
          <div class="rowline">
            <input type="text" id="dn-input" maxlength="40" style="flex:1" />
            <button class="pink" id="dn-save">Save</button>
          </div>
          <div class="toast" id="dn-toast"></div>

          <h2 class="sub">Aliases</h2>
          <p class="muted">Other names you can be referenced by in commands and features.</p>
          <div class="chips" id="alias-chips"></div>
          <div class="rowline" style="margin-top:.85rem">
            <input type="text" id="alias-input" maxlength="40" placeholder="add an alias" style="flex:1" />
            <button class="pink" id="alias-add">Add</button>
          </div>
          <div class="toast" id="alias-toast"></div>
        </div>

        <div class="card" style="text-align:right">
          <a class="btn pink" href="/auth/logout">Log out</a>
        </div>
      </div>

      <div class="pcol">
        <div class="card">
          <h2 style="margin-top:0">Achievements <span class="count" id="ach-summary"></span></h2>
          <p class="muted">Unlocked achievements are lit up; locked ones show how close you are.</p>
          <div class="ach-grid" id="ach-grid"><span class="muted">Loading…</span></div>
        </div>
      </div>
    </div>`;

  const script = `
    (function(){
      var css = document.createElement('style');
      css.textContent =
        // Two columns; achievements on the right. Collapses before the phone
        // breakpoint, since two card columns get cramped well above 640px.
        '.profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;align-items:start}'
        + '@media (max-width:900px){.profile-grid{grid-template-columns:1fr}}'
        + '.pcol>.card:last-child{margin-bottom:0}'
        + '.who{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}'
        + '.who h1{margin:0}'
        + '.badges{display:inline-flex;gap:.35rem;flex-wrap:wrap}'
        + '.badge{font-size:.72rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;border:1px solid;white-space:nowrap}'
        + '.badge.sub{color:#c9a7ff;border-color:#8b5cf6;background:rgba(139,92,246,.15)}'
        + '.badge.mod{color:#7ee787;border-color:#3fb950;background:rgba(63,185,80,.15)}'
        + '.badge.admin{color:#ff9ed8;border-color:var(--pink);background:rgba(255,110,199,.15)}'
        + 'h2.sub{margin:1.4rem 0 .35rem;font-size:1.05rem}'
        // Achievement badges: unlocked are full-colour with a tier-tinted border;
        // locked are dimmed and show a progress bar toward the target.
        + '.ach-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:.6rem}'
        + '.ach{display:flex;gap:.6rem;align-items:flex-start;background:var(--bg);border:1px solid var(--border);'
        + 'border-radius:10px;padding:.6rem .7rem}'
        + '.ach.locked{opacity:.55}'
        + '.ach.bronze{border-color:#cd7f32}.ach.silver{border-color:#cfd3d8}.ach.gold{border-color:#ffd24a}'
        + '.ach.locked.bronze,.ach.locked.silver,.ach.locked.gold{border-color:var(--border)}'
        + '.ach .emoji{font-size:1.6rem;line-height:1;filter:grayscale(1)}'
        + '.ach:not(.locked) .emoji{filter:none}'
        + '.ach .t{font-weight:700;font-size:.92rem}'
        + '.ach .d{font-size:.76rem;color:var(--muted)}'
        + '.ach .bar{height:5px;border-radius:3px;background:var(--border);margin-top:.35rem;overflow:hidden}'
        + '.ach .bar>i{display:block;height:100%;background:var(--pink)}'
        + '.ach .when{font-size:.72rem;color:var(--muted);margin-top:.25rem}';
      document.head.appendChild(css);
    })();

    // Standing in the channel, shown beside the name instead of a whole card.
    var BADGES=[['subscriber','Subscriber','sub'],['moderator','Moderator','mod'],['botAdmin','Bot Admin','admin']];
    function renderBadges(rel){
      var box=document.getElementById('u-badges');
      var on=BADGES.filter(function(b){ return rel && rel[b[0]]; });
      box.innerHTML=on.map(function(b){ return '<span class="badge '+b[2]+'">'+esc(b[1])+'</span>'; }).join('');
    }

    function renderAchievements(d){
      var grid=document.getElementById('ach-grid');
      var list=(d && d.achievements) || [];
      var sum=(d && d.summary) || { unlocked:0, total:0 };
      document.getElementById('ach-summary').textContent='('+sum.unlocked+' / '+sum.total+' unlocked)';
      if(!list.length){ grid.innerHTML='<span class="muted">No achievements yet.</span>'; return; }
      // Unlocked first (most recent first), then locked by closest-to-done.
      list.sort(function(a,b){
        if(a.unlocked!==b.unlocked) return a.unlocked?-1:1;
        if(a.unlocked) return String(b.unlockedAt||'').localeCompare(String(a.unlockedAt||''));
        return (b.current/b.target)-(a.current/a.target);
      });
      grid.innerHTML=list.map(function(a){
        var pct=Math.max(0,Math.min(100, Math.round((a.current/a.target)*100)));
        var foot = a.unlocked
          ? '<div class="when">Unlocked '+esc(String(a.unlockedAt||'').slice(0,10))+'</div>'
          : '<div class="bar"><i style="width:'+pct+'%"></i></div><div class="when">'+a.current+' / '+a.target+'</div>';
        return '<div class="ach '+esc(a.tier)+(a.unlocked?'':' locked')+'">'
          + '<div class="emoji">'+esc(a.emoji)+'</div>'
          + '<div style="min-width:0"><div class="t">'+esc(a.name)+'</div>'
          + '<div class="d">'+esc(a.description)+'</div>'+foot+'</div></div>';
      }).join('');
    }

    function loadAchievements(){
      api('GET','/api/me/achievements')
        .then(renderAchievements)
        .catch(function(e){
          document.getElementById('ach-grid').innerHTML='<span class="muted">Could not load: '+esc(e.message)+'</span>';
        });
    }

    function renderAliases(aliases){
      var box=document.getElementById('alias-chips');
      if(!aliases || !aliases.length){ box.innerHTML='<span class="muted">No aliases yet.</span>'; return; }
      box.innerHTML=aliases.map(function(a){ return '<span class="chip">'+esc(a)+' <button title="remove" data-alias="'+esc(a)+'">×</button></span>'; }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('button[data-alias]'), function(b){ b.onclick=function(){ removeAlias(b.getAttribute('data-alias')); }; });
    }
    async function removeAlias(a){
      try{ var d=await api('POST','/api/me/aliases/delete',{alias:a}); renderAliases(d.aliases); toast('alias-toast','Removed.',true); }
      catch(e){ toast('alias-toast', e.message, false); }
    }

    window.onMe=function(me){
      if(!me){ location.href='/'; return; }
      loadAchievements();
      renderBadges(me.relationship);
      document.getElementById('u-name').textContent=me.user.displayName;
      document.getElementById('u-canon').textContent=me.user.canonical;
      document.getElementById('dn-input').value=me.user.displayName;
      renderAliases(me.aliases||[]);
    };
    document.getElementById('dn-save').onclick=async function(){
      var v=document.getElementById('dn-input').value;
      try{
        var d=await api('POST','/api/me/display-name',{displayName:v});
        toast('dn-toast','Saved.',true);
        document.getElementById('u-name').textContent=d.displayName;
        var nu=document.getElementById('nav-user'); if(nu){ var s=nu.querySelector('span'); if(s) s.textContent=d.displayName; }
      }catch(e){ toast('dn-toast', e.message, false); }
    };
    document.getElementById('alias-add').onclick=async function(){
      var inp=document.getElementById('alias-input');
      try{ var d=await api('POST','/api/me/aliases',{alias:inp.value}); inp.value=''; toast('alias-toast','Added.',true); renderAliases(d.aliases); }
      catch(e){ toast('alias-toast', e.message, false); }
    };`;

  return renderLayout({ title: 'BasecaBot — Profile', active: 'user', body, script });
}
