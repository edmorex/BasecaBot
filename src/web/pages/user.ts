import { renderLayout } from '../layout.js';

/**
 * User profile page: identity, editable display name, editable aliases, the
 * relationship-to-channel grid, and a log-out button. All dynamic data comes
 * from /api/me (via window.onMe); edits call the /api/me/* endpoints.
 */
export function userPage(): string {
  const body = /* html */ `
    <div class="card">
      <h1 id="u-name">Your profile</h1>
      <div class="muted" id="u-canon"></div>
    </div>

    <div class="card">
      <h2>Display name</h2>
      <p class="muted">The name the bot uses whenever it refers to you.</p>
      <div class="rowline">
        <input type="text" id="dn-input" maxlength="40" />
        <button id="dn-save">Save</button>
      </div>
      <div class="toast" id="dn-toast"></div>
    </div>

    <div class="card">
      <h2>Aliases</h2>
      <p class="muted">Other names you can be referenced by in commands and features.</p>
      <div class="chips" id="alias-chips"></div>
      <div class="rowline" style="margin-top:.85rem">
        <input type="text" id="alias-input" maxlength="40" placeholder="add an alias" />
        <button id="alias-add">Add</button>
      </div>
      <div class="toast" id="alias-toast"></div>
    </div>

    <div class="card">
      <h2>Your relationship to the channel</h2>
      <div class="grid-perms" id="perms"></div>
    </div>

    <div class="card" style="text-align:right">
      <a class="btn secondary" href="/auth/logout">Log out</a>
    </div>`;

  const script = `
    var ROWS=[['broadcaster','Broadcaster'],['botAdmin','Bot Admin'],['moderator','Moderator'],['subscriber','Subscriber'],['follower','Follower']];
    function toast(id,msg,ok){ var t=document.getElementById(id); t.textContent=msg; t.className='toast '+(ok?'ok':'err'); }
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
      document.getElementById('perms').innerHTML=ROWS.map(function(r){ var on=!!me.relationship[r[0]]; return '<div class="row"><span>'+r[1]+'</span><span class="'+(on?'yes':'no')+'">'+(on?'✓':'✗')+'</span></div>'; }).join('');
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
