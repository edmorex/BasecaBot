/**
 * Shared client-side rendering for a row of the custom-commands table.
 *
 * Both the Commands page and the Lists page ("Commands Referencing …") inline
 * this same JS, so the two tables are byte-for-byte identical and editing a row
 * here changes both at once. It provides the FORMATTING only (row/table HTML,
 * pills, icons, click-to-copy); each page supplies its own WIRING for what the
 * toggle/edit/delete buttons do, since those differ (the Lists page has no
 * command-edit modals of its own).
 *
 * Contract with the host page's script:
 *   - `window.esc` exists (from the layout shell).
 *   - a `state` object exists with a boolean `canManage`.
 *   - each command object carries `__i`, an index the page's wiring resolves
 *     back to the command (via the data-toggle / data-edit / data-del attrs).
 *
 * Not itself a template literal at the call site: the returned string is spliced
 * in as a runtime value, so it is not re-processed by the host page's template
 * literal.
 */
export function commandTableScript(): string {
  return `
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
    function groupCell(c){ return c.group ? '<span class="tag">'+esc(c.group)+'</span>' : '<span class="muted">—</span>'; }
    function cdCell(c){
      return '<span class="cd-cell">'
        +'<span class="tag" title="Global cooldown (s)">'+icon('globe',12)+(c.globalCooldown||0)+'</span>'
        +'<span class="tag" title="User cooldown (s)">'+icon('user-round',12)+(c.userCooldown||0)+'</span></span>';
    }

    var CUSTOM_TABLE_HEAD='<tr><th class="col-toggle"></th><th>Command</th><th>Type</th><th>Access</th><th>Uses</th><th>Cooldown</th><th class="wrap">Response</th><th>Group</th><th class="col-actions">Actions</th></tr>';

    function customRow(c){
      // Always render controls so the column layout is identical for everyone;
      // non-managers just see them disabled.
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

    // Full table (header + rows) for a set of command objects. \`emptyMsg\` is raw HTML.
    function customTableHtml(cmds, emptyMsg){
      var b=cmds.map(customRow).join('') || '<tr><td colspan="9" class="muted">'+emptyMsg+'</td></tr>';
      return '<div style="overflow-x:auto"><table><thead>'+CUSTOM_TABLE_HEAD+'</thead><tbody>'+b+'</tbody></table></div>';
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
  `;
}

/**
 * Shared modal HTML for creating/editing/deleting a custom command or alias.
 * Included in the body of any page that hosts command rows (Commands, Lists), so
 * the edit/delete actions work in place. IDs are un-prefixed here but internal
 * helpers in the script are `cm`-prefixed to avoid clashing with a host page's
 * own dialogs.
 */
export function commandModalsHtml(): string {
  const dlg = 'style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px;';
  return /* html */ `
    <dialog id="edit-dlg" ${dlg} width:min(38rem,94vw)">
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

    <dialog id="del-dlg" ${dlg} width:min(30rem,94vw)">
      <h2 style="margin-top:0">Delete <code id="del-name"></code>?</h2>
      <p class="muted" id="del-msg"></p>
      <div class="toast err" id="del-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="del-cancel">Cancel</button>
        <button type="button" class="pink" id="del-confirm">Delete</button>
      </div>
    </dialog>

    <dialog id="alias-dlg" ${dlg} width:min(34rem,94vw)">
      <h2 id="alias-title" style="margin-top:0">New Alias</h2>
      <label class="muted">Alias word</label>
      <input type="text" id="alias-word" maxlength="60" placeholder="e.g. d6" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Aliases to command <span class="muted">(a custom <code>!trigger</code> or a built-in like <code>!wheel</code>; not another alias)</span></label>
      <input type="text" id="alias-target" maxlength="60" placeholder="e.g. roll or wheel" style="width:100%; margin:.35rem 0 .8rem" />
      <label class="muted">Arguments <span class="muted">(optional; the command's full args — forward the caller's with $(args), may use $() variables)</span></label>
      <input type="text" id="alias-args" maxlength="200" placeholder="e.g. add $(sender) or $(2) $(1)" style="width:100%; margin:.35rem 0 .8rem" />
      <div class="toast err" id="alias-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="alias-cancel">Cancel</button>
        <button type="button" class="pink" id="alias-save">Save</button>
      </div>
    </dialog>`;
}

/**
 * Shared JS driving the command modals. Defines the public functions any host
 * page calls from its row wiring — each takes the command OBJECT and an
 * `onDone` reload callback, so the modal itself is page-agnostic:
 *
 *   openNew(onDone)              openEdit(cmd, onDone)
 *   openNewAlias(onDone)         openAliasEdit(cmd, onDone)
 *   delCommand(cmd, onDone)      setEnabled(cmd, onDone, onError)
 *
 * Requires `esc` and `api` (from the shell) and the modal HTML in the DOM.
 */
export function commandModalsScript(): string {
  return `
    var cmEditDlg=document.getElementById('edit-dlg');
    var cmAliasDlg=document.getElementById('alias-dlg');
    var cmDelDlg=document.getElementById('del-dlg');
    var cmEditMode='edit', cmEditTarget=null, cmEditDone=null;
    var cmAliasMode='create', cmAliasTarget=null, cmAliasDone=null;
    var cmDelTarget=null, cmDelDone=null;
    function cmOpen(d){ if(d.showModal) d.showModal(); else d.setAttribute('open',''); }
    function cmClose(d){ if(d.close) d.close(); else d.removeAttribute('open'); }
    function cmSetPerm(v){ Array.prototype.forEach.call(document.querySelectorAll('input[name=edit-perm]'), function(r){ r.checked=(+r.value===(v||0)); }); }
    function cmGetPerm(){ var el=document.querySelector('input[name=edit-perm]:checked'); return el?+el.value:0; }
    function cmGetKind(){ var el=document.querySelector('input[name=edit-kind]:checked'); return el?el.value:'trigger'; }
    function cmCommonFields(){
      return {
        response:document.getElementById('edit-response').value,
        group:document.getElementById('edit-group').value,
        permission:cmGetPerm(),
        enabled:document.getElementById('edit-enabled').checked,
        globalCooldown:parseInt(document.getElementById('edit-global').value,10)||0,
        userCooldown:parseInt(document.getElementById('edit-user').value,10)||0
      };
    }
    function cmUpdateTriggerLabel(){
      var isPhrase=cmGetKind()==='phrase';
      document.getElementById('edit-trigger-label').textContent = isPhrase ? 'Phrase' : 'Trigger word';
      document.getElementById('edit-trigger').placeholder = isPhrase ? 'e.g. good game' : 'e.g. hello';
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name=edit-kind]'), function(r){ r.onchange=cmUpdateTriggerLabel; });

    function openNew(onDone){
      cmEditMode='create'; cmEditTarget=null; cmEditDone=onDone||null;
      document.getElementById('edit-title').textContent='New Command';
      document.getElementById('edit-create-fields').style.display='';
      document.getElementById('edit-response').value='';
      document.getElementById('edit-group').value='';
      cmSetPerm(0);
      document.getElementById('edit-enabled').checked=true;
      document.getElementById('edit-global').value='0';
      document.getElementById('edit-user').value='0';
      var trig=document.querySelector('input[name=edit-kind][value=trigger]'); if(trig) trig.checked=true;
      document.getElementById('edit-trigger').value='';
      cmUpdateTriggerLabel();
      document.getElementById('edit-toast').textContent='';
      document.getElementById('edit-save').textContent='Create';
      cmOpen(cmEditDlg);
      document.getElementById('edit-trigger').focus();
    }
    function openEdit(c, onDone){
      if(!c) return; cmEditMode='edit'; cmEditTarget=c; cmEditDone=onDone||null;
      document.getElementById('edit-title').innerHTML='Edit <code>'+(c.kind==='phrase'?('“'+esc(c.name)+'”'):('!'+esc(c.name)))+'</code>';
      document.getElementById('edit-create-fields').style.display='none';
      document.getElementById('edit-response').value=c.response||'';
      document.getElementById('edit-group').value=c.group||'';
      cmSetPerm(c.access||0);
      document.getElementById('edit-enabled').checked=!!c.enabled;
      document.getElementById('edit-global').value=String(c.globalCooldown||0);
      document.getElementById('edit-user').value=String(c.userCooldown||0);
      document.getElementById('edit-toast').textContent='';
      document.getElementById('edit-save').textContent='Save';
      cmOpen(cmEditDlg);
    }
    document.getElementById('edit-cancel').onclick=function(){ cmClose(cmEditDlg); };
    document.getElementById('edit-save').onclick=async function(){
      var f=cmCommonFields();
      if(cmEditMode==='create'){
        var kind=cmGetKind();
        var name=document.getElementById('edit-trigger').value;
        if(!name.trim()){ document.getElementById('edit-toast').textContent = kind==='phrase' ? 'Enter the phrase text.' : 'Enter a trigger word.'; return; }
        try{ await api('POST','/api/commands/create', Object.assign({ kind:kind, name:name }, f)); cmClose(cmEditDlg); if(cmEditDone) await cmEditDone(); }
        catch(e){ document.getElementById('edit-toast').textContent=e.message; }
        return;
      }
      if(!cmEditTarget) return;
      try{ await api('POST','/api/commands', Object.assign({ kind:cmEditTarget.kind, name:cmEditTarget.name }, f)); cmClose(cmEditDlg); if(cmEditDone) await cmEditDone(); }
      catch(e){ document.getElementById('edit-toast').textContent=e.message; }
    };

    function openNewAlias(onDone){
      cmAliasMode='create'; cmAliasTarget=null; cmAliasDone=onDone||null;
      document.getElementById('alias-title').textContent='New Alias';
      var w=document.getElementById('alias-word'); w.value=''; w.removeAttribute('disabled');
      document.getElementById('alias-target').value='';
      document.getElementById('alias-args').value='';
      document.getElementById('alias-toast').textContent='';
      document.getElementById('alias-save').textContent='Create';
      cmOpen(cmAliasDlg);
      w.focus();
    }
    function openAliasEdit(c, onDone){
      if(!c) return; cmAliasMode='edit'; cmAliasTarget=c; cmAliasDone=onDone||null;
      document.getElementById('alias-title').innerHTML='Edit alias <code>!'+esc(c.name)+'</code>';
      var w=document.getElementById('alias-word'); w.value=c.name; w.setAttribute('disabled','');
      document.getElementById('alias-target').value=c.target||'';
      document.getElementById('alias-args').value=c.args||'';
      document.getElementById('alias-toast').textContent='';
      document.getElementById('alias-save').textContent='Save';
      cmOpen(cmAliasDlg);
    }
    document.getElementById('alias-cancel').onclick=function(){ cmClose(cmAliasDlg); };
    document.getElementById('alias-save').onclick=async function(){
      var target=document.getElementById('alias-target').value;
      var args=document.getElementById('alias-args').value;
      if(!target.trim()){ document.getElementById('alias-toast').textContent='Enter the command to alias to.'; return; }
      try{
        if(cmAliasMode==='create'){
          var word=document.getElementById('alias-word').value;
          if(!word.trim()){ document.getElementById('alias-toast').textContent='Enter the alias word.'; return; }
          await api('POST','/api/commands/alias',{ alias:word, target:target, args:args });
        } else {
          await api('POST','/api/commands/alias/update',{ alias:cmAliasTarget.name, target:target, args:args });
        }
        cmClose(cmAliasDlg);
        if(cmAliasDone) await cmAliasDone();
      }catch(e){ document.getElementById('alias-toast').textContent=e.message; }
    };

    function delCommand(c, onDone){
      if(!c) return; cmDelTarget=c; cmDelDone=onDone||null;
      document.getElementById('del-name').textContent = c.kind==='phrase' ? '“'+c.name+'”' : '!'+c.name;
      document.getElementById('del-msg').textContent = c.kind==='alias'
        ? 'This removes the alias. The command it points to is not affected.'
        : 'This permanently removes the command and any aliases pointing to it.';
      document.getElementById('del-toast').textContent='';
      cmOpen(cmDelDlg);
    }
    document.getElementById('del-cancel').onclick=function(){ cmClose(cmDelDlg); };
    document.getElementById('del-confirm').onclick=async function(){
      if(!cmDelTarget) return;
      try{
        if(cmDelTarget.kind==='alias') await api('POST','/api/commands/alias/delete',{ alias:cmDelTarget.name });
        else await api('POST','/api/commands/delete',{ kind:cmDelTarget.kind, name:cmDelTarget.name });
        cmClose(cmDelDlg); if(cmDelDone) await cmDelDone();
      }
      catch(e){ document.getElementById('del-toast').textContent='Delete failed: '+e.message; }
    };

    // Toggle enable/disable. The switch already flipped optimistically, so on
    // success onDone re-renders truth; on failure onError snaps it back.
    function setEnabled(c, onDone, onError){
      if(!c) return;
      (async function(){
        try{
          if(c.kind==='alias') await api('POST','/api/commands/alias/update',{ alias:c.name, enabled:!c.enabled });
          else await api('POST','/api/commands',{ kind:c.kind, name:c.name, enabled:!c.enabled });
          if(onDone) await onDone();
        }catch(e){ if(onError) onError(); alert(e.message); }
      })();
    }
  `;
}
