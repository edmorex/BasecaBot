// One-off: convert a StreamElements quotes JSON export into a BasecaBot
// quotes-import CSV (columns: ID,Quote,User,Game,Date,Quoted By,Quoted By ID,Created At).
//
//   node scripts/convert-se-quotes.mjs [in=quotes.json] [out=quotes-import.csv]
//
// Import the result on the Quotes page with **Wipe & replace all quotes** so the
// original IDs + timestamps are preserved (additive would assign new IDs).
import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] || 'quotes.json';
const OUT = process.argv[3] || 'quotes-import.csv';

const raw = JSON.parse(readFileSync(IN, 'utf8'));
const quotes = Array.isArray(raw) ? raw : raw.quotes;
if (!Array.isArray(quotes)) throw new Error('Could not find a quotes array in the JSON.');

/** Repair UTF-8-decoded-as-Latin-1 mojibake (â€œ, Ã¶, â€™, â€¦) when present. */
function fixMojibake(s) {
  if (typeof s !== 'string' || !/[ÃÂâÍÊ]/.test(s)) return { s: s ?? '', fixed: false };
  try {
    const r = Buffer.from(s, 'latin1').toString('utf8');
    return { s: r, fixed: r !== s };
  } catch {
    return { s, fixed: false };
  }
}

/** Strip one pair of surrounding quotes (straight, smart, or single). */
function stripWrapQuotes(s) {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0], b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === '“' && b === '”') || (a === "'" && b === "'")) return t.slice(1, -1).trim();
  }
  return t;
}

/** Pull a trailing "- Speaker" / "-Speaker" / "~ Speaker" off the end, if it looks like an attribution. */
function extractSpeaker(text) {
  const t = text.replace(/\s+$/, '');
  const m = t.match(/^([\s\S]*?)\s*[-~–—]\s*([^-~–—]{1,40})$/);
  if (m) {
    let who = m[2].trim();
    const body = m[1].replace(/\s+$/, '');
    if (who && who.length <= 35 && !/[.!?]\s/.test(who)) {
      let commaExtra = false;
      const c = who.indexOf(',');
      if (c >= 0) { who = who.slice(0, c).trim(); commaExtra = true; } // e.g. "Sharon, Mario RPG"
      if (who) return { who, body, commaExtra };
    }
  }
  return null;
}

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (arr) => arr.map(cell).join(',');

const out = [row(['ID', 'Quote', 'User', 'Game', 'Date', 'Quoted By', 'Quoted By ID', 'Created At'])];
const review = { unknownSpeaker: [], mojibake: [], commaSpeaker: [] };
let noAddedBy = 0;

for (const q of [...quotes].sort((a, b) => (a.id || 0) - (b.id || 0))) {
  const { s: text, fixed } = fixMojibake(q.text ?? '');
  const speak = extractSpeaker(text);
  const user = speak ? speak.who : 'unknown';
  const quote = stripWrapQuotes(speak ? speak.body : text);
  if (!speak) review.unknownSpeaker.push(q.id);
  if (speak?.commaExtra) review.commaSpeaker.push(q.id);
  if (fixed) review.mojibake.push(q.id);
  const addedBy = (q.addedBy ?? '').trim();
  if (!addedBy) noAddedBy++;
  const createdAt = q.createdAt || '';
  out.push(row([q.id, quote, user, q.game ?? '', createdAt.slice(0, 10), addedBy, '', createdAt]));
}

writeFileSync(OUT, out.join('\r\n') + '\r\n', 'utf8');

console.log(`Wrote ${quotes.length} quotes -> ${OUT}\n`);
console.log(`Speaker auto-parsed:        ${quotes.length - review.unknownSpeaker.length}`);
console.log(`Speaker = "unknown" (fix):  ${review.unknownSpeaker.length}`);
console.log(`Missing "Quoted By":        ${noAddedBy}`);
console.log(`Mojibake repaired:          ${review.mojibake.length}`);
console.log(`Speaker had trailing comma: ${review.commaSpeaker.length}\n`);
console.log('Review — unknown speaker (IDs):', review.unknownSpeaker.join(', ') || 'none');
console.log('Review — comma in speaker (IDs):', review.commaSpeaker.join(', ') || 'none');
console.log('Review — mojibake repaired (IDs):', review.mojibake.join(', ') || 'none');
