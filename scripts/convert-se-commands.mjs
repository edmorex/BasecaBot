// One-off: convert a StreamElements custom-commands JSON export into a BasecaBot
// commands-import CSV (columns: Type,Name,Response,Group,Access,Enabled,
// Global Cooldown,User Cooldown,Uses,Target,Args,Created At,Updated At).
//
//   node scripts/convert-se-commands.mjs [in=commands-custom.json] [out=commands-import.csv]
//
// Import the result on the Commands page with **Wipe & replace** so the original
// created/updated timestamps are preserved (additive keeps existing rows).
//
// Prints a review report at the end: everything the conversion could not decide
// on its own (access levels, unknown variables, multi-line or over-long
// responses, dropped StreamElements-only features).
import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] || 'commands-custom.json';
const OUT = process.argv[3] || 'commands-import.csv';

// Built-in commands the importer will refuse — a custom command can't shadow one.
const RESERVED = new Set([
  'points', 'p', 'give', 'addpoints', 'command', 'cmd',
  'quote', 'list', 'wheel', 'startgame', 'endgame', 'vote',
]);

// StreamElements access level -> BasecaBot permission label.
// 250 is the uncertain one (SE shows it as sub/regular depending on setup), so
// every non-100 command is surfaced in the report for confirmation.
const ACCESS = { 100: 'Everyone', 250: 'Subscriber', 500: 'Moderator', 1000: 'Broadcaster' };

// Group assignments, by group. StreamElements has no equivalent field, so these
// are editorial — edit here and re-run rather than hand-editing the CSV.
// Anything missing lands in no group and is listed in the report.
const GROUPS = {
  // Animals in foster care (plus `floof`, the roster of who's currently here).
  Fosters: [
    'absynthe', 'alfador', 'anise', 'ashling', 'augustus', 'bandit', 'banhmi', 'beandip',
    'beverly', 'cheerio', 'clawdia', 'crowbar', 'cyra', 'electrickettle', 'elistraee',
    'erastil', 'floof', 'galadriel', 'jellybean', 'jormungandr', 'kaz', 'lily', 'loopy',
    'major', 'mittens', 'moose', 'ollie', 'penguin', 'percy', 'phaet', 'phalen', 'pinto',
    "pojd'sem", 'precious', 'quanchi', 'raquette', 'rona', 'ruby', 'salem', 'torag',
    'tulcats', 'void', 'watson', 'wulfy', 'yakko',
  ],
  // Permanent residents, not fosters — including the foster fail.
  Pets: ['bigboss', 'coco', 'mochi'],
  // Humans: mods, friends, collaborators, the streamer.
  People: ['andrea', 'chloe', 'dorei', 'joe', 'q', 'scott', 'sharon', 'who'],
  // Where to find things.
  Links: ['discord', 'youtube', 'log', 'maps', 'notes'],
  // Game codes, scores, and what's being played.
  Games: ['fc', 'chorlton', 'suffer', 'items', 'ridley', 'schedule'],
  // Fundraisers, charity events, and sponsorships.
  Promos: ['420special', 'bb', 'donate', 'raid', 'bossfight', 'train'],
  // Commands that respond to the sender or to an argument.
  Interactive: ['lurk', 'delurk', 'givechocolate', 'giveflowers', 'rigged', 'so', 'scream', 'screams'],
  // Running gags and channel lore.
  Lore: ['blame', 'chair', 'chaos', 'chuck', 'disappointed', 'lava', 'meow', 'woof', 'phonebook', 'sdk', 'smb35', 'wut'],
};

/** name -> group, inverted from GROUPS above. */
const GROUP_OF = new Map();
for (const [group, names] of Object.entries(GROUPS)) {
  for (const n of names) {
    if (GROUP_OF.has(n)) throw new Error(`"${n}" is in two groups: ${GROUP_OF.get(n)} and ${group}`);
    GROUP_OF.set(n, group);
  }
}

const raw = JSON.parse(readFileSync(IN, 'utf8'));
const commands = Array.isArray(raw) ? raw : raw.commands;
if (!Array.isArray(commands)) throw new Error('Could not find a commands array in the JSON.');

const review = {
  access: [],        // non-Everyone access levels, to confirm
  unknownVar: [],    // SE variables with no known BasecaBot equivalent
  converted: [],     // variables that WERE converted (worth eyeballing)
  multiline: [],     // responses containing newlines
  tooLong: [],       // responses near/over the Twitch 500-char limit
  oddName: [],       // trigger words that aren't plain [a-z0-9_]
  reserved: [],      // collides with a built-in command
  disabled: [],      // came over disabled
  seOnly: [],        // SE-only features that have no BasecaBot equivalent
  countReset: [],    // uses $(count) but starts from 0
  ungrouped: [],     // no entry in GROUPS
};

/** Count of commands placed in each group, for the report. */
const groupCounts = new Map();

/**
 * Rewrite one StreamElements `${...}` variable body as a BasecaBot `$(...)` one.
 * Unknown heads pass through unchanged (with the new bracket style) and are
 * reported rather than silently dropped.
 */
function mapVar(inner, cmdName) {
  if (/^\d+$/.test(inner)) return `$(${inner})`; // ${1} -> $(1)

  const parts = inner.split(/\s+/);
  const head = parts[0];
  const arg = parts.slice(1).join(' ').trim();
  const bare = (s) => s.replace(/^!/, '');

  switch (head) {
    // SE's ${sender} and ${user} both mean "whoever ran the command". BasecaBot
    // splits those: $(user) takes an optional target, $(sender) never does.
    case 'sender':
      return '$(sender)';
    case 'user':
      return arg ? `$(user ${arg})` : '$(sender)';
    // SE: ${count x} increments, ${getcount x} reads. BasecaBot: $(count) with
    // no argument increments the current command; with one it reads that command.
    case 'count':
      return !arg || bare(arg) === cmdName ? '$(count)' : `$(count !${bare(arg)})`;
    case 'getcount':
      return `$(count !${bare(arg)})`;
    case 'game':
      return arg ? `$(game ${arg})` : '$(game)';
    default:
      review.unknownVar.push(`!${cmdName}: \${${inner}}`);
      return `$(${inner})`;
  }
}

/** Convert every SE variable in a response, innermost first so nesting works. */
function convertVars(text, cmdName) {
  const before = text;
  // SE also writes some variables in $(...) form; $(user) there means the sender.
  let s = text.replace(/\$\(user\)/g, '$(sender)');
  for (let guard = 0; guard < 20 && /\$\{[^{}]*\}/.test(s); guard++) {
    s = s.replace(/\$\{([^{}]*)\}/g, (_, inner) => mapVar(inner.trim(), cmdName));
  }
  if (s !== before) review.converted.push(`!${cmdName}: ${before.match(/[$][{(][^})]*[})]/g)?.join(' ')} -> ${s.match(/[$]\([^)]*\)/g)?.join(' ')}`);
  return s;
}

/** Note StreamElements-only settings that carry no meaning in BasecaBot. */
function checkSeOnly(c, name) {
  const notes = [];
  if (c.regex) notes.push(`regex="${c.regex}"`);
  if (c.keywords?.length) notes.push(`keywords=${JSON.stringify(c.keywords)}`);
  if (c.titleKeywords?.length) notes.push(`titleKeywords=${JSON.stringify(c.titleKeywords)}`);
  if (c.cost) notes.push(`cost=${c.cost}`);
  if (c.hidden) notes.push('hidden=true');
  if (c.enabledOnline === false) notes.push('enabledOnline=false');
  if (c.enabledOffline === false) notes.push('enabledOffline=false');
  if (c.aliases?.length) notes.push(`aliases=${JSON.stringify(c.aliases)}`);
  if (notes.length) review.seOnly.push(`!${name}: ${notes.join(', ')}`);
}

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (arr) => arr.map(cell).join(',');

const out = [
  row(['Type', 'Name', 'Response', 'Group', 'Access', 'Enabled', 'Global Cooldown', 'User Cooldown', 'Uses', 'Target', 'Args', 'Created At', 'Updated At']),
];

const sorted = [...commands].sort((a, b) => (a.command || '').localeCompare(b.command || ''));

for (const c of sorted) {
  const name = (c.command || '').trim().toLowerCase().replace(/^!/, '');
  if (!name) continue;

  const response = convertVars(c.reply ?? '', name);
  const access = ACCESS[c.accessLevel] ?? 'Moderator';
  const group = GROUP_OF.get(name) ?? '';
  if (group) groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  else review.ungrouped.push(`!${name}`);

  if (c.accessLevel !== 100) review.access.push(`!${name}: SE ${c.accessLevel} -> ${access}`);
  if (/\n/.test(response)) review.multiline.push(`!${name} (${response.split('\n').length} lines)`);
  if (response.length > 400) review.tooLong.push(`!${name} (${response.length} chars)`);
  if (!/^[a-z0-9_]+$/.test(name)) review.oddName.push(`!${name}`);
  if (RESERVED.has(name)) review.reserved.push(`!${name}`);
  if (c.enabled === false) review.disabled.push(`!${name}`);
  if (/\$\(count\)/.test(response)) review.countReset.push(`!${name}`);
  checkSeOnly(c, name);

  out.push(row([
    'trigger',
    name,
    response,
    group,
    access,
    c.enabled === false ? 'false' : 'true',
    c.cooldown?.global ?? 0,
    c.cooldown?.user ?? 0,
    0, // Uses — SE export carries no usage count
    '', // Target (aliases only)
    '', // Args (aliases only)
    c.createdAt || '',
    c.updatedAt || '',
  ]));
}

writeFileSync(OUT, out.join('\r\n') + '\r\n', 'utf8');

const section = (label, items) => {
  console.log(`\n${label} (${items.length})`);
  if (!items.length) console.log('  none');
  else for (const i of items) console.log(`  ${i}`);
};

console.log(`Wrote ${out.length - 1} commands -> ${OUT}`);
console.log('\nGroups:');
for (const [g, n] of [...groupCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${g.padEnd(12)} ${n}`);
section('UNGROUPED — add to GROUPS in this script', review.ungrouped);
section('Access levels to confirm', review.access);
section('Variables converted — verify these read correctly', review.converted);
section('UNKNOWN variables — need a manual decision', review.unknownVar);
section('Multi-line responses — chat cannot send newlines', review.multiline);
section('Long responses (>400 chars, Twitch caps at 500)', review.tooLong);
section('Trigger words with unusual characters', review.oddName);
section('Collides with a built-in command (import will skip)', review.reserved);
section('Imported disabled', review.disabled);
section('Uses $(count) — counter restarts at 0', review.countReset);
section('StreamElements-only settings dropped', review.seOnly);
