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
  active?: 'commands' | 'user' | '';
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
  .spacer { flex: 1; }
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
  @media (max-width: 720px) { .md-layout { flex-direction: column; } .md-side { flex-basis: auto; width: 100%; position: static; } }
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
  .cd-cell { display: inline-flex; gap: 0.35rem; flex-wrap: wrap; }
  .aliases { display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.3rem; }
  .alias { display: inline-flex; align-items: center; gap: 0.3rem; width: fit-content; color: var(--muted); font-size: 0.8rem; }
  .alias code { font-size: 0.8rem; }
  .args { color: var(--muted); font-size: 0.85rem; font-family: ui-monospace, monospace; }
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
  .toast { margin-top: 0.5rem; font-size: 0.9rem; min-height: 1.2em; }
  .toast.err { color: #ff6b6b; }
  .toast.ok { color: var(--green); }
`;

const SHELL_SCRIPT = /* js */ `
  window.esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  window.api = async (method, url, body) => {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  };
  (async () => {
    let me = null;
    try { const r = await fetch('/api/me', { credentials: 'same-origin' }); if (r.ok) me = await r.json(); } catch {}
    const navRight = document.getElementById('nav-right');
    if (navRight) {
      navRight.innerHTML = me
        ? '<a class="nav-user" id="nav-user" href="/user"><img src="' + esc(me.user.avatar) + '" alt=""><span>' + esc(me.user.displayName) + '</span></a>'
        : '<a class="btn pink" href="/auth/login">Login with Twitch</a>';
    }
    if (typeof window.onMe === 'function') window.onMe(me);
  })();
`;

export function renderLayout(opts: LayoutOptions): string {
  const commandsActive = opts.active === 'commands' ? ' active' : '';
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
      <nav class="links">
        <a href="/commands" class="${commandsActive.trim()}">Commands</a>
      </nav>
      <span class="spacer"></span>
      <span id="nav-right"></span>
    </header>
    <main${mainClass}>${opts.body}</main>
    <script>${SHELL_SCRIPT}</script>
    ${opts.script ? `<script>${opts.script}</script>` : ''}
  </body>
</html>`;
}
