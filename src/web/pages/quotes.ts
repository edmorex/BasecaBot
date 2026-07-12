import { renderLayout } from '../layout.js';

/**
 * Quotes page — a single searchable table (no sidebar), modeled on the Commands
 * page's look. The page head carries a live search box (in place of a "New"
 * button) that filters the list; managers (mods+) get per-row Edit/Delete.
 * Columns: ID / Quote / User / Game / Date / Quoted By / Actions.
 */
export function quotesPage(): string {
  const body = /* html */ `
    <div class="page-head" style="display:flex; align-items:flex-end; justify-content:space-between; gap:1rem">
      <div>
        <h1>Quotes</h1>
        <p class="muted" id="quote-sub" style="margin:0; padding:0">Loading…</p>
      </div>
      <input type="text" id="quote-search" placeholder="Search quotes…" style="flex:none; width:min(22rem,46vw)" />
    </div>
    <div class="card" id="quote-card"><div class="md-main" id="quote-main"></div></div>
    <div class="pager-wrap" id="quote-pager"></div>

    <dialog id="qedit-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(38rem,94vw)">
      <h2 style="margin-top:0">Edit Quote <code id="qedit-id"></code></h2>
      <label class="muted">Quote text</label>
      <input type="text" id="qedit-text" maxlength="500" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">User <span class="muted">(without @)</span></label>
      <input type="text" id="qedit-user" maxlength="80" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Game <span class="muted">(blank = none)</span></label>
      <input type="text" id="qedit-game" maxlength="120" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Date <span class="muted">(YYYY MM DD)</span></label>
      <input type="text" id="qedit-date" maxlength="20" placeholder="2024 01 31" style="width:100%; margin:.35rem 0 .8rem" />
      <div class="toast err" id="qedit-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="qedit-cancel">Cancel</button>
        <button type="button" class="pink" id="qedit-save">Save</button>
      </div>
    </dialog>

    <dialog id="qdel-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(30rem,94vw)">
      <h2 style="margin-top:0">Delete quote <code id="qdel-id"></code>?</h2>
      <p class="muted" id="qdel-msg"></p>
      <div class="toast err" id="qdel-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="qdel-cancel">Cancel</button>
        <button type="button" class="pink" id="qdel-confirm">Delete</button>
      </div>
    </dialog>`;

  const script = `
    var PAGE_SIZE=50;
    var state={ quotes:[], filter:'', page:0, showAll:false, canManage:false };
    var ICONS={
      'pencil':'<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/><path d="m15 5 4 4"/>',
      'trash-2':'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
    };
    function icon(name, size){ size=size||16; return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+ICONS[name]+'</svg>'; }
    function fmtDate(d){ return d ? esc(String(d).replace(/-/g,'/')) : '<span class="muted">—</span>'; }
    function haystack(q){ return (q.id+' '+q.text+' '+q.user+' '+(q.game||'')+' '+(q.date||'')+' '+(q.quotedByName||'')).toLowerCase(); }
    function filtered(){
      var f=state.filter.trim().toLowerCase();
      if(!f) return state.quotes;
      return state.quotes.filter(function(q){ return haystack(q).indexOf(f)>=0; });
    }

    window.onMe=function(me){
      state.canManage=!!(me && me.relationship && (me.relationship.moderator || me.relationship.broadcaster || me.relationship.botAdmin));
      load();
    };
    async function load(){
      try{
        var d=await api('GET','/api/quotes'); state.quotes=(d.quotes||[]).slice();
        for(var i=0;i<state.quotes.length;i++) state.quotes[i].__i=i;
        var n=state.quotes.length;
        document.getElementById('quote-sub').textContent = n+' quote'+(n===1?'':'s')+'.'+(state.canManage?' You can edit quotes.':'');
        render();
      }catch(e){ document.getElementById('quote-sub').textContent='Could not load quotes: '+e.message; }
    }

    function render(){
      var main=document.getElementById('quote-main');
      var list=filtered();
      var total=list.length;
      var paginate=total>PAGE_SIZE && !state.showAll;
      if(state.page*PAGE_SIZE>=total) state.page=0;
      var rows=paginate ? list.slice(state.page*PAGE_SIZE, state.page*PAGE_SIZE+PAGE_SIZE) : list;
      var dis=state.canManage?'':' disabled';
      var body=rows.map(function(q){
        var actions='<td class="col-actions"><div class="actions-cell">'
          +'<button class="secondary icon-btn" data-edit="'+q.__i+'"'+dis+' title="Edit">'+icon('pencil')+'</button>'
          +'<button class="danger icon-btn" data-del="'+q.__i+'"'+dis+' title="Delete">'+icon('trash-2')+'</button></div></td>';
        return '<tr>'
          +'<td>'+q.id+'</td>'
          +'<td class="wrap">'+esc(q.text)+'</td>'
          +'<td>@'+esc(q.user)+'</td>'
          +'<td>'+(q.game?esc(q.game):'<span class="muted">—</span>')+'</td>'
          +'<td>'+fmtDate(q.date)+'</td>'
          +'<td class="muted">'+esc(q.quotedByName||'—')+'</td>'
          +actions+'</tr>';
      }).join('') || '<tr><td colspan="7" class="muted">'+(state.filter?'No quotes match your search.':'No quotes yet. Add one in chat with <code>!quote add</code>.')+'</td></tr>';
      main.innerHTML='<div style="overflow-x:auto"><table>'
        +'<thead><tr><th style="width:1%">ID</th><th class="wrap">Quote</th><th>User</th><th>Game</th><th>Date</th><th>Quoted By</th><th class="col-actions">Actions</th></tr></thead>'
        +'<tbody>'+body+'</tbody></table></div>';
      var q=function(sel,fn){ Array.prototype.forEach.call(main.querySelectorAll(sel), fn); };
      q('button[data-edit]', function(b){ b.onclick=function(){ openEdit(+b.getAttribute('data-edit')); }; });
      q('button[data-del]', function(b){ b.onclick=function(){ askDelete(+b.getAttribute('data-del')); }; });
      renderPager(total);
    }

    function pageList(cur, total){
      if(total<=7){ var a=[]; for(var i=1;i<=total;i++) a.push(i); return a; }
      if(cur<=4) return [1,2,3,4,5,'...',total];
      if(cur>=total-3) return [1,'...',total-4,total-3,total-2,total-1,total];
      return [1,'...',cur-1,cur,cur+1,'...',total];
    }
    function renderPager(total){
      var wrap=document.getElementById('quote-pager');
      if(total<=PAGE_SIZE){ wrap.innerHTML=''; return; }
      if(state.showAll){
        wrap.innerHTML='<span class="muted">Showing all '+total+'</span><button class="linkish" data-collapse>Paginate</button>';
        wrap.querySelector('[data-collapse]').onclick=function(){ state.showAll=false; state.page=0; render(); };
        return;
      }
      var pages=Math.ceil(total/PAGE_SIZE);
      var cur=state.page+1;
      var box=function(cls, lbl, page){ return '<div class="pg'+(cls?' '+cls:'')+'"'+(page?' data-page="'+page+'"':'')+'>'+lbl+'</div>'; };
      var s=box(cur<=1?'disabled':'', '&lt;', cur>1?cur-1:0);
      pageList(cur, pages).forEach(function(p){ s += p==='...' ? box('ellipsis','…',0) : box(p===cur?'current':'', String(p), p); });
      s += box(cur>=pages?'disabled':'', '&gt;', cur<pages?cur+1:0);
      wrap.innerHTML='<div class="pager">'+s+'</div><button class="linkish" data-showall>Show all ('+total+')</button>';
      Array.prototype.forEach.call(wrap.querySelectorAll('.pg[data-page]'), function(b){ b.onclick=function(){ state.page=(+b.getAttribute('data-page'))-1; render(); }; });
      wrap.querySelector('[data-showall]').onclick=function(){ state.showAll=true; render(); };
    }

    var searchBox=document.getElementById('quote-search');
    searchBox.oninput=function(){ state.filter=searchBox.value; state.page=0; render(); };

    // ── Edit ──────────────────────────────────────────────────────────────────
    var editDlg=document.getElementById('qedit-dlg');
    var editing=null;
    function openEdit(i){
      var q=state.quotes[i]; if(!q) return; editing=q;
      document.getElementById('qedit-id').textContent=q.id;
      document.getElementById('qedit-text').value=q.text||'';
      document.getElementById('qedit-user').value=q.user||'';
      document.getElementById('qedit-game').value=q.game||'';
      document.getElementById('qedit-date').value=q.date||'';
      document.getElementById('qedit-toast').textContent='';
      if(editDlg.showModal) editDlg.showModal(); else editDlg.setAttribute('open','');
    }
    document.getElementById('qedit-cancel').onclick=function(){ editDlg.close?editDlg.close():editDlg.removeAttribute('open'); };
    document.getElementById('qedit-save').onclick=async function(){
      if(!editing) return;
      var payload={ id:editing.id,
        text:document.getElementById('qedit-text').value,
        user:document.getElementById('qedit-user').value,
        game:document.getElementById('qedit-game').value,
        date:document.getElementById('qedit-date').value };
      try{ await api('POST','/api/quotes/update', payload); editDlg.close?editDlg.close():editDlg.removeAttribute('open'); await load(); }
      catch(e){ document.getElementById('qedit-toast').textContent=e.message; }
    };

    // ── Delete ────────────────────────────────────────────────────────────────
    var delDlg=document.getElementById('qdel-dlg');
    var deleting=null;
    function askDelete(i){
      var q=state.quotes[i]; if(!q) return; deleting=q;
      document.getElementById('qdel-id').textContent=q.id;
      document.getElementById('qdel-msg').textContent='This permanently removes: "'+q.text+'"';
      document.getElementById('qdel-toast').textContent='';
      if(delDlg.showModal) delDlg.showModal(); else delDlg.setAttribute('open','');
    }
    document.getElementById('qdel-cancel').onclick=function(){ delDlg.close?delDlg.close():delDlg.removeAttribute('open'); };
    document.getElementById('qdel-confirm').onclick=async function(){
      if(!deleting) return;
      try{ await api('POST','/api/quotes/delete',{ id:deleting.id }); delDlg.close?delDlg.close():delDlg.removeAttribute('open'); await load(); }
      catch(e){ document.getElementById('qdel-toast').textContent='Delete failed: '+e.message; }
    };`;

  return renderLayout({ title: 'BasecaBot — Quotes', active: 'quotes', body, script, wide: true });
}
