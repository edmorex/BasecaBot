/**
 * Minimal RFC 4180-ish CSV serialize/parse. Handles quoted fields containing
 * commas, double-quotes (escaped as ""), and newlines; tolerates \n, \r\n, or
 * lone \r line endings and a UTF-8 BOM. No external dependency.
 */

/** Serialize rows to a CSV string (\r\n line endings, minimal quoting). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

function cell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parse CSV text into rows of string fields. Blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\n') {
      endRow();
      i++;
    } else if (c === '\r') {
      endRow();
      if (text[i + 1] === '\n') i++; // consume \r\n as one
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) endRow(); // trailing field/row
  return rows.filter((r) => !(r.length === 1 && r[0] === '')); // drop blank lines
}

/** A CSV column: output/lookup header aliases (case-insensitive) + positional fallback. */
export interface CsvColumn {
  key: string;
  aliases: string[];
  pos: number;
}

/**
 * Map parsed CSV rows to keyed objects. If the first row looks like a header
 * (any expected alias appears in it), columns are matched by name and the header
 * row is dropped; otherwise columns are read by positional fallback.
 */
export function mapCsvRows(rows: string[][], spec: CsvColumn[]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const first = rows[0]!.map((c) => c.trim().toLowerCase());
  // Treat row 0 as a header only if 2+ expected column names appear in it — a
  // single data value happening to equal a header name shouldn't trigger it.
  const hasHeader = spec.filter((s) => s.aliases.some((a) => first.includes(a))).length >= 2;
  const index: Record<string, number> = {};
  for (const s of spec) index[s.key] = hasHeader ? first.findIndex((c) => s.aliases.includes(c)) : s.pos;
  const data = hasHeader ? rows.slice(1) : rows;
  return data.map((r) => {
    const o: Record<string, string> = {};
    for (const s of spec) {
      const i = index[s.key]!;
      o[s.key] = i >= 0 ? (r[i] ?? '') : '';
    }
    return o;
  });
}

/** Standard CSV column layouts for quotes and lists (shared by the API + preview). */
export const QUOTE_CSV_SPEC: CsvColumn[] = [
  { key: 'text', aliases: ['quote'], pos: 1 },
  { key: 'user', aliases: ['user'], pos: 2 },
  { key: 'game', aliases: ['game'], pos: 3 },
  { key: 'date', aliases: ['date'], pos: 4 },
  { key: 'quotedByName', aliases: ['quoted by'], pos: 5 },
  { key: 'quotedById', aliases: ['quoted by id'], pos: 6 },
];
export const LIST_CSV_SPEC: CsvColumn[] = [
  { key: 'list', aliases: ['list', 'list name'], pos: 0 },
  { key: 'displayName', aliases: ['display name'], pos: 1 },
  { key: 'description', aliases: ['description'], pos: 2 },
  { key: 'permission', aliases: ['permission'], pos: 3 },
  { key: 'createdByName', aliases: ['created by'], pos: 4 },
  { key: 'createdById', aliases: ['created by id'], pos: 5 },
  { key: 'text', aliases: ['entry'], pos: 6 },
  { key: 'addedByName', aliases: ['added by'], pos: 7 },
  { key: 'addedById', aliases: ['added by id'], pos: 8 },
  { key: 'addedAt', aliases: ['date added'], pos: 9 },
];
