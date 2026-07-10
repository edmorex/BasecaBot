import { renderLayout } from '../layout.js';

/**
 * Commands page — a master/detail view. The left sidebar lists "All Custom
 * Commands" (the default), an indented tree of the custom command groups beneath
 * it, then an alphabetical list of plugins that registered commands. Selecting an
 * entry renders that view's table on the right: custom views are the full
 * editable table (mod Edit/Enable-Disable/Delete, Group column, paginated 50 +
 * show-all); each plugin view is a compact read-only table.
 */
export function commandsPage(): string {
  const body = /* html */ `
    <div class="page-head" style="display:flex; align-items:flex-end; justify-content:space-between; gap:1rem">
      <div>
        <h1>Commands</h1>
        <p class="muted" id="cmd-sub" style="margin:0; padding:0">Loading…</p>
      </div>
      <button type="button" class="pink" id="new-cmd-btn" style="display:none; flex:none">+ New Command</button>
    </div>
    <div class="md-layout">
      <nav class="md-side card" id="cmd-side"></nav>
      <div class="md-main card" id="cmd-main"></div>
    </div>
    <div class="pager-wrap" id="cmd-pager"></div>

    <dialog id="edit-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(38rem,94vw)">
      <h2 id="edit-title" style="margin-top:0">Edit <code id="edit-name"></code></h2>
      <div id="edit-create-fields">
        <label class="muted">Type</label>
        <div class="radio-row" style="margin:.35rem 0 .8rem">
          <label><input type="radio" name="edit-kind" value="trigger" checked /> Trigger (<code>!word</code>)</label>
          <label><input type="radio" name="edit-kind" value="phrase" /> Phrase (matches chat)</label>
        </div>
        <label class="muted" id="edit-trigger-label">Trigger word</label>
        <input type="text" id="edit-trigger" maxlength="60" placeholder="e.g. hello" style="width:100%; margin:.35rem 0 .8rem" />
      </div>
      <label class="muted">Response <span class="muted">(blank = silent)</span></label>
      <input type="text" id="edit-response" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Group <span class="muted">(blank = ungrouped)</span></label>
      <input type="text" id="edit-group" maxlength="30" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Access</label>
      <div id="edit-permission" class="radio-row" style="margin:.35rem 0 .8rem">
        <label><input type="radio" name="edit-perm" value="0" /> Everyone</label>
        <label><input type="radio" name="edit-perm" value="1" /> Subscriber</label>
        <label><input type="radio" name="edit-perm" value="2" /> VIP</label>
        <label><input type="radio" name="edit-perm" value="3" /> Moderator</label>
        <label><input type="radio" name="edit-perm" value="4" /> Broadcaster</label>
        <label><input type="radio" name="edit-perm" value="5" /> Admin</label>
      </div>
      <label style="display:flex; align-items:center; gap:.4rem"><input type="checkbox" id="edit-enabled" /> Enabled</label>
      <div class="rowline" style="gap:1rem; margin-top:.8rem">
        <div style="flex:1"><label class="muted">Global cooldown (s)</label><input type="text" inputmode="numeric" id="edit-global" style="width:100%; margin-top:.35rem" /></div>
        <div style="flex:1"><label class="muted">User cooldown (s)</label><input type="text" inputmode="numeric" id="edit-user" style="width:100%; margin-top:.35rem" /></div>
      </div>
      <div id="edit-alias-section" style="margin-top:.8rem">
        <label class="muted">Aliases</label>
        <div class="chips" id="edit-aliases" style="margin-top:.35rem"></div>
        <div class="rowline" style="margin-top:.5rem">
          <input type="text" id="edit-alias-input" maxlength="30" placeholder="!alias" style="flex:1" />
          <button type="button" class="secondary" id="edit-alias-btn">Add alias</button>
        </div>
        <div class="toast err" id="edit-alias-toast"></div>
      </div>
      <div class="toast err" id="edit-toast" style="margin-top:.6rem"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="edit-cancel">Cancel</button>
        <button type="button" class="pink" id="edit-save">Save</button>
      </div>
    </dialog>

    <dialog id="del-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(30rem,94vw)">
      <h2 style="margin-top:0">Delete <code id="del-name"></code>?</h2>
      <p class="muted" id="del-msg"></p>
      <div class="toast err" id="del-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="del-cancel">Cancel</button>
        <button type="button" class="pink" id="del-confirm">Delete</button>
      </div>
    </dialog>`;

  const script = `
    var PAGE_SIZE=50;
    // view: 'all' (all customs) | 'group:<name>' (a custom group) | 'plugin:<name>'
    var state={ groups:[], customs:[], customGroups:[], page:0, showAll:false, canManage:false, view:'all' };
    var LABELS=['Everyone','Subscriber','VIP','Moderator','Broadcaster','Admin'];
    function accessLabel(a){ return LABELS[a] || ('Level '+a); }
    // Inline Lucide icons (CSP blocks external assets, so paths are embedded).
    var ICONS={
      'pencil':'<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/><path d="m15 5 4 4"/>',
      'circle-pause':'<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>',
      'circle-play':'<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
      'trash-2':'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
      'globe':'<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
      'user-round':'<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
      'copy':'<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'
    };
    function icon(name, size){ size=size||16; return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+ICONS[name]+'</svg>'; }
    function pretty(g){ return String(g||'other').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/^./,function(m){return m.toUpperCase();}); }
    function byName(a,b){ return a.name.localeCompare(b.name); }
    function copyBtn(text){ return '<span class="copy-btn" data-copy="'+esc(text)+'" title="Copy '+esc(text)+'">'+icon('copy',13)+'</span>'; }
    function nameCell(c){
      var copyText = c.kind==='phrase' ? c.name : '!'+c.name;
      var inner = c.kind==='phrase' ? '&ldquo;'+esc(c.name)+'&rdquo;' : '<code>!'+esc(c.name)+'</code>';
      var main = '<span class="namecopy">'+copyBtn(copyText)+inner+'</span>';
      if(c.usage) main += ' <span class="args">'+esc(c.usage)+'</span>';
      if(c.aliases && c.aliases.length){
        var lines=c.aliases.map(function(a){ var t='!'+esc(a);
          return '<span class="alias">'+copyBtn(t)+'<code>'+t+'</code></span>';
        }).join('');
        main += '<span class="aliases">'+lines+'</span>';
      }
      return main;
    }
    // Attach click-to-copy to every [data-copy] element in a rendered view.
    function wireCopy(root){
      Array.prototype.forEach.call(root.querySelectorAll('[data-copy]'), function(el){
        el.onclick=function(){
          var t=el.getAttribute('data-copy');
          if(navigator.clipboard) navigator.clipboard.writeText(t);
          el.classList.add('copied'); setTimeout(function(){ el.classList.remove('copied'); }, 900);
        };
      });
    }

    window.onMe=function(me){
      state.canManage=!!(me && me.relationship && (me.relationship.moderator || me.relationship.broadcaster || me.relationship.botAdmin));
      load();
    };
    async function load(){
      try{
        var d=await api('GET','/api/commands'); var all=d.commands||[];
        state.customs=all.filter(function(c){return c.kind!=='builtin';}).sort(byName);
        for(var i=0;i<state.customs.length;i++) state.customs[i].__i=i;
        // Distinct custom groups (non-empty), sorted, with counts.
        var gm={}; state.customs.forEach(function(c){ if(c.group){ gm[c.group]=(gm[c.group]||0)+1; } });
        state.customGroups=Object.keys(gm).sort(function(a,b){return a.localeCompare(b);}).map(function(k){ return { name:k, count:gm[k] }; });
        // Plugin groups (built-in commands).
        var g={}; all.filter(function(c){return c.kind==='builtin';}).forEach(function(c){ var k=c.group||'other'; (g[k]=g[k]||[]).push(c); });
        state.groups=Object.keys(g).sort().map(function(k){ return { group:k, cmds:g[k].sort(byName) }; });
        if(!viewExists(state.view)) state.view='all';
        document.getElementById('cmd-sub').textContent=all.length+' command'+(all.length===1?'':'s')+' across '+state.groups.length+' plugin'+(state.groups.length===1?'':'s')+' + '+state.customs.length+' custom.'+(state.canManage?' You can manage custom commands.':'');
        document.getElementById('new-cmd-btn').style.display = state.canManage ? '' : 'none';
        renderSide(); renderMain();
      }catch(e){ document.getElementById('cmd-sub').textContent='Could not load commands: '+e.message; }
    }
    function viewExists(v){
      if(v==='all') return true;
      if(v.indexOf('group:')===0) return state.customGroups.some(function(g){return g.name===v.slice(6);});
      if(v.indexOf('plugin:')===0) return state.groups.some(function(s){return s.group===v.slice(7);});
      return false;
    }
    function currentCustoms(){
      if(state.view.indexOf('group:')===0){ var g=state.view.slice(6); return state.customs.filter(function(c){return (c.group||'')===g;}); }
      return state.customs;
    }

    function renderSide(){
      var side=document.getElementById('cmd-side');
      var html='<div class="label">Custom Commands</div><button class="item'+(state.view==='all'?' active':'')+'" data-view="all">Show All <span class="count">'+state.customs.length+'</span></button>';
      if(state.customGroups.length){
        html+='<div class="subgroups">'+state.customGroups.map(function(g){ var v='group:'+g.name;
          return '<button class="item'+(state.view===v?' active':'')+'" data-view="'+esc(v)+'">'+esc(g.name)+' <span class="count">'+g.count+'</span></button>';
        }).join('')+'</div>';
      }
      if(state.groups.length) html+='<div class="label">Built-in Commands</div>';
      html+=state.groups.map(function(s){ var v='plugin:'+s.group;
        return '<button class="item'+(state.view===v?' active':'')+'" data-view="'+esc(v)+'">'+esc(pretty(s.group))+' <span class="count">'+s.cmds.length+'</span></button>';
      }).join('');
      side.innerHTML=html;
      Array.prototype.forEach.call(side.querySelectorAll('button[data-view]'), function(b){
        b.onclick=function(){ state.view=b.getAttribute('data-view'); state.page=0; state.showAll=false; renderSide(); renderMain(); };
      });
    }

    function renderMain(){
      var main=document.getElementById('cmd-main');
      if(state.view.indexOf('plugin:')===0){
        document.getElementById('cmd-pager').innerHTML='';
        var sec=state.groups.filter(function(s){return s.group===state.view.slice(7);})[0];
        main.innerHTML = sec ? builtinView(sec) : '<p class="muted">Nothing here.</p>';
        wireCopy(main);
        return;
      }
      main.innerHTML=customView(); wireCustom(); wireCopy(main); renderPager();
    }

    function cdCell(c){
      return '<span class="cd-cell">'
        +'<span class="tag" title="Global cooldown (s)">'+icon('globe',12)+(c.globalCooldown||0)+'</span>'
        +'<span class="tag" title="User cooldown (s)">'+icon('user-round',12)+(c.userCooldown||0)+'</span></span>';
    }

    function builtinView(sec){
      var rows=sec.cmds.map(function(c){
        return '<tr><td>'+nameCell(c)+'</td><td>'+esc(accessLabel(c.access))+'</td><td>'+cdCell(c)+'</td><td class="muted">'+esc(c.description||'')+'</td></tr>';
      }).join('');
      return '<h2>'+esc(pretty(sec.group))+' <span class="count">('+sec.cmds.length+' command'+(sec.cmds.length===1?'':'s')+')</span></h2>'
        +'<div style="overflow-x:auto"><table class="cmd-builtins"><thead><tr><th>Command</th><th>Access</th><th>Cooldown</th><th>Description</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }

    function groupCell(c){ return c.group ? '<span class="tag">'+esc(c.group)+'</span>' : '<span class="muted">—</span>'; }

    function customView(){
      var list=currentCustoms();
      var total=list.length;
      var paginate=total>PAGE_SIZE && !state.showAll;
      var rows=paginate ? list.slice(state.page*PAGE_SIZE, state.page*PAGE_SIZE+PAGE_SIZE) : list;
      var title = state.view.indexOf('group:')===0 ? esc(state.view.slice(6)) : 'All Custom Commands';
      var head='<tr><th>Command</th><th>Type</th><th>Access</th><th>On</th><th>Uses</th><th>Cooldown</th><th class="wrap">Response</th><th>Group</th><th class="col-actions">Actions</th></tr>';
      var b=rows.map(customRow).join('') || '<tr><td colspan="9" class="muted">No custom commands here. Add one in chat with <code>!command add</code>.</td></tr>';
      return '<h2>'+title+' <span class="count">('+total+')</span></h2>'
        +'<div style="overflow-x:auto"><table><thead>'+head+'</thead><tbody>'+b+'</tbody></table></div>';
    }

    function customRow(c){
      var on = c.enabled?'<span class="yes">✓</span>':'<span class="no">✗</span>';
      var cd = cdCell(c);
      var resp = c.response ? esc(c.response) : '<span class="muted">(silent)</span>';
      // Always render the buttons so the column layout is identical for everyone;
      // non-mods just see them disabled/greyed out.
      var dis = state.canManage ? '' : ' disabled';
      var actions = '<td class="col-actions"><div class="actions-cell">'
        +'<button class="secondary icon-btn" data-edit="'+c.__i+'"'+dis+' title="Edit">'+icon('pencil')+'</button>'
        +'<button class="secondary icon-btn" data-toggle="'+c.__i+'"'+dis+' title="'+(c.enabled?'Disable':'Enable')+'">'+icon(c.enabled?'circle-pause':'circle-play')+'</button>'
        +'<button class="danger icon-btn" data-del="'+c.__i+'"'+dis+' title="Delete">'+icon('trash-2')+'</button></div></td>';
      return '<tr>'
        +'<td>'+nameCell(c)+'</td>'
        +'<td><span class="tag">'+esc(c.kind)+'</span></td>'
        +'<td>'+esc(accessLabel(c.access))+'</td>'
        +'<td>'+on+'</td>'
        +'<td>'+String(c.usageCount||0)+'</td>'
        +'<td>'+cd+'</td>'
        +'<td class="wrap muted">'+resp+'</td>'
        +'<td>'+groupCell(c)+'</td>'
        +actions+'</tr>';
    }

    function wireCustom(){
      var root=document.getElementById('cmd-main');
      var q=function(sel,fn){ Array.prototype.forEach.call(root.querySelectorAll(sel), fn); };
      q('button[data-edit]', function(b){ b.onclick=function(){ openEdit(+b.getAttribute('data-edit')); }; });
      q('button[data-toggle]', function(b){ b.onclick=function(){ toggleEnabled(+b.getAttribute('data-toggle')); }; });
      q('button[data-del]', function(b){ b.onclick=function(){ delCommand(+b.getAttribute('data-del')); }; });
    }

    // Page tokens to show. <=7 pages: show them all. Otherwise ALWAYS 7 boxes:
    //   near start:  1 2 3 4 5 … last
    //   near end:    1 … n-4 n-3 n-2 n-1 n
    //   middle:      1 … c-1 c c+1 … last
    function pageList(cur, total){
      if(total<=7){ var a=[]; for(var i=1;i<=total;i++) a.push(i); return a; }
      if(cur<=4) return [1,2,3,4,5,'...',total];
      if(cur>=total-3) return [1,'...',total-4,total-3,total-2,total-1,total];
      return [1,'...',cur-1,cur,cur+1,'...',total];
    }

    // Connected-squares pager, rendered OUTSIDE the panel and centered.
    function renderPager(){
      var wrap=document.getElementById('cmd-pager');
      var total=currentCustoms().length;
      if(total<=PAGE_SIZE){ wrap.innerHTML=''; return; }
      if(state.showAll){
        wrap.innerHTML='<span class="muted">Showing all '+total+'</span><button class="linkish" data-collapse>Paginate</button>';
        wrap.querySelector('[data-collapse]').onclick=function(){ state.showAll=false; state.page=0; renderMain(); };
        return;
      }
      var pages=Math.ceil(total/PAGE_SIZE);
      var cur=state.page+1;
      var box=function(cls, label, page){ return '<div class="pg'+(cls?' '+cls:'')+'"'+(page?' data-page="'+page+'"':'')+'>'+label+'</div>'; };
      var s=box(cur<=1?'disabled':'', '&lt;', cur>1?cur-1:0);
      pageList(cur, pages).forEach(function(p){
        s += p==='...' ? box('ellipsis','…',0) : box(p===cur?'current':'', String(p), p);
      });
      s += box(cur>=pages?'disabled':'', '&gt;', cur<pages?cur+1:0);
      wrap.innerHTML='<div class="pager">'+s+'</div><button class="linkish" data-showall>Show all ('+total+')</button>';
      Array.prototype.forEach.call(wrap.querySelectorAll('.pg[data-page]'), function(b){
        b.onclick=function(){ state.page=(+b.getAttribute('data-page'))-1; renderMain(); };
      });
      wrap.querySelector('[data-showall]').onclick=function(){ state.showAll=true; renderMain(); };
    }

    var dlg=document.getElementById('edit-dlg');
    var editing=null;
    var mode='edit'; // 'edit' | 'create'
    function setPermRadio(v){
      Array.prototype.forEach.call(document.querySelectorAll('input[name=edit-perm]'), function(r){ r.checked = (+r.value === (v||0)); });
    }
    function getPermRadio(){ var el=document.querySelector('input[name=edit-perm]:checked'); return el ? +el.value : 0; }
    function editAliasToast(msg, ok){ var t=document.getElementById('edit-alias-toast'); t.textContent=msg||''; t.className='toast '+(ok?'ok':'err'); }
    function renderEditAliases(){
      var box=document.getElementById('edit-aliases');
      var aliases=editing.aliases||[];
      if(!aliases.length){ box.innerHTML='<span class="muted">No aliases.</span>'; return; }
      box.innerHTML=aliases.map(function(a){ return '<span class="chip">!'+esc(a)+' <button type="button" title="Remove" data-alias="'+esc(a)+'">×</button></span>'; }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('button[data-alias]'), function(b){ b.onclick=function(){ removeEditAlias(b.getAttribute('data-alias')); }; });
    }
    // Re-fetch after an alias change so the table + modal reflect it, keeping the modal open.
    async function reloadEditing(){
      await load();
      var found=state.customs.filter(function(c){return c.kind===editing.kind && c.name===editing.name;})[0];
      if(found){ editing=found; renderEditAliases(); }
    }
    async function addEditAlias(){
      var inp=document.getElementById('edit-alias-input');
      if(!inp.value.trim()) return;
      try{ await api('POST','/api/commands/alias',{ kind:editing.kind, name:editing.name, alias:inp.value }); inp.value=''; editAliasToast('Added.',true); await reloadEditing(); }
      catch(e){ editAliasToast(e.message,false); }
    }
    async function removeEditAlias(a){
      try{ await api('POST','/api/commands/alias/delete',{ alias:a }); editAliasToast('Removed.',true); await reloadEditing(); }
      catch(e){ editAliasToast(e.message,false); }
    }
    document.getElementById('edit-alias-btn').onclick=addEditAlias;
    document.getElementById('edit-alias-input').onkeydown=function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); addEditAlias(); } };

    // The scalar fields shared by create + edit.
    function commonFields(){
      return {
        response:document.getElementById('edit-response').value,
        group:document.getElementById('edit-group').value,
        permission:getPermRadio(),
        enabled:document.getElementById('edit-enabled').checked,
        globalCooldown:parseInt(document.getElementById('edit-global').value,10)||0,
        userCooldown:parseInt(document.getElementById('edit-user').value,10)||0
      };
    }
    function getKindRadio(){ var el=document.querySelector('input[name=edit-kind]:checked'); return el ? el.value : 'trigger'; }
    function updateTriggerLabel(){
      var isPhrase=getKindRadio()==='phrase';
      document.getElementById('edit-trigger-label').textContent = isPhrase ? 'Phrase' : 'Trigger word';
      document.getElementById('edit-trigger').placeholder = isPhrase ? 'e.g. good game' : 'e.g. hello';
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name=edit-kind]'), function(r){ r.onchange=updateTriggerLabel; });

    function openNew(){
      mode='create'; editing=null;
      document.getElementById('edit-title').textContent='New Command';
      document.getElementById('edit-create-fields').style.display='';
      document.getElementById('edit-alias-section').style.display='none'; // add aliases after creating
      document.getElementById('edit-response').value='';
      document.getElementById('edit-group').value='';
      setPermRadio(0);
      document.getElementById('edit-enabled').checked=true;
      document.getElementById('edit-global').value='0';
      document.getElementById('edit-user').value='0';
      var trig=document.querySelector('input[name=edit-kind][value=trigger]'); if(trig) trig.checked=true;
      document.getElementById('edit-trigger').value='';
      updateTriggerLabel();
      document.getElementById('edit-toast').textContent='';
      document.getElementById('edit-save').textContent='Create';
      if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
      document.getElementById('edit-trigger').focus();
    }

    function openEdit(i){
      var c=state.customs[i]; if(!c) return; mode='edit'; editing=c;
      document.getElementById('edit-title').innerHTML='Edit <code>'+(c.kind==='phrase'?('“'+esc(c.name)+'”'):('!'+esc(c.name)))+'</code>';
      document.getElementById('edit-create-fields').style.display='none';
      document.getElementById('edit-response').value=c.response||'';
      document.getElementById('edit-group').value=c.group||'';
      setPermRadio(c.access||0);
      document.getElementById('edit-enabled').checked=!!c.enabled;
      document.getElementById('edit-global').value=String(c.globalCooldown||0);
      document.getElementById('edit-user').value=String(c.userCooldown||0);
      // Aliases only apply to trigger commands.
      var aliasSection=document.getElementById('edit-alias-section');
      aliasSection.style.display = c.kind==='phrase' ? 'none' : '';
      if(c.kind!=='phrase') renderEditAliases();
      editAliasToast('');
      document.getElementById('edit-toast').textContent='';
      document.getElementById('edit-save').textContent='Save';
      if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
    }
    document.getElementById('new-cmd-btn').onclick=openNew;
    document.getElementById('edit-cancel').onclick=function(){ dlg.close ? dlg.close() : dlg.removeAttribute('open'); };
    document.getElementById('edit-save').onclick=async function(){
      var f=commonFields();
      if(mode==='create'){
        var kind=getKindRadio();
        var name=document.getElementById('edit-trigger').value;
        if(!name.trim()){ document.getElementById('edit-toast').textContent = kind==='phrase' ? 'Enter the phrase text.' : 'Enter a trigger word.'; return; }
        try{ await api('POST','/api/commands/create', Object.assign({ kind:kind, name:name }, f)); dlg.close?dlg.close():dlg.removeAttribute('open'); await load(); }
        catch(e){ document.getElementById('edit-toast').textContent=e.message; }
        return;
      }
      if(!editing) return;
      try{ await api('POST','/api/commands', Object.assign({ kind:editing.kind, name:editing.name }, f)); dlg.close?dlg.close():dlg.removeAttribute('open'); await load(); }
      catch(e){ document.getElementById('edit-toast').textContent=e.message; }
    };
    async function toggleEnabled(i){
      var c=state.customs[i]; if(!c) return;
      try{ await api('POST','/api/commands',{ kind:c.kind, name:c.name, enabled:!c.enabled }); await load(); }
      catch(e){ alert(e.message); }
    }
    var delDlg=document.getElementById('del-dlg');
    var deleting=null;
    function delCommand(i){
      var c=state.customs[i]; if(!c) return; deleting=c;
      document.getElementById('del-name').textContent = c.kind==='phrase' ? '“'+c.name+'”' : '!'+c.name;
      var hasAliases = c.kind!=='phrase' && c.aliases && c.aliases.length;
      var aliasNote = hasAliases ? ' and its alias'+(c.aliases.length>1?'es':'')+' ('+c.aliases.map(function(a){return '!'+a;}).join(', ')+')' : '';
      document.getElementById('del-msg').textContent = 'This permanently removes the command'+aliasNote+'.';
      document.getElementById('del-toast').textContent='';
      if(delDlg.showModal) delDlg.showModal(); else delDlg.setAttribute('open','');
    }
    document.getElementById('del-cancel').onclick=function(){ delDlg.close?delDlg.close():delDlg.removeAttribute('open'); };
    document.getElementById('del-confirm').onclick=async function(){
      if(!deleting) return;
      try{ await api('POST','/api/commands/delete',{ kind:deleting.kind, name:deleting.name }); delDlg.close?delDlg.close():delDlg.removeAttribute('open'); await load(); }
      catch(e){ document.getElementById('del-toast').textContent='Delete failed: '+e.message; }
    };`;

  return renderLayout({ title: 'BasecaBot — Commands', active: 'commands', body, script, wide: true });
}
