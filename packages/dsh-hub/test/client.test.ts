import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

interface ModuleRegistration {
  id: string;
  factory: (require: (mod: string) => unknown) => {
    inject: string[];
    apply: (ctx: {
      slots: {
        inject: (name: string, factory: () => unknown) => void;
        register: (meta: Record<string, unknown>, component: unknown) => unknown;
      };
      uiWorkspace?: {
        openSession?: (sessionId: string) => void;
      };
    }) => void;
  };
}

test('compiled lib/client.js executes as a classic script and registers @local/dsh-hub via __ModuleLoader__.load', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const clientPath = path.resolve(testDir, '..', '..', 'lib', 'client.js');
  const code = fs.readFileSync(clientPath, 'utf8');

  assert.equal(/^\s*export\b/m.test(code), false);
  assert.equal(/^\s*import\b/m.test(code), false);

  const registrations: ModuleRegistration[] = [];
  const sandboxWindow = {
    __ModuleLoader__: {
      load(spec: ModuleRegistration): void {
        registrations.push(spec);
      },
    },
  };

  const script = new vm.Script(code, { filename: 'lib/client.js' });
  const context = vm.createContext({ window: sandboxWindow, globalThis: sandboxWindow });
  script.runInContext(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@local/dsh-hub');
  assert.equal(typeof registrations[0].factory, 'function');

  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    Fragment: Symbol('Fragment'),
    useState: <T,>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, () => {}],
    useEffect: () => {},
    useCallback: <T,>(fn: T) => fn,
  };

  const plugin = registrations[0].factory((mod: string) => {
    assert.equal(mod, 'react');
    return fakeReact;
  });

  assert.deepEqual(Array.from(plugin.inject), ['slots', 'uiWorkspace']);
  assert.equal(typeof plugin.apply, 'function');

  const registeredSlots: Array<{ meta: Record<string, unknown>; component: unknown }> = [];
  const injectedSlotNames: string[] = [];
  const openedSessions: string[] = [];

  plugin.apply({
    slots: {
      inject(name: string, factory: () => unknown): void {
        injectedSlotNames.push(name);
        factory();
      },
      register(meta: Record<string, unknown>, component: unknown): unknown {
        registeredSlots.push({ meta, component });
        return meta;
      },
    },
    uiWorkspace: {
      openSession(sessionId: string): void {
        openedSessions.push(sessionId);
      },
    },
  });

  assert.deepEqual(injectedSlotNames, [
    'main',
    'sidebar.panellist',
    'conversation.session.header.utilities',
    'sidebar.session.row.leading',
  ]);
  assert.equal(registeredSlots.length, 4);

  const mainSlot = registeredSlots.find((s) => s.meta.name === 'main');
  assert.equal(mainSlot?.meta.key, 'dsh-hub-panel');
  assert.equal(typeof mainSlot?.component, 'function');

  const renderedTree = (mainSlot!.component as () => unknown)();
  const renderedJson = JSON.stringify(renderedTree);
  assert.ok(renderedJson.includes('Hub 总控台'));
  assert.ok(renderedJson.includes('收件箱'));
  assert.ok(renderedJson.includes('便签本'));
  assert.ok(renderedJson.includes('草稿箱'));
  assert.ok(renderedJson.includes('已接入插件'));

  const sidebarPanelSlot = registeredSlots.find((s) => s.meta.name === 'sidebar.panellist');
  assert.equal(sidebarPanelSlot?.meta.id, 'dsh-hub-panel');
  assert.equal((sidebarPanelSlot?.meta.label as () => string)(), 'Hub 总控台');

  const headerSlot = registeredSlots.find((s) => s.meta.name === 'conversation.session.header.utilities');
  assert.ok(headerSlot);
  const headerInject = headerSlot.meta.inject as (arg: unknown) => Record<string, unknown>;
  assert.equal(headerInject('sess-42').sessionId, 'sess-42');
  assert.equal(headerInject({ sessionId: 'sess-99' }).sessionId, 'sess-99');

  const rowLeadingSlot = registeredSlots.find((s) => s.meta.name === 'sidebar.session.row.leading');
  assert.ok(rowLeadingSlot);
  const rowLeadingInject = rowLeadingSlot.meta.inject as () => Record<string, unknown>;
  assert.deepEqual(Object.keys(rowLeadingInject()), []);
  assert.deepEqual(openedSessions, []);
});

interface HubVNode {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
}

function hubFind(node: unknown, predicate: (v: HubVNode) => boolean, out: HubVNode[] = []): HubVNode[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) hubFind(item, predicate, out);
    return out;
  }
  const v = node as HubVNode;
  if ('type' in v && 'children' in v) {
    if (predicate(v)) out.push(v);
    for (const child of v.children) hubFind(child, predicate, out);
  }
  return out;
}

function hubText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(hubText).join('');
  if (node && typeof node === 'object' && 'children' in (node as HubVNode)) return (node as HubVNode).children.map(hubText).join('');
  return '';
}

test('Hub inbox folds same-entity events into one thread card with timeline, search and source capsules', async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const code = fs.readFileSync(path.resolve(testDir, '..', '..', 'lib', 'client.js'), 'utf8');
  const registrations: ModuleRegistration[] = [];
  const fetchCalls: string[] = [];
  const ek = 'github:example-owner/example-repo#222';
  const inboxItems = [
    { id: 'i1', source: 'github', type: 'github.pinned.activity', entityKey: ek, actor: 'example-owner', sessionId: 'sess-222', summary: 'Latest pinned comment', tier: 'inbox-only', preGateTags: [], status: 'unread', rawUrl: 'https://github.com/example-owner/example-repo/issues/222#c4', createdAt: '2026-11-21T10:30:00Z' },
    { id: 'i2', source: 'github', type: 'github.pr.updated', entityKey: ek, actor: 'victorwads', sessionId: null, summary: 'Pushed fix commit', tier: 'review', verdict: 'ACTION_REQUIRED', preGateTags: [], status: 'triaged', createdAt: '2026-11-21T10:20:00Z' },
    { id: 'i3', source: 'github', type: 'github.issue.updated', entityKey: ek, actor: 'example-owner', sessionId: null, summary: 'Edited description', tier: 'inbox-only', preGateTags: [], status: 'triaged', createdAt: '2026-11-21T10:10:00Z' },
    { id: 'i4', source: 'github', type: 'github.pinned.activity', entityKey: ek, actor: 'example-owner', sessionId: null, summary: 'First pinned comment', tier: 'inbox-only', preGateTags: [], status: 'triaged', createdAt: '2026-11-21T10:00:00Z' },
    { id: 'w1', source: 'wechat', type: 'wechat.message', entityKey: null, actor: 'Alice', sessionId: null, summary: 'Hello from WeChat', tier: 'inbox-only', preGateTags: [], status: 'unread', createdAt: '2026-11-21T09:00:00Z' },
    { id: 'm1', source: 'memo', type: 'memo.time_nudge.due', entityKey: null, actor: 'memo', sessionId: null, summary: 'Memo reminder', tier: 'inbox-only', preGateTags: [], status: 'unread', createdAt: '2026-11-21T08:00:00Z' },
  ];
  const mockFetch = async (url: string) => {
    fetchCalls.push(url);
    const respond = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
    if (url === '/local-hub/status') return respond({ sources: [], connectors: [], sinks: [], activeWorkstreams: 0, unreadInbox: 3, pendingDrafts: 0, autoSessionsThisHour: 0 });
    if (url.startsWith('/local-hub/inbox')) return respond({ items: inboxItems });
    if (url === '/local-hub/memos') return respond({ memos: [] });
    if (url === '/local-hub/drafts') return respond({ drafts: [] });
    if (url === '/local-hub/connectors') return respond({ connectors: [] });
    if (url === '/local-hub/subscriptions') return respond({ subscriptions: [] });
    return respond({ ok: true });
  };
  const sandboxWindow = {
    __ModuleLoader__: { load(spec: ModuleRegistration): void { registrations.push(spec); } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  new vm.Script(code, { filename: 'lib/client.js' }).runInContext(
    vm.createContext({ window: sandboxWindow, globalThis: sandboxWindow, fetch: mockFetch, setInterval: () => 1, clearInterval: () => {} }),
  );

  const states: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  let effectsArmed = true;
  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): HubVNode => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: <T,>(initial: T | (() => T)) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      const setter = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === 'function' ? (next as (prev: T) => T)(states[idx] as T) : next;
      };
      return [states[idx] as T, setter];
    },
    useEffect: (effect: () => void | (() => void)) => {
      if (effectsArmed) effects.push(() => void effect());
    },
    useCallback: <T,>(fn: T) => fn,
  };
  const plugin = registrations[0].factory(() => fakeReact);
  const slots: Array<{ meta: Record<string, unknown>; component: unknown }> = [];
  const opened: string[] = [];
  plugin.apply({
    slots: { inject: (_n: string, f: () => unknown) => void f(), register: (meta: Record<string, unknown>, component: unknown) => slots.push({ meta, component }) },
    uiWorkspace: { openSession: (id: string) => void opened.push(id) },
  });
  const main = slots.find((s) => s.meta.name === 'main')!;
  const render = (): HubVNode => {
    cursor = 0;
    return (main.component as () => HubVNode)();
  };

  render();
  effectsArmed = false;
  for (const run of effects) run();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fetchCalls.includes('/local-hub/inbox?limit=200'));

  let tree = render();
  const threadCards = () => hubFind(tree, (v) => v.type === 'article' && String(v.props?.className ?? '').includes('dw-thread'));
  assert.equal(threadCards().length, 3);
  const ghCard = threadCards()[0];
  const ghText = hubText(ghCard);
  assert.ok(ghText.includes('example-owner/example-repo #222'));
  assert.equal(ghText.includes('github:example-owner'), false);
  assert.ok(ghText.includes('GitHub'));
  assert.ok(ghText.includes('PR 更新'));
  assert.ok(ghText.includes('PR 主楼'));
  assert.ok(ghText.includes('@victorwads'));
  assert.ok(ghText.includes('4 条动态'));
  assert.ok(ghText.includes('展开 3 条后续动态 ▾'));
  assert.ok(ghText.includes('入箱于'));
  assert.ok(ghText.includes('Pushed fix commit'));
  assert.equal(ghText.includes('Latest pinned comment'), false);
  assert.equal(JSON.stringify(tree).includes('dangerouslySetInnerHTML'), false);

  const openBtn = hubFind(ghCard, (v) => v.type === 'button' && hubText(v) === '打开 DSH 会话')[0];
  (openBtn.props!.onClick as () => void)();
  assert.deepEqual(opened, ['sess-222']);
  assert.ok(hubFind(ghCard, (v) => v.type === 'a' && v.props?.href === 'https://github.com/example-owner/example-repo/issues/222#c4').length > 0);

  const countBtn = hubFind(ghCard, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dw-count'))[0];
  (countBtn.props!.onClick as () => void)();
  tree = render();
  const items = hubFind(threadCards()[0], (v) => v.type === 'li' && String(v.props?.className ?? '').includes('dw-tl-item'));
  assert.equal(items.length, 3);
  assert.ok(hubText(items[0]).includes('评论 1'));
  assert.ok(hubText(items[0]).includes('First pinned comment'));
  assert.ok(hubText(items[1]).includes('主楼旧快照'));
  assert.ok(hubText(items[1]).includes('Issue 更新'));
  assert.ok(hubText(items[2]).includes('评论 2'));
  assert.ok(hubText(items[2]).includes('Latest pinned comment'));
  (countBtn.props!.onClick as () => void)();

  const caps = () => hubFind(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dw-cap'));
  assert.deepEqual(caps().map((c) => hubText(c)), ['全部3', 'GitHub1', '微信1', '备忘1']);
  (caps()[2].props!.onClick as () => void)();
  tree = render();
  assert.equal(threadCards().length, 1);
  assert.ok(hubText(threadCards()[0]).includes('Hello from WeChat'));
  (caps()[0].props!.onClick as () => void)();
  tree = render();

  const search = hubFind(tree, (v) => v.type === 'input' && String(v.props?.className ?? '').includes('dw-search'))[0];
  (search.props!.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'first pinned' } });
  tree = render();
  assert.equal(threadCards().length, 1);
  const hits = hubFind(tree, (v) => v.type === 'li' && String(v.props?.className ?? '').includes('hit'));
  assert.equal(hits.length, 1);
  assert.ok(hubText(hits[0]).includes('First pinned comment'));
});

function hubPad(n: number): string {
  return String(n).padStart(2, '0');
}

function hubAbs(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hubPad(d.getHours())}:${hubPad(d.getMinutes())}`;
}

function hubFull(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${hubPad(d.getMonth() + 1)}-${hubPad(d.getDate())} ${hubPad(d.getHours())}:${hubPad(d.getMinutes())}:${hubPad(d.getSeconds())}`;
}

test('Hub inbox shows Issue root on top, comments folded by occurredAt ascending, each with original + inbox time', async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const code = fs.readFileSync(path.resolve(testDir, '..', '..', 'lib', 'client.js'), 'utf8');
  const registrations: ModuleRegistration[] = [];
  const ek = 'github:org/repo#240';
  const base = { source: 'github', entityKey: ek, sessionId: null, tier: 'inbox-only', preGateTags: [], status: 'triaged' };
  const root = { ...base, id: 'root', type: 'github.issue.updated', actor: 'example-owner', summary: 'Issue root body', rawUrl: 'https://github.com/org/repo/issues/240', occurredAt: '2026-11-20T15:29:00Z', createdAt: '2026-11-21T09:00:00Z' };
  const c1 = { ...base, id: 'c1', type: 'github.issue.comment', actor: 'amy', summary: 'Comment one', rawUrl: 'https://github.com/org/repo/issues/240#issuecomment-1', occurredAt: '2026-11-20T16:00:00Z', createdAt: '2026-11-21T11:00:00Z' };
  const c2 = { ...base, id: 'c2', type: 'github.pinned.activity', actor: 'ben', summary: 'Comment two', rawUrl: 'https://github.com/org/repo/issues/240#issuecomment-2', occurredAt: '2026-11-20T17:00:00Z', createdAt: '2026-11-21T08:00:00Z' };
  const c3 = { ...base, id: 'c3', type: 'github.event', actor: 'cat', summary: 'Comment three', rawUrl: 'https://github.com/org/repo/issues/240#issuecomment-3', occurredAt: '2026-11-20T18:00:00Z', createdAt: '2026-11-21T10:00:00Z' };
  const items = [c1, c3, root, c2];
  const mockFetch = async (url: string) => {
    const respond = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
    if (url === '/local-hub/status') return respond({ sources: [], connectors: [], sinks: [], activeWorkstreams: 0, unreadInbox: 0, pendingDrafts: 0, autoSessionsThisHour: 0 });
    if (url.startsWith('/local-hub/inbox')) return respond({ items });
    if (url === '/local-hub/memos') return respond({ memos: [] });
    if (url === '/local-hub/drafts') return respond({ drafts: [] });
    if (url === '/local-hub/connectors') return respond({ connectors: [] });
    if (url === '/local-hub/subscriptions') return respond({ subscriptions: [] });
    return respond({ ok: true });
  };
  const sandboxWindow = { __ModuleLoader__: { load(spec: ModuleRegistration): void { registrations.push(spec); } }, addEventListener: () => {}, removeEventListener: () => {} };
  new vm.Script(code, { filename: 'lib/client.js' }).runInContext(vm.createContext({ window: sandboxWindow, globalThis: sandboxWindow, fetch: mockFetch, setInterval: () => 1, clearInterval: () => {} }));
  const states: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  let armed = true;
  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): HubVNode => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: <T,>(initial: T | (() => T)) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      const setter = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === 'function' ? (next as (prev: T) => T)(states[idx] as T) : next;
      };
      return [states[idx] as T, setter];
    },
    useEffect: (effect: () => void | (() => void)) => {
      if (armed) effects.push(() => void effect());
    },
    useCallback: <T,>(fn: T) => fn,
  };
  const plugin = registrations[0].factory(() => fakeReact);
  const slots: Array<{ meta: Record<string, unknown>; component: unknown }> = [];
  plugin.apply({ slots: { inject: (_n: string, f: () => unknown) => void f(), register: (meta: Record<string, unknown>, component: unknown) => slots.push({ meta, component }) } });
  const main = slots.find((s) => s.meta.name === 'main')!;
  const render = (): HubVNode => {
    cursor = 0;
    return (main.component as () => HubVNode)();
  };
  render();
  armed = false;
  for (const run of effects) run();
  await new Promise((r) => setTimeout(r, 20));

  let tree = render();
  const card = () => hubFind(tree, (v) => v.type === 'article' && String(v.props?.className ?? '').includes('dw-thread'))[0];
  const cls = (v: HubVNode, name: string): boolean => String(v.props?.className ?? '') === name;
  const head = card();
  assert.ok(hubText(head).includes('Issue 主楼'));
  assert.ok(hubText(head).includes('Issue root body'));
  assert.equal(hubText(head).includes('Comment one'), false);
  const headSrc = hubFind(head, (v) => cls(v, 'dw-tm src'))[0];
  assert.equal(hubText(headSrc), `Issue 于 ${hubAbs(root.occurredAt)}`);
  assert.equal(headSrc.props?.title, hubFull(root.occurredAt));
  const headAna = hubFind(head, (v) => cls(v, 'dw-tm ana'))[0];
  assert.ok(hubText(headAna).startsWith('入箱于 '));
  assert.equal(headAna.props?.title, hubFull(root.createdAt));

  const toggle = hubFind(head, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dw-tl-toggle'))[0];
  assert.equal(hubText(toggle), '展开 3 条评论 ▾');
  (toggle.props!.onClick as () => void)();
  tree = render();
  assert.ok(hubText(card()).includes('收起评论 ▴'));
  const floors = hubFind(card(), (v) => v.type === 'li' && String(v.props?.className ?? '').includes('dw-tl-item'));
  assert.equal(floors.length, 3);
  assert.deepEqual(floors.map((f) => hubText(hubFind(f, (v) => String(v.props?.className ?? '').startsWith('dw-floor'))[0])), ['评论 1', '评论 2', '评论 3']);
  [c1, c2, c3].forEach((c, i) => {
    assert.ok(hubText(floors[i]).includes(c.summary));
    assert.ok(hubText(floors[i]).includes(`@${c.actor}`));
    assert.equal(hubText(hubFind(floors[i], (v) => cls(v, 'dw-tm src'))[0]), `评论于 ${hubAbs(c.occurredAt)}`);
    assert.ok(hubText(hubFind(floors[i], (v) => cls(v, 'dw-tm ana'))[0]).startsWith('入箱于 '));
  });
});

test('Hub MemoTab shows active memos first, folds history, and localizes statuses and reasons', async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const code = fs.readFileSync(path.resolve(testDir, '..', '..', 'lib', 'client.js'), 'utf8');
  const registrations: ModuleRegistration[] = [];
  const memoRows = [
    {
      id: 'm-active',
      kind: 'time_nudge',
      roomKey: 'wechat:room-1',
      targetSessionId: null,
      title: '提醒做八段锦（明天）',
      basis: '明天傍晚提醒做八段锦',
      status: 'active',
      nextCheckAt: '2026-11-24T10:49:07.000Z',
      lastCheckedAt: null,
      resultSummary: 'deferred:proactive_budget_exhausted',
    },
    {
      id: 'm-torn',
      kind: 'time_nudge',
      roomKey: 'wechat:room-1',
      targetSessionId: null,
      title: '提醒做八段锦（今天）',
      basis: '今天傍晚提醒做八段锦',
      status: 'torn',
      nextCheckAt: null,
      lastCheckedAt: '2026-11-23T09:03:37.579Z',
      resultSummary: 'proactive_budget_exhausted',
    },
    {
      id: 'm-fired',
      kind: 'time_nudge',
      roomKey: 'wechat:room-1',
      targetSessionId: null,
      title: '提醒做八段锦（昨天）',
      basis: '昨天傍晚提醒做八段锦',
      status: 'fired',
      nextCheckAt: null,
      lastCheckedAt: '2026-11-22T09:14:11.749Z',
      resultSummary: 'fired_wechat_session:2026-11-22T09:14:11.749Z',
    },
  ];
  const mockFetch = async (url: string) => {
    const respond = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
    if (url === '/local-hub/status') return respond({ sources: [], connectors: [], sinks: [], activeWorkstreams: 0, unreadInbox: 0, pendingDrafts: 0, autoSessionsThisHour: 0 });
    if (url.startsWith('/local-hub/inbox')) return respond({ items: [] });
    if (url === '/local-hub/memos') return respond({ memos: memoRows });
    if (url === '/local-hub/drafts') return respond({ drafts: [] });
    if (url === '/local-hub/connectors') return respond({ connectors: [] });
    if (url === '/local-hub/subscriptions') return respond({ subscriptions: [] });
    return respond({ ok: true });
  };
  const sandboxWindow = {
    __dshHubPendingTab: 'memos',
    __ModuleLoader__: { load(spec: ModuleRegistration): void { registrations.push(spec); } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  new vm.Script(code, { filename: 'lib/client.js' }).runInContext(
    vm.createContext({ window: sandboxWindow, globalThis: sandboxWindow, fetch: mockFetch, setInterval: () => 1, clearInterval: () => {} }),
  );

  const states: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  let armed = true;
  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): HubVNode => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: <T,>(initial: T | (() => T)) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      const setter = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === 'function' ? (next as (prev: T) => T)(states[idx] as T) : next;
      };
      return [states[idx] as T, setter];
    },
    useEffect: (effect: () => void | (() => void)) => {
      if (armed) effects.push(() => void effect());
    },
    useCallback: <T,>(fn: T) => fn,
  };
  const plugin = registrations[0].factory(() => fakeReact);
  const slots: Array<{ meta: Record<string, unknown>; component: unknown }> = [];
  plugin.apply({
    slots: { inject: (_n: string, f: () => unknown) => void f(), register: (meta: Record<string, unknown>, component: unknown) => slots.push({ meta, component }) },
  });
  const main = slots.find((s) => s.meta.name === 'main')!;
  const render = (): HubVNode => {
    cursor = 0;
    const raw = (main.component as () => HubVNode)();
    const expand = (node: unknown): unknown => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(expand);
      const v = node as HubVNode;
      if (typeof v.type === 'function') {
        return expand((v.type as (p: Record<string, unknown>) => unknown)(v.props ?? {}));
      }
      return { ...v, children: v.children.map(expand) };
    };
    return expand(raw) as HubVNode;
  };

  render();
  armed = false;
  for (const run of effects) run();
  await new Promise((r) => setTimeout(r, 20));

  let tree = render();
  const memoCards = () => hubFind(tree, (v) => v.type === 'article' && String(v.props?.className ?? '').includes('dw-memo-card'));
  assert.equal(memoCards().length, 1);
  assert.ok(hubText(memoCards()[0]).includes('进行中'));
  assert.ok(hubText(memoCards()[0]).includes('主动消息额度已用尽，已顺延至额度恢复后重试'));
  assert.equal(hubText(tree).includes('提醒做八段锦（今天）'), false);

  const historyToggle = hubFind(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dw-memo-history-toggle'))[0];
  assert.ok(hubText(historyToggle).includes('展开 2 条历史便签'));
  (historyToggle.props!.onClick as () => void)();
  tree = render();
  assert.equal(memoCards().length, 3);
  const fullText = hubText(tree);
  assert.ok(fullText.includes('已撕掉'));
  assert.ok(fullText.includes('主动消息额度已用尽（当次未发出）'));
  assert.ok(fullText.includes('已触发'));
  assert.ok(fullText.includes('已交由微信会话自然发出'));
  assert.equal(fullText.includes('proactive_budget_exhausted'), false);
});
