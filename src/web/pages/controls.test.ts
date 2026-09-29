import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { welcomePage } from './welcome.js';
import { userPage } from './user.js';
import { commandsPage } from './commands.js';
import { listsPage } from './lists.js';
import { quotesPage } from './quotes.js';
import { adminPage } from './admin.js';

/**
 * Guards the shared look of the form controls.
 *
 * The site's CSS lives in one template literal and the pages build their markup as
 * strings, so neither tsc nor eslint can see inside either. These checks stand in
 * for that: every control type a page actually renders must be styled, and no page
 * may leak a backtick or a dollar-brace into its own template literal.
 */
const PAGES: Record<string, () => string> = {
  welcome: welcomePage,
  user: userPage,
  commands: commandsPage,
  lists: listsPage,
  quotes: quotesPage,
  admin: adminPage,
};

const PAGE_DIR = path.dirname(new URL(import.meta.url).pathname);
const LAYOUT = readFileSync(path.join(PAGE_DIR, '..', 'layout.ts'), 'utf8');

/** Every distinct control the rendered pages contain, including script-built markup. */
function controlsIn(html: string): Set<string> {
  const found = new Set<string>();
  for (const m of html.matchAll(/type=\\?['"](\w+)\\?['"]/g)) {
    const t = m[1]!;
    if (t !== 'button' && t !== 'submit' && t !== 'hidden') found.add(`input[type=${t}]`);
  }
  for (const tag of ['select', 'textarea']) if (new RegExp(`<${tag}[\\s>]`).test(html)) found.add(tag);
  return found;
}

describe('form control styling', () => {
  const all = new Set<string>();
  for (const render of Object.values(PAGES)) for (const c of controlsIn(render())) all.add(c);

  it('renders the control types we expect to exist (a canary on this test itself)', () => {
    // If this list shrinks, the extractor above has stopped seeing markup and the
    // rest of these assertions would pass vacuously.
    expect([...all].sort()).toEqual([
      'input[type=checkbox]',
      'input[type=file]',
      'input[type=number]',
      'input[type=radio]',
      'input[type=range]',
      'input[type=text]',
      'select',
      'textarea',
    ]);
  });

  it('styles every control type the site renders', () => {
    const unstyled = [...all].filter((sel) => !LAYOUT.includes(sel));
    expect(unstyled, `unstyled in layout.ts: ${unstyled.join(', ')}`).toEqual([]);
  });

  it('draws every native control itself, so engines cannot disagree', () => {
    // appearance:none is what removes each browser's own widget; without it a
    // select, range or checkbox reverts to per-engine metrics and accent colours.
    for (const sel of ['select', 'input[type=range]', 'input[type=checkbox]', 'input[type=radio]', 'input[type=number]']) {
      expect(LAYOUT, `${sel} should be reset`).toMatch(new RegExp(sel.replace(/[[\]]/g, '\\$&')));
    }
    expect(LAYOUT).toContain('appearance: none');
    expect(LAYOUT).toContain('-webkit-appearance: none');
    // Firefox needs its own opt-outs and pseudo-elements, or it keeps native parts.
    expect(LAYOUT).toContain('-moz-appearance: textfield');
    expect(LAYOUT).toContain('::-moz-range-thumb');
    expect(LAYOUT).toContain('::-moz-range-track');
    // A select with no native arrow and no replacement is a blank box, so both the
    // bare select and the button that stands in for it get our chevron.
    expect(LAYOUT).toMatch(/select,\s*\.sel-btn\s*{[^}]*background-image/s);
  });

  it('keeps webkit and moz slider thumbs visually identical', () => {
    const grab = (pseudo: string) => {
      const i = LAYOUT.indexOf(pseudo);
      expect(i, `${pseudo} missing`).toBeGreaterThan(-1);
      const body = LAYOUT.slice(LAYOUT.indexOf('{', i) + 1, LAYOUT.indexOf('}', i));
      return Object.fromEntries(
        body.split(';').map((d) => d.split(':').map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[0]),
      ) as Record<string, string>;
    };
    const wk = grab('input[type=range]::-webkit-slider-thumb');
    const moz = grab('input[type=range]::-moz-range-thumb');
    for (const prop of ['width', 'height', 'border-radius', 'background', 'border']) {
      expect(moz[prop], `${prop} differs between engines`).toBe(wk[prop]);
    }
  });

  it('replaces the select popup, which the OS draws and CSS cannot reach', () => {
    // A native option list opens wherever the OS wants (over the box, not under it)
    // and in the OS's own colours, so the list itself has to be ours.
    expect(LAYOUT).toContain('.sel-menu');
    expect(LAYOUT).toContain('.sel-opt');
    expect(LAYOUT).toContain("role', 'listbox'");
    // Parented to <body> and fixed, so no ancestor overflow can clip it...
    expect(LAYOUT).toMatch(/\.sel-menu\s*{[^}]*position:\s*fixed/s);
    expect(LAYOUT).toContain('document.body.appendChild(menu)');
    // ...and positioned from the button's own rect, i.e. directly below it.
    expect(LAYOUT).toContain('getBoundingClientRect');
    expect(LAYOUT).toContain('(r.bottom + 4)');
    // The real select must survive as the value holder, clipped like the file input.
    expect(LAYOUT).toMatch(/\.sel select\s*{[^}]*clip:/s);
  });

  it('left-packs a row of fields instead of spreading them across the card', () => {
    // As a grid of 1fr tracks, two fields each took half the card and their
    // controls ended up far apart; only a full row of five happened to look right.
    const i = LAYOUT.indexOf('.grid-fields {');
    expect(i).toBeGreaterThan(-1);
    const rule = LAYOUT.slice(i, LAYOUT.indexOf('}', i));
    expect(rule).toContain('display: flex');
    expect(rule).toContain('flex-wrap: wrap');
    expect(rule).not.toContain('1fr');
    // No grow, so a short row starts at the left rather than stretching to fill.
    expect(LAYOUT).toContain('.grid-fields > .field { flex: 0 1 13rem; }');
    // Text-ish fields are the exception and do still share out the spare room.
    expect(LAYOUT).toContain('.grid-fields > .field:has(input[type=text])');
    expect(LAYOUT).toMatch(/:has\(textarea\)[^{]*{ flex: 1 1 13rem; }/);
  });

  it('gives every number field the same fixed width, not a stretchy one', () => {
    // A row of settings should read as a set; letting each box flex to its
    // container made them all different widths.
    expect(LAYOUT).toContain('--ctl-num-w');
    expect(LAYOUT).toMatch(/--ctl-num-w:\s*calc\(6\.5ch/);   // 6 digits plus caret slack
    const i = LAYOUT.indexOf('.num { position: relative');
    const rule = LAYOUT.slice(i, LAYOUT.indexOf('}', i));
    expect(rule).toContain('width: var(--ctl-num-w)');
    expect(rule).toContain('flex: none');                     // never stretched by a flex row
    expect(rule).toContain('max-width: 100%');                // ...but never overflows either
    // ch must resolve in the input's own font, not the inherited body size.
    expect(rule).toContain('font-size: var(--ctl-font)');
    // The field grid stretches selects and text boxes, but must not stretch these.
    expect(LAYOUT).toContain('.field .num { width: var(--ctl-num-w); }');
    // A page's inline width:100% is dropped rather than lifted onto the wrapper.
    expect(LAYOUT).toContain("liftBoxStyles(inp, wrap, ['margin', 'marginTop', 'marginBottom'])");
  });

  it('marks only the chevron on hover, and never tiles it', () => {
    // button:hover sets the `background` SHORTHAND at (0,1,1), which outranks a
    // plain .sel-btn rule and resets background-repeat to `repeat` — tiling the
    // 12x8 chevron across the whole field. The hover rule must restate every
    // background longhand to stop that, at a specificity that beats it outright
    // rather than relying on source order.
    expect(LAYOUT).toContain('.sel .sel-btn:hover');
    const i = LAYOUT.indexOf('select:hover, .sel .sel-btn:hover');
    expect(i).toBeGreaterThan(-1);
    const rule = LAYOUT.slice(i, LAYOUT.indexOf('}', i));
    expect(rule).toContain('background-repeat: no-repeat');
    expect(rule).toContain('background-position: right 0.65rem center');
    expect(rule).toContain('background-size: 12px 8px');
    // Hover is the chevron turning pink and nothing else: no tint, no border move.
    expect(rule).toContain('background-color: var(--bg)');
    expect(rule).not.toMatch(/border-color/);
  });

  it('sizes the select to its widest option so it cannot resize on selection', () => {
    expect(LAYOUT).toContain('.sel-sizer');
    // Zero-height and hidden, yet still contributing to max-content width.
    const i = LAYOUT.indexOf('.sel-sizer {');
    const rule = LAYOUT.slice(i, LAYOUT.indexOf('}', i));
    expect(rule).toContain('height: 0');
    expect(rule).toContain('visibility: hidden');
    expect(LAYOUT).toContain('syncWidth');
    // The label lives in its own span, or setting it would wipe the sizer out.
    expect(LAYOUT).toContain('sel-btn-label');
    expect(LAYOUT).toContain('label.textContent = o ? o.textContent');
  });

  it('keeps the select usable by keyboard and by screen readers', () => {
    for (const bit of ['aria-haspopup', 'aria-expanded', 'aria-selected', 'aria-activedescendant', 'aria-controls']) {
      expect(LAYOUT, `${bit} missing`).toContain(bit);
    }
    for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Home', 'End', 'Enter']) {
      expect(LAYOUT, `${key} not handled`).toContain(key);
    }
  });

  it('writes a picked option back through the real select', () => {
    // Page code reads .value and binds onchange; the widget must look identical to
    // a user operating the native control.
    expect(LAYOUT).toContain('sel.selectedIndex = i');
    expect(LAYOUT).toMatch(/sel\.dispatchEvent\(new Event\('change'/);
    // A bare `.value =` assignment fires nothing, so the setter is wrapped.
    expect(LAYOUT).toContain("Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')");
  });

  it('cannot leave an orphaned menu behind when a panel re-renders', () => {
    // The admin sections replace their own markup while a menu could be open.
    expect(LAYOUT).toContain('!openSel.btn.isConnected');
    expect(LAYOUT).toMatch(/addEventListener\('scroll'/);
  });

  it('replaces the file input, whose native wording is browser and locale specific', () => {
    expect(LAYOUT).toContain('.filepick');
    expect(LAYOUT).toContain('Choose File');       // our label, not the browser's
    // The real input must stay in the DOM for the form and for screen readers.
    expect(LAYOUT).toMatch(/\.filepick input\[type=file\]\s*{[^}]*clip:/s);
  });

  it('does not let the hand-drawn checkbox leak into the toggle switch', () => {
    // The switch's checkbox is an invisible hit target sitting under .slider; if it
    // picked up a border and a tick, every toggle would render twice.
    const i = LAYOUT.indexOf('.switch input {');
    expect(i).toBeGreaterThan(-1);
    const rule = LAYOUT.slice(i, LAYOUT.indexOf('}', i));
    expect(rule).toContain('appearance: none');
    expect(rule).toContain('border: 0');
    expect(LAYOUT).toContain('.switch input::after { content: none; }');
  });

  it('gives every control one focus treatment', () => {
    expect(LAYOUT).toMatch(/input:focus-visible[^{]*{[^}]*outline/s);
  });
});

describe('custom property references', () => {
  const PAGE_FILES = ['admin.ts', 'commands.ts', 'lists.ts', 'quotes.ts', 'user.ts', 'welcome.ts', 'commandRow.ts',
    'overlayFloof.ts', 'overlayBossBattle.ts', 'overlayFirst.ts', 'overlayChatStats.ts', 'overlayAchievement.ts', 'overlayTts.ts'];

  /**
   * Custom properties a source declares: in CSS (its own :root or inline style),
   * or at runtime via setProperty, which the achievement overlay uses to colour a
   * pop by tier.
   */
  const declaredIn = (src: string) =>
    new Set([
      ...[...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!),
      ...[...src.matchAll(/setProperty\(\s*'(--[\w-]+)'/g)].map((m) => m[1]!),
    ]);
  const shared = declaredIn(LAYOUT);

  it.each(PAGE_FILES)('%s only uses custom properties that exist', (file) => {
    // A var() pointing at an undeclared property is "invalid at computed-value
    // time": the whole declaration is dropped and the style silently never applies.
    // Nothing warns — not tsc, not eslint, not the browser console. This caught
    // four borders in the admin panel referencing a --line token that was never
    // declared anywhere (the real token is --border), so they simply never drew.
    const src = readFileSync(path.join(PAGE_DIR, file), 'utf8');
    const known = new Set([...shared, ...declaredIn(src)]);
    // Only fallback-less references matter: var(--x, something) degrades to the
    // fallback by design, so it can never silently drop the declaration.
    const used = [...src.matchAll(/var\((--[\w-]+)\s*([,)])/g)]
      .filter((m) => m[2] === ')')
      .map((m) => m[1]!);
    const undefinedRefs = [...new Set(used.filter((v) => !known.has(v)))];
    expect(undefinedRefs, `${file} references undeclared: ${undefinedRefs.join(', ')}`).toEqual([]);
  });

  it('is actually looking at the shared tokens (a canary on the check above)', () => {
    for (const token of ['--bg', '--panel', '--border', '--text', '--muted', '--pink']) {
      expect(shared, `${token} should be declared in layout.ts`).toContain(token);
    }
    expect(shared).not.toContain('--line');   // the token that never existed
  });
});

describe('inline page scripts', () => {
  it('every page renders script blocks that are syntactically valid JS', () => {
    // The pages build their scripts as strings, so tsc and eslint never parse them.
    // (A stray backtick that ends the literal early IS caught by tsc, immediately;
    // what tsc cannot see is JS that is well-formed as a string but broken as code.)
    // new Function compiles without running, which is exactly the check we want.
    for (const [name, render] of Object.entries(PAGES)) {
      const html = render();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(scripts.length, `${name} rendered no script`).toBeGreaterThan(0);
      for (const js of scripts) {
        expect(() => new Function(js), `${name} has invalid inline JS`).not.toThrow();
      }
    }
  });

  it('builds the number steppers and file pickers from script, not per-page markup', () => {
    // The admin panels re-render with innerHTML constantly, so enhancement has to be
    // observed rather than called — otherwise a re-rendered section loses its
    // steppers and silently falls back to the native widgets.
    expect(LAYOUT).toContain('MutationObserver');
    expect(LAYOUT).toMatch(/enhanceNumber/);
    expect(LAYOUT).toMatch(/enhanceFile/);
    // Stepping must look like typing to the handlers already bound to these inputs.
    expect(LAYOUT).toContain("new Event('input', { bubbles: true })");
    expect(LAYOUT).toContain("new Event('change', { bubbles: true })");
    // Sizing a page put on the native control has to follow it onto the wrapper,
    // or an inline width:100% collapses against a shrink-wrapping flex parent.
    expect(LAYOUT).toContain('liftBoxStyles');
  });
});
