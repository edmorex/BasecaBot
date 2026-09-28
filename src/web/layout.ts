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
  /* Quotes: a combined "#id "quote" - user" cell, shown only at the phone breakpoint. */
  td.q-mobile, th.q-mobile { display: none; }
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
    /* Hide CSV import/export on phones (Commands, Lists, Quotes) to save space. */
    .csv-btn { display: none !important; }
    .card { padding: 1rem; }
    .page-head { flex-wrap: wrap; }

    /* Column layout on phones: stretch children to full width (the base
       align-items:flex-start would otherwise shrink .md-col to its content). */
    .md-layout { flex-direction: column; align-items: stretch; gap: .7rem; }
    .md-side { position: static; width: 100%; flex-basis: auto; display: none; padding: .6rem; }
    .md-side.open { display: block; }
    .md-side-toggle {
      display: flex; align-items: center; justify-content: space-between; gap: .5rem; width: 100%;
      background: var(--bg); border: 1px solid var(--border); color: var(--text); font-family: inherit;
      font-weight: 600; font-size: .95rem; padding: .6rem .8rem; border-radius: 8px; cursor: pointer; text-align: left;
    }
    .md-side-toggle::after { content: '▾'; color: var(--muted); }
    .md-side-toggle.open::after { content: '▴'; }

    /* Commands: the custom-commands table collapses to toggle + command +
       actions. Hide the middle columns (Type…Group = 3rd–8th); the command column
       flexes to width:100% so the toggle anchors left, the action buttons anchor
       right, and the command fills the space between. */
    table.cmd-custom th:nth-child(n+3):nth-child(-n+8),
    table.cmd-custom td:nth-child(n+3):nth-child(-n+8) { display: none; }
    table.cmd-custom th:nth-child(2), table.cmd-custom td:nth-child(2) { width: 100%; }

    /* Timers (toggle/name/actions) and Lists entries (#/entry/actions) collapse
       the same way: hide the 3rd + 4th columns; the 2nd column flexes to fill. */
    table.cmd-timers th:nth-child(n+3):nth-child(-n+4),
    table.cmd-timers td:nth-child(n+3):nth-child(-n+4),
    table.list-entries th:nth-child(n+3):nth-child(-n+4),
    table.list-entries td:nth-child(n+3):nth-child(-n+4) { display: none; }
    table.cmd-timers th:nth-child(2), table.cmd-timers td:nth-child(2),
    table.list-entries th:nth-child(2), table.list-entries td:nth-child(2) { width: 100%; }

    /* Lists detail header: keep just the name + reference, drop the description
       and meta, and stack the Edit List / +Entry buttons below the name. */
    .list-detail-head { flex-direction: column; }
    .list-detail-desc, .list-detail-meta { display: none; }

    /* Quotes table collapses to the combined cell + actions: hide the desktop
       columns, show the combined cell and let it fill the width. */
    td.q-desk, th.q-desk { display: none; }
    td.q-mobile, th.q-mobile { display: table-cell; width: 100%; }

    /* Action columns stay snug on phones across all the collapsed tables. */
    .col-actions { min-width: 0; }

    /* Built-in command tables collapse to just the Command column, full width and
       wrapping (a long command + options can span multiple lines). Overrides the
       desktop nowrap/width:1% pin on the first column. */
    table.cmd-builtins th:nth-child(n+2),
    table.cmd-builtins td:nth-child(n+2) { display: none; }
    table.cmd-builtins th:nth-child(1),
    table.cmd-builtins td:nth-child(1) { width: 100%; white-space: normal; }
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
  /* ══ Form controls ═══════════════════════════════════════════════════════════
     Every control is drawn by US rather than the browser, so the site looks the
     same in Chrome, Safari and Firefox. Native widgets differ in size, corner
     radius and accent colour between engines, so anything with a native
     appearance is reset with appearance:none and rebuilt from these tokens.
     The two exceptions, both unavoidable and both cosmetic-only:
       - a <select>'s open option list is drawn by the OS (color-scheme: dark
         keeps it dark, but its metrics are not ours to set);
       - the native file input is hidden and replaced, see .filepick below.
     ── */
  :root { --ctl-radius: 8px; --ctl-pad: 0.5rem 0.7rem; --ctl-font: 0.95rem; --ctl-h: 2.2rem;
    /* Number fields are a fixed width rather than stretchy, so a row of them reads
       as a set. Room for 6 digits: 6ch, plus half a digit so the caret and the
       widest digit still fit once the browser has rounded, plus the left pad and
       the stepper column. */
    --ctl-num-w: calc(6.5ch + 0.7rem + 1.9rem + 2px); }

  /* The shared "box" look: text-ish inputs, selects and textareas. Typed out as
     an explicit list rather than input:not(...) so a new control type is
     unstyled loudly rather than inheriting something almost-right. */
  input[type=text], input[type=number], input[type=search], input[type=email],
  input[type=password], input[type=url], input[type=tel], input[type=date],
  select, textarea, .sel-btn {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--ctl-radius); padding: var(--ctl-pad); font-size: var(--ctl-font);
    font-family: inherit; line-height: 1.2; appearance: none; -webkit-appearance: none;
  }
  input[type=text]:hover, input[type=number]:hover, select:hover, textarea:hover { border-color: #3d3d42; }
  textarea { resize: vertical; min-height: 4.5rem; width: 100%; display: block; }

  /* One focus treatment for everything, including the faked controls. */
  input:focus-visible, select:focus-visible, textarea:focus-visible,
  button:focus-visible, .btn:focus-visible, .switch input:focus-visible + .slider,
  .filepick input:focus-visible ~ .filepick-btn {
    outline: 2px solid var(--pink); outline-offset: 2px;
  }
  input:disabled, select:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Select ──────────────────────────────────────────────────────────────────
     A native select's OPTION LIST is drawn by the OS: its position (it opens over
     the box, not under it), its metrics and its colours are all outside CSS's
     reach. So the select itself is kept as the value holder and hidden, and
     .sel-btn + .sel-menu below are a listbox we draw and position ourselves.
     The bare select rules still apply before the script runs, so the control
     looks right even if enhancement never happens. ── */
  /* The chevron. Every background longhand is repeated in the hover rules on
     purpose: button:hover further up sets the background SHORTHAND, and at
     specificity (0,1,1) it outranks a plain .sel-btn rule (0,1,0) - which would
     reset background-repeat to repeat on hover and tile the 12x8 chevron across
     the whole control. Restating the longhands at (0,2,0) keeps it a single mark. */
  select, .sel-btn {
    padding-right: 2rem; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5l5-5' fill='none' stroke='%23adadb8' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 0.65rem center; background-size: 12px 8px;
  }
  /* Hover marks the chevron ONLY — no tint, no border change. */
  select:hover, .sel .sel-btn:hover, .sel.open .sel-btn {
    background-color: var(--bg); color: var(--text);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5l5-5' fill='none' stroke='%23ff6ec7' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 0.65rem center; background-size: 12px 8px;
  }

  .sel { position: relative; display: inline-flex; max-width: 100%; min-width: 0; }
  /* The real select stays in the DOM: it holds the value, it is what page scripts
     read and write, and screen readers get a real listbox. */
  .sel select {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .sel-btn {
    flex: 1 1 auto; min-width: 0; max-width: 100%; text-align: left; font-weight: 400;
    white-space: nowrap; overflow: hidden;
  }
  .sel-btn-label { display: block; overflow: hidden; text-overflow: ellipsis; }
  /* Holds one hidden copy of every option, so the button's intrinsic width is the
     WIDEST entry and picking a different one never resizes the control. Zero-height
     and hidden, but still contributes to max-content width — which is the point. */
  .sel-sizer { display: block; height: 0; overflow: hidden; visibility: hidden; }
  .sel-sizer > span { display: block; white-space: nowrap; }
  /* Positioned per-open in script and parented to <body>, so no ancestor's
     overflow can clip it and it always lands directly under the button. */
  .sel-menu {
    position: fixed; z-index: 120; margin: 0; padding: 0.3rem; list-style: none;
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--ctl-radius);
    box-shadow: 0 12px 34px rgba(0,0,0,.6); max-height: 16rem; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  .sel-menu::-webkit-scrollbar { width: 10px; }
  .sel-menu::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; border: 3px solid var(--panel); }
  .sel-opt {
    padding: 0.45rem 1.6rem 0.45rem 0.6rem; border-radius: 6px; cursor: pointer;
    font-size: var(--ctl-font); color: var(--text); position: relative;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sel-opt.active { background: #241f2b; }
  .sel-opt[aria-selected=true] { color: var(--pink); font-weight: 600; }
  .sel-opt[aria-selected=true]::after {
    content: ''; position: absolute; right: 0.6rem; top: 50%; width: 0.3rem; height: 0.55rem;
    border: solid var(--pink); border-width: 0 2px 2px 0; transform: translateY(-65%) rotate(45deg);
  }
  .sel-opt[data-disabled=true] { color: var(--off); cursor: not-allowed; }

  /* ── Number: native spinners are unstylable and differ per engine, so they are
     removed and replaced by the .num stepper the enhancer script builds. ── */
  input[type=number] { -moz-appearance: textfield; }
  input[type=number]::-webkit-outer-spin-button,
  input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  /* font-size is pinned so the ch unit in --ctl-num-w resolves in the same font
     the input uses, rather than the inherited body size. */
  .num { position: relative; display: inline-flex; align-items: stretch; flex: none;
    font-size: var(--ctl-font); width: var(--ctl-num-w); max-width: 100%; }
  .num > input[type=number] { padding-right: 1.9rem; width: 100%; min-width: 0; }
  /* Opt-outs for the rare field that really should fill its container. */
  .num.num-wide { width: 100%; }
  .num-btns { position: absolute; right: 1px; top: 1px; bottom: 1px; width: 1.5rem;
    display: flex; flex-direction: column; border-left: 1px solid var(--border);
    border-radius: 0 var(--ctl-radius) var(--ctl-radius) 0; overflow: hidden; }
  .num-btns button {
    flex: 1; padding: 0; margin: 0; border: 0; border-radius: 0; background: #202024;
    color: var(--muted); font-size: 0.6rem; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center; min-height: 0;
  }
  .num-btns button:hover { background: var(--pink); color: #1a1220; }
  .num-btns button + button { border-top: 1px solid var(--border); }
  .num-btns button:focus-visible { outline: 2px solid var(--pink); outline-offset: -2px; }

  /* ── Range: track + thumb drawn for both engines so they match ── */
  input[type=range] {
    appearance: none; -webkit-appearance: none; background: none; margin: 0;
    height: var(--ctl-h); cursor: pointer; padding: 0;
  }
  input[type=range]::-webkit-slider-runnable-track {
    height: 6px; border-radius: 999px; background: var(--border); border: 1px solid #333338;
  }
  input[type=range]::-moz-range-track {
    height: 6px; border-radius: 999px; background: var(--border); border: 1px solid #333338;
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 1.1rem; height: 1.1rem; border-radius: 50%;
    background: var(--pink); border: 2px solid #1a1220; box-shadow: 0 1px 4px rgba(0,0,0,.6);
    margin-top: calc((6px - 1.1rem) / 2); /* centre on the track, webkit needs this */
  }
  input[type=range]::-moz-range-thumb {
    width: 1.1rem; height: 1.1rem; border-radius: 50%;
    background: var(--pink); border: 2px solid #1a1220; box-shadow: 0 1px 4px rgba(0,0,0,.6);
  }
  input[type=range]:hover::-webkit-slider-thumb { background: #ff8ad4; }
  input[type=range]:hover::-moz-range-thumb { background: #ff8ad4; }
  input[type=range]:disabled::-webkit-slider-thumb { background: var(--off); }
  input[type=range]:disabled::-moz-range-thumb { background: var(--off); }

  /* ── Checkbox / radio: hand-drawn, because accent-color still leaves each
     engine's own box shape and size. ── */
  input[type=checkbox], input[type=radio] {
    appearance: none; -webkit-appearance: none; margin: 0; flex: none;
    width: 1.05rem; height: 1.05rem; background: var(--bg);
    border: 1px solid var(--border); cursor: pointer; position: relative;
    display: inline-block; vertical-align: -0.18rem;
  }
  input[type=checkbox] { border-radius: 4px; }
  input[type=radio] { border-radius: 50%; }
  input[type=checkbox]:hover, input[type=radio]:hover { border-color: var(--pink); }
  input[type=checkbox]:checked, input[type=radio]:checked { background: var(--pink); border-color: var(--pink); }
  /* The tick: two borders on a rotated box, so no font or image is involved. */
  input[type=checkbox]:checked::after {
    content: ''; position: absolute; left: 0.3rem; top: 0.12rem;
    width: 0.28rem; height: 0.52rem; border: solid #1a1220;
    border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  input[type=radio]:checked::after {
    content: ''; position: absolute; inset: 0.22rem; border-radius: 50%; background: #1a1220;
  }
  input[type=checkbox]:disabled, input[type=radio]:disabled { opacity: 0.45; cursor: not-allowed; }

  /* ── File picker: the native control is replaced outright. Its button label and
     "no file chosen" text are browser- AND locale-specific, which is exactly the
     inconsistency we are removing. The real input stays in the DOM (screen
     readers and the form still need it) but is reduced to a clipped pixel; a
     <label for> opens it, so no script is needed for the click itself. ── */
  .filepick { display: inline-flex; align-items: center; gap: 0.6rem; max-width: 100%; }
  .filepick input[type=file] {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .filepick-btn { flex: none; cursor: pointer; }
  .filepick-name {
    color: var(--muted); font-size: 0.88rem; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .filepick-name.has-file { color: var(--text); }

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
  /* The toggle's checkbox is an invisible hit target, so it must not pick up the
     hand-drawn checkbox styling above. */
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer;
    appearance: none; -webkit-appearance: none; border: 0; background: none; border-radius: 0; }
  .switch input::after { content: none; }
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
  .row { display: flex; justify-content: space-between; align-items: center; padding: 0.55rem 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; }
  .yes { color: var(--green); font-weight: 700; }
  .no { color: var(--off); font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .chip { display: inline-flex; align-items: center; gap: 0.4rem; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 0.3rem 0.7rem; }
  .chip button { background: none; padding: 0; color: var(--muted); font-size: 1rem; line-height: 1; cursor: pointer; }
  .chip button:hover { color: #ff6b6b; background: none; }
  .radio-row { display: flex; flex-wrap: nowrap; gap: 0.4rem 0.8rem; overflow-x: auto; }
  .radio-row label { display: inline-flex; align-items: center; gap: 0.3rem; cursor: pointer; white-space: nowrap; font-size: 0.85rem; }
  .rowline { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  /* Labelled-field grid shared by the admin settings panels. */
  /* Left-packed, not stretched. As a grid of 1fr tracks, a row holding two fields
     gave each one half the card and the controls drifted far apart; a full row of
     five looked fine only because the tracks happened to be narrow. Flex with a
     fixed basis and no grow keeps every row starting at the left, whatever it
     holds, and still wraps when it runs out of room. */
  .grid-fields { display: flex; flex-wrap: wrap; gap: 0.7rem; align-items: flex-start; }
  .grid-fields > .field { flex: 0 1 13rem; }
  /* Text, selects and textareas do benefit from the extra room, so those still
     grow to share out whatever is left on their row. */
  .grid-fields > .field:has(input[type=text]),
  .grid-fields > .field:has(select),
  .grid-fields > .field:has(textarea) { flex: 1 1 13rem; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .field > span:first-child { font-size: 0.85rem; font-weight: 600; }
  .field input, .field select, .field textarea, .field .sel { width: 100%; }
  /* ...but number fields keep their fixed width inside a field grid too. */
  .field .num { width: var(--ctl-num-w); }
  .field .num > input[type=number] { width: 100%; }
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
  /* Live state for a panel that saves itself; sits where its Save button used to. */
  .save-state { font-size: 0.85rem; color: var(--muted); display: inline-flex; align-items: center;
    gap: 0.4rem; min-height: 1.2rem; transition: color 0.2s; }
  /* Nothing to report yet: hide it entirely rather than leaving a stray dot. */
  .save-state:empty { display: none; }
  /* Panel heading with its live save state beside it, so both self-saving panels
     report in the same place. */
  .panel-head { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; margin: 0 0 0.75rem; }
  .panel-head h2 { margin: 0; }
  .save-state::before { content: ''; width: 0.5rem; height: 0.5rem; border-radius: 50%;
    background: var(--off); transition: background 0.2s; }
  .save-state.pending::before { background: var(--muted); }
  .save-state.saving::before { background: var(--purple); }
  .save-state.saved { color: var(--green); }
  .save-state.saved::before { background: var(--green); }
  .save-state.failed { color: #ff6b6b; }
  .save-state.failed::before { background: #ff6b6b; }
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
  // ── Control enhancers ──────────────────────────────────────────────────────
  // Number steppers and file pickers are built from markup rather than written by
  // hand on every page: the admin sections re-render themselves with innerHTML
  // constantly, so a MutationObserver keeps newly-inserted controls enhanced
  // without any page needing to remember to call anything.

  let ctlSeq = 0;

  /**
   * Move sizing that a page put on the native control onto the wrapper we build
   * around it. Without this, an inline width:100% would resolve against a
   * shrink-wrapping inline-flex parent and the field would collapse.
   */
  const liftBoxStyles = (inp, wrap, props) => {
    for (const prop of props || ['width', 'margin', 'marginTop', 'marginBottom', 'flex']) {
      if (inp.style[prop]) { wrap.style[prop] = inp.style[prop]; inp.style[prop] = ''; }
    }
  };

  /**
   * Give a number input our own up/down buttons.
   *
   * Native spinners cannot be styled and differ per engine, so the CSS hides them
   * and these take over. Stepping dispatches input + change so existing handlers
   * (slider read-outs, the cannon maths) fire exactly as if the value were typed.
   */
  const enhanceNumber = (inp) => {
    if (inp.dataset.ctlDone) return;
    inp.dataset.ctlDone = '1';
    const wrap = document.createElement('span');
    wrap.className = 'num';
    inp.parentNode.insertBefore(wrap, inp);
    // Margins follow the control, but NOT width: number fields are deliberately a
    // uniform 6-digit box, so a page's inline width:100% is dropped rather than
    // stretching one of them across its container.
    liftBoxStyles(inp, wrap, ['margin', 'marginTop', 'marginBottom']);
    inp.style.width = '';
    wrap.appendChild(inp);

    const step = (dir) => {
      if (inp.disabled) return;
      const s = Math.abs(parseFloat(inp.step)) || 1;
      const min = inp.min === '' ? -Infinity : parseFloat(inp.min);
      const max = inp.max === '' ? Infinity : parseFloat(inp.max);
      let v = parseFloat(inp.value);
      if (!isFinite(v)) v = isFinite(min) ? min : 0;
      // Round to the step's own precision, or 0.63 + 0.05 lands on 0.6799999999.
      const dp = (String(s).split('.')[1] || '').length;
      let next = parseFloat((v + dir * s).toFixed(dp));
      next = Math.min(max, Math.max(min, next));
      if (String(next) === inp.value) return;
      inp.value = String(next);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Typing 9999 into a field capped at 600 would otherwise show 9999 while the
    // server stored 600. Clamp on commit (blur/Enter) so the box never lies —
    // which matters most where the panel saves itself with no confirmation step.
    inp.addEventListener('change', () => {
      if (inp.value === '') return;
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      const min = inp.min === '' ? -Infinity : parseFloat(inp.min);
      const max = inp.max === '' ? Infinity : parseFloat(inp.max);
      const c = Math.min(max, Math.max(min, v));
      if (c === v) return;
      inp.value = String(c);
      // input only: re-dispatching change here would recurse.
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const btns = document.createElement('span');
    btns.className = 'num-btns';
    [['▲', 1, 'Increase'], ['▼', -1, 'Decrease']].forEach(([glyph, dir, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.tabIndex = -1;              // the input itself is the keyboard path (arrow keys)
      b.setAttribute('aria-label', label);
      b.addEventListener('click', () => step(dir));
      btns.appendChild(b);
    });
    wrap.appendChild(btns);
  };

  /**
   * Replace a file input with a pink button plus a filename.
   *
   * The native widget's button text and "no file chosen" wording vary by browser
   * AND by locale, which is the single most obvious cross-browser difference on
   * the site. The real input stays in the DOM, clipped to a pixel, so the form and
   * screen readers are unaffected; a <label for> drives the click natively.
   */
  const enhanceFile = (inp) => {
    if (inp.dataset.ctlDone) return;
    inp.dataset.ctlDone = '1';
    if (!inp.id) inp.id = 'ctl-file-' + (++ctlSeq);
    const wrap = document.createElement('span');
    wrap.className = 'filepick';
    inp.parentNode.insertBefore(wrap, inp);
    liftBoxStyles(inp, wrap);
    wrap.appendChild(inp);

    const btn = document.createElement('label');
    btn.className = 'btn pink filepick-btn';
    btn.setAttribute('for', inp.id);
    btn.textContent = 'Choose File';
    const name = document.createElement('span');
    name.className = 'filepick-name';
    name.textContent = 'No file chosen';
    wrap.appendChild(btn);
    wrap.appendChild(name);

    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      name.textContent = f ? f.name : 'No file chosen';
      name.classList.toggle('has-file', !!f);
      name.title = f ? f.name : '';
    });
  };

  // ── Custom select ──
  // Only one menu is ever open, and it is parented to <body> so no ancestor's
  // overflow can clip it.
  let openSel = null;

  const closeSel = (focusBtn) => {
    if (!openSel) return;
    const { wrap, btn, menu } = openSel;
    openSel = null;
    menu.remove();
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-activedescendant');
    if (focusBtn && btn.isConnected) btn.focus();
  };

  /**
   * Replace a select's OS-drawn option list with one we control.
   *
   * The select stays in the DOM and remains the single source of truth: page
   * scripts keep reading and writing .value exactly as before, and picking an
   * option writes through to it and fires change, so existing onchange handlers
   * are none the wiser. The value setter is wrapped so a programmatic assignment
   * (the TTS "reset to defaults" does this) still updates the visible label.
   */
  const enhanceSelect = (sel) => {
    if (sel.dataset.ctlDone || sel.multiple) return;
    sel.dataset.ctlDone = '1';
    if (!sel.id) sel.id = 'ctl-sel-' + (++ctlSeq);

    const wrap = document.createElement('span');
    wrap.className = 'sel';
    sel.parentNode.insertBefore(wrap, sel);
    liftBoxStyles(sel, wrap);
    wrap.appendChild(sel);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sel-btn';
    btn.id = sel.id + '-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (sel.disabled) btn.disabled = true;
    const label = document.createElement('span');
    label.className = 'sel-btn-label';
    const sizer = document.createElement('span');
    sizer.className = 'sel-sizer';
    sizer.setAttribute('aria-hidden', 'true');
    btn.appendChild(label);
    btn.appendChild(sizer);
    wrap.appendChild(btn);

    const syncLabel = () => {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
      btn.title = o ? o.textContent : '';
    };
    /**
     * Park a hidden copy of every option inside the button so its width is the
     * widest entry. Cheaper and more exact than measuring text, and it needs no
     * assumptions about the font. Refreshed whenever the option list might have
     * changed, since these panels rebuild their selects.
     */
    const syncWidth = () => {
      if (sizer.childElementCount === sel.options.length) {
        let same = true;
        for (let i = 0; i < sel.options.length; i++) {
          if (sizer.children[i].textContent !== sel.options[i].textContent) { same = false; break; }
        }
        if (same) return;
      }
      sizer.textContent = '';
      for (let i = 0; i < sel.options.length; i++) {
        const g = document.createElement('span');
        g.textContent = sel.options[i].textContent;
        sizer.appendChild(g);
      }
    };
    syncLabel();
    syncWidth();
    sel.addEventListener('change', syncLabel);

    // Catch a plain sel.value = x from page code, which fires no event of its own.
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && desc.set) {
      Object.defineProperty(sel, 'value', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); syncWidth(); syncLabel(); },
      });
    }

    const choose = (i) => {
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        syncLabel();
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closeSel(true);
    };

    const open = () => {
      if (openSel) { const same = openSel.btn === btn; closeSel(false); if (same) return; }
      // Rebuilt every time, so options added or replaced since the last open are
      // always reflected — in the menu and in the button's fixed width.
      syncWidth();
      const menu = document.createElement('ul');
      menu.className = 'sel-menu';
      menu.id = sel.id + '-menu';
      menu.setAttribute('role', 'listbox');
      let active = Math.max(0, sel.selectedIndex);
      const items = [];
      for (let i = 0; i < sel.options.length; i++) {
        const o = sel.options[i];
        const li = document.createElement('li');
        li.className = 'sel-opt';
        li.id = sel.id + '-opt-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
        if (o.disabled) li.setAttribute('data-disabled', 'true');
        li.textContent = o.textContent;
        li.addEventListener('mouseenter', () => setActive(i));
        li.addEventListener('click', () => { if (!o.disabled) choose(i); });
        menu.appendChild(li);
        items.push(li);
      }
      const setActive = (i) => {
        if (i < 0 || i >= items.length) return;
        items.forEach((el) => el.classList.remove('active'));
        active = i;
        items[i].classList.add('active');
        btn.setAttribute('aria-activedescendant', items[i].id);
        items[i].scrollIntoView({ block: 'nearest' });
      };

      document.body.appendChild(menu);
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', menu.id);
      openSel = { wrap, btn, menu, items, setActive, choose, get active() { return active; } };

      // Directly under the button, matching its width; flipped above only when
      // there genuinely is not room below.
      const r = btn.getBoundingClientRect();
      menu.style.minWidth = r.width + 'px';
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      const below = window.innerHeight - r.bottom - 8;
      if (menu.offsetHeight > below && r.top > below) {
        menu.style.top = Math.max(8, r.top - menu.offsetHeight - 4) + 'px';
      } else {
        menu.style.top = (r.bottom + 4) + 'px';
      }
      if (sel.selectedIndex >= 0) setActive(sel.selectedIndex);
    };

    btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!openSel || openSel.btn !== btn) open();
      }
    });
  };

  document.addEventListener('keydown', (e) => {
    if (!openSel) return;
    const { items, setActive, choose } = openSel;
    const i = openSel.active;
    if (e.key === 'Escape') { e.preventDefault(); closeSel(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (items[i] && items[i].getAttribute('data-disabled') !== 'true') choose(i);
    } else if (e.key === 'Tab') closeSel(false);
  });
  document.addEventListener('click', (e) => {
    if (openSel && !openSel.menu.contains(e.target) && e.target !== openSel.btn) closeSel(false);
  });
  // A fixed menu would otherwise drift away from its button.
  window.addEventListener('scroll', () => closeSel(false), true);
  window.addEventListener('resize', () => closeSel(false));

  const enhanceControls = (root) => {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input[type=number]:not([data-ctl-done])').forEach(enhanceNumber);
    scope.querySelectorAll('input[type=file]:not([data-ctl-done])').forEach(enhanceFile);
    scope.querySelectorAll('select:not([data-ctl-done])').forEach(enhanceSelect);
  };
  window.enhanceControls = enhanceControls;
  enhanceControls(document);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('input[type=number],input[type=file],select')) {
          if (node.tagName === 'SELECT') enhanceSelect(node);
          else if (node.type === 'number') enhanceNumber(node);
          else enhanceFile(node);
        } else {
          enhanceControls(node);
        }
      }
      // A section re-rendering underneath an open menu would leave it orphaned,
      // pointing at a button that no longer exists.
      if (r.removedNodes.length && openSel && !openSel.btn.isConnected) closeSel(false);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

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
