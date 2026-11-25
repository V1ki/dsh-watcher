import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

interface VNode {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
}

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

function resolveClientBundlePath(): string {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const direct = path.resolve(testDir, '..', 'lib', 'client.js');
  if (fs.existsSync(direct)) return direct;
  return path.resolve(testDir, '..', '..', 'lib', 'client.js');
}

function findNodes(node: unknown, predicate: (v: VNode) => boolean, out: VNode[] = []): VNode[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, predicate, out);
    return out;
  }
  const v = node as VNode;
  if ('type' in v && 'children' in v) {
    if (predicate(v)) out.push(v);
    for (const child of v.children) findNodes(child, predicate, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'children' in (node as VNode)) {
    return (node as VNode).children.map(textOf).join('');
  }
  return '';
}

test('compiled lib/client.js executes as classic script, registers @local/dsh-router, and renders all 4 tabs', async () => {
  const clientPath = resolveClientBundlePath();
  const code = fs.readFileSync(clientPath, 'utf8');

  assert.equal(/^\s*export\b/m.test(code), false);
  assert.equal(/^\s*import\b/m.test(code), false);

  const registrations: ModuleRegistration[] = [];
  const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

  const mockPolicy = {
    enabled: true,
    timezone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    workStartHour: 9,
    workEndHour: 19,
    presenceMode: 'auto',
    lastWebActiveAt: '2026-11-21T10:00:00Z',
    workHoursDest: 'web',
    offHoursDest: 'defer',
    weekendDest: 'defer',
    awayFallbackDest: 'wechat',
    wechatTarget: 'owner',
    triageFilterEnabled: true,
    defaultMaxLevel: 'prepare',
  };

  const mockFetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET';
    fetchCalls.push({ url, method, body: init?.body });
    const respond = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
    if (url === '/local-router/status') {
      return respond({
        ok: true,
        enabled: true,
        presenceMode: 'auto',
        webActive: true,
        currentSlot: 'work',
        currentDestination: 'web',
        unreadNotifications: 1,
        pendingDecisions: 1,
        activeSubscriptions: 1,
        policy: mockPolicy,
      });
    }
    if (url === '/local-router/decisions') {
      return respond({
        decisions: [
          {
            id: 'dec-1',
            source: 'github',
            threadKey: 'github:org/repo#1',
            actor: 'alice',
            level: 'prepare',
            summary: 'CI failed on **PR #1**\n\n- rerun `npm test`\n- see [log](https://example.com/log)\n- bad [x](javascript:alert(1))',
            reason: 'Direct failure',
            question: 'How to proceed?',
            options: ['Fix now (Recommended)', 'Defer'],
            recommendedIndex: 0,
            answeredOption: null,
            status: 'filtered',
            destination: 'web',
            workerSessionId: 'sess-worker-1',
            subscriptionId: 'sub-1',
            rawUrl: 'https://example.com/pr/1',
            createdAt: '2026-11-21T10:00:00Z',
          },
          {
            id: 'dec-2',
            source: 'github',
            threadKey: 'org/repo#2',
            actor: 'bob',
            level: 'inform',
            summary: 'New issue opened',
            reason: 'llm_fail_open:triage_llm_invalid_json;deterministic_default_inform;capped_by_policy_prepare',
            question: null,
            options: [],
            recommendedIndex: null,
            answeredOption: null,
            status: 'notified',
            destination: 'web',
            workerSessionId: null,
            subscriptionId: null,
            rawUrl: null,
            createdAt: '2026-11-21T10:05:00Z',
          },
          {
            id: 'dec-3',
            source: 'github',
            threadKey: 'org/repo#1',
            actor: 'carol',
            level: 'inform',
            summary: 'Earlier comment from carol',
            reason: 'deterministic_default_inform',
            question: null,
            options: [],
            recommendedIndex: null,
            answeredOption: null,
            status: 'notified',
            destination: 'web',
            workerSessionId: null,
            subscriptionId: null,
            rawUrl: 'https://example.com/pr/1#c3',
            createdAt: '2026-11-21T09:00:00Z',
          },
          {
            id: 'dec-4',
            source: 'github',
            threadKey: 'github:github:org/repo#1',
            actor: 'dave',
            level: 'ignore',
            summary: 'Bot pushed a commit',
            reason: 'bot_self_filtered',
            question: null,
            options: [],
            recommendedIndex: null,
            answeredOption: null,
            status: 'filtered',
            destination: 'none',
            workerSessionId: null,
            subscriptionId: null,
            rawUrl: null,
            createdAt: '2026-11-21T08:00:00Z',
          },
        ],
      });
    }
    if (url === '/local-router/notifications') {
      return respond({
        notifications: [
          {
            id: 'notif-1',
            decisionId: 'dec-1',
            channel: 'web',
            title: '[github] github:org/repo#1',
            summary: 'CI failed on PR #1',
            reason: 'deterministic_actionable_github.pr.review_requested (work_present_policy_web)',
            rawUrl: 'https://example.com/pr/1',
            status: 'delivered',
            dueAt: null,
            createdAt: '2026-11-21T10:00:00Z',
          },
          {
            id: 'notif-2',
            decisionId: 'dec-2',
            channel: 'defer',
            title: '[github] org/repo#2',
            summary: 'New issue opened',
            reason: 'Off hours defer',
            rawUrl: null,
            status: 'deferred',
            dueAt: '2026-11-22T01:00:00Z',
            createdAt: '2026-11-21T12:00:00Z',
          },
          {
            id: 'notif-3',
            decisionId: 'dec-3',
            channel: 'wechat',
            title: '[github] org/repo#1',
            summary: 'Earlier comment from carol',
            reason: 'deterministic_default_inform (weekend_present_policy_defer);wechat_unavailable_deferred',
            rawUrl: null,
            status: 'delivered',
            dueAt: null,
            createdAt: '2026-11-21T09:00:00Z',
          },
        ],
      });
    }
    if (url.startsWith('/local-router/stats')) {
      return respond({
        days: 7,
        totalEvents: 12,
        notifiedCount: 5,
        filteredCount: 4,
        restoredCount: 1,
        restoreRate: 0.25,
        dispatchedWorkers: 3,
        activeSubscriptions: 1,
        answeredDecisions: 2,
        recommendedPickedCount: 2,
      });
    }
    if (url === '/local-router/subscriptions' && method === 'GET') {
      return respond({
        subscriptions: [
          {
            id: 'sub-1',
            source: 'github',
            threadKey: 'org/repo#1',
            sessionId: 'sess-worker-1',
            owner: 'router',
            status: 'active',
            updatedAt: '2026-11-21T10:00:00Z',
          },
        ],
      });
    }
    if (url === '/local-router/preview') {
      return respond({
        destination: 'wechat',
        slot: 'off_hours',
        present: false,
        reason: 'urgent_override_off_hours_wechat',
        dueAt: null,
      });
    }
    if (url === '/wxarc/automation') {
      return respond({
        targets: [
          { id: 'wxid_owner_demo', title: 'owner' },
          { id: 'demo-family@chatroom', title: '周末群' },
          { id: 'filehelper', title: '文件传输助手' },
        ],
      });
    }
    if (url === '/local-router/policy') return respond(mockPolicy);
    if (url === '/local-router/simulate-event') {
      return respond({ result: { accepted: true, routedVia: 'subscription' }, decision: null });
    }
    return respond({ ok: true });
  };

  const sandboxWindow = {
    __ModuleLoader__: {
      load(spec: ModuleRegistration): void {
        registrations.push(spec);
      },
    },
  };

  const script = new vm.Script(code, { filename: 'lib/client.js' });
  const context = vm.createContext({
    window: sandboxWindow,
    globalThis: sandboxWindow,
    fetch: mockFetch,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  script.runInContext(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@local/dsh-router');

  const states: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  let effectRan = false;

  const fakeReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode => ({
      type,
      props,
      children,
    }),
    useState: <T,>(initial: T | (() => T)) => {
      const idx = cursor++;
      if (!(idx in states)) {
        states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setter = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === 'function' ? (next as (prev: T) => T)(states[idx] as T) : next;
      };
      return [states[idx] as T, setter];
    },
    useEffect: (effect: () => void | (() => void)) => {
      if (!effectRan) effects.push(() => void effect());
    },
    useCallback: <T,>(fn: T) => fn,
  };

  const plugin = registrations[0].factory((mod: string) => {
    assert.equal(mod, 'react');
    return fakeReact;
  });

  assert.deepEqual(Array.from(plugin.inject), ['slots', 'uiWorkspace']);

  const registeredSlots: Array<{ meta: Record<string, unknown>; component: unknown }> = [];
  const openedSessions: string[] = [];

  plugin.apply({
    slots: {
      inject(_name: string, factory: () => unknown): void {
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

  const mainSlot = registeredSlots.find((s) => s.meta.name === 'main');
  const sidebarSlot = registeredSlots.find((s) => s.meta.name === 'sidebar.panellist');
  assert.equal(mainSlot?.meta.key, 'dsh-router-panel');
  assert.equal(sidebarSlot?.meta.id, 'dsh-router-panel');
  assert.equal(sidebarSlot?.meta.order, 10);
  assert.equal((sidebarSlot?.meta.label as () => string)(), 'Router');

  const render = (): VNode => {
    cursor = 0;
    return (mainSlot!.component as () => VNode)();
  };

  let tree = render();
  assert.equal(effects.length, 1);
  effectRan = true;
  effects[0]();
  await new Promise((r) => setTimeout(r, 20));
  tree = render();

  const iconTree = (sidebarSlot!.component as (p: { size?: number }) => VNode)({});
  assert.equal(iconTree.type, 'svg');

  const json = JSON.stringify(tree);
  assert.ok(json.includes('分诊'));
  assert.ok(json.includes('提醒队列'));
  assert.ok(json.includes('注意力与作息'));
  assert.ok(json.includes('效果与快车道'));
  assert.ok(json.includes('待你拍板'));
  assert.equal(json.includes('模拟测试事件'), false);
  assert.equal(json.includes('模拟冷启动'), false);
  assert.equal(json.includes('github:github:'), false);
  assert.equal(json.includes('github:org/repo'), false);
  assert.ok(json.includes('org/repo #1'));
  assert.ok(json.includes('@alice'));
  assert.ok(json.includes('已过滤'));
  assert.ok(json.includes('分诊依据'));
  assert.ok(json.includes('Direct failure'));
  assert.equal(json.includes('Earlier comment from carol'), false);
  assert.equal(json.includes('Bot pushed a commit'), false);
  assert.ok(json.includes('展开 2 条后续动态 ▾'));
  assert.ok(json.includes('分析于'));
  const countBtns = findNodes(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-count'));
  assert.equal(countBtns.length, 1);
  assert.equal(textOf(countBtns[0]), '3 条动态');
  assert.equal(findNodes(tree, (v) => v.type === 'article' && String(v.props?.className ?? '').includes('dr-card')).length, 1);

  assert.ok(findNodes(tree, (v) => v.type === 'strong' && textOf(v) === 'PR #1').length > 0);
  assert.ok(findNodes(tree, (v) => v.type === 'code' && textOf(v) === 'npm test').length > 0);
  assert.ok(findNodes(tree, (v) => v.type === 'a' && v.props?.href === 'https://example.com/log').length > 0);
  assert.equal(findNodes(tree, (v) => v.type === 'a' && String(v.props?.href ?? '').startsWith('javascript:')).length, 0);
  assert.equal(json.includes('dangerouslySetInnerHTML'), false);

  const optionCards = findNodes(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-opt'));
  assert.equal(optionCards.length, 2);
  assert.equal(textOf(optionCards[0]), 'AFix now推荐');
  assert.equal(textOf(optionCards[1]), 'BDefer');
  assert.ok(String(optionCards[0].props?.className).includes('rec'));

  const openSessionBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '打开 Worker 会话')[0];
  assert.ok(openSessionBtn);
  (openSessionBtn.props!.onClick as () => void)();
  assert.deepEqual(openedSessions, ['sess-worker-1']);

  const restoreBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '仍然通知')[0];
  assert.ok(restoreBtn);
  (restoreBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/decisions/dec-1/restore' && c.method === 'POST'));

  const dispatchBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '派 Worker 建快车道')[0];
  assert.ok(dispatchBtn);
  (dispatchBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/decisions/dec-2/dispatch' && c.method === 'POST'));

  (optionCards[0].props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/decisions/dec-1/answer' && c.body === '{"optionIndex":0}'));

  tree = render();
  const searchInput = findNodes(tree, (v) => v.type === 'input' && String(v.props?.className ?? '').includes('dr-search'))[0];
  assert.ok(searchInput);
  (searchInput.props!.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'carol' } });
  tree = render();
  const searchJson = JSON.stringify(tree);
  assert.ok(searchJson.includes('Earlier comment from carol'));
  assert.equal(searchJson.includes('New issue opened'), false);
  const hitItems = findNodes(tree, (v) => v.type === 'li' && String(v.props?.className ?? '').includes('hit'));
  assert.equal(hitItems.length, 1);
  assert.ok(textOf(hitItems[0]).includes('@carol'));
  (searchInput.props!.onChange as (e: { target: { value: string } }) => void)({ target: { value: '' } });
  tree = render();
  assert.equal(JSON.stringify(tree).includes('Earlier comment from carol'), false);
  const countBtn = findNodes(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-count'))[0];
  (countBtn.props!.onClick as () => void)();
  tree = render();
  const tlItems = findNodes(tree, (v) => v.type === 'li' && String(v.props?.className ?? '').includes('dr-tl-item'));
  assert.equal(tlItems.length, 2);
  assert.ok(textOf(tlItems[0]).includes('@dave'));
  assert.ok(textOf(tlItems[1]).includes('@carol'));
  const tlDispatch = findNodes(tlItems[1], (v) => v.type === 'button' && textOf(v) === '派 Worker')[0];
  assert.ok(tlDispatch);
  (tlDispatch.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/decisions/dec-3/dispatch' && c.method === 'POST'));
  const tlRestore = findNodes(tlItems[0], (v) => v.type === 'button' && textOf(v) === '仍然通知')[0];
  assert.ok(tlRestore);

  tree = render();
  const informSeg = findNodes(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-seg-btn') && textOf(v).startsWith('告知'))[0];
  assert.ok(informSeg);
  (informSeg.props!.onClick as () => void)();
  tree = render();
  const informJson = JSON.stringify(tree);
  assert.ok(informJson.includes('New issue opened'));
  assert.equal(informJson.includes('待你拍板 ·'), false);

  const tabBtn = (label: string): VNode => findNodes(tree, (v) => v.type === 'button' && v.props?.role === 'tab' && textOf(v).startsWith(label))[0];

  (tabBtn('提醒队列').props!.onClick as () => void)();
  tree = render();
  const notifJson = JSON.stringify(tree);
  assert.ok(notifJson.includes('org/repo #1'));
  assert.equal(notifJson.includes('[github]'), false);
  assert.ok(notifJson.includes('延后至'));
  const markReadBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '标为已读')[0];
  assert.ok(markReadBtn);
  (markReadBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/notifications/notif-1/read' && c.method === 'POST'));
  assert.ok(notifJson.includes('规则判定：有人请你审阅 PR，需要你处理'));
  assert.ok(notifJson.includes('工作时段 · 你在电脑前，按作息策略在网页提醒你'));
  assert.ok(notifJson.includes('展开历史提醒（1）'));
  for (const code of ['deterministic_', '_policy_', 'wechat_unavailable', 'llm_fail_open']) assert.equal(notifJson.includes(code), false);
  assert.equal(findNodes(tree, (v) => v.type === 'article').length, 2);
  const allReadBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '本线程全部标为已读（2）')[0];
  assert.ok(allReadBtn);
  (allReadBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/notifications/notif-3/read' && c.method === 'POST'));
  const notifCount = findNodes(tree, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-count'))[0];
  (notifCount.props!.onClick as () => void)();
  tree = render();
  const notifOpenJson = JSON.stringify(tree);
  assert.ok(notifOpenJson.includes('收起历史提醒'));
  const notifDetail = findNodes(tree, (v) => v.type === 'li' && String(v.props?.className ?? '').includes('dr-tl-item'))[0];
  const detailBtn = findNodes(notifDetail, (v) => v.type === 'button' && textOf(v) === '详情')[0];
  (detailBtn.props!.onClick as () => void)();
  tree = render();
  const detailJson = JSON.stringify(tree);
  assert.ok(detailJson.includes('周末 · 你在电脑前，按作息策略延后汇总'));
  assert.ok(detailJson.includes('微信暂时发不出去，已改为延后汇总'));
  assert.equal(detailJson.includes('wechat_unavailable_deferred'), false);

  (tabBtn('注意力与作息').props!.onClick as () => void)();
  tree = render();
  const wxSelect = findNodes(tree, (v) => v.type === 'select' && v.props?.['aria-label'] === '微信转发会话')[0];
  assert.ok(wxSelect);
  const wxSelectText = textOf(wxSelect);
  assert.ok(wxSelectText.includes('owner（私聊）'));
  assert.ok(wxSelectText.includes('周末群（群聊）'));
  assert.ok(wxSelectText.includes('文件传输助手（系统）'));
  (wxSelect.props!.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'wxid_owner_demo' } });
  tree = render();
  const savePolicyBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '保存偏好')[0];
  assert.ok(savePolicyBtn);
  (savePolicyBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/policy' && c.method === 'PUT'));
  const previewBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '试算去向')[0];
  assert.ok(previewBtn);
  (previewBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  tree = render();
  const previewJson = JSON.stringify(tree);
  assert.ok(previewJson.includes('判定依据：紧急事件：跳过下班时段的延后/静默，直接转发到微信'));
  assert.equal(previewJson.includes('urgent_override'), false);

  (tabBtn('效果与快车道').props!.onClick as () => void)();
  tree = render();
  const statsJson = JSON.stringify(tree);
  assert.ok(statsJson.includes('找回率'));
  assert.ok(statsJson.includes('推荐采纳率'));
  assert.equal(statsJson.includes('github:org/repo'), false);
  const unsubBtn = findNodes(tree, (v) => v.type === 'button' && textOf(v) === '解除订阅')[0];
  assert.ok(unsubBtn);
  (unsubBtn.props!.onClick as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.some((c) => c.url === '/local-router/subscriptions' && c.method === 'DELETE'));
  assert.equal(fetchCalls.some((c) => c.url === '/local-router/simulate-event'), false);
});


function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function shortAbs(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fullAbs(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${shortAbs(iso).split(' ')[1]}:${pad2(d.getSeconds())}`;
}

async function mountRouter(decisions: unknown[], notifications: unknown[] = []): Promise<{ render: () => VNode }> {
  const code = fs.readFileSync(resolveClientBundlePath(), 'utf8');
  const registrations: ModuleRegistration[] = [];
  const policy = { enabled: true, timezone: 'Asia/Shanghai', workdays: [1, 2, 3, 4, 5], workStartHour: 9, workEndHour: 19, presenceMode: 'auto', lastWebActiveAt: null, workHoursDest: 'web', offHoursDest: 'defer', weekendDest: 'defer', awayFallbackDest: 'wechat', wechatTarget: '', triageFilterEnabled: true, defaultMaxLevel: 'prepare' };
  const mockFetch = async (url: string) => {
    const respond = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
    if (url === '/local-router/status') return respond({ ok: true, enabled: true, presenceMode: 'auto', webActive: true, currentSlot: 'work', currentDestination: 'web', unreadNotifications: 0, pendingDecisions: 0, activeSubscriptions: 0, policy });
    if (url === '/local-router/decisions') return respond({ decisions });
    if (url === '/local-router/notifications') return respond({ notifications });
    if (url.startsWith('/local-router/stats')) return respond({ days: 7, totalEvents: 0, notifiedCount: 0, filteredCount: 0, restoredCount: 0, restoreRate: 0, dispatchedWorkers: 0, activeSubscriptions: 0, answeredDecisions: 0, recommendedPickedCount: 0 });
    if (url === '/local-router/subscriptions') return respond({ subscriptions: [] });
    return respond({ ok: true });
  };
  new vm.Script(code, { filename: 'lib/client.js' }).runInContext(vm.createContext({
    window: { __ModuleLoader__: { load: (spec: ModuleRegistration) => void registrations.push(spec) } },
    fetch: mockFetch,
    setInterval: () => 1,
    clearInterval: () => {},
  }));
  const states: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  let armed = true;
  const fakeReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode => ({ type, props, children }),
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
  const render = (): VNode => {
    cursor = 0;
    return (main.component as () => VNode)();
  };
  render();
  armed = false;
  for (const run of effects) run();
  await new Promise((r) => setTimeout(r, 20));
  return { render };
}

const baseDecision = {
  source: 'github',
  level: 'inform',
  reason: 'deterministic_default_inform',
  question: null,
  options: [] as string[],
  recommendedIndex: null,
  answeredOption: null,
  status: 'notified',
  destination: 'web',
  workerSessionId: null,
  subscriptionId: null,
};

test('Router threads render forum floors: Issue root on top, comments folded in ascending original time, with dual timestamps', async () => {
  const root = { ...baseDecision, id: 'r240', threadKey: 'github:org/repo#240', actor: 'example-owner', summary: 'Root issue body analysis', eventType: 'github.issue.updated', rawUrl: 'https://github.com/org/repo/issues/240', eventOccurredAt: '2026-11-20T15:29:00Z', createdAt: '2026-11-21T09:00:00Z', updatedAt: '2026-11-21T09:30:00Z' };
  const c1 = { ...baseDecision, id: 'c1', threadKey: 'org/repo#240', actor: 'amy', summary: 'First comment analysis', eventType: 'github.issue_comment', rawUrl: 'https://github.com/org/repo/issues/240#issuecomment-1', eventOccurredAt: '2026-11-20T16:00:00Z', createdAt: '2026-11-21T11:00:00Z' };
  const c2 = { ...baseDecision, id: 'c2', threadKey: 'org/repo#240', actor: 'ben', summary: 'Second comment analysis', eventType: 'github.pinned.activity', rawUrl: 'https://github.com/org/repo/issues/240#issuecomment-2', eventOccurredAt: '2026-11-20T17:00:00Z', createdAt: '2026-11-21T08:00:00Z' };
  const c3 = { ...baseDecision, id: 'c3', threadKey: 'org/repo#240', actor: 'cat', summary: 'Third comment analysis', eventType: null, rawUrl: 'https://github.com/org/repo/issues/240#issuecomment-3', eventOccurredAt: '2026-11-20T18:00:00Z', createdAt: '2026-11-21T10:00:00Z' };
  const legacy = { ...baseDecision, id: 'old7', threadKey: 'org/repo#7', actor: 'dan', summary: 'Legacy entry without original time', rawUrl: null, createdAt: '2026-11-19T10:00:00Z' };
  const p0 = { ...baseDecision, id: 'p0', threadKey: 'org/repo#224', actor: 'eve', summary: 'PR root analysis', eventType: 'github.pr.updated', rawUrl: 'https://github.com/org/repo/pull/224', eventOccurredAt: '2026-11-20T08:00:00Z', createdAt: '2026-11-20T08:05:00Z' };
  const p1 = { ...baseDecision, id: 'p1', threadKey: 'org/repo#224', actor: 'fox', summary: 'Pending review comment', level: 'prepare', question: 'Merge it?', options: ['Merge (Recommended)', 'Wait'], recommendedIndex: 0, eventType: 'github.pr.comment', rawUrl: 'https://github.com/org/repo/pull/224#discussion_r9', eventOccurredAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-20T10:01:00Z' };
  const p2 = { ...baseDecision, id: 'p2', threadKey: 'org/repo#224', actor: 'gus', summary: 'Earlier PR comment', eventType: 'github.pr.comment', rawUrl: 'https://github.com/org/repo/pull/224#issuecomment-5', eventOccurredAt: '2026-11-20T09:00:00Z', createdAt: '2026-11-20T09:01:00Z' };
  const { render } = await mountRouter([c1, c3, legacy, root, c2, p1, p0, p2]);
  let tree = render();

  const rows = () => findNodes(tree, (v) => v.type === 'div' && String(v.props?.className ?? '').split(' ').includes('dr-crow'));
  assert.equal(rows().length, 2);
  const issueRow = rows()[0];
  const issueText = textOf(issueRow);
  assert.ok(issueText.includes('org/repo #240'));
  assert.ok(issueText.includes('Issue 主楼'));
  assert.ok(issueText.includes('Root issue body analysis'));
  assert.equal(issueText.includes('First comment analysis'), false);
  const rootSrc = findNodes(issueRow, (v) => String(v.props?.className ?? '') === 'dr-tm src')[0];
  assert.equal(textOf(rootSrc), `Issue 于 ${shortAbs(root.eventOccurredAt)}`);
  assert.equal(rootSrc.props?.title, fullAbs(root.eventOccurredAt));
  const rootAna = findNodes(issueRow, (v) => String(v.props?.className ?? '') === 'dr-tm ana')[0];
  assert.ok(textOf(rootAna).startsWith('分析于 '));
  assert.equal(rootAna.props?.title, fullAbs(root.updatedAt));

  const toggle = findNodes(issueRow, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-tl-toggle'))[0];
  assert.equal(textOf(toggle), '展开 3 条评论分析 ▾');
  (toggle.props!.onClick as () => void)();
  tree = render();
  const openRow = rows()[0];
  assert.ok(textOf(openRow).includes('收起评论分析 ▴'));
  const floors = findNodes(openRow, (v) => v.type === 'li' && String(v.props?.className ?? '').includes('dr-tl-item'));
  assert.equal(floors.length, 3);
  assert.deepEqual(floors.map((f) => textOf(findNodes(f, (v) => String(v.props?.className ?? '').startsWith('dr-floor'))[0])), ['评论 1', '评论 2', '评论 3']);
  assert.ok(textOf(floors[0]).includes('@amy') && textOf(floors[0]).includes('First comment analysis'));
  assert.ok(textOf(floors[1]).includes('@ben'));
  assert.ok(textOf(floors[2]).includes('@cat'));
  [c1, c2, c3].forEach((c, i) => {
    const src = findNodes(floors[i], (v) => String(v.props?.className ?? '') === 'dr-tm src')[0];
    assert.equal(textOf(src), `评论于 ${shortAbs(c.eventOccurredAt)}`);
    const ana = findNodes(floors[i], (v) => String(v.props?.className ?? '') === 'dr-tm ana')[0];
    assert.equal(ana.props?.title, fullAbs(c.createdAt));
  });

  const legacyRow = rows()[1];
  assert.ok(textOf(legacyRow).includes('Legacy entry without original time'));
  assert.equal(findNodes(legacyRow, (v) => String(v.props?.className ?? '') === 'dr-tm src').length, 0);
  assert.equal(findNodes(legacyRow, (v) => String(v.props?.className ?? '') === 'dr-tm ana').length, 1);

  const focusCards = findNodes(tree, (v) => v.type === 'article' && String(v.props?.className ?? '').includes('focus'));
  assert.equal(focusCards.length, 1);
  const prCard = focusCards[0];
  assert.ok(textOf(prCard).includes('评论待拍板 · 评论 2'));
  assert.ok(textOf(prCard).includes('Pending review comment'));
  assert.equal(findNodes(prCard, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-opt')).length, 2);
  const prToggle = findNodes(prCard, (v) => v.type === 'button' && String(v.props?.className ?? '').includes('dr-tl-toggle'))[0];
  assert.equal(textOf(prToggle), '展开主楼与 1 条评论分析 ▾');
  (prToggle.props!.onClick as () => void)();
  tree = render();
  const prOpen = findNodes(tree, (v) => v.type === 'article' && String(v.props?.className ?? '').includes('focus'))[0];
  const prFloors = findNodes(prOpen, (v) => v.type === 'li' && String(v.props?.className ?? '').includes('dr-tl-item'));
  assert.equal(prFloors.length, 2);
  assert.ok(String(prFloors[0].props?.className).includes('root'));
  assert.ok(textOf(prFloors[0]).includes('PR 主楼'));
  assert.ok(textOf(prFloors[0]).includes(`PR 于 ${shortAbs(p0.eventOccurredAt)}`));
  assert.ok(textOf(prFloors[1]).includes('评论 1'));
  assert.ok(textOf(prFloors[1]).includes('@gus'));
});
