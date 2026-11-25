import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

interface LoadedPluginEntry {
  id: string;
  factory: (require: (id: string) => Record<string, unknown>) => {
    apply: (ctx: {
      slots: {
        inject: (name: string, fn: () => unknown) => unknown;
        register: (slot: Record<string, unknown>, render: unknown) => unknown;
      };
    }) => void;
  };
}

const candidates = [
  new URL('../../lib/client.js', import.meta.url),
  new URL('../lib/client.js', import.meta.url),
];

test('compiled GitHub connector client.js runs as classic script and registers @local/dsh-connector-github', () => {
  const clientUrl = candidates.find((u) => existsSync(u)) ?? candidates[0];
  const code = readFileSync(clientUrl, 'utf8');
  assert.doesNotMatch(code, /^\s*export\s/m);
  assert.doesNotMatch(code, /^\s*import\s/m);
  new vm.Script(code);
  let loaded: LoadedPluginEntry | undefined;
  const regs: Array<{ slot: Record<string, unknown> }> = [];
  vm.runInNewContext(code, {
    window: {
      __ModuleLoader__: {
        load: (entry: LoadedPluginEntry) => {
          loaded = entry;
        },
      },
    },
  });
  assert.ok(loaded);
  assert.equal(loaded.id, '@local/dsh-connector-github');
  const plugin = loaded.factory(() => ({}));
  plugin.apply({
    slots: {
      inject: (_n, fn) => fn(),
      register: (slot) => regs.push({ slot }),
    },
  });
  assert.equal(regs.length, 2);
  assert.equal(regs[0].slot.key, regs[1].slot.id);
  assert.equal((regs[1].slot.label as () => string)(), 'GitHub');
});


interface FakeEl { type: unknown; props: Record<string, unknown>; children: unknown[] }

function createFakeReact(): { React: Record<string, unknown>; render: (comp: () => unknown) => unknown; rerender: () => unknown } {
  const states: unknown[] = [];
  const effectDeps: Array<readonly unknown[] | undefined> = [];
  const pending: Array<() => void> = [];
  let idx = 0;
  let eIdx = 0;
  let comp: (() => unknown) | null = null;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
    Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  const memo = new Map<number, { deps: readonly unknown[]; value: unknown }>();
  const React = {
    Fragment: 'Fragment',
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeEl => ({ type, props: props ?? {}, children }),
    useState: <T,>(init: T | (() => T)) => {
      const i = idx++;
      if (!(i in states)) states[i] = typeof init === 'function' ? (init as () => T)() : init;
      const set = (next: T | ((p: T) => T)) => {
        states[i] = typeof next === 'function' ? (next as (p: T) => T)(states[i] as T) : next;
      };
      return [states[i] as T, set];
    },
    useEffect: (fn: () => void, deps?: readonly unknown[]) => {
      const i = eIdx++;
      if (!same(effectDeps[i], deps)) {
        effectDeps[i] = deps;
        pending.push(fn);
      }
    },
    useCallback: <T,>(fn: T) => fn,
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => {
      const i = eIdx++;
      const hit = memo.get(i);
      if (hit && same(hit.deps, deps)) return hit.value as T;
      const value = factory();
      memo.set(i, { deps, value });
      return value;
    },
  };
  const rerender = (): unknown => {
    idx = 0;
    eIdx = 0;
    const out = comp ? comp() : null;
    while (pending.length) pending.shift()?.();
    return out;
  };
  return { React, render: (c) => { comp = c; return rerender(); }, rerender };
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const el = node as FakeEl;
  if (el.type === 'style') return '';
  return (el.children ?? []).map(textOf).join('');
}

function findAll(node: unknown, pred: (el: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, out);
    return out;
  }
  const el = node as FakeEl;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) findAll(c, pred, out);
  return out;
}

const baseConfig = {
  authStatus: { configured: true, source: 'gh', login: 'example-owner', scopes: ['repo', 'notifications'], notificationsScopeMissing: false, hasBotToken: false, actMode: 'app', githubApp: { configured: true, appId: 1, slug: 'example-bot', botLogin: 'example-bot[bot]' } },
  enableNotifications: true,
  pollIntervalMs: 60000,
  autoSendOwners: ['example-owner'],
  repos: [{ repo: 'example-owner/example-repo', localPath: '/tmp/x' }],
  pinnedItems: [{ repo: 'example-owner/example-repo', number: 222, linkedPrs: [], watchReactions: true }],
};

async function mountPanel(events: unknown[]): Promise<{ fake: ReturnType<typeof createFakeReact>; fetched: string[]; tree: unknown }> {
  const clientUrl = candidates.find((u) => existsSync(u)) ?? candidates[0];
  const code = readFileSync(clientUrl, 'utf8');
  const fetched: string[] = [];
  const fetchFake = async (path: string) => {
    fetched.push(path);
    const body = path.endsWith('/config') ? baseConfig : path.endsWith('/events') ? { events } : { personas: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const fake = createFakeReact();
  let panel: (() => unknown) | undefined;
  let entry: LoadedPluginEntry | undefined;
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load: (e: LoadedPluginEntry) => { entry = e; } } },
    fetch: fetchFake,
    setInterval: () => 0,
    clearInterval: () => undefined,
    Date,
  });
  assert.ok(entry);
  entry.factory(() => fake.React).apply({
    slots: {
      inject: (_n, fn) => fn(),
      register: (slot, render) => {
        if (slot.key === 'dsh-connector-github-panel') panel = render as () => unknown;
        if (slot.id) assert.equal(slot.order, 12);
      },
    },
  });
  assert.ok(panel);
  fake.render(panel);
  await new Promise((r) => setTimeout(r, 10));
  return { fake, fetched, tree: fake.rerender() };
}

const articles = (tree: unknown): FakeEl[] => findAll(tree, (el) => el.type === 'article');

function expand(fake: ReturnType<typeof createFakeReact>, card: FakeEl): unknown {
  const more = findAll(card, (el) => el.props['aria-expanded'] === false)[0];
  assert.ok(more);
  (more.props.onClick as () => void)();
  return fake.rerender();
}

test('GitHub panel groups events of the same issue into one collapsible thread card with 3 tabs', async () => {
  const now = Date.now();
  const iso = (minAgo: number): string => new Date(now - minAgo * 60000).toISOString();
  const events = [
    { id: 'e1', source: 'github', type: 'github.issue_comment', repo: 'example-owner/example-repo', number: 222, entityKey: 'github:example-owner/example-repo#222', threadKey: 'github:example-owner/example-repo#222', actor: 'alice', summary: 'latest comment body', url: 'https://github.com/example-owner/example-repo/issues/222#issuecomment-1', occurredAt: iso(2) },
    { id: 'e2', source: 'github', type: 'github.pinned.activity', repo: 'example-owner/example-repo', number: 222, entityKey: 'github:example-owner/example-repo#222', threadKey: 'github:example-owner/example-repo#222', actor: 'bob', summary: 'pinned activity', url: null, occurredAt: iso(30) },
    { id: 'e3', source: 'github', type: 'github.issue.updated', repo: 'example-owner/example-repo', number: 222, entityKey: 'github:example-owner/example-repo#222', threadKey: 'github:example-owner/example-repo#222', actor: { login: 'carol' }, summary: 'issue updated', rawRef: { url: 'https://github.com/example-owner/example-repo/issues/222' }, occurredAt: iso(90) },
    { id: 'e4', source: 'github', type: 'github.pr.updated', repo: 'example-owner/other', number: 7, entityKey: 'github:example-owner/other#7', threadKey: 'github:example-owner/other#7', actor: 'dave', summary: 'pr updated', url: null, occurredAt: iso(5) },
  ];
  const { fake, fetched, tree } = await mountPanel(events);
  assert.ok(fetched.includes('/connector/github/events'));
  const tabs = findAll(tree, (el) => el.props.role === 'tab' && String(el.props.className).includes('gh-tab')).map(textOf);
  assert.deepEqual(tabs.map((t) => t.replace(/\d+|!/g, '')), ['事件箱', '仓库与盯防', '账号与高级设置']);
  const cards = articles(tree);
  assert.equal(cards.length, 2);
  const first = textOf(cards[0]);
  assert.match(first, /example-owner\/example-repo#222/);
  assert.match(first, /共 3 条动态/);
  assert.match(first, /Issue 主楼/);
  assert.match(first, /@carol/);
  assert.match(first, /issue updated/);
  assert.match(first, /展开 2 条评论动态/);
  assert.doesNotMatch(first, /pinned activity/);
  assert.doesNotMatch(first, /latest comment body/);
  const opened = textOf(articles(expand(fake, cards[0]))[0]);
  assert.match(opened, /收起/);
  assert.match(opened, /pinned activity/);
  assert.match(opened, /@alice/);
  const second = textOf(articles(fake.rerender())[1]);
  assert.match(second, /PR 主楼/);
  assert.match(second, /PR 于/);
});

test('issue head stays on top, comments follow in ascending occurredAt order with dual timestamps', async () => {
  const now = Date.now();
  const iso = (minAgo: number): string => new Date(now - minAgo * 60000).toISOString();
  const k = { repo: 'example-owner/zero', number: 42, entityKey: 'github:example-owner/zero#42', threadKey: 'github:example-owner/zero#42' };
  const events = [
    { ...k, id: 'c3', type: 'github.issue_comment', actor: 'zed', summary: 'third comment', url: 'https://github.com/example-owner/zero/issues/42#issuecomment-3', occurredAt: iso(3), ingestedAt: iso(1) },
    { ...k, id: 'c1', type: 'github.issue_comment', actor: 'amy', summary: 'first comment', url: 'https://github.com/example-owner/zero/issues/42#issuecomment-1', occurredAt: iso(120), ingestedAt: iso(100) },
    { ...k, id: 'h1', type: 'github.issue.updated', actor: 'owner', summary: 'issue body main floor', url: 'https://github.com/example-owner/zero/issues/42', occurredAt: iso(600), ingestedAt: iso(590) },
    { ...k, id: 'c2', type: 'github.issue_comment', actor: 'ben', summary: 'second comment', url: 'https://github.com/example-owner/zero/issues/42#issuecomment-2', occurredAt: iso(60) },
    { id: 'o1', type: 'github.issue_comment', repo: 'example-owner/only', number: 9, entityKey: 'github:example-owner/only#9', threadKey: 'github:example-owner/only#9', actor: 'early', summary: 'early only comment', url: 'https://github.com/example-owner/only/issues/9#issuecomment-1', occurredAt: iso(30) },
    { id: 'o2', type: 'github.issue_comment', repo: 'example-owner/only', number: 9, entityKey: 'github:example-owner/only#9', threadKey: 'github:example-owner/only#9', actor: 'late', summary: 'late only comment', url: 'https://github.com/example-owner/only/issues/9#issuecomment-2', occurredAt: iso(10) },
  ];
  const { fake, tree } = await mountPanel(events);
  const cards = articles(tree);
  assert.equal(cards.length, 2);
  const head = textOf(cards[0]);
  assert.match(head, /example-owner\/zero#42/);
  assert.match(head, /Issue 主楼/);
  assert.match(head, /@owner/);
  assert.match(head, /issue body main floor/);
  assert.match(head, /展开 3 条评论动态 ▾/);
  assert.doesNotMatch(head, /first comment|second comment|third comment/);
  const headTimes = findAll(cards[0], (el) => el.props.className === 'gh-times');
  assert.equal(headTimes.length, 1);
  assert.match(textOf(headTimes[0]), /^Issue 于.+·拉取于.+$/);
  const headTimeEls = findAll(headTimes[0], (el) => el.type === 'time');
  assert.equal(headTimeEls.length, 2);
  for (const t of headTimeEls) assert.match(String(t.props.title), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(headTimeEls[0].props.dateTime, iso(600));
  assert.equal(headTimeEls[1].props.dateTime, iso(590));

  const openedCard = articles(expand(fake, cards[0]))[0];
  const openedText = textOf(openedCard);
  assert.match(openedText, /收起 ▴/);
  assert.ok(openedText.indexOf('issue body main floor') < openedText.indexOf('first comment'));
  const items = findAll(openedCard, (el) => el.type === 'li');
  assert.equal(items.length, 3);
  const itemText = items.map(textOf);
  assert.match(itemText[0], /#1.*@amy.*first comment/);
  assert.match(itemText[1], /#2.*@ben.*second comment/);
  assert.match(itemText[2], /#3.*@zed.*third comment/);
  for (const t of itemText) assert.match(t, /评论于/);
  assert.match(itemText[0], /拉取于/);
  assert.doesNotMatch(itemText[1], /拉取于/);
  assert.match(itemText[2], /拉取于/);
  const c2Times = findAll(items[1], (el) => el.type === 'time');
  assert.equal(c2Times.length, 1);
  assert.equal(c2Times[0].props.dateTime, iso(60));

  const fallback = textOf(articles(fake.rerender())[1]);
  assert.match(fallback, /example-owner\/only#9/);
  assert.match(fallback, /评论/);
  assert.doesNotMatch(fallback, /主楼/);
  assert.match(fallback, /early only comment/);
  assert.doesNotMatch(fallback, /late only comment/);
  assert.match(fallback, /评论于/);
  assert.doesNotMatch(fallback, /拉取于/);
  assert.match(fallback, /展开 1 条评论动态/);
});
