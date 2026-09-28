import { renderLayout } from '../layout.js';

/**
 * Admin page — broadcaster / bot admins only. Master-detail layout like Commands
 * and Lists: sections in the left sidebar, the active section's panel on the
 * right.
 *
 * Sections:
 *  - Users: every registered user with their aggregates; edit display name,
 *    aliases, and points, delete an account, or create one from a Twitch handle
 *    before that person has ever chatted.
 *  - Event Simulator: injects real BotEvents over HTTP. Replaces the former
 *    `webapps/event-sim` WebSocket harness — the admin session is the gate, so
 *    no socket, shared secret, or production kill-switch is involved.
 *
 * The server re-checks admin rights on every /api/admin call — the client-side
 * gating below is only about not showing a dead end.
 */
export function adminPage(): string {
  const body = /* html */ `
    <div class="page-head" style="display:flex; align-items:flex-end; justify-content:space-between; gap:1rem">
      <div>
        <h1>Admin</h1>
        <p class="muted" id="admin-sub" style="margin:0; padding:0">Loading…</p>
      </div>
      <div class="rowline" style="flex:none; gap:.5rem; justify-content:flex-end">
        <button type="button" class="pink" id="init-user-btn" style="display:none">Init New User</button>
      </div>
    </div>

    <div id="admin-denied" class="card" style="display:none">
      <h2 style="margin-top:0">Admins only</h2>
      <p class="muted">This page is limited to the broadcaster and bot admins.</p>
    </div>

    <div class="md-layout" id="admin-layout" style="display:none">
      <button type="button" class="md-side-toggle" data-side="admin-side" data-default="Sections"><span class="mst-label">Sections</span></button>
      <nav class="md-side card" id="admin-side"></nav>
      <div class="md-main card" id="admin-main"></div>
    </div>

    <dialog id="user-dlg" class="modal" style="width:min(38rem,94vw)">
      <h2 id="user-dlg-title" style="margin-top:0">Edit User</h2>
      <p class="muted" id="user-dlg-who" style="margin:0 0 .8rem"></p>

      <label class="muted">Display name</label>
      <input type="text" id="u-display" maxlength="40" style="width:100%; margin:.35rem 0 .8rem" />

      <label class="muted">Aliases</label>
      <div class="chips" id="u-aliases" style="margin:.35rem 0 .5rem"></div>
      <div class="rowline" style="margin-bottom:.8rem">
        <input type="text" id="u-alias-new" maxlength="40" placeholder="add an alias" style="flex:1" />
        <button type="button" class="secondary" id="u-alias-add">Add</button>
      </div>

      <label class="muted">Points <span class="muted">(sets the balance outright)</span></label>
      <input type="number" id="u-points" min="0" step="1" style="width:100%; margin:.35rem 0 .8rem" />

      <div class="toast err" id="user-toast"></div>
      <div class="rowline" style="justify-content:space-between; margin-top:.4rem">
        <button type="button" class="danger" id="u-delete">Delete user</button>
        <div class="rowline" style="justify-content:flex-end">
          <button type="button" class="secondary" id="u-cancel">Cancel</button>
          <button type="button" class="pink" id="u-save">Save</button>
        </div>
      </div>
    </dialog>

    <dialog id="init-dlg" class="modal" style="width:min(32rem,94vw)">
      <h2 style="margin-top:0">Init New User</h2>
      <p class="muted">Look up a Twitch account and add it to the database, so you can set points or aliases before they ever chat.</p>
      <label class="muted">Twitch username</label>
      <input type="text" id="init-handle" maxlength="40" placeholder="@username" style="width:100%; margin:.35rem 0 .8rem" />
      <div class="toast err" id="init-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="init-cancel">Cancel</button>
        <button type="button" class="pink" id="init-save">Look up &amp; add</button>
      </div>
    </dialog>

    <dialog id="udel-dlg" class="modal" style="width:min(32rem,94vw)">
      <h2 style="margin-top:0">Delete this user?</h2>
      <p id="udel-msg" style="margin:0 0 .6rem"></p>
      <p class="muted" style="margin:0 0 .8rem">
        Their points balance, display name, and aliases are permanently removed. Quotes
        and list entries they authored are kept, but stop being linked to an account.
        This cannot be undone.
      </p>
      <div class="toast err" id="udel-toast"></div>
      <div class="rowline" style="justify-content:flex-end; margin-top:.4rem">
        <button type="button" class="secondary" id="udel-cancel">Cancel</button>
        <button type="button" class="danger" id="udel-confirm">Delete permanently</button>
      </div>
    </dialog>
  `;

  const script = /* js */ `
    var SECTIONS = [
      { id: 'users', label: 'Users' },
      { id: 'eventsim', label: 'EventSimulator' },
      { id: 'overlays', label: 'Overlays' },
      { id: 'strings', label: 'Text Strings' },
      { id: 'tts', label: 'TTS' },
      { id: 'achievements', label: 'Achievements' },
      { id: 'floof', label: 'Pet the Floof' },
      { id: 'boss', label: 'Boss Battle' },
    ];
    var section = 'users';
    var users = [];

    // Lucide paths, inlined to match the Commands/Lists/Quotes tables.
    var ICONS={
      'pencil':'<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/><path d="m15 5 4 4"/>',
      'trash-2':'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
      'dice-5':'<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>'
    };
    function icon(name, size){ size=size||16; return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+ICONS[name]+'</svg>'; }
    var editing = null;        // user row being edited
    var draftAliases = [];     // alias list inside the edit dialog
    var pendingDelete = null;


    function fmtDate(iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      var days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days === 0) return 'today';
      if (days === 1) return 'yesterday';
      if (days < 30) return days + ' days ago';
      return d.toISOString().slice(0, 10);
    }

    function renderSide() {
      document.getElementById('admin-side').innerHTML =
        '<div class="label">Sections</div>' +
        SECTIONS.map(function (s) {
          return '<button type="button" class="item' + (s.id === section ? ' active' : '') +
            '" data-section="' + s.id + '">' + esc(s.label) + '</button>';
        }).join('');
      Array.prototype.forEach.call(document.querySelectorAll('#admin-side .item'), function (b) {
        b.onclick = function () { section = b.getAttribute('data-section'); render(); };
      });
    }

    // ── Users ──────────────────────────────────────────────────────────────────

    function renderUsers() {
      document.getElementById('init-user-btn').style.display = '';
      document.getElementById('admin-sub').textContent =
        users.length + (users.length === 1 ? ' registered user' : ' registered users');

      if (!users.length) {
        document.getElementById('admin-main').innerHTML =
          '<h2>Users</h2><p class="muted">Nobody is registered yet. Users are added automatically as they chat.</p>';
        return;
      }

      var rows = users.map(function (u, i) {
        var aliases = u.aliases.length
          ? u.aliases.map(function (a) { return '<span class="chip">' + esc(a) + '</span>'; }).join(' ')
          : '<span class="muted">—</span>';
        return '<tr>' +
          '<td><code>' + esc(u.canonical) + '</code></td>' +
          '<td class="muted"><code>' + esc(u.id) + '</code></td>' +
          '<td>' + esc(u.displayName) + '</td>' +
          '<td><div class="chips">' + aliases + '</div></td>' +
          '<td>' + esc(u.permissionLabel) + '</td>' +
          '<td>' + u.points + '</td>' +
          '<td>' + u.quotes + '</td>' +
          '<td class="muted">' + esc(fmtDate(u.lastSeenAt)) + '</td>' +
          '<td><div class="rowline">' +
            '<button type="button" class="secondary icon-btn" data-edit="' + i + '" title="Edit">' + icon('pencil') + '</button>' +
            '<button type="button" class="danger icon-btn" data-del="' + i + '" title="Delete">' + icon('trash-2') + '</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');

      document.getElementById('admin-main').innerHTML =
        '<h2>Users</h2>' +
        '<div style="overflow-x:auto"><table class="admin-users"><thead><tr>' +
        '<th>Account</th><th>ID</th><th>Display Name</th><th>Aliases</th>' +
        '<th>Permission</th><th>Points</th><th>Quotes</th><th>Last Seen</th><th>Actions</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';

      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () { openEdit(users[Number(b.getAttribute('data-edit'))]); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () { openDelete(users[Number(b.getAttribute('data-del'))]); };
      });
    }

    function renderDraftAliases() {
      document.getElementById('u-aliases').innerHTML = draftAliases.length
        ? draftAliases.map(function (a) {
            return '<span class="chip">' + esc(a) + '<button type="button" data-drop="' + esc(a) + '">&times;</button></span>';
          }).join(' ')
        : '<span class="muted">No aliases.</span>';
      Array.prototype.forEach.call(document.querySelectorAll('#u-aliases [data-drop]'), function (b) {
        b.onclick = function () {
          var a = b.getAttribute('data-drop');
          draftAliases = draftAliases.filter(function (x) { return x !== a; });
          renderDraftAliases();
        };
      });
    }

    function openEdit(u) {
      editing = u;
      draftAliases = u.aliases.slice();
      document.getElementById('user-dlg-who').textContent = u.canonical + ' · ' + u.id;
      document.getElementById('u-display').value = u.displayName;
      document.getElementById('u-points').value = u.points;
      document.getElementById('u-alias-new').value = '';
      renderDraftAliases();
      toast('user-toast', '');
      openDialog('user-dlg');
    }

    function openDelete(u) {
      pendingDelete = u;
      document.getElementById('udel-msg').innerHTML =
        '<strong>' + esc(u.displayName) + '</strong> (' + esc(u.canonical) + ') — ' +
        u.points + ' points, ' + u.quotes + (u.quotes === 1 ? ' quote' : ' quotes') + '.';
      toast('udel-toast', '');
      openDialog('udel-dlg');
    }

    async function reload() {
      var d = await api('GET', '/api/admin/users');
      users = d.users || [];
    }

    // ── Event simulator ────────────────────────────────────────────────────────

    // Random value helpers, carried over from the retired WebSocket harness.
    var NAMES = ['Ninja_Pango','QueenBeeVT','saltyPixel','DrLoot','mossy_kai','VoidHopper','BitBaron','lil_fern','CaptainYikes','nova_wisp'];
    var MESSAGES = ['Love the stream!','First time here 👋','LETS GOOO','Been watching for months','','Take my money','poggers'];
    var TIERS = ['1000','2000','3000','Prime'];
    var CURRENCIES = ['USD','EUR','GBP','CAD'];
    function pick(a){ return a[Math.floor(Math.random()*a.length)]; }
    function rint(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
    function randName(){ return pick(NAMES) + (Math.random()<0.3 ? rint(1,99) : ''); }

    // Per-event field specs: name, input type, default, and a randomizer.
    var EVENTS = [
      { type: 'live', emoji: '😻', label: 'Stream Live', fields: [] },
      { type: 'sub', emoji: '🎉', label: 'Subscription', fields: [
        { name:'user', type:'text', def:'TestUser', rand: randName },
        { name:'tier', type:'select', options:TIERS, def:'1000', rand: function(){ return pick(TIERS); } },
        { name:'months', type:'number', def:1, rand: function(){ return 1; } },
        { name:'message', type:'text', def:'', rand: function(){ return pick(MESSAGES); } },
      ]},
      { type: 'resub', emoji: '🎉', label: 'Resubscription', fields: [
        { name:'user', type:'text', def:'TestUser', rand: randName },
        { name:'tier', type:'select', options:TIERS, def:'1000', rand: function(){ return pick(TIERS); } },
        { name:'months', type:'number', def:6, rand: function(){ return rint(2,48); } },
        { name:'message', type:'text', def:'Still here!', rand: function(){ return pick(MESSAGES); } },
      ]},
      { type: 'subgift', emoji: '🎁', label: 'Gift Sub(s)', fields: [
        { name:'gifter', type:'text', def:'TestGifter', rand: randName },
        { name:'count', type:'number', def:1, rand: function(){ return pick([1,1,1,5,10,20]); } },
        { name:'tier', type:'select', options:TIERS, def:'1000', rand: function(){ return pick(TIERS); } },
        { name:'recipientLogin', type:'text', def:'luckyviewer', rand: function(){ return randName().toLowerCase(); } },
      ]},
      { type: 'bits', emoji: '✨', label: 'Bits / Cheer', fields: [
        { name:'user', type:'text', def:'TestUser', rand: randName },
        { name:'amount', type:'number', def:100, rand: function(){ return pick([1,50,100,500,1000,5000]); } },
        { name:'message', type:'text', def:'', rand: function(){ return pick(MESSAGES); } },
      ]},
      { type: 'raid', emoji: '🚀', label: 'Raid', fields: [
        { name:'fromLogin', type:'text', def:'someraider', rand: function(){ return randName().toLowerCase(); } },
        { name:'viewers', type:'number', def:25, rand: function(){ return rint(2,800); } },
      ]},
      { type: 'follow', emoji: '👋', label: 'Follow', fields: [
        { name:'user', type:'text', def:'TestUser', rand: randName },
      ]},
      { type: 'donation', emoji: '💜', label: 'Donation', fields: [
        { name:'fromName', type:'text', def:'TestDonor', rand: randName },
        { name:'amount', type:'number', def:5, rand: function(){ return pick([1,5,10,25,50,100]); } },
        { name:'currency', type:'select', options:CURRENCIES, def:'USD', rand: function(){ return pick(CURRENCIES); } },
        { name:'message', type:'text', def:'', rand: function(){ return pick(MESSAGES); } },
      ]},
    ];
    var simLog = [];

    function fieldId(type, name){ return 'f_' + type + '_' + name; }
    function eventOf(type){ return EVENTS.filter(function(e){ return e.type === type; })[0]; }

    function randomize(type) {
      var ev = eventOf(type);
      if (!ev) return;
      ev.fields.forEach(function (f) {
        var el = document.getElementById(fieldId(type, f.name));
        if (el && f.rand) el.value = f.rand();
      });
    }

    function renderSim() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Inject real events into the bot for testing.';

      var cards = EVENTS.map(function (e) {
        var inputs = e.fields.map(function (f) {
          var id = fieldId(e.type, f.name);
          var label = '<label class="muted" style="display:block; margin-top:.4rem">' + esc(f.name) + '</label>';
          if (f.type === 'select') {
            return label + '<select id="' + id + '" style="width:100%">' + f.options.map(function (o) {
              return '<option' + (o === f.def ? ' selected' : '') + '>' + esc(o) + '</option>';
            }).join('') + '</select>';
          }
          return label + '<input id="' + id + '" type="' + (f.type === 'number' ? 'number' : 'text') +
            '" value="' + esc(f.def) + '" style="width:100%" />';
        }).join('');
        return '<div class="card" style="margin:0">' +
          '<h3 style="margin:0 0 .2rem">' + e.emoji + ' ' + esc(e.label) + '</h3>' +
          '<p class="muted" style="margin:0; font-size:.82rem"><code>' + esc(e.type) + '</code></p>' +
          inputs +
          '<div class="rowline" style="margin-top:.7rem; flex-wrap:nowrap">' +
            '<button type="button" class="secondary" data-rand="' + e.type + '" title="Randomize">' + icon('dice-5') + '</button>' +
            '<button type="button" class="pink" data-fire="' + e.type + '" style="flex:1">Fire</button>' +
          '</div>' +
        '</div>';
      }).join('');

      document.getElementById('admin-main').innerHTML =
        '<h2>Event Simulator</h2>' +
        '<p class="muted">These fire <strong>real</strong> events: the bot posts to chat and writes points and event-log rows. ' +
        'Simulated users are created as <code>sim-*</code> accounts and show up in the Users table.</p>' +
        '<div class="rowline" style="margin:.6rem 0">' +
          '<button type="button" class="secondary" id="sim-rand-all">Randomize every card</button>' +
          '<button type="button" class="secondary" id="sim-random">Fire one random event</button>' +
        '</div>' +
        '<div class="sim-grid">' + cards + '</div>' +
        '<h3 style="margin-top:1.2rem">Activity</h3>' +
        '<div class="toast" id="sim-toast"></div>' +
        '<pre id="sim-log" style="background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:.7rem; max-height:14rem; overflow:auto; margin:0; font-size:.82rem"></pre>';

      Array.prototype.forEach.call(document.querySelectorAll('[data-fire]'), function (b) {
        b.onclick = function () { fire(b.getAttribute('data-fire')); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-rand]'), function (b) {
        b.onclick = function () { randomize(b.getAttribute('data-rand')); };
      });
      document.getElementById('sim-rand-all').onclick = function () {
        EVENTS.forEach(function (e) { randomize(e.type); });
      };
      document.getElementById('sim-random').onclick = function () {
        var ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
        randomize(ev.type);
        fire(ev.type);
      };
      renderSimLog();
    }

    function renderSimLog() {
      var el = document.getElementById('sim-log');
      if (el) el.textContent = simLog.length ? simLog.join('\\n') : 'Nothing fired yet.';
    }

    async function fire(type) {
      var ev = eventOf(type);
      if (!ev) return;
      var payload = {};
      ev.fields.forEach(function (f) {
        var el = document.getElementById(fieldId(type, f.name));
        if (!el) return;
        var v = String(el.value).trim();
        if (v === '') return; // let the server apply its own default
        payload[f.name] = f.type === 'number' ? Number(v) : v;
      });
      try {
        var d = await api('POST', '/api/admin/simulate', { type: type, payload: payload });
        simLog.unshift(new Date().toLocaleTimeString() + '  ✓ injected ' + d.injected + '  ' + JSON.stringify(payload));
        toast('sim-toast', 'Fired ' + type + '.', true);
      } catch (e) {
        simLog.unshift(new Date().toLocaleTimeString() + '  ✗ ' + type + ': ' + e.message);
        toast('sim-toast', e.message, false);
      }
      simLog = simLog.slice(0, 50);
      renderSimLog();
    }

    // ── wiring ─────────────────────────────────────────────────────────────────

    function render() {
      renderSide();
      if (section === 'users') renderUsers();
      else if (section === 'overlays') renderOverlays();
      else if (section === 'strings') renderStrings();
      else if (section === 'tts') renderTts();
      else if (section === 'achievements') renderAchievements();
      else if (section === 'floof') renderFloof();
      else if (section === 'boss') renderBoss();
      else renderSim();
    }

    // ── Text Strings: edit the chat text plugins post (grouped by feature) ───────
    async function renderStrings() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Edit the text the bot posts to chat.';
      var main = document.getElementById('admin-main');
      main.innerHTML = '<h2>Text Strings</h2><p class="muted">Loading…</p>';
      try {
        var d = await api('GET', '/api/admin/strings');
        var groups = d.groups || [];
        if (!groups.length) { main.innerHTML = '<h2>Text Strings</h2><p class="muted">No editable strings are registered yet.</p>'; return; }
        var cards = groups.map(function (g) {
          var rows = g.strings.map(function (s) {
            var ph = (s.placeholders && s.placeholders.length)
              ? '<div class="muted" style="font-size:.78rem; margin-top:.2rem">Placeholders: ' + s.placeholders.map(function (p) { return '<code>{' + esc(p) + '}</code>'; }).join(' ') + '</div>' : '';
            var desc = s.description ? '<div class="muted" style="font-size:.8rem">' + esc(s.description) + '</div>' : '';
            var reset = s.custom ? ' · <a href="#" class="linkish" data-reset data-feature="' + esc(s.feature) + '" data-key="' + esc(s.key) + '">reset to default</a>' : '';
            var tag = s.custom ? ' <span class="tag">custom</span>' : '';
            return '<tr>' +
              '<td style="vertical-align:top; white-space:nowrap"><strong>' + esc(s.label) + '</strong>' + tag +
                '<div class="muted" style="font-size:.78rem"><code>' + esc(s.feature) + '.' + esc(s.key) + '</code>' + reset + '</div>' + desc + ph + '</td>' +
              '<td style="width:100%; vertical-align:middle"><input type="text" value="' + esc(s.value) + '" style="width:100%" /></td>' +
              '<td style="vertical-align:middle; text-align:right; white-space:nowrap"><button type="button" class="pink" data-save data-feature="' + esc(s.feature) + '" data-key="' + esc(s.key) + '">Save</button></td>' +
              '</tr>';
          }).join('');
          return '<div class="card" style="margin:0 0 1rem"><h3 style="margin:0 0 .6rem">' + esc(pretty(g.feature)) + '</h3>' +
            '<div style="overflow-x:auto"><table style="width:100%"><thead><tr><th>Label</th><th>Text</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
        }).join('');
        main.innerHTML = '<h2>Text Strings</h2>' +
          '<p class="muted">Edit the text the bot posts to chat, grouped by feature. Placeholders like <code>{user}</code> are filled in when the message is sent. Changes take effect immediately.</p>' +
          cards;
        // Dim the Save button until the text is edited; brighten on unsaved changes.
        Array.prototype.forEach.call(document.querySelectorAll('[data-save]'), function (b) {
          var inp = b.closest('tr').querySelector('input');
          inp.setAttribute('data-orig', inp.value);
          b.style.opacity = '.5';
          inp.oninput = function () { b.style.opacity = (inp.value !== inp.getAttribute('data-orig')) ? '1' : '.5'; };
          b.onclick = function () { saveString(b); };
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-reset]'), function (a) { a.onclick = function (ev) { ev.preventDefault(); resetString(a); }; });
      } catch (e) { main.innerHTML = '<h2>Text Strings</h2><p class="muted">Could not load: ' + esc(e.message) + '</p>'; }
    }
    async function saveString(b) {
      var inp = b.closest('tr').querySelector('input');
      try {
        await api('POST', '/api/admin/strings', { feature: b.getAttribute('data-feature'), key: b.getAttribute('data-key'), value: inp.value });
        inp.setAttribute('data-orig', inp.value);
        b.style.opacity = '.5'; // no unsaved changes anymore
        b.textContent = 'Saved!';
        setTimeout(renderStrings, 700);
      } catch (e) { alert('Save failed: ' + e.message); }
    }
    async function resetString(a) {
      try {
        await api('POST', '/api/admin/strings', { feature: a.getAttribute('data-feature'), key: a.getAttribute('data-key'), reset: true });
        renderStrings();
      } catch (e) { alert('Reset failed: ' + e.message); }
    }

    // ── Overlays: reveal the OBS browser-source URLs (read-only token) ───────────
    async function renderOverlays() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Add these as Browser Sources in OBS.';
      var main = document.getElementById('admin-main');
      main.innerHTML = '<h2>Overlays</h2><p class="muted">Loading…</p>';
      try {
        var d = await api('GET', '/api/admin/overlays');
        if (!d.configured) {
          main.innerHTML = '<h2>Overlays</h2><p class="muted">No overlay token is set. Add <code>OVERLAY_TOKEN</code> to the bot .env file and restart to enable read-only OBS overlays.</p>';
          return;
        }
        var rows = (d.overlays || []).map(function (o) {
          return '<div class="card" style="margin:0 0 1rem">' +
            '<h3 style="margin:0 0 .4rem">' + esc(o.name) + '</h3>' +
            '<div class="rowline" style="gap:.5rem; align-items:center; flex-wrap:nowrap">' +
              '<input type="text" readonly value="' + esc(o.url) + '" id="ov-' + esc(o.id) + '" style="flex:1" />' +
              '<button type="button" class="pink" data-copy="ov-' + esc(o.id) + '">Copy</button>' +
            '</div></div>';
        }).join('');
        main.innerHTML = '<h2>Overlays</h2>' +
          '<p class="muted">Each URL carries your read-only overlay token — treat it as a secret and <strong>do not show it on stream</strong>. Add each as a Browser Source in OBS (transparent background).</p>' +
          rows;
        Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) {
          b.onclick = function () {
            var inp = document.getElementById(b.getAttribute('data-copy'));
            inp.select();
            if (navigator.clipboard) navigator.clipboard.writeText(inp.value);
            b.textContent = 'Copied!';
            setTimeout(function () { b.textContent = 'Copy'; }, 1200);
          };
        });
      } catch (e) {
        main.innerHTML = '<h2>Overlays</h2><p class="muted">Could not load overlays: ' + esc(e.message) + '</p>';
      }
    }

    // ── TTS: mute, voice knobs, and a test-fire box for the audio overlay ────────
    var TTS_KNOBS = [
      { key: 'lengthScale', label: 'Speed', min: 0.5, max: 2, step: 0.05, hint: 'higher = slower' },
      { key: 'noiseScale', label: 'Expressiveness', min: 0, max: 1, step: 0.01, hint: 'pitch / intonation variability' },
      { key: 'noiseW', label: 'Cadence variation', min: 0, max: 1, step: 0.01, hint: 'phoneme-duration variation' },
      { key: 'sentenceSilence', label: 'Sentence pause', min: 0, max: 1, step: 0.05, hint: 'seconds after each sentence' },
      { key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05, hint: 'playback loudness' }
    ];
    function ttsFmt(key, val) { return key === 'volume' ? Math.round(val * 100) + '%' : (Math.round(val * 100) / 100).toFixed(2); }

    async function renderTts() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Vocalize messages through the TTS audio overlay.';
      var main = document.getElementById('admin-main');
      main.innerHTML = '<h2>Text-to-Speech</h2><p class="muted">Loading…</p>';
      try {
        var d = await api('GET', '/api/admin/tts');
        if (!d.configured) {
          main.innerHTML = '<h2>Text-to-Speech</h2><p class="muted">TTS is not configured. Set <code>PIPER_MODEL</code> (and, if needed, <code>PIPER_BIN</code>) in the bot <code>.env</code> and restart to enable it — see <code>.env.example</code>. Install piper + a voice from <code>github.com/rhasspy/piper</code>.</p>';
          return;
        }
        var defaults = d.defaults || {};
        var voice = d.voice || {};
        var speakers = (d.speakers && d.speakers.speakers) || [];

        var sliders = TTS_KNOBS.map(function (k) {
          var v = (voice[k.key] != null) ? voice[k.key] : defaults[k.key];
          return '<div class="rowline" style="gap:.6rem; align-items:center; margin:.35rem 0">' +
            '<label style="flex:0 0 13rem">' + esc(k.label) + ' <span class="muted" style="font-size:.76rem">(' + esc(k.hint) + ')</span></label>' +
            '<input type="range" data-knob="' + k.key + '" min="' + k.min + '" max="' + k.max + '" step="' + k.step + '" value="' + v + '" style="flex:1">' +
            '<span class="muted" data-val="' + k.key + '" style="flex:0 0 3.5em; text-align:right"></span>' +
            '</div>';
        }).join('');
        var speakerRow = '';
        if (speakers.length) {
          speakerRow = '<div class="rowline" style="gap:.6rem; align-items:center; margin:.35rem 0">' +
            '<label style="flex:0 0 13rem">Speaker</label>' +
            '<select id="tts-speaker" style="flex:1">' + speakers.map(function (sp) {
              return '<option value="' + sp.id + '"' + (((voice.speaker || 0) === sp.id) ? ' selected' : '') + '>' + esc(sp.name) + '</option>';
            }).join('') + '</select><span style="flex:0 0 3.5em"></span></div>';
        }

        main.innerHTML = '<h2>Text-to-Speech</h2>' +
          '<p class="muted">Piper reads messages aloud through the <strong>TTS audio overlay</strong> — add its URL from the <strong>Overlays</strong> section as a Browser Source in OBS. Changes apply to the next spoken line.</p>' +
          '<div class="card" style="margin:0 0 1rem"><div class="row"><div><strong>Mute TTS</strong>' +
            '<div class="muted" style="font-size:.82rem">When muted, nothing is spoken — the service ignores all speak requests.</div></div>' +
            '<label class="switch"><input type="checkbox" id="tts-mute"' + (d.muted ? ' checked' : '') + '><span class="slider"></span></label></div></div>' +
          '<div class="card" style="margin:0 0 1rem"><h3 style="margin:0 0 .5rem">Voice settings</h3>' + sliders + speakerRow +
            '<div class="rowline" style="gap:.8rem; margin-top:.7rem; align-items:center"><button type="button" class="pink" id="tts-save">Save</button>' +
            '<button type="button" class="linkish" id="tts-reset">Reset to defaults</button></div></div>' +
          '<div class="card" style="margin:0 0 1rem"><h3 style="margin:0 0 .5rem">Test</h3>' +
            '<div class="rowline" style="gap:.6rem"><input type="text" id="tts-say" placeholder="Type something to speak…" style="flex:1" maxlength="500">' +
              '<button type="button" class="pink" id="tts-voice-btn">Test Voice</button>' +
              '<button type="button" class="pink" id="tts-say-btn">Test Overlay</button></div>' +
            '<p class="muted" style="font-size:.8rem; margin:.4rem 0 0"><strong>Test Voice</strong> plays here on the page (works even when muted); <strong>Test Overlay</strong> sends it to the OBS overlay.</p>' +
            '<div class="toast" id="tts-toast"></div></div>';

        function updateVal(key) {
          var inp = document.querySelector('[data-knob="' + key + '"]');
          var out = document.querySelector('[data-val="' + key + '"]');
          if (inp && out) out.textContent = ttsFmt(key, parseFloat(inp.value));
        }
        TTS_KNOBS.forEach(function (k) {
          updateVal(k.key);
          document.querySelector('[data-knob="' + k.key + '"]').oninput = function () { updateVal(k.key); };
        });
        function collectVoice() {
          var out = {};
          TTS_KNOBS.forEach(function (k) { out[k.key] = parseFloat(document.querySelector('[data-knob="' + k.key + '"]').value); });
          var sp = document.getElementById('tts-speaker');
          if (sp) out.speaker = parseInt(sp.value, 10) || 0;
          return out;
        }
        function saveVoice(msg) {
          return api('POST', '/api/admin/tts', { voice: collectVoice() })
            .then(function () { toast('tts-toast', msg, true); })
            .catch(function (e) { toast('tts-toast', e.message, false); });
        }
        document.getElementById('tts-save').onclick = function () { saveVoice('Voice settings saved.'); };
        document.getElementById('tts-reset').onclick = function () {
          TTS_KNOBS.forEach(function (k) {
            var inp = document.querySelector('[data-knob="' + k.key + '"]');
            if (defaults[k.key] != null) inp.value = defaults[k.key];
            updateVal(k.key);
          });
          var sp = document.getElementById('tts-speaker'); if (sp) sp.value = '0';
          saveVoice('Reset to defaults.');
        };

        var muteEl = document.getElementById('tts-mute');
        var sayEl = document.getElementById('tts-say');
        var sayBtn = document.getElementById('tts-say-btn');
        var voiceBtn = document.getElementById('tts-voice-btn');
        // Only Test Overlay respects mute; Test Voice (local preview) + the input stay usable.
        function setOverlayEnabled(en) { sayBtn.disabled = !en; }
        setOverlayEnabled(!d.muted);
        muteEl.onchange = function () {
          var muted = muteEl.checked;
          api('POST', '/api/admin/tts', { muted: muted })
            .then(function () { setOverlayEnabled(!muted); toast('tts-toast', muted ? 'TTS muted.' : 'TTS unmuted.', true); })
            .catch(function (e) { muteEl.checked = !muted; toast('tts-toast', e.message, false); });
        };
        sayBtn.onclick = function () {
          var t = sayEl.value.trim();
          if (!t) { toast('tts-toast', 'Enter something to say.', false); return; }
          api('POST', '/api/admin/tts/say', { text: t })
            .then(function () { toast('tts-toast', 'Sent to the overlay.', true); })
            .catch(function (e) { toast('tts-toast', e.message, false); });
        };
        voiceBtn.onclick = function () {
          var t = sayEl.value.trim();
          if (!t) { toast('tts-toast', 'Enter something to say.', false); return; }
          // Same-origin <audio> src (not a blob: URL, which the page CSP would block)
          // and play() called inside this click so the browser allows playback.
          var vol = document.querySelector('[data-knob="volume"]'); // preview at the current volume slider
          var a = new Audio('/api/admin/tts/preview?text=' + encodeURIComponent(t));
          a.volume = vol ? Math.max(0, Math.min(1, parseFloat(vol.value))) : 1;
          a.onerror = function () { toast('tts-toast', 'Could not play the clip (synthesis may have failed).', false); };
          var p = a.play();
          if (p && p.then) p.then(function () { toast('tts-toast', 'Playing on this page.', true); })
            .catch(function (e) { toast('tts-toast', (e && e.name === 'NotAllowedError') ? 'Browser blocked playback — click the page and retry.' : 'Could not play the clip.', false); });
        };
      } catch (e) {
        main.innerHTML = '<h2>Text-to-Speech</h2><p class="muted">Could not load: ' + esc(e.message) + '</p>';
      }
    }

    // ── Achievements: browse the catalog and fire simulated unlocks ─────────────
    async function renderAchievements() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Browse the catalog and fire test unlocks at the overlay.';
      var main = document.getElementById('admin-main');
      main.innerHTML = '<h2>Achievements</h2><p class="muted">Loading…</p>';
      try {
        var d = await api('GET', '/api/admin/achievements');
        var list = d.achievements || [];
        var totals = d.totals || { catalog: 0, awarded: 0 };

        var rows = list.map(function (a) {
          return '<tr>' +
            '<td style="font-size:1.3rem; text-align:center">' + esc(a.emoji) + '</td>' +
            '<td><strong>' + esc(a.name) + '</strong>' + (a.repeatable ? ' <span class="tag">repeatable</span>' : '') +
              '<div class="muted" style="font-size:.78rem">' + esc(a.description) + '</div>' +
              '<div class="muted" style="font-size:.75rem"><code>' + esc(a.key) + '</code></div></td>' +
            '<td>' + esc(pretty(a.group)) + '</td>' +
            '<td><span class="tag">' + esc(a.tier) + '</span></td>' +
            '<td style="text-align:right">' + a.holders + '</td>' +
            '<td style="text-align:right; white-space:nowrap"><button type="button" class="pink" data-sim="' + esc(a.key) + '">Simulate</button></td>' +
            '</tr>';
        }).join('');

        main.innerHTML = '<h2>Achievements</h2>' +
          '<p class="muted">' + totals.catalog + ' in the catalog · ' + totals.awarded + ' awarded so far. ' +
            'Definitions live in code (<code>achievementCatalog.ts</code>); this page is for inspecting them and testing the overlay.</p>' +
          '<div class="card" style="margin:0 0 1rem"><h3 style="margin:0 0 .5rem">Simulate an unlock</h3>' +
            '<p class="muted" style="font-size:.85rem; margin:0 0 .6rem">Fires a fake unlock so you can position and validate the OBS overlay. Nothing is saved to the database.</p>' +
            '<div class="rowline" style="gap:.6rem; align-items:center">' +
              '<label class="muted">Show as</label>' +
              '<input type="text" id="ach-user" maxlength="40" placeholder="(your display name)" style="flex:1" />' +
              '<label class="muted" style="display:inline-flex; align-items:center; gap:.4rem; white-space:nowrap">' +
                '<input type="checkbox" id="ach-announce" /> Also announce in chat</label>' +
            '</div>' +
            '<div class="toast" id="ach-toast"></div></div>' +
          '<div class="card" style="margin:0 0 1rem"><div class="row"><div><strong>Backfill from history</strong>' +
            '<div class="muted" style="font-size:.82rem">Grant everything users have already earned. Silent and safe to re-run.</div></div>' +
            '<button type="button" class="pink" id="ach-backfill">Run backfill</button></div></div>' +
          '<div style="overflow-x:auto"><table style="width:100%"><thead><tr><th></th><th>Achievement</th><th>Group</th><th>Tier</th><th style="text-align:right">Holders</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';

        Array.prototype.forEach.call(document.querySelectorAll('[data-sim]'), function (b) {
          b.onclick = function () {
            var body = {
              key: b.getAttribute('data-sim'),
              user: document.getElementById('ach-user').value.trim(),
              announce: document.getElementById('ach-announce').checked,
            };
            api('POST', '/api/admin/achievements/simulate', body)
              .then(function (r) { toast('ach-toast', r.announced ? 'Sent to the overlay and chat.' : 'Sent to the overlay.', true); })
              .catch(function (e) { toast('ach-toast', e.message, false); });
          };
        });
        var bf = document.getElementById('ach-backfill');
        bf.onclick = function () {
          bf.disabled = true;
          toast('ach-toast', 'Backfilling…', true);
          api('POST', '/api/admin/achievements/backfill', {})
            .then(function (r) { toast('ach-toast', 'Backfill complete: granted ' + r.granted + ' across ' + r.users + ' users.', true); renderAchievements(); })
            .catch(function (e) { toast('ach-toast', e.message, false); bf.disabled = false; });
        };
      } catch (e) {
        main.innerHTML = '<h2>Achievements</h2><p class="muted">Could not load: ' + esc(e.message) + '</p>';
      }
    }

    // ── Autosave ────────────────────────────────────────────────────────────────
    /**
     * Save a settings panel as it is edited, instead of behind a Save button.
     *
     * Writes are debounced so dragging a slider or holding a stepper is one request,
     * and serialised so two in-flight saves can never land out of order — the last
     * state the user left always wins. The id list is explicit rather than
     * scraped from the DOM, because these panels also hold controls that are NOT
     * settings (the spawn pickers, the boss picker) and must not trigger a save.
     */
    function autoSaver(url, collect, statusId, ids) {
      var timer = null, inFlight = false, again = false;

      function state(cls, msg) {
        var el = document.getElementById(statusId);
        if (!el) return;
        el.className = 'save-state ' + cls;
        el.textContent = msg;
      }

      function flush() {
        timer = null;
        if (inFlight) { again = true; return; }   // coalesce into the current save
        inFlight = true;
        state('saving', 'Saving…');
        api('POST', url, { config: collect() })
          .then(function () { if (!again) state('saved', 'Saved'); })
          .catch(function (e) { state('failed', e.message || 'Could not save'); })
          .then(function () {
            inFlight = false;
            if (again) { again = false; flush(); }
          });
      }

      function queue(immediate) {
        if (timer) clearTimeout(timer);
        state('pending', 'Unsaved changes…');
        timer = setTimeout(flush, immediate ? 0 : 650);
      }

      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox' || el.tagName === 'SELECT') {
          // A toggle or a pick is a finished decision; no reason to wait.
          el.addEventListener('change', function () { queue(true); });
        } else {
          el.addEventListener('input', function () { queue(false); });
        }
      });
      return queue;
    }

    // ── Pet the Floof: settings, manual spawn, and the photo library ────────────
    var FLOOF_TIMING = [
      { key: 'baseSeconds', label: 'Base timer', hint: 'seconds between floofs', min: 10, max: 86400, step: 10 },
      { key: 'randomSeconds', label: 'Random extra', hint: 'up to this many more seconds', min: 0, max: 86400, step: 10 },
      { key: 'despawnSeconds', label: 'Despawn after', hint: 'seconds before an un-pet floof gives up', min: 5, max: 3600, step: 5 }
    ];
    // One tuning group per animation style, matching the overlay's movers.
    var FLOOF_ANIM = [
      { style: 'pingpong', blurb: 'Drifts in a straight line and bounces off the padded edges, wagging as it goes.', fields: [
        { key: 'speed', label: 'Drift speed', hint: '1 slow - 10 fast', min: 1, max: 10, step: 1 },
        { key: 'pingpongWagDegrees', label: 'Wag amount', hint: 'degrees either side', min: 0, max: 45, step: 1 },
        { key: 'pingpongWagSeconds', label: 'Wag speed', hint: 'seconds per full wag', min: 0.2, max: 5, step: 0.05 }
      ] },
      { style: 'roll', blurb: 'Trundles along the bottom edge like a tyre, rotating as it travels.', fields: [
        { key: 'rollSpeed', label: 'Roll speed', hint: '1 slow - 10 fast', min: 1, max: 10, step: 1 }
      ] },
      { style: 'hop', blurb: 'Bounds left and right in arcs, sitting still between hops.', fields: [
        { key: 'hopDistance', label: 'Hop distance', hint: 'pixels covered per hop', min: 40, max: 1200, step: 10 },
        { key: 'hopHeight', label: 'Hop height', hint: 'pixels at the top of the arc', min: 10, max: 600, step: 10 },
        { key: 'hopSeconds', label: 'Hop duration', hint: 'seconds in the air', min: 0.2, max: 3, step: 0.1 },
        { key: 'hopDelaySeconds', label: 'Rest between hops', hint: 'seconds sat still', min: 0, max: 5, step: 0.1 }
      ] },
      { style: 'peek', blurb: 'Pops up from random spots along the bottom edge, then ducks away again, wagging while it watches.', fields: [
        { key: 'peekHeight', label: 'Peek height', hint: 'pixels it rises above the edge', min: 16, max: 400, step: 4 },
        { key: 'peekRiseSeconds', label: 'Slide time', hint: 'seconds to rise (and to duck)', min: 0.1, max: 3, step: 0.1 },
        { key: 'peekHoldSeconds', label: 'Peek duration', hint: 'seconds spent looking around', min: 0.2, max: 15, step: 0.1 },
        { key: 'peekDelaySeconds', label: 'Hidden between peeks', hint: 'seconds out of sight', min: 0, max: 10, step: 0.1 },
        { key: 'peekWagDegrees', label: 'Wag amount', hint: 'degrees either side while watching', min: 0, max: 45, step: 1 },
        { key: 'peekWagSeconds', label: 'Wag speed', hint: 'seconds per full wag', min: 0.2, max: 5, step: 0.05 }
      ] },
      { style: 'ghost', blurb: 'Fades in and out on the spot, wagging, without travelling.', fields: [
        { key: 'ghostFadeSeconds', label: 'Fade time', hint: 'seconds to fade in (and out)', min: 0.2, max: 5, step: 0.1 },
        { key: 'ghostHoldSeconds', label: 'Visible for', hint: 'seconds at full opacity', min: 0.2, max: 10, step: 0.1 },
        { key: 'ghostDelaySeconds', label: 'Hidden between', hint: 'seconds invisible', min: 0, max: 10, step: 0.1 },
        { key: 'ghostWagDegrees', label: 'Wag amount', hint: 'degrees either side', min: 0, max: 45, step: 1 },
        { key: 'ghostWagSeconds', label: 'Wag speed', hint: 'seconds per full wag', min: 0.2, max: 5, step: 0.1 }
      ] }
    ];
    var FLOOF_PAD = [
      { key: 'padLeft', label: 'Left' }, { key: 'padRight', label: 'Right' },
      { key: 'padTop', label: 'Top' }, { key: 'padBottom', label: 'Bottom' }
    ];
    var floofData = null;

    function floofField(f, cfg) {
      return '<label class="field"><span>' + esc(f.label) + '</span>' +
        '<input type="number" id="fl-' + f.key + '" value="' + cfg[f.key] + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" />' +
        '<span class="muted" style="font-size:.78rem">' + esc(f.hint) + '</span></label>';
    }

    /** The chip list for one floof's taunts; shared by the first render and updates. */
    function floofTauntChips(name, idx, taunts) {
      if (!taunts || !taunts.length) return '<span class="muted">none</span>';
      return taunts.map(function (t) {
        return '<span class="chip">' + esc(t) +
          '<button type="button" class="chip-x" data-ftaunt="' + esc(t) + '" data-fname="' + esc(name) +
          '" data-fidx="' + idx + '" aria-label="Remove">×</button></span>';
      }).join('');
    }

    /**
     * Repaint just one floof's taunts after an edit.
     *
     * Deliberately NOT a re-render: rebuilding the section would fold the editor
     * shut again, which makes adding several lines in a row miserable.
     */
    function applyFloofTaunts(name, idx, taunts) {
      var box = document.getElementById('ftc-' + idx);
      if (box) {
        box.innerHTML = floofTauntChips(name, idx, taunts);
        wireFloofTauntChips(box);
      }
      var count = document.querySelector('[data-ftoggle="ft-' + idx + '"]');
      if (count) count.textContent = taunts.length;
      var quiet = document.getElementById('ftq-' + idx);
      if (quiet) quiet.style.display = taunts.length ? 'none' : '';
      // Keep the cached copy honest, so a later full render agrees with the screen.
      var im = (floofData.images || []).filter(function (x) { return x.name === name; })[0];
      if (im) im.taunts = taunts;
    }

    /** Wire the remove buttons inside a container (they are replaced on each edit). */
    function wireFloofTauntChips(root) {
      Array.prototype.forEach.call(root.querySelectorAll('[data-ftaunt]'), function (b) {
        b.onclick = function () {
          var name = b.getAttribute('data-fname');
          var idx = b.getAttribute('data-fidx');
          api('POST', '/api/admin/floof/taunt', { name: name, text: b.getAttribute('data-ftaunt'), remove: true })
            .then(function (d) {
              applyFloofTaunts(name, idx, d.taunts || []);
              toast('floof-toast', 'Taunt removed from ' + name + '.', true);
            })
            .catch(function (e) { toast('floof-toast', e.message, false); });
        };
      });
    }

    function styleLabel(id) {
      return (floofData && floofData.styleLabels && floofData.styleLabels[id]) || id;
    }

    async function renderFloof() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Pet the Floof — timing, animation styles, and the floof photo library.';
      var main = document.getElementById('admin-main');
      main.innerHTML = '<h2>Pet the Floof</h2><p class="muted">Loading…</p>';
      try {
        floofData = await api('GET', '/api/admin/floof');
      } catch (e) {
        main.innerHTML = '<h2>Pet the Floof</h2><p class="muted">Could not load: ' + esc(e.message) + '</p>';
        return;
      }
      var c = floofData.config;
      var styles = floofData.styles || [];

      // Photos as a table: one row each, with a checkbox per animation style.
      var colspan = styles.length + 4;
      var photoRows = (floofData.images || []).length
        ? '<table class="floof-table"><thead><tr><th></th><th>Photo</th>' +
            styles.map(function (s) { return '<th class="mid">' + esc(styleLabel(s)) + '</th>'; }).join('') +
            '<th class="mid">Taunts</th><th></th></tr></thead><tbody>' +
          floofData.images.map(function (im, idx) {
            var none = !(im.styles || []).length;
            var taunts = im.taunts || [];
            return '<tr' + (none ? ' class="shelved"' : '') + '>' +
              '<td><img src="' + esc(im.url) + '" alt="" /></td>' +
              '<td class="nm">' + esc(im.name) +
                (none ? '<div class="muted" style="font-size:.75rem">never spawns — no animations enabled</div>' : '') +
                '<div class="muted" id="ftq-' + idx + '" style="font-size:.75rem' +
                  (taunts.length ? ';display:none' : '') + '">stays silent — no taunts</div>' + '</td>' +
              styles.map(function (s) {
                return '<td class="mid"><input type="checkbox" data-fstyle="' + esc(s) + '" data-fname="' + esc(im.name) + '"' +
                  ((im.styles || []).indexOf(s) !== -1 ? ' checked' : '') + ' /></td>';
              }).join('') +
              '<td class="mid"><button type="button" class="pink" data-ftoggle="ft-' + idx + '">' +
                taunts.length + '</button></td>' +
              '<td class="mid"><button type="button" class="pink" data-fdel="' + esc(im.name) + '">Delete</button></td>' +
            '</tr>' +
            // Editor for this floof's own lines, folded away until asked for.
            '<tr class="taunt-row hidden" id="ft-' + idx + '"><td colspan="' + colspan + '">' +
              '<div class="muted" style="font-size:.8rem; margin:0 0 .5rem">Speech-bubble lines for <strong>' + esc(im.name) +
              '</strong>. One is picked at random each time it goes unpet (never the same line twice running). Remove them all to keep this floof quiet.</div>' +
              '<div class="chips" id="ftc-' + idx + '">' + floofTauntChips(im.name, idx, taunts) + '</div>' +
              '<div class="rowline" style="margin-top:.6rem"><input type="text" maxlength="120" placeholder="add a taunt" data-ftnew="' + esc(im.name) + '" style="flex:1" />' +
              '<button type="button" class="pink" data-ftadd="' + esc(im.name) + '" data-fidx="' + idx + '">Add</button></div>' +
            '</td></tr>';
          }).join('') + '</tbody></table>'
        : '<span class="muted">No floofs uploaded yet. Add a square PNG to get started.</span>';

      var spawnPicker = '<select id="fl-pick-image"><option value="">Random floof</option>' +
        (floofData.images || []).map(function (im) {
          return '<option value="' + esc(im.name) + '">' + esc(im.name) + '</option>';
        }).join('') + '</select>' +
        '<select id="fl-pick-style"><option value="">Random animation</option>' +
        styles.map(function (s) { return '<option value="' + esc(s) + '">' + esc(styleLabel(s)) + '</option>'; }).join('') +
        '</select>';

      main.innerHTML = '<div class="panel-head"><h2>Pet the Floof</h2>' +
        '<span class="save-state" id="floof-status"></span></div>' +
        '<p class="muted">A floof appears on the overlay and the first chatter to type <code>!pet</code> wins. Each spawn picks a random photo <em>and</em> a random animation style. Add the <strong>Pet the Floof</strong> overlay from the Overlays section as a Browser Source.</p>' +

        // Actions first, so the buttons you reach for most are at the top.
        '<div class="card"><div class="rowline" style="gap:.6rem; flex-wrap:wrap; align-items:center">' +
          '<button type="button" class="pink" id="floof-fire">Spawn Floof</button>' + spawnPicker +
          '<button type="button" class="pink" id="floof-sim">Simulate !pet</button></div>' +
          '<p class="muted" style="font-size:.8rem; margin:.7rem 0 0"><strong>Spawn Floof</strong> ignores the enable switch and the live check, so you can test any time. <strong>Simulate !pet</strong> plays the win animation without recording a win.</p>' +
          '<div class="toast" id="floof-toast"></div></div>' +

        '<div class="card"><div class="rowline" style="justify-content:space-between; align-items:center">' +
          '<div><strong>Game enabled</strong>' +
          '<div class="muted" style="font-size:.82rem">When off, floofs never spawn on the timer. Floofs only appear while the stream is live.</div></div>' +
          '<label class="switch"><input type="checkbox" id="floof-enabled"' + (c.enabled ? ' checked' : '') + '><span class="slider"></span></label></div></div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Timing</h3>' +
          '<div class="grid-fields">' + FLOOF_TIMING.map(function (f) { return floofField(f, c); }).join('') + '</div>' +
          '<p class="muted" style="font-size:.8rem; margin:.5rem 0 0">With the defaults a floof appears every 16–24 minutes.</p></div>' +

        '<div class="card"><h3 style="margin:0 0 .3rem">Animation styles</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .9rem">One style is picked at random per spawn, from the ones the chosen photo allows.</p>' +
          FLOOF_ANIM.map(function (g) {
            return '<div class="anim-group"><h4>' + esc(styleLabel(g.style)) + '</h4>' +
              '<p class="muted" style="font-size:.8rem; margin:0 0 .5rem">' + esc(g.blurb) + '</p>' +
              '<div class="grid-fields">' + g.fields.map(function (f) { return floofField(f, c); }).join('') + '</div></div>';
          }).join('') + '</div>' +

        '<div class="card"><h3 style="margin:0 0 .3rem">Edge padding</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .6rem">Pixels kept clear so the floof never clips an edge. Padding also feathers the win effects that cross it, instead of hard-clipping them.</p>' +
          '<div class="grid-fields">' + FLOOF_PAD.map(function (f) {
            return '<label class="field"><span>' + esc(f.label) + '</span>' +
              '<input type="number" id="fl-' + f.key + '" value="' + c[f.key] + '" min="0" max="800" step="2" /></label>';
          }).join('') + '</div></div>' +

        '<div class="card"><h3 style="margin:0 0 .3rem">Floof photos</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .8rem">Square PNGs up to ' + Math.floor(floofData.maxBytes / 1048576) + 'MB, rendered at 128×128. Untick an animation to stop a photo using it — handy when a pose only reads well one way. A photo with none ticked is never spawned at random. Each floof also has <strong>its own taunts</strong>: hit the number in the Taunts column to edit them.</p>' +
          '<div class="rowline" style="gap:.6rem; align-items:center"><input type="file" id="floof-file" accept="image/png" />' +
          '<button type="button" class="pink" id="floof-upload">Upload</button></div>' +
          '<div style="margin-top:.9rem; overflow-x:auto">' + photoRows + '</div></div>';

      injectFloofCss();

      function collect() {
        var out = { enabled: document.getElementById('floof-enabled').checked };
        var all = FLOOF_TIMING.concat(FLOOF_PAD);
        FLOOF_ANIM.forEach(function (g) { all = all.concat(g.fields); });
        all.forEach(function (f) { out[f.key] = Number(document.getElementById('fl-' + f.key).value); });
        return out;
      }

      // Every settings control, and deliberately NOT the two spawn pickers.
      var floofIds = ['floof-enabled'];
      var floofFields = FLOOF_TIMING.concat(FLOOF_PAD);
      FLOOF_ANIM.forEach(function (g) { floofFields = floofFields.concat(g.fields); });
      floofFields.forEach(function (f) { floofIds.push('fl-' + f.key); });
      autoSaver('/api/admin/floof', collect, 'floof-status', floofIds);
      document.getElementById('floof-fire').onclick = function () {
        var image = document.getElementById('fl-pick-image').value;
        var style = document.getElementById('fl-pick-style').value;
        api('POST', '/api/admin/floof/fire', { image: image, style: style })
          .then(function () { toast('floof-toast', 'A floof is on the way!', true); })
          .catch(function (e) { toast('floof-toast', e.message, false); });
      };
      document.getElementById('floof-sim').onclick = function () {
        api('POST', '/api/admin/floof/simulate-pet', {})
          .then(function () { toast('floof-toast', 'Simulated a !pet (not scored).', true); })
          .catch(function (e) { toast('floof-toast', e.message, false); });
      };
      // Per-floof taunts: show/hide the editor, then add/remove lines on that floof.
      Array.prototype.forEach.call(document.querySelectorAll('[data-ftoggle]'), function (b) {
        b.onclick = function () {
          var row = document.getElementById(b.getAttribute('data-ftoggle'));
          if (row) row.classList.toggle('hidden');
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-ftadd]'), function (b) {
        var name = b.getAttribute('data-ftadd');
        var idx = b.getAttribute('data-fidx');
        var inp = document.querySelector('[data-ftnew="' + name + '"]');
        var add = function () {
          api('POST', '/api/admin/floof/taunt', { name: name, text: inp.value })
            .then(function (d) {
              inp.value = '';
              applyFloofTaunts(name, idx, d.taunts || []);
              inp.focus();                    // ready for the next line
              toast('floof-toast', 'Taunt added to ' + name + '.', true);
            })
            .catch(function (e) { toast('floof-toast', e.message, false); });
        };
        b.onclick = add;
        inp.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); add(); } };
      });
      wireFloofTauntChips(document);
      Array.prototype.forEach.call(document.querySelectorAll('[data-fstyle]'), function (cb) {
        cb.onchange = function () {
          var name = cb.getAttribute('data-fname');
          api('POST', '/api/admin/floof/image/style', { name: name, style: cb.getAttribute('data-fstyle'), on: cb.checked })
            .then(function (d) {
              // Re-render only if this photo just became (or stopped being) shelved.
              var row = cb.closest('tr');
              var none = !(d.styles || []).length;
              if (row) row.classList.toggle('shelved', none);
              toast('floof-toast', 'Animations updated for ' + name + '.', true);
              if (none || (d.styles || []).length === 1) renderFloof();
            })
            .catch(function (e) { cb.checked = !cb.checked; toast('floof-toast', e.message, false); });
        };
      });
      document.getElementById('floof-upload').onclick = function () {
        var inp = document.getElementById('floof-file');
        var file = inp.files && inp.files[0];
        if (!file) { toast('floof-toast', 'Choose a PNG first.', false); return; }
        // Raw binary body — no multipart parsing needed on the server.
        fetch('/api/admin/floof/image?name=' + encodeURIComponent(file.name), {
          method: 'POST', credentials: 'same-origin', body: file
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
          return r.json();
        }).then(function () { toast('floof-toast', 'Uploaded.', true); renderFloof(); })
          .catch(function (e) { toast('floof-toast', e.message, false); });
      };
      Array.prototype.forEach.call(document.querySelectorAll('[data-fdel]'), function (b) {
        b.onclick = function () {
          api('POST', '/api/admin/floof/image/delete', { name: b.getAttribute('data-fdel') })
            .then(function () { toast('floof-toast', 'Deleted.', true); renderFloof(); })
            .catch(function (e) { toast('floof-toast', e.message, false); });
        };
      });
    }

    function injectFloofCss() {
      if (document.getElementById('floof-css')) return;
      var st = document.createElement('style');
      st.id = 'floof-css';
      st.textContent = '.floof-table{width:100%;border-collapse:collapse;font-size:.9rem}'
        + '.floof-table th{text-align:left;font-size:.78rem;color:var(--muted);font-weight:600;padding:.3rem .5rem;white-space:nowrap}'
        + '.floof-table th.mid,.floof-table td.mid{text-align:center}'
        + '.floof-table td{padding:.35rem .5rem;border-top:1px solid var(--line);vertical-align:middle}'
        + '.floof-table img{width:52px;height:52px;object-fit:cover;border-radius:8px;background:#0008;display:block}'
        + '.floof-table td.nm{font-weight:600;word-break:break-all;min-width:9rem}'
        + '.floof-table tr.shelved td.nm,.floof-table tr.shelved img{opacity:.5}'
        + '.floof-table tr.taunt-row.hidden{display:none}'
        + '.floof-table tr.taunt-row td{background:var(--bg);border-top:0;padding:.2rem .6rem .8rem}'
        + '.anim-group{border-top:1px solid var(--line);padding:.8rem 0 .2rem}'
        + '.anim-group:first-of-type{border-top:0;padding-top:0}'
        + '.anim-group h4{margin:0 0 .2rem;font-size:.92rem}'
        + '@media (max-width:640px){.floof-table th,.floof-table td{padding:.3rem .25rem}'
        + '.floof-table img{width:40px;height:40px}.floof-table td.nm{min-width:6rem;font-size:.82rem}}';
      document.head.appendChild(st);
    }


    // ── Boss Battle: settings, triggers, the sound library and the boss roster ──
    var BOSS_ANIM = [
      { key: 'alertSeconds', label: 'Red alert holds', hint: 'seconds of klaxon before the dossier', min: 1, max: 15, step: 1 },
      { key: 'intelSeconds', label: 'Dossier holds', hint: 'seconds the boss intel screen stays up', min: 1, max: 30, step: 1 },
      { key: 'tauntEverySeconds', label: 'Taunt every', hint: 'seconds of movement between taunts', min: 3, max: 120, step: 1 },
      { key: 'tauntHoldSeconds', label: 'Taunt holds', hint: 'seconds the boss stops to speak', min: 1, max: 15, step: 1 },
      { key: 'dartSeconds', label: 'Dart leg', hint: 'seconds per zig-zag leg', min: 0.2, max: 3, step: 0.1 },
      { key: 'spinRadius', label: 'Spin radius', hint: 'pixels across the circular path', min: 40, max: 600, step: 10 },
      { key: 'spinSeconds', label: 'Spin lap', hint: 'seconds for one full circle', min: 2, max: 30, step: 1 },
      { key: 'crowdMax', label: 'Max fighters shown', hint: 'avatars drawn along the bottom', min: 1, max: 200, step: 1 },
      { key: 'outroTauntSeconds', label: 'Outro taunt holds', hint: 'seconds of dying words before the banner', min: 0, max: 15, step: 1 }
    ];
    var BOSS_CANNON = [
      { key: 'cannonRate', label: 'Conversion rate', hint: 'cannon points per duplicate emote', min: 0, max: 1, step: 0.05 },
      { key: 'cannonCap', label: 'Conversion cap', hint: 'most dupes one message may contribute', min: 0, max: 50, step: 1 },
      { key: 'cannonFull', label: 'Full size', hint: 'points needed before it fires', min: 1, max: 500, step: 1 },
      { key: 'cannonDamage', label: 'Damage', hint: 'HP the cannon takes off the boss', min: 1, max: 500, step: 1 },
      { key: 'cannonDischarge', label: 'Discharge rate', hint: 'points lost per second', min: 0, max: 10, step: 0.05 }
    ];
    var bossData = null;
    var bossEditing = null;   // the boss being edited, or null when the roster is showing

    function bossToast(msg, ok) { toast('boss-toast', msg, ok); }

    /** A <select> of every boss, defaulting to a random pick. */
    function bossPicker(id) {
      var opts = ['<option value="">Random</option>'];
      (bossData.bosses || []).forEach(function (b) {
        opts.push('<option value="' + b.id + '">' + esc(b.name) + (b.enabled ? '' : ' (disabled)') + '</option>');
      });
      return '<select id="' + id + '">' + opts.join('') + '</select>';
    }

    function pickedBoss(id) {
      var v = document.getElementById(id).value;
      return v ? Number(v) : null;
    }

    function numField(f, cfg) {
      return '<label class="field"><span>' + esc(f.label) + '</span>' +
        '<input type="number" id="boss-' + f.key + '" value="' + cfg[f.key] + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" />' +
        '<span class="muted" style="font-size:.78rem">' + esc(f.hint) + '</span></label>';
    }

    async function renderBoss() {
      document.getElementById('init-user-btn').style.display = 'none';
      document.getElementById('admin-sub').textContent = 'Boss Battle — chat fights a boss with emotes.';
      var main = document.getElementById('admin-main');
      main.innerHTML = '<h2>Boss Battle</h2><p class="muted">Loading…</p>';
      try {
        bossData = await api('GET', '/api/admin/boss');
      } catch (e) {
        main.innerHTML = '<h2>Boss Battle</h2><p class="muted">Could not load: ' + esc(e.message) + '</p>';
        return;
      }
      if (bossEditing) return renderBossEditor();

      var c = bossData.config;
      var roster = (bossData.bosses || []).length
        ? bossData.bosses.map(function (b) {
            var hurt = (b.emotesPublic || []).length + (b.emotesPrivate || []).length;
            return '<div class="boss-card">' +
              (b.imageUrl ? '<img src="' + esc(b.imageUrl) + '" alt="" />' : '<div class="noart">no art</div>') +
              '<div class="boss-meta"><div class="boss-name">' + esc(b.name) + (b.enabled ? '' : ' <span class="muted">(disabled)</span>') + '</div>' +
              '<div class="muted" style="font-size:.8rem">' + b.hp + ' HP · ' + hurt + ' weakness' + (hurt === 1 ? '' : 'es') +
              ' · ' + b.size + 'px · escapes in ' + b.escapeSeconds + 's</div></div>' +
              '<div class="rowline" style="gap:.4rem; flex-wrap:nowrap">' +
              '<button type="button" class="pink" data-bedit="' + b.id + '">Edit</button>' +
              '<button type="button" class="pink" data-bclone="' + b.id + '">Clone</button></div></div>';
          }).join('')
        : '<span class="muted">No bosses yet. Create one to get started.</span>';

      var soundRows = (bossData.sounds || []).map(function (s) {
        return '<div class="snd-row"><div><strong>' + esc(s.label) + '</strong>' +
          '<div class="muted" style="font-size:.78rem">' + esc(s.hint) + (s.file ? ' · ' + esc(s.file) + ' (' + Math.round(s.bytes / 1024) + ' KB)' : ' · empty') + '</div></div>' +
          '<div class="rowline" style="gap:.4rem; flex-wrap:nowrap">' +
          (s.url ? '<button type="button" class="pink" data-bplay="' + esc(s.url) + '">Play</button>' : '') +
          '<input type="file" accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav" data-bsnd="' + esc(s.slot) + '" />' +
          (s.file ? '<button type="button" class="pink" data-bsnddel="' + esc(s.slot) + '">Clear</button>' : '') +
          '</div></div>';
      }).join('');

      main.innerHTML = '<div class="panel-head"><h2>Boss Battle</h2>' +
        '<span class="save-state" id="boss-status"></span></div>' +
        '<p class="muted">Chat fights a boss by spamming the emotes it is weak to. Add the <strong>Boss Battle</strong> overlay from the Overlays section as a full-screen Browser Source, and tick <em>Control audio via OBS</em> so the sound reaches your stream.</p>' +

        '<div class="card"><div class="rowline" style="justify-content:space-between; align-items:center">' +
          '<div><strong>Game enabled</strong>' +
          '<div class="muted" style="font-size:.82rem">The buttons below always work; this switch gates any automatic trigger.</div></div>' +
          '<label class="switch"><input type="checkbox" id="boss-enabled"' + (c.enabled ? ' checked' : '') + '><span class="slider"></span></label></div></div>' +

        '<div class="card"><h3 style="margin:0 0 .5rem">Start a battle</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .7rem">Hit start before you step away — the boss arrives after the delay.</p>' +
          '<div class="rowline" style="gap:.6rem; align-items:center; flex-wrap:wrap">' + bossPicker('boss-pick') +
          '<label class="rowline" style="gap:.5rem; align-items:center"><span class="muted">Delay</span>' +
          '<input type="number" id="boss-delay" min="0" max="120" step="1" value="' + c.startDelaySeconds + '" />' +
          '<span class="muted">seconds</span></label></div>' +
          '<div class="rowline" style="gap:.6rem; margin-top:.8rem; flex-wrap:wrap">' +
          '<button type="button" class="pink" id="boss-start">Start Boss Battle</button>' +
          '<button type="button" class="pink" id="boss-cancel">Cancel</button></div></div>' +

        '<div class="card"><h3 style="margin:0 0 .5rem">Simulate</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .7rem">Runs the whole presentation but records nothing — no scoreboard, no achievements, no chat messages.</p>' +
          '<div class="rowline" style="gap:.6rem; flex-wrap:wrap">' +
          '<button type="button" class="pink" id="boss-sim-spawn">Spawn</button>' +
          '<button type="button" class="pink" id="boss-sim-hit">Hit</button>' +
          '<button type="button" class="pink" id="boss-sim-miss">Miss</button>' +
          '<button type="button" class="pink" id="boss-sim-heal">Heal</button>' +
          '<button type="button" class="pink" id="boss-sim-dupe">Dupe</button></div>' +
          '<p class="muted" style="font-size:.8rem; margin:.7rem 0 0"><strong>Dupe</strong> feeds the cannon one chatter\u2019s full allowance, so you can walk it up to a shot on your own.</p></div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Combat</h3>' +
          '<div class="grid-fields">' +
          numField({ key: 'cooldownSeconds', label: 'Emote cooldown', hint: 'seconds before a chatter lands again', min: 0, max: 600, step: 1 }, c) +
          '</div>' +
          '<p class="muted" style="font-size:.8rem; margin:.4rem 0 0">How long a chatter waits before their emotes land again. Everything they send while cooling down shows as a MISS — healers are held to the same clock.</p></div>' +

        '<div class="card"><h3 style="margin:0 0 .3rem">Mega cannon</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .8rem">Repeating an emote the boss is weak to no longer misses — those duplicates charge a shared cannon in the bottom centre of the screen, which fires for big damage once full. It bleeds charge continuously, so it takes sustained spam from the whole chat rather than one well-timed burst. A cannon kill leaves the <strong>Basecamp Hero</strong> badge unclaimed, since nobody fired it alone.</p>' +
          '<div class="grid-fields">' + BOSS_CANNON.map(function (f) { return numField(f, c); }).join('') + '</div>' +
          '<p class="muted" style="font-size:.8rem; margin:.7rem 0 0" id="boss-cannon-math"></p></div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Animation &amp; presentation</h3>' +
          '<div class="grid-fields">' + BOSS_ANIM.map(function (f) { return numField(f, c); }).join('') + '</div></div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Volume</h3>' +
          '<label class="rowline" style="gap:.6rem; align-items:center"><span style="flex:0 0 11rem">Sound effects</span>' +
          '<input type="range" id="boss-volumeSfx" min="0" max="100" step="1" value="' + c.volumeSfx + '" style="flex:1" />' +
          '<span class="muted" id="boss-volumeSfx-val" style="flex:0 0 3.4em; text-align:right"></span></label>' +
          '<label class="rowline" style="gap:.6rem; align-items:center; margin-top:.5rem"><span style="flex:0 0 11rem">Battle music</span>' +
          '<input type="range" id="boss-volumeBgm" min="0" max="100" step="1" value="' + c.volumeBgm + '" style="flex:1" />' +
          '<span class="muted" id="boss-volumeBgm-val" style="flex:0 0 3.4em; text-align:right"></span></label></div>' +

        '<div class="toast" id="boss-toast"></div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Sounds</h3>' +
          '<p class="muted" style="font-size:.85rem; margin:0 0 .7rem">MP3, OGG or WAV. Effects up to ' + Math.floor(bossData.maxSfxBytes / 1048576) + 'MB, music up to ' + Math.floor(bossData.maxBgmBytes / 1048576) + 'MB. An empty slot simply plays nothing.</p>' +
          soundRows + '</div>' +

        '<div class="card"><div class="rowline" style="justify-content:space-between; align-items:center; margin:0 0 .7rem">' +
          '<h3 style="margin:0">Bosses</h3><button type="button" class="pink" id="boss-new">Create New Boss</button></div>' +
          '<div class="boss-list">' + roster + '</div></div>';

      injectBossCss();

      // Live value read-outs on the sliders.
      // Only the volume sliders still need a value read-out; the delay and cooldown
      // are number fields now and show their own value.
      ['boss-volumeSfx', 'boss-volumeBgm'].forEach(function (id) {
        var r = document.getElementById(id);
        var out = document.getElementById(id + '-val');
        var sync = function () { out.textContent = r.value + '%'; };
        r.oninput = sync;
        sync();
      });

      // Spell out what the five numbers add up to, since their interaction is
      // much easier to grasp as "N chatters within M seconds".
      function cannonMath() {
        var rate = Number(document.getElementById('boss-cannonRate').value);
        var cap = Number(document.getElementById('boss-cannonCap').value);
        var full = Number(document.getElementById('boss-cannonFull').value);
        var dmg = Number(document.getElementById('boss-cannonDamage').value);
        var drain = Number(document.getElementById('boss-cannonDischarge').value);
        var out = document.getElementById('boss-cannon-math');
        var perUser = rate * cap;
        if (perUser <= 0) { out.textContent = 'With these numbers the cannon can never charge.'; return; }
        var users = Math.ceil(full / perUser);
        var txt = 'One chatter at full allowance adds ' + (Math.round(perUser * 100) / 100) +
          ' points, so it takes about ' + users + (users === 1 ? ' message' : ' such messages') +
          ' to fire for ' + dmg + ' damage.';
        if (drain > 0) txt += ' A full cannon drains away in ' + Math.round(full / drain) + 's if chat goes quiet.';
        out.textContent = txt;
      }
      BOSS_CANNON.forEach(function (f) { document.getElementById('boss-' + f.key).oninput = cannonMath; });
      cannonMath();

      function bossCollect() {
        var out = { enabled: document.getElementById('boss-enabled').checked,
          cooldownSeconds: Number(document.getElementById('boss-cooldownSeconds').value),
          startDelaySeconds: Number(document.getElementById('boss-delay').value),
          volumeSfx: Number(document.getElementById('boss-volumeSfx').value),
          volumeBgm: Number(document.getElementById('boss-volumeBgm').value) };
        BOSS_ANIM.concat(BOSS_CANNON).forEach(function (f) { out[f.key] = Number(document.getElementById('boss-' + f.key).value); });
        return out;
      }
      // Every settings control, and deliberately NOT the boss picker.
      var bossIds = ['boss-enabled', 'boss-delay', 'boss-cooldownSeconds', 'boss-volumeSfx', 'boss-volumeBgm'];
      BOSS_ANIM.concat(BOSS_CANNON).forEach(function (f) { bossIds.push('boss-' + f.key); });
      autoSaver('/api/admin/boss', bossCollect, 'boss-status', bossIds);

      document.getElementById('boss-start').onclick = function () {
        api('POST', '/api/admin/boss/start', { bossId: pickedBoss('boss-pick'), delaySeconds: Number(document.getElementById('boss-delay').value) })
          .then(function () { bossToast('Battle queued.', true); })
          .catch(function (e) { bossToast(e.message, false); });
      };
      document.getElementById('boss-cancel').onclick = function () {
        api('POST', '/api/admin/boss/cancel', {})
          .then(function () { bossToast('Cancelled.', true); })
          .catch(function (e) { bossToast(e.message, false); });
      };
      document.getElementById('boss-sim-spawn').onclick = function () {
        api('POST', '/api/admin/boss/sim/spawn', { bossId: pickedBoss('boss-pick') })
          .then(function () { bossToast('Mock battle incoming (nothing is recorded).', true); })
          .catch(function (e) { bossToast(e.message, false); });
      };
      ['hit', 'miss', 'heal', 'dupe'].forEach(function (action) {
        document.getElementById('boss-sim-' + action).onclick = function () {
          api('POST', '/api/admin/boss/sim/action', { action: action })
            .then(function () { bossToast('Simulated a ' + action + '.', true); })
            .catch(function (e) { bossToast(e.message, false); });
        };
      });

      document.getElementById('boss-new').onclick = function () {
        bossEditing = { id: 0, name: '', description: '', image: '', hp: 20, emotesPublic: [], emotesPrivate: [],
          emotesHeal: [], tauntOpening: '', tauntBattle: [], tauntDeath: '', tauntEscape: '', escapeSeconds: 180,
          size: 256, speedFull: 9, speedNearDeath: 2, styles: ['pingpong'], enabled: true };
        renderBossEditor();
      };
      Array.prototype.forEach.call(document.querySelectorAll('[data-bedit]'), function (b) {
        b.onclick = function () {
          var id = Number(b.getAttribute('data-bedit'));
          var found = bossData.bosses.filter(function (x) { return x.id === id; })[0];
          if (!found) return;
          // Clone so an abandoned edit never mutates the cached roster.
          bossEditing = JSON.parse(JSON.stringify(found));
          renderBossEditor();
        };
      });

      Array.prototype.forEach.call(document.querySelectorAll('[data-bclone]'), function (b) {
        b.onclick = function () {
          api('POST', '/api/admin/boss/clone', { id: Number(b.getAttribute('data-bclone')) })
            .then(function (d) {
              // Drop straight into the copy so only the differences need typing.
              bossEditing = d.boss;
              renderBoss();
              bossToast('Cloned — left out of the random pool until you enable it.', true);
            })
            .catch(function (e) { bossToast(e.message, false); });
        };
      });

      // Sound library wiring.
      Array.prototype.forEach.call(document.querySelectorAll('[data-bplay]'), function (b) {
        b.onclick = function () {
          try { var a = new Audio(b.getAttribute('data-bplay')); a.volume = 0.8; a.play(); } catch (e) { bossToast('Could not play that file.', false); }
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-bsnd]'), function (inp) {
        inp.onchange = function () {
          var file = inp.files && inp.files[0];
          if (!file) return;
          fetch('/api/admin/boss/sound?slot=' + encodeURIComponent(inp.getAttribute('data-bsnd')) + '&name=' + encodeURIComponent(file.name), {
            method: 'POST', credentials: 'same-origin', body: file
          }).then(function (r) {
            if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
            return r.json();
          }).then(function () { bossToast('Sound uploaded.', true); renderBoss(); })
            .catch(function (e) { bossToast(e.message, false); });
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-bsnddel]'), function (b) {
        b.onclick = function () {
          api('POST', '/api/admin/boss/sound/delete', { slot: b.getAttribute('data-bsnddel') })
            .then(function () { bossToast('Cleared.', true); renderBoss(); })
            .catch(function (e) { bossToast(e.message, false); });
        };
      });
    }

    /** Editable chip list used for the three emote lists and the battle taunts. */
    function chipList(id, items, placeholder) {
      var chips = (items || []).length
        ? items.map(function (t) {
            return '<span class="chip">' + esc(t) + '<button type="button" class="chip-x" data-bchip="' + esc(id) + '" data-bval="' + esc(t) + '" aria-label="Remove">×</button></span>';
          }).join('')
        : '<span class="muted">none</span>';
      return '<div class="chips" id="chips-' + id + '">' + chips + '</div>' +
        '<div class="rowline" style="margin-top:.5rem"><input type="text" id="new-' + id + '" placeholder="' + esc(placeholder) + '" style="flex:1" />' +
        '<button type="button" class="pink" data-badd="' + id + '">Add</button></div>';
    }

    function renderBossEditor() {
      var b = bossEditing;
      var main = document.getElementById('admin-main');
      document.getElementById('admin-sub').textContent = b.id ? 'Editing ' + b.name : 'Creating a new boss';

      var artOpts = ['<option value="">— no art —</option>'].concat((bossData.images || []).map(function (i) {
        return '<option value="' + esc(i.name) + '"' + (i.name === b.image ? ' selected' : '') + '>' + esc(i.name) + '</option>';
      })).join('');
      var styleBoxes = (bossData.styles || []).map(function (s) {
        var labels = { pingpong: 'Ping Pong — drifts and bounces off the edges', darting: 'Darting — zig-zags to random points', spin: 'Spin — orbits a point while rotating' };
        return '<label class="rowline" style="gap:.5rem; align-items:center"><input type="checkbox" data-bstyle="' + esc(s) + '"' +
          ((b.styles || []).indexOf(s) !== -1 ? ' checked' : '') + ' /><span>' + esc(labels[s] || s) + '</span></label>';
      }).join('');
      var sizeOpts = (bossData.sizes || []).map(function (n) {
        return '<option value="' + n + '"' + (n === b.size ? ' selected' : '') + '>' + n + ' × ' + n + '</option>';
      }).join('');

      main.innerHTML = '<h2>' + (b.id ? 'Edit boss' : 'New boss') + '</h2>' +
        '<div class="card"><div class="grid-fields">' +
          '<label class="field"><span>Name</span><input type="text" id="be-name" maxlength="60" value="' + esc(b.name) + '" /><span class="muted" style="font-size:.78rem">Shown in the dossier and in chat.</span></label>' +
          '<label class="field"><span>Health (HP)</span><input type="number" id="be-hp" min="1" max="500" value="' + b.hp + '" /><span class="muted" style="font-size:.78rem">Distinct vulnerable emotes needed to kill it.</span></label>' +
          '<label class="field"><span>Escapes after</span><input type="number" id="be-escapeSeconds" min="10" max="3600" step="5" value="' + b.escapeSeconds + '" /><span class="muted" style="font-size:.78rem">Seconds the fight lasts.</span></label>' +
          '<label class="field"><span>Size</span><select id="be-size">' + sizeOpts + '</select><span class="muted" style="font-size:.78rem">Rendered size on a 1920×1080 overlay.</span></label>' +
          '<label class="field"><span>Speed at full health</span><input type="number" id="be-speedFull" min="1" max="10" value="' + b.speedFull + '" /><span class="muted" style="font-size:.78rem">1 slow – 10 fast.</span></label>' +
          '<label class="field"><span>Speed near death</span><input type="number" id="be-speedNearDeath" min="1" max="10" value="' + b.speedNearDeath + '" /><span class="muted" style="font-size:.78rem">Interpolated as health drains — either direction works.</span></label>' +
        '</div>' +
        '<label class="field" style="margin-top:.8rem"><span>Description</span>' +
        '<textarea id="be-description" rows="2" maxlength="400">' + esc(b.description) + '</textarea>' +
        '<span class="muted" style="font-size:.78rem">Typed out on the intel screen under the name.</span></label>' +
        '<div class="rowline" style="gap:.6rem; align-items:center; margin-top:.8rem; flex-wrap:wrap">' +
          '<label class="field" style="flex:1; min-width:14rem"><span>Portrait</span><select id="be-image">' + artOpts + '</select></label>' +
          (b.image ? '<img class="be-preview" src="' + esc('/assets/boss/' + b.image) + '" alt="" />' : '') +
          '<label class="rowline" style="gap:.5rem; align-items:center"><input type="file" id="be-file" accept="image/png" />' +
          '<button type="button" class="pink" id="be-upload">Upload PNG</button></label></div>' +
        '<label class="rowline" style="gap:.5rem; align-items:center; margin-top:.8rem"><input type="checkbox" id="be-enabled"' + (b.enabled ? ' checked' : '') + ' />' +
        '<span>Include in the random pool</span></label></div>' +

        '<div class="card"><h3 style="margin:0 0 .3rem">Vulnerabilities</h3>' +
        '<p class="muted" style="font-size:.85rem; margin:0 0 .8rem">Twitch emote names, exactly as typed in chat — <strong>case matters</strong> (Kappa is not kappa). Each distinct matching emote in a message takes off 1 HP; repeats and anything else are misses.</p>' +
        '<h4 style="margin:.2rem 0 .4rem; font-size:.9rem">Emotes that hurt — public <span class="muted" style="font-weight:400">(revealed on the intel screen)</span></h4>' +
        chipList('pub', b.emotesPublic, 'e.g. Kappa') +
        '<h4 style="margin:1rem 0 .4rem; font-size:.9rem">Emotes that hurt — private <span class="muted" style="font-weight:400">(shown only as “???”)</span></h4>' +
        chipList('priv', b.emotesPrivate, 'a secret weakness') +
        '<h4 style="margin:1rem 0 .4rem; font-size:.9rem">Emotes that heal <span class="muted" style="font-weight:400">(never revealed)</span></h4>' +
        chipList('heal', b.emotesHeal, 'heals the boss') + '</div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Taunts</h3>' +
        '<label class="field"><span>Opening taunt</span><input type="text" id="be-tauntOpening" maxlength="200" value="' + esc(b.tauntOpening) + '" /></label>' +
        '<h4 style="margin:1rem 0 .4rem; font-size:.9rem">Battle taunts <span class="muted" style="font-weight:400">(one picked at random each pause)</span></h4>' +
        chipList('taunt', b.tauntBattle, 'add a battle taunt') +
        '<div class="grid-fields" style="margin-top:1rem">' +
        '<label class="field"><span>Death taunt</span><input type="text" id="be-tauntDeath" maxlength="200" value="' + esc(b.tauntDeath) + '" /></label>' +
        '<label class="field"><span>Escape taunt</span><input type="text" id="be-tauntEscape" maxlength="200" value="' + esc(b.tauntEscape) + '" /></label>' +
        '</div></div>' +

        '<div class="card"><h3 style="margin:0 0 .6rem">Movement styles</h3>' +
        '<p class="muted" style="font-size:.85rem; margin:0 0 .7rem">One is re-rolled from the ticked styles every time the boss pauses to taunt.</p>' +
        styleBoxes + '</div>' +

        '<div class="rowline" style="gap:.6rem; flex-wrap:wrap">' +
        '<button type="button" class="pink" id="be-save">' + (b.id ? 'Save boss' : 'Create boss') + '</button>' +
        '<button type="button" class="pink" id="be-back">Back to roster</button>' +
        (b.id ? '<button type="button" class="danger" id="be-delete">Delete boss</button>' : '') +
        '</div><div class="toast" id="boss-toast"></div>';

      injectBossCss();

      var LISTS = { pub: 'emotesPublic', priv: 'emotesPrivate', heal: 'emotesHeal', taunt: 'tauntBattle' };
      Array.prototype.forEach.call(document.querySelectorAll('[data-badd]'), function (btn) {
        var id = btn.getAttribute('data-badd');
        var inp = document.getElementById('new-' + id);
        var add = function () {
          var v = inp.value.trim();
          if (!v) return;
          var arr = bossEditing[LISTS[id]] || [];
          if (arr.indexOf(v) === -1) arr.push(v);
          bossEditing[LISTS[id]] = arr;
          collectEditor();      // keep the other fields' edits before re-rendering
          renderBossEditor();
        };
        btn.onclick = add;
        inp.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); add(); } };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-bchip]'), function (btn) {
        btn.onclick = function () {
          var id = btn.getAttribute('data-bchip');
          var val = btn.getAttribute('data-bval');
          bossEditing[LISTS[id]] = (bossEditing[LISTS[id]] || []).filter(function (t) { return t !== val; });
          collectEditor();
          renderBossEditor();
        };
      });

      document.getElementById('be-image').onchange = function () { collectEditor(); renderBossEditor(); };
      document.getElementById('be-upload').onclick = function () {
        var inp = document.getElementById('be-file');
        var file = inp.files && inp.files[0];
        if (!file) { bossToast('Choose a square PNG first.', false); return; }
        fetch('/api/admin/boss/image?name=' + encodeURIComponent(file.name), {
          method: 'POST', credentials: 'same-origin', body: file
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
          return r.json();
        }).then(function (d) {
          collectEditor();
          bossEditing.image = d.image.name;   // select what was just uploaded
          bossToast('Uploaded.', true);
          renderBoss();
        }).catch(function (e) { bossToast(e.message, false); });
      };

      document.getElementById('be-back').onclick = function () { bossEditing = null; renderBoss(); };
      document.getElementById('be-save').onclick = function () {
        collectEditor();
        if (!bossEditing.name) { bossToast('Give the boss a name.', false); return; }
        api('POST', '/api/admin/boss/save', { id: bossEditing.id || null, boss: bossEditing })
          .then(function () { bossEditing = null; renderBoss(); bossToast('Boss saved.', true); })
          .catch(function (e) { bossToast(e.message, false); });
      };
      var del = document.getElementById('be-delete');
      if (del) del.onclick = function () {
        if (!window.confirm('Delete "' + bossEditing.name + '" for good?')) return;
        api('POST', '/api/admin/boss/delete', { id: bossEditing.id })
          .then(function () { bossEditing = null; renderBoss(); })
          .catch(function (e) { bossToast(e.message, false); });
      };
    }

    /** Read every editor field back into the draft, so a re-render loses nothing. */
    function collectEditor() {
      var b = bossEditing;
      if (!b) return;
      var val = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
      b.name = val('be-name').trim();
      b.description = val('be-description');
      b.image = val('be-image');
      b.hp = Number(val('be-hp'));
      b.escapeSeconds = Number(val('be-escapeSeconds'));
      b.size = Number(val('be-size'));
      b.speedFull = Number(val('be-speedFull'));
      b.speedNearDeath = Number(val('be-speedNearDeath'));
      b.tauntOpening = val('be-tauntOpening');
      b.tauntDeath = val('be-tauntDeath');
      b.tauntEscape = val('be-tauntEscape');
      var en = document.getElementById('be-enabled');
      b.enabled = en ? en.checked : true;
      var styles = [];
      Array.prototype.forEach.call(document.querySelectorAll('[data-bstyle]'), function (cb) {
        if (cb.checked) styles.push(cb.getAttribute('data-bstyle'));
      });
      b.styles = styles.length ? styles : ['pingpong'];
    }

    function injectBossCss() {
      if (document.getElementById('boss-css')) return;
      var st = document.createElement('style');
      st.id = 'boss-css';
      st.textContent = '.boss-list{display:flex;flex-direction:column;gap:.6rem}'
        + '.boss-card{display:flex;align-items:center;gap:.8rem;background:var(--bg);border:1px solid var(--line);'
        + 'border-radius:10px;padding:.55rem .7rem}'
        + '.boss-card img{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#0008;flex:0 0 auto}'
        + '.boss-card .noart{width:56px;height:56px;border-radius:8px;background:#0004;display:flex;align-items:center;'
        + 'justify-content:center;font-size:.68rem;color:var(--muted);flex:0 0 auto;text-align:center}'
        + '.boss-card .boss-meta{flex:1;min-width:0}'
        + '.boss-card .boss-name{font-weight:600}'
        + '.be-preview{width:72px;height:72px;object-fit:cover;border-radius:10px;background:#0008}'
        + '.snd-row{display:flex;align-items:center;justify-content:space-between;gap:.8rem;flex-wrap:wrap;'
        + 'padding:.5rem 0;border-top:1px solid var(--line)}'
        + '.snd-row:first-of-type{border-top:0}'
        + '.snd-row input[type=file]{max-width:13rem}'
        + '@media (max-width:640px){.boss-card{flex-wrap:wrap}.snd-row{flex-direction:column;align-items:flex-start}}';
      document.head.appendChild(st);
    }

    window.onMe = async function (me) {
      var admin = !!(me && me.relationship && (me.relationship.broadcaster || me.relationship.botAdmin));
      if (!admin) {
        document.getElementById('admin-denied').style.display = '';
        document.getElementById('admin-sub').textContent = '';
        return;
      }
      document.getElementById('admin-layout').style.display = '';
      try {
        await reload();
        render();
      } catch (e) {
        document.getElementById('admin-sub').textContent = e.message;
      }
    };

    document.getElementById('u-cancel').onclick = function () { closeDialog('user-dlg'); };
    document.getElementById('u-alias-add').onclick = function () {
      var inp = document.getElementById('u-alias-new');
      var v = inp.value.trim();
      if (!v) return;
      if (draftAliases.indexOf(v) === -1) draftAliases.push(v);
      inp.value = '';
      renderDraftAliases();
    };

    document.getElementById('u-save').onclick = async function () {
      if (!editing) return;
      // Diff the draft against what the user had, so unchanged aliases aren't
      // re-added (which the server would reject as already taken).
      var had = editing.aliases;
      var add = draftAliases.filter(function (a) { return had.indexOf(a) === -1; });
      var remove = had.filter(function (a) { return draftAliases.indexOf(a) === -1; });
      var display = document.getElementById('u-display').value.trim();
      var points = document.getElementById('u-points').value;
      try {
        await api('POST', '/api/admin/users/update', {
          id: editing.id,
          displayName: display !== editing.displayName ? display : undefined,
          addAliases: add,
          removeAliases: remove,
          points: points === '' ? undefined : Number(points),
        });
        closeDialog('user-dlg');
        await reload();
        render();
      } catch (e) {
        toast('user-toast', e.message, false);
      }
    };

    document.getElementById('u-delete').onclick = function () {
      if (!editing) return;
      closeDialog('user-dlg');
      openDelete(editing);
    };

    document.getElementById('udel-cancel').onclick = function () { closeDialog('udel-dlg'); };
    document.getElementById('udel-confirm').onclick = async function () {
      if (!pendingDelete) return;
      try {
        await api('POST', '/api/admin/users/delete', { id: pendingDelete.id });
        closeDialog('udel-dlg');
        await reload();
        render();
      } catch (e) {
        toast('udel-toast', e.message, false);
      }
    };

    document.getElementById('init-user-btn').onclick = function () {
      document.getElementById('init-handle').value = '';
      toast('init-toast', '');
      openDialog('init-dlg');
    };
    document.getElementById('init-cancel').onclick = function () { closeDialog('init-dlg'); };
    document.getElementById('init-save').onclick = async function () {
      var handle = document.getElementById('init-handle').value.trim();
      if (!handle) { toast('init-toast', 'Enter a Twitch username.', false); return; }
      try {
        var d = await api('POST', '/api/admin/users/init', { handle: handle });
        closeDialog('init-dlg');
        await reload();
        render();
        openEdit(users.filter(function (u) { return u.id === d.user.id; })[0] || d.user);
      } catch (e) {
        toast('init-toast', e.message, false);
      }
    };
  `;

  return renderLayout({ title: 'Admin · BasecaBot', active: 'admin', wide: true, body, script });
}
