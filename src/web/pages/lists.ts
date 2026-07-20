import { renderLayout } from '../layout.js';
import { commandTableScript, commandModalsHtml, commandModalsScript } from './commandRow.js';

/**
 * Lists page — a master/detail view modeled on the Commands page. The left
 * sidebar lists every named list; selecting one shows its description +
 * permission and an entries table (# / entry / added by / date / actions).
 * Managers (mods+, subject to a list's own restriction) get "Edit List" and
 * "+ Add Entry" buttons plus per-row edit/delete; the "+ Add List" button in the
 * page head creates a new list.
 */
export function listsPage(): string {
  const body = /* html */ `
    <div class="page-head" style="display:flex; align-items:flex-end; justify-content:space-between; gap:1rem">
      <div>
        <h1>Lists</h1>
        <p class="muted" id="list-sub" style="margin:0; padding:0">Loading…</p>
      </div>
      <div class="rowline" style="flex:none; gap:.5rem; justify-content:flex-end">
        <button type="button" class="pink" id="new-list-btn" style="display:none">+ Add List</button>
        <button type="button" class="pink" id="l-import-btn" style="display:none">Import CSV</button>
        <button type="button" class="pink" id="l-export-btn" style="display:none">Export CSV</button>
      </div>
    </div>
    <div class="md-layout">
      <nav class="md-side card" id="list-side"></nav>
      <div class="md-col">
        <div class="md-main card" id="list-main"></div>
        <div class="card" id="list-refs" style="display:none"></div>
      </div>
    </div>

    <dialog id="list-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(38rem,94vw)">
      <h2 id="list-dlg-title" style="margin-top:0">New List</h2>
      <label class="muted">Reference name <span class="muted">(a single word, used as <code>!list</code> target)</span></label>
      <input type="text" id="list-name" maxlength="40" placeholder="e.g. quotes" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Display name <span class="muted">(optional, longer label)</span></label>
      <input type="text" id="list-display" maxlength="80" placeholder="e.g. Funny Quotes" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Description <span class="muted">(optional)</span></label>
      <input type="text" id="list-desc" maxlength="500" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Who can add entries</label>
      <div id="list-perm" class="radio-row" style="margin:.35rem 0 .8rem">
        <label><input type="radio" name="list-perm" value="0" /> Everyone</label>
        <label><input type="radio" name="list-perm" value="1" /> Subscriber</label>
        <label><input type="radio" name="list-perm" value="2" /> VIP</label>
        <label><input type="radio" name="list-perm" value="3" checked /> Moderator</label>
        <label><input type="radio" name="list-perm" value="4" /> Broadcaster</label>
        <label><input type="radio" name="list-perm" value="5" /> Admin</label>
      </div>
      <div class="toast err" id="list-toast"></div>
      <div class="rowline" style="justify-content:space-between; margin-top:.4rem">
        <button type="button" class="danger" id="list-delete" style="display:none">Delete list</button>
        <div class="rowline" style="justify-content:flex-end">
          <button type="button" class="secondary" id="list-cancel">Cancel</button>
          <button type="button" class="pink" id="list-save">Save</button>
        </div>
      </div>
    </dialog>

    <dialog id="entry-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(34rem,94vw)">
      <h2 id="entry-dlg-title" style="margin-top:0">Add Entry</h2>
      <label class="muted">Entry text</label>
      <input type="text" id="entry-text" maxlength="500" style="width:100%; margin:.35rem 0 .8rem" />
      <div class="toast err" id="entry-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="entry-cancel">Cancel</button>
        <button type="button" class="pink" id="entry-save">Save</button>
      </div>
    </dialog>

    <dialog id="ldel-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(30rem,94vw)">
      <h2 style="margin-top:0" id="del-title">Delete?</h2>
      <p class="muted" id="ldel-msg"></p>
      <div class="toast err" id="ldel-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="ldel-cancel">Cancel</button>
        <button type="button" class="pink" id="ldel-confirm">Delete</button>
      </div>
    </dialog>

    <dialog id="lexp-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(32rem,94vw)">
      <h2 style="margin-top:0">Export Lists to CSV</h2>
      <div class="radio-row" style="margin:.35rem 0 .8rem; flex-wrap:wrap">
        <label><input type="radio" name="lexp-scope" value="all" checked /> All lists</label>
        <label><input type="radio" name="lexp-scope" value="active" /> Active list only (<code id="lexp-active">—</code>)</label>
      </div>
      <div class="toast err" id="lexp-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="lexp-cancel">Cancel</button>
        <button type="button" class="pink" id="lexp-go">Export</button>
      </div>
    </dialog>

    <dialog id="limp-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(38rem,94vw)">
      <h2 style="margin-top:0">Import Lists from CSV</h2>
      <p class="muted" style="margin:.2rem 0 .8rem">Columns: <code>List, Display Name, Description, Permission, Created By, Created By ID, List Created At, List Updated At, Entry, Added By, Added By ID, Date Added</code>. <strong>Wipe &amp; replace all is a true backup restore</strong> — it preserves creator IDs and timestamps. A header row is optional.</p>
      <label class="muted">CSV file</label>
      <input type="file" id="limp-file" accept=".csv,text/csv" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Mode</label>
      <div style="display:flex; flex-direction:column; gap:.35rem; margin:.35rem 0 .8rem">
        <label><input type="radio" name="limp-mode" value="add" checked /> Add entries to the active list (<code id="limp-active">—</code>)</label>
        <label><input type="radio" name="limp-mode" value="replace" /> Wipe &amp; replace the active list's entries</label>
        <label><input type="radio" name="limp-mode" value="replace-all" /> Wipe &amp; replace ALL lists</label>
      </div>
      <div class="toast err" id="limp-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="limp-cancel">Cancel</button>
        <button type="button" class="pink" id="limp-go">Import</button>
      </div>
    </dialog>

    <dialog id="lwarn-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(32rem,94vw)">
      <h2 style="margin-top:0" id="lwarn-title">⚠️ Confirm wipe &amp; replace</h2>
      <p class="muted" id="lwarn-msg"></p>
      <div class="toast err" id="lwarn-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="lwarn-cancel">Cancel</button>
        <button type="button" class="danger" id="lwarn-confirm">Wipe &amp; replace</button>
      </div>
    </dialog>

    ${commandModalsHtml()}`;

  const script = `
    var state={ lists:[], commands:[], view:null, canManage:false, myLevel:0 };
    // Shared custom-command row/table formatting + edit/delete modals — the
    // "Commands Referencing …" table below reuses the exact rows AND the same
    // edit/delete/toggle behavior as the Commands page (see commandRow.ts).
    // Provides: customRow, customTableHtml, openEdit, openAliasEdit, delCommand, setEnabled, …
    ${commandTableScript()}
    ${commandModalsScript()}
    function fmtDate(iso){ try{ return new Date(iso).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }catch(e){ return ''; } }
    function levelFromRel(r){ if(!r) return 0; if(r.botAdmin) return 5; if(r.broadcaster) return 4; if(r.moderator) return 3; if(r.subscriber) return 1; return 0; }
    function current(){ return state.lists.filter(function(l){ return l.name===state.view; })[0] || null; }
    function canManageList(l){ return state.canManage && l && state.myLevel >= l.permission; }
    function canAddTo(l){ return l && state.myLevel >= l.permission; }

    // ── Commands referencing a list ────────────────────────────────────────────
    // The list reference names used in a $(list <name>) / $(list.n <name>) /
    // $(list.all <name>) variable within a string. Case-insensitive on the
    // keyword; a leading '!' on the name is stripped, mirroring normalizeListName.
    function listRefsIn(str){
      var out={}; if(!str) return out;
      // Char classes instead of backslash escapes: this whole script is a
      // template literal, which would eat regex backslashes before the browser
      // sees them. Matches $(list NAME) and $(list.SUB NAME).
      var re=/[$][(]list(?:[.][^ )]+)?[ ]+([^ )]+)/gi, m;
      while((m=re.exec(str))){ out[m[1].replace(/^!/,'').toLowerCase()]=true; }
      return out;
    }
    // Custom commands + aliases that reference the given list. An alias counts if
    // its own args reference the list, or the command it targets does.
    function commandsReferencing(name){
      name=String(name).toLowerCase();
      var targets={};
      state.commands.forEach(function(c){ if(c.kind==='trigger'||c.kind==='phrase') targets[String(c.name).toLowerCase()]=c; });
      return state.commands.filter(function(c){
        if(c.kind==='alias'){
          if(listRefsIn(c.args)[name]) return true;
          var t=c.target?targets[String(c.target).toLowerCase()]:null;
          return !!(t && listRefsIn(t.response)[name]);
        }
        if(c.kind==='builtin') return false; // built-ins have no editable response to scan
        return !!listRefsIn(c.response)[name];
      }).sort(function(a,b){ return String(a.name).localeCompare(String(b.name)); });
    }

    // Populate the separate "Commands Referencing …" panel using the SHARED
    // command-row rendering, so it matches the Commands page exactly. Each row's
    // __i indexes state.refCmds, which the panel's wiring resolves back.
    function renderRefs(){
      var panel=document.getElementById('list-refs');
      var l=current();
      state.refCmds=l?commandsReferencing(l.name):[];
      // Only shown when a list is selected AND something references it.
      if(!l || !state.refCmds.length){ panel.style.display='none'; panel.innerHTML=''; return; }
      var title=(l.displayName && l.displayName.trim()) || l.name;
      for(var i=0;i<state.refCmds.length;i++) state.refCmds[i].__i=i;
      panel.style.display='';
      panel.innerHTML='<h2 style="margin-top:0">Commands Referencing '+esc(title)+' <span class="count">('+state.refCmds.length+')</span></h2>'
        +customTableHtml(state.refCmds, 'No commands reference this list.');
      wireRefs(panel);
      wireCopy(panel);
    }

    // Toggle + edit + delete all use the SHARED command modals, so they behave
    // exactly as on the Commands page. load() reloads lists+commands and
    // re-renders (which repaints this panel via renderRefs).
    function wireRefs(panel){
      var q=function(sel,fn){ Array.prototype.forEach.call(panel.querySelectorAll(sel), fn); };
      var at=function(b,name){ return state.refCmds[+b.getAttribute(name)]; };
      q('input[data-toggle]', function(b){ b.onchange=function(){ setEnabled(at(b,'data-toggle'), load, renderRefs); }; });
      q('button[data-edit]', function(b){ b.onclick=function(){ openEdit(at(b,'data-edit'), load); }; });
      q('button[data-aedit]', function(b){ b.onclick=function(){ openAliasEdit(at(b,'data-aedit'), load); }; });
      q('button[data-del]', function(b){ b.onclick=function(){ delCommand(at(b,'data-del'), load); }; });
    }

    window.onMe=function(me){
      var rel = me && me.relationship;
      state.canManage = !!(rel && (rel.moderator || rel.broadcaster || rel.botAdmin));
      state.myLevel = levelFromRel(rel);
      load();
    };
    async function load(){
      try{
        var d=await api('GET','/api/lists'); state.lists=(d.lists||[]).slice();
        // Commands are fetched to show which reference each list; a failure here
        // must not stop the lists themselves from rendering.
        try{ state.commands=((await api('GET','/api/commands')).commands)||[]; }catch(_e){ state.commands=[]; }
        if(!state.lists.some(function(l){ return l.name===state.view; })) state.view = state.lists.length ? state.lists[0].name : null;
        var n=state.lists.length;
        document.getElementById('list-sub').textContent = n+' list'+(n===1?'':'s')+'.'+(state.canManage?' You can manage lists.':'');
        document.getElementById('new-list-btn').style.display = state.canManage ? '' : 'none';
        document.getElementById('l-import-btn').style.display = state.canManage ? '' : 'none';
        document.getElementById('l-export-btn').style.display = state.canManage ? '' : 'none';
        renderSide(); renderMain();
      }catch(e){ document.getElementById('list-sub').textContent='Could not load lists: '+e.message; }
    }

    function renderSide(){
      var side=document.getElementById('list-side');
      if(!state.lists.length){ side.innerHTML='<div class="label">Lists</div><p class="muted" style="padding:.2rem .2rem">None yet.</p>'; return; }
      var html='<div class="label">Lists</div>'+state.lists.map(function(l){
        var title = (l.displayName && l.displayName.trim()) || l.name;
        return '<button class="item'+(state.view===l.name?' active':'')+'" data-list="'+esc(l.name)+'">'+esc(title)+' <span class="count">'+l.entries.length+'</span></button>';
      }).join('');
      side.innerHTML=html;
      Array.prototype.forEach.call(side.querySelectorAll('button[data-list]'), function(b){
        b.onclick=function(){ state.view=b.getAttribute('data-list'); renderSide(); renderMain(); };
      });
    }

    function renderMain(){
      renderRefs(); // keep the referencing-commands panel in step with the selection
      var main=document.getElementById('list-main');
      if(!state.lists.length){
        main.innerHTML='<p class="muted">No lists yet.'+(state.canManage?' Use <strong>+ Add List</strong> above, or <code>!list new &lt;name&gt;</code> in chat.':'')+'</p>';
        return;
      }
      var l=current(); if(!l){ main.innerHTML='<p class="muted">Select a list.</p>'; return; }
      var title=(l.displayName && l.displayName.trim()) || l.name;
      var meta='<span class="tag">Add access: '+esc(accessLabel(l.permission))+'+</span>';
      if(l.createdByName) meta+=' <span class="muted">· created by '+esc(l.createdByName)+(l.createdAt?' on '+esc(fmtDate(l.createdAt)):'')+'</span>';
      var btns='';
      if(canManageList(l)) btns+='<button type="button" class="pink" id="edit-list-btn">Edit List</button>';
      if(canAddTo(l)) btns+='<button type="button" class="pink" id="add-entry-btn">+ Add Entry</button>';

      var head='<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; margin-bottom:1rem">'
        +'<div><h2 style="margin:0 0 .35rem">'+esc(title)+' <span class="ref-name">('+esc(l.name)+')</span></h2>'
        +'<p class="muted" style="margin:.15rem 0 .5rem">'+(l.description?esc(l.description):'<em>No description.</em>')+'</p>'+meta+'</div>'
        +'<div class="rowline" style="flex:none; justify-content:flex-end">'+btns+'</div></div>';

      var manage=canManageList(l);
      var rows=l.entries.map(function(en, i){
        var actions='';
        if(manage){
          actions='<div class="actions-cell">'
            +'<button class="secondary icon-btn" data-edit="'+en.id+'" title="Edit">'+icon('pencil')+'</button>'
            +'<button class="danger icon-btn" data-del="'+en.id+'" title="Delete">'+icon('trash-2')+'</button></div>';
        } else { actions='<span class="muted">—</span>'; }
        return '<tr><td>'+(i+1)+'</td><td class="wrap">'+esc(en.text)+'</td><td>'+esc(en.addedByName||'—')+'</td><td class="muted">'+esc(fmtDate(en.addedAt))+'</td><td class="col-actions">'+actions+'</td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">No entries yet.'+(canAddTo(l)?' Add one with <strong>+ Add Entry</strong>.':'')+'</td></tr>';

      main.innerHTML=head+'<div style="overflow-x:auto"><table><thead><tr><th style="width:1%">#</th><th class="wrap">Entry</th><th>Added by</th><th>Date added</th><th class="col-actions">Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>';

      var eb=document.getElementById('edit-list-btn'); if(eb) eb.onclick=function(){ openEditList(l); };
      var ab=document.getElementById('add-entry-btn'); if(ab) ab.onclick=function(){ openAddEntry(l); };
      Array.prototype.forEach.call(main.querySelectorAll('button[data-edit]'), function(b){ b.onclick=function(){ openEditEntry(l, +b.getAttribute('data-edit')); }; });
      Array.prototype.forEach.call(main.querySelectorAll('button[data-del]'), function(b){ b.onclick=function(){ askDeleteEntry(l, +b.getAttribute('data-del')); }; });
    }

    // ── List create/edit dialog ──────────────────────────────────────────────
    var listDlg=document.getElementById('list-dlg');
    var listMode='create'; // 'create' | 'edit'
    var editingListName=null;
    function setPermRadio(v){ Array.prototype.forEach.call(document.querySelectorAll('input[name=list-perm]'), function(r){ r.checked=(+r.value===(v||0)); }); }
    function getPermRadio(){ var el=document.querySelector('input[name=list-perm]:checked'); return el?+el.value:0; }
    function openNewList(){
      listMode='create'; editingListName=null;
      document.getElementById('list-dlg-title').textContent='New List';
      document.getElementById('list-name').value='';
      document.getElementById('list-display').value='';
      document.getElementById('list-desc').value='';
      setPermRadio(3);
      document.getElementById('list-delete').style.display='none';
      document.getElementById('list-toast').textContent='';
      document.getElementById('list-save').textContent='Create';
      if(listDlg.showModal) listDlg.showModal(); else listDlg.setAttribute('open','');
      document.getElementById('list-name').focus();
    }
    function openEditList(l){
      listMode='edit'; editingListName=l.name;
      document.getElementById('list-dlg-title').textContent='Edit List';
      document.getElementById('list-name').value=l.name;
      document.getElementById('list-display').value=l.displayName||'';
      document.getElementById('list-desc').value=l.description||'';
      setPermRadio(l.permission||0);
      document.getElementById('list-delete').style.display='';
      document.getElementById('list-toast').textContent='';
      document.getElementById('list-save').textContent='Save';
      if(listDlg.showModal) listDlg.showModal(); else listDlg.setAttribute('open','');
    }
    document.getElementById('list-delete').onclick=function(){
      var l=current(); if(!l) return;
      listDlg.close?listDlg.close():listDlg.removeAttribute('open');
      askDeleteList(l);
    };
    document.getElementById('new-list-btn').onclick=openNewList;
    document.getElementById('list-cancel').onclick=function(){ listDlg.close?listDlg.close():listDlg.removeAttribute('open'); };
    document.getElementById('list-save').onclick=async function(){
      var name=document.getElementById('list-name').value.trim();
      var display=document.getElementById('list-display').value;
      var desc=document.getElementById('list-desc').value;
      var perm=getPermRadio();
      if(!name){ document.getElementById('list-toast').textContent='Enter a reference name.'; return; }
      try{
        if(listMode==='create'){
          await api('POST','/api/lists/create',{ name:name, displayName:display, description:desc, permission:perm });
          state.view=name.toLowerCase().replace(/^!/,'');
        } else {
          await api('POST','/api/lists/update',{ name:editingListName, newName:name, displayName:display, description:desc, permission:perm });
          state.view=name.toLowerCase().replace(/^!/,'');
        }
        listDlg.close?listDlg.close():listDlg.removeAttribute('open');
        await load();
      }catch(e){ document.getElementById('list-toast').textContent=e.message; }
    };

    // ── Entry add/edit dialog ────────────────────────────────────────────────
    var entryDlg=document.getElementById('entry-dlg');
    var entryMode='add'; var entryListName=null; var entryId=null;
    function openAddEntry(l){
      entryMode='add'; entryListName=l.name; entryId=null;
      document.getElementById('entry-dlg-title').textContent='Add Entry';
      document.getElementById('entry-text').value='';
      document.getElementById('entry-toast').textContent='';
      if(entryDlg.showModal) entryDlg.showModal(); else entryDlg.setAttribute('open','');
      document.getElementById('entry-text').focus();
    }
    function openEditEntry(l, id){
      var en=l.entries.filter(function(x){ return x.id===id; })[0]; if(!en) return;
      entryMode='edit'; entryListName=l.name; entryId=id;
      document.getElementById('entry-dlg-title').textContent='Edit Entry';
      document.getElementById('entry-text').value=en.text;
      document.getElementById('entry-toast').textContent='';
      if(entryDlg.showModal) entryDlg.showModal(); else entryDlg.setAttribute('open','');
      document.getElementById('entry-text').focus();
    }
    document.getElementById('entry-cancel').onclick=function(){ entryDlg.close?entryDlg.close():entryDlg.removeAttribute('open'); };
    document.getElementById('entry-text').onkeydown=function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); document.getElementById('entry-save').click(); } };
    document.getElementById('entry-save').onclick=async function(){
      var text=document.getElementById('entry-text').value;
      if(!text.trim()){ document.getElementById('entry-toast').textContent='Enter some text.'; return; }
      try{
        if(entryMode==='add') await api('POST','/api/lists/entries/add',{ list:entryListName, text:text });
        else await api('POST','/api/lists/entries/update',{ list:entryListName, id:entryId, text:text });
        entryDlg.close?entryDlg.close():entryDlg.removeAttribute('open');
        await load();
      }catch(e){ document.getElementById('entry-toast').textContent=e.message; }
    };

    // ── Delete dialog (list or entry) ────────────────────────────────────────
    var lDelDlg=document.getElementById('ldel-dlg');
    var delKind=null; var delListName=null; var delEntryId=null;
    function askDeleteList(l){
      delKind='list'; delListName=l.name; delEntryId=null;
      document.getElementById('del-title').textContent='Delete list?';
      document.getElementById('ldel-msg').textContent='This permanently deletes "'+((l.displayName&&l.displayName.trim())||l.name)+'" and all '+l.entries.length+' of its entries.';
      document.getElementById('ldel-toast').textContent='';
      if(lDelDlg.showModal) lDelDlg.showModal(); else lDelDlg.setAttribute('open','');
    }
    function askDeleteEntry(l, id){
      delKind='entry'; delListName=l.name; delEntryId=id;
      document.getElementById('del-title').textContent='Delete entry?';
      document.getElementById('ldel-msg').textContent='This permanently removes the entry from "'+((l.displayName&&l.displayName.trim())||l.name)+'".';
      document.getElementById('ldel-toast').textContent='';
      if(lDelDlg.showModal) lDelDlg.showModal(); else lDelDlg.setAttribute('open','');
    }
    document.getElementById('ldel-cancel').onclick=function(){ lDelDlg.close?lDelDlg.close():lDelDlg.removeAttribute('open'); };
    document.getElementById('ldel-confirm').onclick=async function(){
      try{
        if(delKind==='list') await api('POST','/api/lists/delete',{ name:delListName });
        else await api('POST','/api/lists/entries/delete',{ list:delListName, id:delEntryId });
        lDelDlg.close?lDelDlg.close():lDelDlg.removeAttribute('open');
        if(delKind==='list') state.view=null;
        await load();
      }catch(e){ document.getElementById('ldel-toast').textContent='Delete failed: '+e.message; }
    };

    // ── CSV export/import ───────────────────────────────────────────────────────
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

    // Export (scope: all vs active list)
    var expDlg=document.getElementById('lexp-dlg');
    document.getElementById('l-export-btn').onclick=function(){
      var activeEl=document.querySelector('input[name=lexp-scope][value=active]');
      document.getElementById('lexp-active').textContent = state.view || '—';
      if(activeEl) activeEl.disabled = !state.view;
      var allEl=document.querySelector('input[name=lexp-scope][value=all]'); if(allEl) allEl.checked=true;
      document.getElementById('lexp-toast').textContent='';
      if(expDlg.showModal) expDlg.showModal(); else expDlg.setAttribute('open','');
    };
    document.getElementById('lexp-cancel').onclick=function(){ expDlg.close?expDlg.close():expDlg.removeAttribute('open'); };
    document.getElementById('lexp-go').onclick=async function(){
      var scopeEl=document.querySelector('input[name=lexp-scope]:checked'); var scope=scopeEl?scopeEl.value:'all';
      var qs = scope==='active' ? ('?scope=active&list='+encodeURIComponent(state.view||'')) : '?scope=all';
      try{
        var res=await fetch('/api/lists/export'+qs,{ credentials:'same-origin' });
        if(!res.ok) throw new Error('HTTP '+res.status);
        downloadCsv(scope==='active'&&state.view ? state.view+'.csv' : 'lists.csv', await res.text());
        expDlg.close?expDlg.close():expDlg.removeAttribute('open');
      }catch(e){ document.getElementById('lexp-toast').textContent='Export failed: '+e.message; }
    };

    // Import (add / replace-current / replace-all)
    var limpDlg=document.getElementById('limp-dlg');
    var lwarnDlg=document.getElementById('lwarn-dlg');
    var lPendingCsv='';
    function limpMode(){ var el=document.querySelector('input[name=limp-mode]:checked'); return el?el.value:'add'; }
    document.getElementById('l-import-btn').onclick=function(){
      document.getElementById('limp-file').value='';
      document.getElementById('limp-active').textContent = state.view || '(none selected)';
      var add=document.querySelector('input[name=limp-mode][value=add]'); if(add) add.checked=true;
      // current-list modes need an active list selected
      var needActive=!state.view;
      document.querySelector('input[name=limp-mode][value=add]').disabled=needActive;
      document.querySelector('input[name=limp-mode][value=replace]').disabled=needActive;
      if(needActive){ var ra=document.querySelector('input[name=limp-mode][value=replace-all]'); if(ra) ra.checked=true; }
      document.getElementById('limp-toast').textContent='';
      if(limpDlg.showModal) limpDlg.showModal(); else limpDlg.setAttribute('open','');
    };
    document.getElementById('limp-cancel').onclick=function(){ limpDlg.close?limpDlg.close():limpDlg.removeAttribute('open'); };
    async function doListImport(mode, csv){
      var body={ mode:mode, csv:csv }; if(mode!=='replace-all') body.list=state.view;
      var d=await api('POST','/api/lists/import', body);
      limpDlg.close?limpDlg.close():limpDlg.removeAttribute('open');
      lwarnDlg.close?lwarnDlg.close():lwarnDlg.removeAttribute('open');
      if(mode==='replace-all') state.view=null;
      await load();
      var sub=document.getElementById('list-sub');
      var msg = mode==='replace-all' ? ('Replaced all lists ('+d.lists+').') : ((mode==='replace'?'Replaced entries — ':'Imported ')+d.added+' entr'+(d.added===1?'y':'ies')+'.');
      sub.textContent = msg+' '+sub.textContent;
    }
    document.getElementById('limp-go').onclick=async function(){
      try{
        var mode=limpMode();
        if((mode==='add'||mode==='replace') && !state.view){ document.getElementById('limp-toast').textContent='Select a list first (left panel) for current-list modes.'; return; }
        lPendingCsv=await readFileText(document.getElementById('limp-file'));
        if(mode==='replace' || mode==='replace-all'){
          document.getElementById('lwarn-title').textContent = mode==='replace-all' ? '⚠️ Wipe & replace ALL lists?' : '⚠️ Wipe & replace this list?';
          document.getElementById('lwarn-msg').innerHTML = mode==='replace-all'
            ? 'This permanently deletes <strong>every list and all their entries</strong>, then rebuilds them from your CSV. This cannot be undone.'
            : 'This permanently deletes all entries in <strong>'+esc(state.view)+'</strong> and replaces them with your CSV. This cannot be undone.';
          document.getElementById('lwarn-confirm').setAttribute('data-mode', mode);
          document.getElementById('lwarn-toast').textContent='';
          if(lwarnDlg.showModal) lwarnDlg.showModal(); else lwarnDlg.setAttribute('open','');
          return;
        }
        await doListImport('add', lPendingCsv);
      }catch(e){ document.getElementById('limp-toast').textContent=e.message; }
    };
    document.getElementById('lwarn-cancel').onclick=function(){ lwarnDlg.close?lwarnDlg.close():lwarnDlg.removeAttribute('open'); };
    document.getElementById('lwarn-confirm').onclick=async function(){
      try{ await doListImport(document.getElementById('lwarn-confirm').getAttribute('data-mode'), lPendingCsv); }
      catch(e){ document.getElementById('lwarn-toast').textContent=e.message; }
    };`;

  return renderLayout({ title: 'BasecaBot — Lists', active: 'lists', body, script, wide: true });
}
