import { describe, it, expect, vi, afterEach } from 'vitest';
import { CommandVarEngine, type VarContext, type VarDeps } from './commandVars.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };

function makeDeps(over: Partial<VarDeps> = {}): VarDeps {
  return {
    points: { getBalance: async (id: string) => (id === 'u1' ? 100 : 0) },
    users: { getByLogin: async (l: string) => (l === 'bob' ? { id: 'u2', login: 'bob', displayName: 'Bob' } : null) },
    quotes: {
      getById: async (n: number) => ({ id: n, text: 'hi', user: 'baseca', game: 'Elden Ring', date: '2024-01-02', quotedByName: 'm', createdAt: '' }),
      random: async () => ({ id: 7, text: 'rand', user: 'baseca', game: null, date: '2024-05-06', quotedByName: 'm', createdAt: '' }),
    },
    lists: {
      displayNameOf: async (r: string) => (r === 'games' ? 'Completed Games' : null),
      entryAt: async (r: string, n: number) => (r === 'games' && n === 2 ? 'Metal Gear' : null),
      random: async (r: string) => (r === 'games' ? 'Half-Life' : null),
    },
    customCommands: { getUsageCount: async (t: { name: string }) => (t.name === 'death' ? 41 : null) },
    api: {} as never,
    broadcasterUsername: 'baseca',
    pointsName: 'BascaPoints',
    logger: noopLogger,
    ...over,
  } as unknown as VarDeps;
}

const ctx = (over: Partial<VarContext> = {}): VarContext => ({
  sender: { id: 'u1', login: 'styler', displayName: 'Styler' },
  channel: 'baseca',
  args: ['Alice', '25'],
  argString: 'Alice 25',
  command: { name: 'test', count: 5 },
  ...over,
});

const render = (tpl: string, c: VarContext = ctx(), deps: VarDeps = makeDeps()) => new CommandVarEngine(deps).render(tpl, c);

afterEach(() => vi.restoreAllMocks());

describe('CommandVarEngine — args', () => {
  it('$(args) and indexed args', async () => {
    expect(await render('in: $(args)')).toBe('in: Alice 25');
    expect(await render('$(1) is $(2) years old')).toBe('Alice is 25 years old');
    expect(await render('$(args.2)')).toBe('25');
    expect(await render('$(9)')).toBe(''); // missing -> empty
  });
  it('${n:} argument slices', async () => {
    expect(await render('${1:}')).toBe('Alice 25');
    expect(await render('${2:}')).toBe('25');
    expect(await render('${1:1}')).toBe('Alice');
  });
  it('$(n.word) and $(n.emote) filters', async () => {
    expect(await render('$(1.word)')).toBe('Alice');
    expect(await render('$(1.word)', ctx({ args: ['a!b'] }))).toBe(''); // has a symbol
  });
});

describe('CommandVarEngine — sender/user/points/pointsname', () => {
  it('sender variants', async () => {
    expect(await render('$(sender) / $(sender.name) / $(sender.points)')).toBe('Styler / styler / 100');
    expect(await render('$(source)')).toBe('Styler'); // alias
  });
  it('user with an argument', async () => {
    expect(await render('$(user bob) has $(user.points bob)')).toBe('Bob has 0');
    expect(await render('$(user)')).toBe('Styler'); // defaults to sender
  });
  it('pointsname', async () => {
    expect(await render('Earn $(pointsname)!')).toBe('Earn BascaPoints!');
  });
});

describe('CommandVarEngine — count', () => {
  it('current command count and another command', async () => {
    expect(await render('deaths: $(count)')).toBe('deaths: 5');
    expect(await render('$(count !death)')).toBe('41');
    expect(await render('$(getcount !death)')).toBe('41'); // alias
    expect(await render('$(count !unknown)')).toBe('0');
  });
});

describe('CommandVarEngine — math/escape/repeat/random', () => {
  it('math evaluates (with nested vars)', async () => {
    expect(await render('$(math "round(10/3)")')).toBe('3');
    expect(await render('$(math "$(1) * 2")', ctx({ args: ['5'] }))).toBe('10');
  });
  it('invalid math yields empty (never throws)', async () => {
    expect(await render('$(math "2 +")')).toBe(''); // parse error -> empty
  });
  it('path/queryescape', async () => {
    expect(await render('$(pathescape "User Input & Symbols?")')).toBe('User%20Input%20%26%20Symbols%3F');
    expect(await render('$(queryescape funny cat videos)')).toBe('funny+cat+videos');
  });
  it('repeat, including a nested variable (evaluated once)', async () => {
    expect(await render('$(repeat 3 Kappa)')).toBe('Kappa Kappa Kappa');
    expect(await render('$(repeat 2 "$(sender) is awesome!")')).toBe('Styler is awesome! Styler is awesome!');
  });
  it('random number + pick are within range/list', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // lowest bound / first item
    expect(await render('$(random 1-6)')).toBe('1');
    expect(await render("$(random.pick 'pizza' 'pasta' 'salad')")).toBe('pizza');
  });
});

describe('CommandVarEngine — quote/list', () => {
  it('quote by id (formatted)', async () => {
    expect(await render('$(quote 3)')).toBe('Quote 3: "hi" - @baseca [Elden Ring] [2024/01/02]');
  });
  it('list name, nth entry, and random entry', async () => {
    expect(await render('$(list games)')).toBe('Completed Games');
    expect(await render('$(list.2 games)')).toBe('Metal Gear');
    expect(await render('$(list.0 games)')).toBe('Half-Life');
    expect(await render('$(list nope)')).toBe(''); // unknown list
  });
});

describe('CommandVarEngine — robustness', () => {
  it('unknown variables and bad syntax degrade to empty / literal', async () => {
    expect(await render('a$(bogus)b')).toBe('ab');
    expect(await render('unbalanced $(args')).toBe('unbalanced $(args'); // no close -> literal
  });
  it('both $() and ${} syntaxes work', async () => {
    expect(await render('${sender} and $(sender)')).toBe('Styler and Styler');
  });
});

describe('CommandVarEngine — channel/live data (mocked Helix)', () => {
  const api = (over: Record<string, unknown>) =>
    ({
      users: { getUserByName: async () => ({ id: 'b1', displayName: 'Baseca' }) },
      streams: { getStreamByUserId: async () => null },
      channels: {
        getChannelInfoById: async () => ({ gameName: 'Valorant', title: 'Ranked grind', displayName: 'Baseca' }),
        getChannelFollowers: async () => ({ total: 50000 }),
      },
      chat: { getChannelEmotes: async () => [], getChattersPaginated: () => ({ getAll: async () => [] }) },
      ...over,
    }) as unknown as VarDeps['api'];

  it('$(channel) is the channel name; display_name/game/followers via Helix', async () => {
    const deps = makeDeps({ api: api({}) });
    expect(await render('$(channel)', ctx(), deps)).toBe('baseca');
    expect(await render('$(channel.display_name)', ctx(), deps)).toBe('Baseca');
    expect(await render('$(channel.game)', ctx(), deps)).toBe('Valorant');
    expect(await render('$(channel.followers)', ctx(), deps)).toBe('50000');
  });

  it('viewers/uptime report "not live" when offline', async () => {
    const deps = makeDeps({ api: api({}) });
    const engine = new CommandVarEngine(deps);
    expect(await engine.render('$(channel.viewers)', ctx())).toBe('not live');
    expect(await engine.render('$(channel.uptime)', ctx())).toBe('not live');
  });

  it('viewers + uptime when live', async () => {
    const start = new Date(Date.now() - 2 * 3600_000 - 15 * 60_000); // 2h15m ago
    const deps = makeDeps({ api: api({ streams: { getStreamByUserId: async () => ({ viewers: 1337, startDate: start }) } }) });
    const engine = new CommandVarEngine(deps);
    expect(await engine.render('$(channel.viewers)', ctx())).toBe('1337');
    expect(await engine.render('$(channel.uptime)', ctx())).toBe('2 hours 15 minutes');
  });
});
