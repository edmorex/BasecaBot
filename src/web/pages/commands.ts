import { renderLayout } from '../layout.js';
import { commandTableScript, commandModalsHtml, commandModalsScript } from './commandRow.js';

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
      <div class="md-col">
        <div class="md-main card" id="cmd-main"></div>
        <div class="card" id="cmd-aliases" style="display:none"></div>
      </div>
    </div>
    <div class="pager-wrap" id="cmd-pager"></div>

    ${commandModalsHtml()}

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

`;

  const script = `
    var PAGE_SIZE=50;
    // view: 'all' (all customs) | 'group:<name>' (a custom group) | 'plugin:<name>'
    var state={ groups:[], customs:[], customGroups:[], page:0, showAll:false, canManage:false, view:'all' };
    // Shared custom-command row/table formatting + edit/delete modals (see
    // commandRow.ts) — the same code renders the "Commands Referencing …" table
    // and drives its edit/delete actions on the Lists page.
    ${commandTableScript()}
    ${commandModalsScript()}
    function pretty(g){ return String(g||'other').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/^./,function(m){return m.toUpperCase();}); }
    function byName(a,b){ return a.name.localeCompare(b.name); }

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
        renderBuiltinAliases(sec); // second panel: aliases pointing at these built-ins
        return;
      }
      hideAliasPanel(); // custom views already list aliases inline
      main.innerHTML=customView(); wireCustom(); wireCopy(main); renderPager();
    }

    function hideAliasPanel(){ var p=document.getElementById('cmd-aliases'); p.style.display='none'; p.innerHTML=''; }

    // A second card listing the custom aliases that target the built-in commands
    // in this plugin group (e.g. !addme -> !wheel add $(sender)). Uses the SHARED
    // rows, so each is editable/deletable/toggleable exactly like a custom row.
    function renderBuiltinAliases(sec){
      if(!sec){ hideAliasPanel(); return; }
      var names={}; sec.cmds.forEach(function(c){ names[c.name]=true; });
      var aliases=state.customs.filter(function(c){ return c.kind==='alias' && names[c.target]; });
      if(!aliases.length){ hideAliasPanel(); return; }
      var panel=document.getElementById('cmd-aliases');
      panel.style.display='';
      panel.innerHTML='<h2 style="margin-top:0">Aliases for '+esc(pretty(sec.group))+' <span class="count">('+aliases.length+')</span></h2>'
        +customTableHtml(aliases, 'No aliases.');
      wireCommandRows(panel); wireCopy(panel);
    }

    function builtinView(sec){
      var rows=sec.cmds.map(function(c){
        return '<tr><td>'+nameCell(c)+'</td><td>'+esc(accessLabel(c.access))+'</td><td>'+cdCell(c)+'</td><td class="muted">'+esc(c.description||'')+'</td></tr>';
      }).join('');
      return '<h2>'+esc(pretty(sec.group))+' <span class="count">('+sec.cmds.length+' command'+(sec.cmds.length===1?'':'s')+')</span></h2>'
        +'<div style="overflow-x:auto"><table class="cmd-builtins"><thead><tr><th>Command</th><th>Access</th><th>Cooldown</th><th>Description</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }

    function customView(){
      var list=currentCustoms();
      var total=list.length;
      var paginate=total>PAGE_SIZE && !state.showAll;
      var rows=paginate ? list.slice(state.page*PAGE_SIZE, state.page*PAGE_SIZE+PAGE_SIZE) : list;
      var title = state.view.indexOf('group:')===0 ? esc(state.view.slice(6)) : 'All Custom Commands';
      return '<h2>'+title+' <span class="count">('+total+')</span></h2>'
        +customTableHtml(rows, 'No custom commands here. Add one in chat with <code>!command add</code>.');
    }

    // Wire the shared row controls within an element (used by both the main
    // custom table and the aliases panel). Rows carry __i = index into state.customs.
    function wireCommandRows(root){
      var q=function(sel,fn){ Array.prototype.forEach.call(root.querySelectorAll(sel), fn); };
      q('button[data-edit]', function(b){ b.onclick=function(){ openEdit(state.customs[+b.getAttribute('data-edit')], load); }; });
      q('button[data-aedit]', function(b){ b.onclick=function(){ openAliasEdit(state.customs[+b.getAttribute('data-aedit')], load); }; });
      q('input[data-toggle]', function(b){ b.onchange=function(){ setEnabled(state.customs[+b.getAttribute('data-toggle')], load, renderMain); }; });
      q('button[data-del]', function(b){ b.onclick=function(){ delCommand(state.customs[+b.getAttribute('data-del')], load); }; });
    }
    function wireCustom(){ wireCommandRows(document.getElementById('cmd-main')); }

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

    // The + New Command / + Add Alias buttons open the shared modals; load() reloads on success.
    document.getElementById('new-cmd-btn').onclick=function(){ openNew(load); };
    document.getElementById('new-alias-btn').onclick=function(){ openNewAlias(load); };

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
