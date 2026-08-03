/**
 * Shared page shell: the common header/nav + a consistent dark theme, plus a
 * bootstrap script that loads the current user once (GET /api/me), fills the
 * nav's user area, and hands the data to the page via `window.onMe(me)`.
 *
 * Pages call `renderLayout({...})` with their body markup and an optional script
 * that defines `window.onMe`.
 */
export interface LayoutOptions {
  title: string;
  /** Which nav item to highlight. */
  active?: 'commands' | 'lists' | 'quotes' | 'user' | 'admin' | '';
  /** Page body markup (inside <main>). */
  body: string;
  /** Optional page script (runs after the shell script; may define window.onMe). */
  script?: string;
  /** Use a wider content column (for data-heavy pages like Commands). */
  wide?: boolean;
}

const SHARED_STYLE = /* css */ `
  :root {
    color-scheme: dark;
    --bg: #0e0e10; --panel: #18181b; --border: #2a2a2d; --text: #efeff1; --muted: #adadb8;
    --pink: #ff6ec7; --purple: #a970ff; --purple-dark: #772ce8; --green: #3fb950; --off: #6e6e77;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
  a { color: var(--purple); text-decoration: none; }
  header.nav {
    display: flex; align-items: center; gap: 1.25rem; padding: 0.6rem 1.25rem;
    background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 0.6rem; }
  .brand img.logo { height: 40px; width: 40px; border-radius: 50%; object-fit: cover; }
  .brand .title { font-size: 1.25rem; font-weight: 800; color: var(--pink); letter-spacing: 0.2px; }
  nav.links { display: flex; gap: 1rem; align-items: center; }
  nav.links a { color: var(--muted); font-weight: 600; padding: 0.35rem 0.2rem; border-bottom: 2px solid transparent; }
  nav.links a:hover { color: var(--text); }
  nav.links a.active { color: var(--text); border-bottom-color: var(--pink); }
  /* Fills the header between the brand and the right edge; space-between anchors
     the links on the left (next to the brand) and the user area on the right. */
  .nav-menu { display: flex; align-items: center; gap: 1.25rem; flex: 1; justify-content: space-between; }
  /* Hamburger — hidden on desktop, shown at the mobile breakpoint below. */
  .nav-toggle { display: none; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 1.25rem; line-height: 1; padding: .35rem .55rem; border-radius: 8px; cursor: pointer; }
  .nav-toggle:hover { background: #241f2b; }
  a.nav-user { display: flex; align-items: center; gap: 0.55rem; color: var(--text); font-weight: 600; }
  a.nav-user img { height: 34px; width: 34px; border-radius: 50%; border: 2px solid var(--purple); }
  main { width: min(56rem, 92vw); margin: 2rem auto; }
  main.wide { width: min(115rem, 98vw); }
  td.wrap { white-space: normal; min-width: 11rem; }
  th.wrap { min-width: 11rem; }
  section.cmd-group { margin-bottom: 1.75rem; }
  section.cmd-group > h2 { display: flex; align-items: baseline; gap: .5rem; }
  section.cmd-group > h2 .count, h2 .count { font-size: .8rem; color: var(--muted); font-weight: 500; }
  /* master-detail (sidebar + content) — two separate panels */
  .page-head { margin-bottom: 1rem; }
  .page-head h1 { margin-bottom: .25rem; }
  .md-layout { display: flex; gap: 1.25rem; align-items: flex-start; }
  .md-side { flex: 0 0 16.5rem; padding: .85rem; position: sticky; top: 4.75rem; }
  /* The sidebar's mobile "dropdown" toggle — hidden on desktop. */
  .md-side-toggle { display: none; }
  .md-side .label { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: .75rem .2rem .35rem; }
  .md-side .item { display: block; width: 100%; text-align: left; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: .55rem .75rem; margin-bottom: .4rem; color: var(--text); cursor: pointer; font-size: .95rem; font-family: inherit; white-space: nowrap; }
  .md-side .item:hover { border-color: var(--purple); }
  .md-side .item.active { border-color: var(--pink); background: #241f2b; }
  .md-side .item .count { float: right; color: var(--muted); font-size: .82rem; }
  /* Indented custom-group buttons with a tree line up to "All Custom Commands". */
  .md-side .subgroups { margin: -0.15rem 0 0.4rem 0.85rem; padding-left: 0.85rem; border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.35rem; }
  .md-side .subgroups .item { position: relative; margin-bottom: 0; font-size: 0.88rem; }
  .md-side .subgroups .item::before { content: ''; position: absolute; left: -0.85rem; top: 50%; width: 0.7rem; height: 1px; background: var(--border); }
  /* Last group: hide the vertical line below its connector so it reads as an L, not a T. */
  .md-side .subgroups .item:last-child::after { content: ''; position: absolute; left: calc(-0.85rem - 2px); top: calc(50% + 1px); bottom: -0.6rem; width: 4px; background: var(--panel); }
  .md-main { flex: 1 1 auto; min-width: 0; }
  .md-main > h2 { margin-top: 0; }
  /* Right-hand column: stacks the main panel and any panels beneath it (e.g. the
     Lists page's "Commands Referencing …" card) so they share the main width and
     never extend under the sidebar. */
  .md-col { flex: 1 1 auto; min-width: 0; }
  .md-col > * + * { margin-top: 1.25rem; }
  /* Slightly denser tables in the command panels so more columns fit without scroll. */
  .md-main table { font-size: 0.9rem; }
  .md-main th, .md-main td { padding: 0.5rem 0.5rem; }
  /* Built-in (plugin) tables: Command fits its content, Access/Cooldown fixed, Description takes the rest. */
  table.cmd-builtins { width: 100%; table-layout: auto; }
  table.cmd-builtins th:nth-child(1), table.cmd-builtins td:nth-child(1) { white-space: nowrap; width: 1%; }
  table.cmd-builtins th:nth-child(2), table.cmd-builtins td:nth-child(2) { white-space: nowrap; width: 7.5rem; }
  table.cmd-builtins th:nth-child(3), table.cmd-builtins td:nth-child(3) { white-space: nowrap; width: 9rem; }
  table.cmd-builtins td:nth-child(3) .cd-cell { flex-wrap: nowrap; }
  table.cmd-builtins th:nth-child(4), table.cmd-builtins td:nth-child(4) { white-space: normal; width: 100%; }
  /* ── Mobile (phones) ── main nav collapses to a hamburger dropdown; the
     master-detail sidebar collapses to a tap-to-open dropdown. */
  @media (max-width: 640px) {
    header.nav { gap: .6rem; padding: .55rem .8rem; }
    .brand .title { font-size: 1.1rem; }
    .nav-toggle { display: block; margin-left: auto; } /* anchor the hamburger on the right */
    .nav-menu {
      display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 20;
      flex-direction: column; align-items: stretch; justify-content: flex-start; gap: .25rem;
      background: var(--panel); border-bottom: 1px solid var(--border);
      padding: .5rem .8rem; box-shadow: 0 10px 18px rgba(0,0,0,.4);
    }
    .nav-menu.open { display: flex; }
    nav.links { flex-direction: column; align-items: stretch; gap: 0; width: 100%; }
    nav.links a { padding: .65rem .4rem; border-bottom: 1px solid var(--border); }
    nav.links a.active { color: var(--pink); }
    #nav-right { padding-top: .5rem; }
    #nav-right a.nav-user, #nav-right a.btn { width: 100%; justify-content: center; }

    main { width: 94vw; margin: 1rem auto; }
    main.wide { width: 96vw; }
    .card { padding: 1rem; }
    .page-head { flex-wrap: wrap; }

    .md-layout { flex-direction: column; gap: .7rem; }
    .md-side { position: static; width: 100%; flex-basis: auto; display: none; padding: .6rem; }
    .md-side.open { display: block; }
    .md-side-toggle {
      display: flex; align-items: center; justify-content: space-between; gap: .5rem; width: 100%;
      background: var(--bg); border: 1px solid var(--border); color: var(--text); font-family: inherit;
      font-weight: 600; font-size: .95rem; padding: .6rem .8rem; border-radius: 8px; cursor: pointer; text-align: left;
    }
    .md-side-toggle::after { content: '▾'; color: var(--muted); }
    .md-side-toggle.open::after { content: '▴'; }
  }
  /* connected-squares pagination (lives outside the panel, centered) */
  .pager-wrap { display: flex; flex-direction: column; align-items: center; gap: .55rem; margin: 1.25rem 0 .5rem; }
  .pager { display: inline-flex; }
  .pager .pg { min-width: 2.4rem; height: 2.4rem; padding: 0 .5rem; display: inline-flex; align-items: center; justify-content: center;
               border: 1px solid var(--border); border-left-width: 0; background: var(--panel); color: var(--text); font-size: .95rem; user-select: none; cursor: pointer; }
  .pager .pg:first-child { border-left-width: 1px; border-radius: 8px 0 0 8px; }
  .pager .pg:last-child { border-radius: 0 8px 8px 0; }
  .pager .pg:hover:not(.current):not(.disabled):not(.ellipsis) { background: #241f2b; }
  .pager .pg.current { background: var(--pink); border-color: var(--pink); color: #fff; font-weight: 700; }
  .pager .pg.ellipsis { cursor: default; color: var(--muted); }
  .pager .pg.disabled { cursor: default; color: var(--off); }
  .linkish { background: none; border: none; color: var(--muted); cursor: pointer; font-size: .85rem; text-decoration: underline; padding: 0; font-family: inherit; }
  .linkish:hover { color: var(--text); background: none; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.25rem; }
  h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
  h2 { margin: 0 0 0.75rem; font-size: 1.15rem; }
  .muted { color: var(--muted); }
  button, .btn {
    background: var(--purple); color: #fff; border: none; border-radius: 8px; padding: 0.5rem 0.9rem;
    font-size: 0.95rem; cursor: pointer; font-family: inherit;
  }
  button:hover, .btn:hover { background: var(--purple-dark); }
  button.secondary { background: #3a3a3d; }
  button.secondary:hover { background: #4a4a4d; }
  button.pink, a.pink, .btn.pink { background: var(--pink); color: #1a1220; font-weight: 600; }
  button.pink:hover, a.pink:hover, .btn.pink:hover { background: #ff8ad4; }
  button.danger { background: #b0341d; }
  button.danger:hover { background: #d13f24; }
  input[type=text] { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.7rem; font-size: 0.95rem; font-family: inherit; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .tag { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; padding: 0.12rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .icon-btn { padding: 0.35rem 0.45rem; line-height: 0; }
  .icon-btn svg { display: block; }
  button:disabled, .icon-btn:disabled { background: #2a2a2d; color: var(--off); cursor: not-allowed; opacity: 0.6; }
  button:disabled:hover, .icon-btn:disabled:hover { background: #2a2a2d; }
  /* Cooldown pills (global + user) always sit side by side, never stacking. */
  .cd-cell { display: inline-flex; gap: 0.35rem; flex-wrap: nowrap; white-space: nowrap; }
  /* Enable/disable toggle switch (leftmost custom-command column). */
  .col-toggle { width: 1%; }
  .switch { position: relative; display: inline-block; width: 2.2rem; height: 1.2rem; flex: none; vertical-align: middle; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch .slider { position: absolute; inset: 0; border-radius: 999px; background: var(--off); transition: background 0.15s; }
  .switch .slider::before { content: ''; position: absolute; height: 0.9rem; width: 0.9rem; left: 0.15rem; top: 0.15rem; border-radius: 50%; background: #fff; transition: transform 0.15s; }
  .switch input:checked + .slider { background: var(--pink); }
  .switch input:checked + .slider::before { transform: translateX(1rem); }
  .switch input:disabled { cursor: not-allowed; }
  .switch input:disabled + .slider { opacity: 0.5; }
  /* A disabled command's whole row reads dimmer, so its state is obvious at a glance. */
  tr.row-off td { opacity: 0.5; }
  tr.row-off td:first-child { opacity: 1; } /* keep the toggle itself legible */
  .aliases { display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.3rem; }
  .alias { display: inline-flex; align-items: center; gap: 0.3rem; width: fit-content; color: var(--muted); font-size: 0.8rem; }
  .alias code { font-size: 0.8rem; }
  .args { color: var(--muted); font-size: 0.85rem; font-family: ui-monospace, monospace; }
  /* A list's reference name beside its display-name heading: dimmer + lighter so it reads as secondary. */
  .ref-name { color: var(--muted); font-weight: 400; font-size: 0.82em; }
  /* Only the copy icon is clickable/flashes; the command text is not. */
  .namecopy { display: inline-flex; align-items: center; gap: 0.3rem; }
  .copy-btn { display: inline-flex; cursor: pointer; flex: none; }
  .copy-btn > svg { color: var(--muted); display: block; }
  .copy-btn:hover > svg { color: var(--text); }
  .copy-btn.copied > svg { color: var(--green); }
  .actions-cell { display: flex; gap: 0.4rem; flex-wrap: nowrap; align-items: center; }
  .col-actions { min-width: 7.5rem; white-space: nowrap; }
  .grid-perms { display: grid; gap: 0.5rem; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 0.55rem 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; }
  .yes { color: var(--green); font-weight: 700; }
  .no { color: var(--off); font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .chip { display: inline-flex; align-items: center; gap: 0.4rem; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 0.3rem 0.7rem; }
  .chip button { background: none; padding: 0; color: var(--muted); font-size: 1rem; line-height: 1; cursor: pointer; }
  .chip button:hover { color: #ff6b6b; background: none; }
  .radio-row { display: flex; flex-wrap: nowrap; gap: 0.4rem 0.8rem; overflow-x: auto; }
  .radio-row label { display: inline-flex; align-items: center; gap: 0.3rem; cursor: pointer; white-space: nowrap; font-size: 0.85rem; }
  .radio-row input { accent-color: var(--pink); }
  .rowline { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  /* Admin: users table stays readable, ids/dates don't wrap. */
  table.admin-users { width: 100%; }
  table.admin-users td, table.admin-users th { vertical-align: top; }
  table.admin-users td:nth-child(2) { font-size: 0.8rem; white-space: nowrap; }
  table.admin-users td:nth-child(5), table.admin-users td:nth-child(8) { white-space: nowrap; }
  table.admin-users .chip { padding: 0.15rem 0.5rem; font-size: 0.8rem; }
  /* Admin: event-simulator cards. */
  .sim-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.85rem; }
  .sim-grid .card { padding: 0.85rem; }
  .toast { margin-top: 0.5rem; font-size: 0.9rem; min-height: 1.2em; }
  .toast.err { color: #ff6b6b; }
  .toast.ok { color: var(--green); }
  /* Shared modal chrome — each <dialog class="modal"> only sets its own width. */
  dialog.modal { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 12px; }
  dialog.modal::backdrop { background: rgba(0,0,0,0.5); }
`;

const SHELL_SCRIPT = /* js */ `
  window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  // A single dropped request must never strand a panel on "Loading…" forever. A
  // GET is idempotent, so on a network-level failure or a 5xx (e.g. the dev
  // preview server restarting, or a keep-alive socket closed mid-reuse) retry it
  // a few times with a short backoff before surfacing the error. POSTs are not
  // idempotent, so they're tried exactly once.
  window.api = async (method, url, body) => {
    const waits = method === 'GET' ? [0, 250, 600, 1200] : [0];
    let lastErr = null;
    for (const wait of waits) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      let res;
      try {
        res = await fetch(url, {
          method, credentials: 'same-origin',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) { lastErr = e; continue; }                 // network dropped — retry (GET only)
      if (method === 'GET' && res.status >= 500) { lastErr = new Error('HTTP ' + res.status); continue; }
      let data = null; try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      return data;
    }
    throw lastErr || new Error('Request failed');
  };
  // Shared page helpers (available to every page script). Accept an element or id.
  window.openDialog = (d) => { if (typeof d === 'string') d = document.getElementById(d); if (d) (d.showModal ? d.showModal() : d.setAttribute('open', '')); };
  window.closeDialog = (d) => { if (typeof d === 'string') d = document.getElementById(d); if (d) (d.close ? d.close() : d.removeAttribute('open')); };
  window.toast = (id, msg, ok) => { const t = document.getElementById(id); if (!t) return; t.textContent = msg; t.className = 'toast ' + (ok ? 'ok' : 'err'); };
  window.pretty = (s) => String(s == null ? '' : s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (m) => m.toUpperCase());
  window.levelFromRel = (r) => !r ? 0 : r.botAdmin ? 5 : r.broadcaster ? 4 : r.moderator ? 3 : r.subscriber ? 1 : 0;
  window.downloadCsv = (filename, text) => {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.readFileText = (input) => new Promise((resolve, reject) => {
    const f = input.files && input.files[0];
    if (!f) { reject(new Error('Choose a CSV file first.')); return; }
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsText(f);
  });
  // ── Mobile: top-nav hamburger dropdown ──
  const navToggle = document.getElementById('nav-toggle');
  const navMenu = document.getElementById('nav-menu');
  if (navToggle && navMenu) {
    const setNav = (open) => { navMenu.classList.toggle('open', open); navToggle.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    navToggle.addEventListener('click', (e) => { e.stopPropagation(); setNav(!navMenu.classList.contains('open')); });
    navMenu.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('click', (e) => { if (!navMenu.contains(e.target) && e.target !== navToggle) setNav(false); });
  }

  // ── Mobile: master-detail sidebar collapses to a tap-to-open dropdown. The
  // toggle button lives outside the sidebar (which pages re-render), and its
  // label tracks the active item via a MutationObserver. ──
  document.querySelectorAll('.md-side-toggle').forEach((btn) => {
    const side = document.getElementById(btn.getAttribute('data-side'));
    if (!side) return;
    const labelEl = btn.querySelector('.mst-label');
    const setLabel = () => {
      const active = side.querySelector('.item.active');
      let text = btn.getAttribute('data-default') || 'Menu';
      if (active) { const c = active.cloneNode(true); const cnt = c.querySelector('.count'); if (cnt) cnt.remove(); text = c.textContent.trim() || text; }
      if (labelEl) labelEl.textContent = text;
    };
    btn.addEventListener('click', () => { const open = side.classList.toggle('open'); btn.classList.toggle('open', open); });
    side.addEventListener('click', (e) => { if (e.target.closest('.item')) { side.classList.remove('open'); btn.classList.remove('open'); } });
    new MutationObserver(setLabel).observe(side, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setLabel();
  });

  (async () => {
    let me = null;
    // Same resilience as window.api: a dropped /api/me would leave every page
    // stuck (onMe never fires), so retry a transient failure before giving up.
    for (const wait of [0, 250, 600, 1200]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        const r = await fetch('/api/me', { credentials: 'same-origin' });
        if (r.status >= 500) continue;           // transient — retry
        if (r.ok) me = await r.json();
        break;                                   // 200, or a real 401/4xx — done
      } catch {}                                 // network dropped — retry
    }
    const navRight = document.getElementById('nav-right');
    if (navRight) {
      navRight.innerHTML = me
        ? '<a class="nav-user" id="nav-user" href="/user"><img src="' + esc(me.user.avatar) + '" alt=""><span>' + esc(me.user.displayName) + '</span></a>'
        : '<a class="btn pink" href="/auth/login">Login with Twitch</a>';
    }
    // The Admin link is hidden unless this visitor can actually use it. The
    // server gates /admin regardless; this only avoids showing a dead end.
    const navAdmin = document.getElementById('nav-admin');
    if (navAdmin && me && me.relationship && (me.relationship.broadcaster || me.relationship.botAdmin)) {
      navAdmin.style.display = '';
    }
    if (typeof window.onMe === 'function') window.onMe(me);
  })();
`;

export function renderLayout(opts: LayoutOptions): string {
  const commandsActive = opts.active === 'commands' ? ' active' : '';
  const listsActive = opts.active === 'lists' ? ' active' : '';
  const quotesActive = opts.active === 'quotes' ? ' active' : '';
  const adminActive = opts.active === 'admin' ? ' active' : '';
  const mainClass = opts.wide ? ' class="wide"' : '';

  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${opts.title}</title>
    <style>${SHARED_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <a class="brand" href="/">
        <img class="logo" src="/assets/logo.png" alt="BasecaBot logo" onerror="this.style.display='none'" />
        <span class="title">BasecaBot</span>
      </a>
      <div class="nav-menu" id="nav-menu">
        <nav class="links">
          <a href="/commands" class="${commandsActive.trim()}">Commands</a>
          <a href="/lists" class="${listsActive.trim()}">Lists</a>
          <a href="/quotes" class="${quotesActive.trim()}">Quotes</a>
          <a href="/admin" id="nav-admin" class="${adminActive.trim()}" style="display:none">Admin</a>
        </nav>
        <span id="nav-right"></span>
      </div>
      <button type="button" class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false">☰</button>
    </header>
    <main${mainClass}>${opts.body}</main>
    <script>${SHELL_SCRIPT}</script>
    ${opts.script ? `<script>${opts.script}</script>` : ''}
  </body>
</html>`;
}
