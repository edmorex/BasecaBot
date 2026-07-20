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
      <div class="rowline" style="flex:none; gap:.5rem; justify-content:flex-end">
        <button type="button" class="pink" id="new-cmd-btn" style="display:none">+ New Command</button>
        <button type="button" class="pink" id="new-alias-btn" style="display:none">+ Add Alias</button>
        <button type="button" class="pink" id="cmd-import-btn" style="display:none">Import CSV</button>
        <button type="button" class="pink" id="cmd-export-btn" style="display:none">Export CSV</button>
      </div>
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
    </dialog>

    <dialog id="cimp-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(38rem,94vw)">
      <h2 style="margin-top:0">Import Commands from CSV</h2>
      <p class="muted" style="margin:.2rem 0 .8rem">Columns: <code>Type, Name, Response, Group, Access, Enabled, Global Cooldown, User Cooldown, Uses, Target, Args, Created At, Updated At</code>. Type is <code>trigger</code>, <code>phrase</code>, or <code>alias</code> (alias rows use Target + Args). Only custom commands are affected — built-ins are never touched. <strong>Wipe &amp; replace preserves timestamps</strong> for a true backup restore. A header row is optional.</p>
      <label class="muted">CSV file</label>
      <input type="file" id="cimp-file" accept=".csv,text/csv" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Mode</label>
      <div class="radio-row" style="margin:.35rem 0 .8rem; flex-wrap:wrap">
        <label><input type="radio" name="cimp-mode" value="add" checked /> Add (skip existing)</label>
        <label><input type="radio" name="cimp-mode" value="replace" /> Wipe &amp; replace all custom commands</label>
      </div>
      <div class="toast err" id="cimp-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="cimp-cancel">Cancel</button>
        <button type="button" class="pink" id="cimp-go">Import</button>
      </div>
    </dialog>

    <dialog id="cwarn-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(32rem,94vw)">
      <h2 style="margin-top:0">⚠️ Wipe &amp; replace all custom commands?</h2>
      <p class="muted">This permanently deletes <strong>every custom command and alias</strong> (built-ins are unaffected) and replaces them with the rows in your CSV. This cannot be undone.</p>
      <div class="toast err" id="cwarn-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="cwarn-cancel">Cancel</button>
        <button type="button" class="danger" id="cwarn-confirm">Wipe &amp; replace</button>
      </div>
    </dialog>

    <dialog id="alias-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(34rem,94vw)">
      <h2 id="alias-title" style="margin-top:0">New Alias</h2>
      <label class="muted">Alias word</label>
      <input type="text" id="alias-word" maxlength="60" placeholder="e.g. d6" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Aliases to command <span class="muted">(a <code>!trigger</code> command, not another alias)</span></label>
      <input type="text" id="alias-target" maxlength="60" placeholder="e.g. roll" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Extra arguments <span class="muted">(optional; passed to the command, may use $() variables)</span></label>
      <input type="text" id="alias-args" maxlength="200" placeholder="e.g. $(random 1-6)" style="width:100%; margin:.35rem 0 .8rem" />
      <div class="toast err" id="alias-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="alias-cancel">Cancel</button>
        <button type="button" class="pink" id="alias-save">Save</button>
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
      return main;
    }
    // Title-cased type pill: Trigger / Phrase / Alias.
    function typePill(c){ var s=String(c.kind||''); return '<span class="tag">'+esc(s.charAt(0).toUpperCase()+s.slice(1))+'</span>'; }
    // Response column: alias rows show the command they run (+ any extra args).
    function respCell(c){
      if(c.kind==='alias'){
        var t='<code>!'+esc(c.target||'')+'</code>';
        if(c.args) t+=' <span class="args">'+esc(c.args)+'</span>';
        return t;
      }
      return c.response ? esc(c.response) : '<span class="muted">(silent)</span>';
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
        document.getElementById('new-alias-btn').style.display = state.canManage ? '' : 'none';
        document.getElementById('cmd-import-btn').style.display = state.canManage ? '' : 'none';
        document.getElementById('cmd-export-btn').style.display = state.canManage ? '' : 'none';
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
      var head='<tr><th class="col-toggle"></th><th>Command</th><th>Type</th><th>Access</th><th>Uses</th><th>Cooldown</th><th class="wrap">Response</th><th>Group</th><th class="col-actions">Actions</th></tr>';
      var b=rows.map(customRow).join('') || '<tr><td colspan="9" class="muted">No custom commands here. Add one in chat with <code>!command add</code>.</td></tr>';
      return '<h2>'+title+' <span class="count">('+total+')</span></h2>'
        +'<div style="overflow-x:auto"><table><thead>'+head+'</thead><tbody>'+b+'</tbody></table></div>';
    }

    function customRow(c){
      // Always render controls so the column layout is identical for everyone;
      // non-mods just see them disabled. Alias rows edit via a separate modal.
      var dis = state.canManage ? '' : ' disabled';
      var editAttr = c.kind==='alias' ? 'data-aedit' : 'data-edit';
      var toggle = '<td class="col-toggle"><label class="switch" title="'+(c.enabled?'Enabled — click to disable':'Disabled — click to enable')+'">'
        +'<input type="checkbox" data-toggle="'+c.__i+'"'+(c.enabled?' checked':'')+dis+'><span class="slider"></span></label></td>';
      var actions = '<td class="col-actions"><div class="actions-cell">'
        +'<button class="secondary icon-btn" '+editAttr+'="'+c.__i+'"'+dis+' title="Edit">'+icon('pencil')+'</button>'
        +'<button class="danger icon-btn" data-del="'+c.__i+'"'+dis+' title="Delete">'+icon('trash-2')+'</button></div></td>';
      return '<tr'+(c.enabled?'':' class="row-off"')+'>'
        +toggle
        +'<td>'+nameCell(c)+'</td>'
        +'<td>'+typePill(c)+'</td>'
        +'<td>'+esc(accessLabel(c.access))+'</td>'
        +'<td>'+String(c.usageCount||0)+'</td>'
        +'<td>'+cdCell(c)+'</td>'
        +'<td class="wrap muted">'+respCell(c)+'</td>'
        +'<td>'+groupCell(c)+'</td>'
        +actions+'</tr>';
    }

    function wireCustom(){
      var root=document.getElementById('cmd-main');
      var q=function(sel,fn){ Array.prototype.forEach.call(root.querySelectorAll(sel), fn); };
      q('button[data-edit]', function(b){ b.onclick=function(){ openEdit(+b.getAttribute('data-edit')); }; });
      q('button[data-aedit]', function(b){ b.onclick=function(){ openAliasEdit(+b.getAttribute('data-aedit')); }; });
      q('input[data-toggle]', function(b){ b.onchange=function(){ toggleEnabled(+b.getAttribute('data-toggle')); }; });
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
      try{
        if(c.kind==='alias') await api('POST','/api/commands/alias/update',{ alias:c.name, enabled:!c.enabled });
        else await api('POST','/api/commands',{ kind:c.kind, name:c.name, enabled:!c.enabled });
        await load();
      }
      // The switch already flipped optimistically; re-render from unchanged state
      // to snap it back to the true value before reporting the failure.
      catch(e){ renderMain(); alert(e.message); }
    }

    // ── Alias create/edit dialog ──────────────────────────────────────────────
    var aliasDlg=document.getElementById('alias-dlg');
    var aliasMode='create', aliasEditing=null;
    function openNewAlias(){
      aliasMode='create'; aliasEditing=null;
      document.getElementById('alias-title').textContent='New Alias';
      var w=document.getElementById('alias-word'); w.value=''; w.removeAttribute('disabled');
      document.getElementById('alias-target').value='';
      document.getElementById('alias-args').value='';
      document.getElementById('alias-toast').textContent='';
      document.getElementById('alias-save').textContent='Create';
      if(aliasDlg.showModal) aliasDlg.showModal(); else aliasDlg.setAttribute('open','');
      w.focus();
    }
    function openAliasEdit(i){
      var c=state.customs[i]; if(!c) return; aliasMode='edit'; aliasEditing=c;
      document.getElementById('alias-title').innerHTML='Edit alias <code>!'+esc(c.name)+'</code>';
      var w=document.getElementById('alias-word'); w.value=c.name; w.setAttribute('disabled','');
      document.getElementById('alias-target').value=c.target||'';
      document.getElementById('alias-args').value=c.args||'';
      document.getElementById('alias-toast').textContent='';
      document.getElementById('alias-save').textContent='Save';
      if(aliasDlg.showModal) aliasDlg.showModal(); else aliasDlg.setAttribute('open','');
    }
    document.getElementById('new-alias-btn').onclick=openNewAlias;
    document.getElementById('alias-cancel').onclick=function(){ aliasDlg.close?aliasDlg.close():aliasDlg.removeAttribute('open'); };
    document.getElementById('alias-save').onclick=async function(){
      var target=document.getElementById('alias-target').value;
      var args=document.getElementById('alias-args').value;
      if(!target.trim()){ document.getElementById('alias-toast').textContent='Enter the command to alias to.'; return; }
      try{
        if(aliasMode==='create'){
          var word=document.getElementById('alias-word').value;
          if(!word.trim()){ document.getElementById('alias-toast').textContent='Enter the alias word.'; return; }
          await api('POST','/api/commands/alias',{ alias:word, target:target, args:args });
        } else {
          await api('POST','/api/commands/alias/update',{ alias:aliasEditing.name, target:target, args:args });
        }
        aliasDlg.close?aliasDlg.close():aliasDlg.removeAttribute('open');
        await load();
      }catch(e){ document.getElementById('alias-toast').textContent=e.message; }
    };
    var delDlg=document.getElementById('del-dlg');
    var deleting=null;
    function delCommand(i){
      var c=state.customs[i]; if(!c) return; deleting=c;
      document.getElementById('del-name').textContent = c.kind==='phrase' ? '“'+c.name+'”' : '!'+c.name;
      document.getElementById('del-msg').textContent = c.kind==='alias'
        ? 'This removes the alias. The command it points to is not affected.'
        : 'This permanently removes the command and any aliases pointing to it.';
      document.getElementById('del-toast').textContent='';
      if(delDlg.showModal) delDlg.showModal(); else delDlg.setAttribute('open','');
    }
    document.getElementById('del-cancel').onclick=function(){ delDlg.close?delDlg.close():delDlg.removeAttribute('open'); };
    document.getElementById('del-confirm').onclick=async function(){
      if(!deleting) return;
      try{
        if(deleting.kind==='alias') await api('POST','/api/commands/alias/delete',{ alias:deleting.name });
        else await api('POST','/api/commands/delete',{ kind:deleting.kind, name:deleting.name });
        delDlg.close?delDlg.close():delDlg.removeAttribute('open'); await load();
      }
      catch(e){ document.getElementById('del-toast').textContent='Delete failed: '+e.message; }
    };

    // ── CSV export/import (custom commands + aliases only) ──────────────────────
    function downloadCsv(filename, text){
      var blob=new Blob([text], { type:'text/csv;charset=utf-8' });
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a'); a.href=url; a.download=filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    }
    function readFileText(input){
      return new Promise(function(resolve,reject){
        var f=input.files && input.files[0];
        if(!f){ reject(new Error('Choose a CSV file first.')); return; }
        var r=new FileReader();
        r.onload=function(){ resolve(String(r.result||'')); };
        r.onerror=function(){ reject(new Error('Could not read the file.')); };
        r.readAsText(f);
      });
    }
    document.getElementById('cmd-export-btn').onclick=async function(){
      try{
        var res=await fetch('/api/commands/export',{ credentials:'same-origin' });
        if(!res.ok) throw new Error('HTTP '+res.status);
        downloadCsv('commands.csv', await res.text());
      }catch(e){ alert('Export failed: '+e.message); }
    };
    var cimpDlg=document.getElementById('cimp-dlg');
    var cwarnDlg=document.getElementById('cwarn-dlg');
    var cPendingCsv='';
    function cimpMode(){ var el=document.querySelector('input[name=cimp-mode]:checked'); return el?el.value:'add'; }
    document.getElementById('cmd-import-btn').onclick=function(){
      document.getElementById('cimp-file').value='';
      var add=document.querySelector('input[name=cimp-mode][value=add]'); if(add) add.checked=true;
      document.getElementById('cimp-toast').textContent='';
      if(cimpDlg.showModal) cimpDlg.showModal(); else cimpDlg.setAttribute('open','');
    };
    document.getElementById('cimp-cancel').onclick=function(){ cimpDlg.close?cimpDlg.close():cimpDlg.removeAttribute('open'); };
    async function doCmdImport(mode, csv){
      var d=await api('POST','/api/commands/import',{ mode:mode, csv:csv });
      cimpDlg.close?cimpDlg.close():cimpDlg.removeAttribute('open');
      cwarnDlg.close?cwarnDlg.close():cwarnDlg.removeAttribute('open');
      await load();
      var sub=document.getElementById('cmd-sub');
      sub.textContent = 'Imported '+d.commands+' command'+(d.commands===1?'':'s')+' + '+d.aliases+' alias'+(d.aliases===1?'':'es')+(d.skipped?(' ('+d.skipped+' skipped)'):'')+'. '+sub.textContent;
    }
    document.getElementById('cimp-go').onclick=async function(){
      try{
        cPendingCsv=await readFileText(document.getElementById('cimp-file'));
        if(cimpMode()==='replace'){ document.getElementById('cwarn-toast').textContent=''; if(cwarnDlg.showModal) cwarnDlg.showModal(); else cwarnDlg.setAttribute('open',''); return; }
        await doCmdImport('add', cPendingCsv);
      }catch(e){ document.getElementById('cimp-toast').textContent=e.message; }
    };
    document.getElementById('cwarn-cancel').onclick=function(){ cwarnDlg.close?cwarnDlg.close():cwarnDlg.removeAttribute('open'); };
    document.getElementById('cwarn-confirm').onclick=async function(){
      try{ await doCmdImport('replace', cPendingCsv); }
      catch(e){ document.getElementById('cwarn-toast').textContent=e.message; }
    };`;

  return renderLayout({ title: 'BasecaBot — Commands', active: 'commands', body, script, wide: true });
}
