import type { Storage } from './storage/index.js';

/**
 * A registered, admin-overridable chat string. Plugins register their strings
 * (with a hard-coded default + metadata) at startup; the broadcaster can then
 * override the text on the dashboard without a redeploy.
 */
export interface TextStringDef {
  /** Grouping / plugin name, e.g. "events". */
  feature: string;
  /** Reference within the feature, e.g. "sub". This is how code looks it up. */
  key: string;
  /** Hard-coded fallback used until the broadcaster customizes it. */
  default: string;
  /** Human label for the dashboard (defaults to `key`). */
  label?: string;
  /** Optional help text shown under the label. */
  description?: string;
  /** Available `{token}` placeholders this string interpolates. */
  placeholders?: string[];
}

/** A registered string plus its effective value, for the dashboard. */
export interface TextStringView {
  feature: string;
  key: string;
  label: string;
  description: string;
  placeholders: string[];
  /** The effective text: the override if customized, else the default. */
  value: string;
  default: string;
  /** True when an override is stored (i.e. it differs from the default source). */
  custom: boolean;
}

/** Registered strings grouped by feature, in registration order. */
export interface TextStringGroup {
  feature: string;
  strings: TextStringView[];
}

const SEP = '\u0000'; // internal Map-key separator (never in a feature/key)
const composite = (feature: string, key: string): string => feature + SEP + key;

/** Replace `{token}` placeholders from `vars`; unknown tokens are left as-is. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/**
 * Registry + override store for admin-editable chat strings.
 *
 * Defaults live in code (registered by each plugin at init); this service stores
 * only the OVERRIDES in the `TextString` table. `get`/`format` are synchronous
 * and read from an in-memory cache (loaded once via `init`, kept current on
 * `set`/`reset`), so they're safe on hot event-handler paths and reflect edits
 * live — the same instance is shared by the plugins and the web dashboard.
 */
export class TextStringsService {
  private readonly registry = new Map<string, TextStringDef>(); // insertion-ordered
  private readonly overrides = new Map<string, string>();

  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Load persisted overrides into memory. Call once at startup. */
  async init(): Promise<void> {
    const rows = await this.db.textString.findMany();
    for (const r of rows) this.overrides.set(composite(r.feature, r.key), r.value);
  }

  /** Register a string's default + metadata. Re-registering updates the default. */
  register(def: TextStringDef): void {
    this.registry.set(composite(def.feature, def.key), def);
  }

  /** The effective value (override if customized, else the registered default). */
  get(feature: string, key: string): string {
    const c = composite(feature, key);
    const override = this.overrides.get(c);
    if (override !== undefined) return override;
    return this.registry.get(c)?.default ?? '';
  }

  /** The effective value with `{token}` placeholders substituted from `vars`. */
  format(feature: string, key: string, vars: Record<string, string | number> = {}): string {
    return interpolate(this.get(feature, key), vars);
  }

  /** Store an override for a string (persisted + cached). */
  async set(feature: string, key: string, value: string): Promise<void> {
    await this.db.textString.upsert({
      where: { feature_key: { feature, key } },
      create: { feature, key, value },
      update: { value },
    });
    this.overrides.set(composite(feature, key), value);
  }

  /** Remove an override, reverting the string to its code default. */
  async reset(feature: string, key: string): Promise<void> {
    await this.db.textString.deleteMany({ where: { feature, key } });
    this.overrides.delete(composite(feature, key));
  }

  /** Every registered string grouped by feature, in registration order. */
  list(): TextStringGroup[] {
    const groups = new Map<string, TextStringView[]>();
    for (const [c, def] of this.registry) {
      const override = this.overrides.get(c);
      const view: TextStringView = {
        feature: def.feature,
        key: def.key,
        label: def.label ?? def.key,
        description: def.description ?? '',
        placeholders: def.placeholders ?? [],
        value: override ?? def.default,
        default: def.default,
        custom: override !== undefined,
      };
      const arr = groups.get(def.feature);
      if (arr) arr.push(view);
      else groups.set(def.feature, [view]);
    }
    return [...groups.entries()].map(([feature, strings]) => ({ feature, strings }));
  }
}
