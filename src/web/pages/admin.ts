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
      <nav class="md-side card" id="admin-side"></nav>
      <div class="md-main card" id="admin-main"></div>
    </div>

    <dialog id="user-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(38rem,94vw)">
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

    <dialog id="init-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(32rem,94vw)">
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

    <dialog id="udel-dlg" style="background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:12px; width:min(32rem,94vw)">
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

    function toast(id, msg, ok) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = msg || '';
      el.className = 'toast ' + (ok ? 'ok' : 'err');
    }

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
      document.getElementById('user-dlg').showModal();
    }

    function openDelete(u) {
      pendingDelete = u;
      document.getElementById('udel-msg').innerHTML =
        '<strong>' + esc(u.displayName) + '</strong> (' + esc(u.canonical) + ') — ' +
        u.points + ' points, ' + u.quotes + (u.quotes === 1 ? ' quote' : ' quotes') + '.';
      toast('udel-toast', '');
      document.getElementById('udel-dlg').showModal();
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
      else renderSim();
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

    document.getElementById('u-cancel').onclick = function () { document.getElementById('user-dlg').close(); };
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
        document.getElementById('user-dlg').close();
        await reload();
        render();
      } catch (e) {
        toast('user-toast', e.message, false);
      }
    };

    document.getElementById('u-delete').onclick = function () {
      if (!editing) return;
      document.getElementById('user-dlg').close();
      openDelete(editing);
    };

    document.getElementById('udel-cancel').onclick = function () { document.getElementById('udel-dlg').close(); };
    document.getElementById('udel-confirm').onclick = async function () {
      if (!pendingDelete) return;
      try {
        await api('POST', '/api/admin/users/delete', { id: pendingDelete.id });
        document.getElementById('udel-dlg').close();
        await reload();
        render();
      } catch (e) {
        toast('udel-toast', e.message, false);
      }
    };

    document.getElementById('init-user-btn').onclick = function () {
      document.getElementById('init-handle').value = '';
      toast('init-toast', '');
      document.getElementById('init-dlg').showModal();
    };
    document.getElementById('init-cancel').onclick = function () { document.getElementById('init-dlg').close(); };
    document.getElementById('init-save').onclick = async function () {
      var handle = document.getElementById('init-handle').value.trim();
      if (!handle) { toast('init-toast', 'Enter a Twitch username.', false); return; }
      try {
        var d = await api('POST', '/api/admin/users/init', { handle: handle });
        document.getElementById('init-dlg').close();
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
