import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sessionPoint } from './session-position.js';
import type { DesktopLayout, Rect } from './session-position.js';
import { clipboard } from './clipboard.js';
import type { ClipboardFn } from './clipboard.js';
import { messageBody, isQuote } from './core.js';

export interface CuaNode {
  identifier?: string;
  role?: string;
  subrole?: string;
  title?: string;
  value?: string;
  description?: string;
  index?: number;
  frame?: Rect;
  states?: string[];
  actions?: string[];
  children?: CuaNode[];
}

export interface CuaWindowInfo {
  id: number;
  title?: string;
  bounds: Rect;
}

export interface CuaAppState {
  info?: {
    frontmostApp?: string;
    permissions?: {
      accessibility?: boolean;
    };
    window?: CuaWindowInfo;
  };
  windows?: Array<{ id?: number; title?: string }>;
  text?: string;
  accessibility?: {
    nodes?: CuaNode[];
  };
}

export interface CuaOcrMatch {
  text: string;
  source?: string;
  confidence?: number;
  windowId?: number;
  rect: Rect;
}

export interface CuaRule {
  sourceId?: string;
  title: string;
  search?: string;
  wechatId?: string;
  uniqueTitle?: boolean;
}

export interface CuaSenderIdentity {
  id?: string;
  uiName?: string;
  uniqueUiName?: boolean;
  groupNickname?: string;
  nickname?: string;
}

export interface CuaEvent {
  kind?: string;
  local_type?: number;
  text?: string;
  sender?: string;
  senderId?: string;
  senderIdentity?: CuaSenderIdentity;
  image?: {
    status?: unknown;
    hash?: unknown;
    [key: string]: unknown;
  };
}

export interface CuaDecision {
  text: string;
  replyTo?: string;
  action?: string;
}

export interface CuaMention {
  id: string;
  name: string;
  nickname?: string;
  groupNickname?: string;
  uniqueUiName?: boolean;
}

export interface CuaJob {
  event: CuaEvent;
  quoteEvent?: CuaEvent;
  rule: CuaRule;
  decision: CuaDecision;
  mention?: CuaMention | null;
  mentions?: CuaMention[];
  inputText?: string;
  mentionProof?: { axPrefix: string };
  deliveryDetail?: string;
  deliveryAnchor?: unknown;
}

export interface CommitReceipt {
  confirmed: boolean;
  detail?: string;
}

export interface PreparedCommit {
  (signal: AbortSignal): Promise<CommitReceipt>;
  deliveryDetail?: string;
  discard?: (signal: AbortSignal) => Promise<void>;
}

export interface MomentTarget {
  list: CuaNode;
  post: CuaNode;
  area: CuaNode;
}

export type CuaRunner = (
  file: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string }>;

export type CuaPause = (ms: number, signal: AbortSignal) => Promise<void>;

const execFileAsync = promisify(execFile);
const exec: CuaRunner = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', ...options });
  return { stdout: String(stdout) };
};
const APP = 'com.tencent.xinWeChat';

class QuoteLocationUnavailable extends Error {}

const quoteEvent = (job: { quoteEvent?: CuaEvent; event: CuaEvent }): CuaEvent =>
  job.quoteEvent || job.event;

const jobMentions = (job: CuaJob): CuaMention[] =>
  Array.isArray(job.mentions) && job.mentions.length > 0
    ? job.mentions
    : job.mention
      ? [job.mention]
      : [];

const ocrText = (text?: string): string =>
  (text || '').normalize('NFKC').replace(/[，]/g, ',').replace(/\s/g, '');

export function flatten(nodes: CuaNode[] = []): CuaNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

export function one<T>(nodes: T[], predicate: (node: T) => boolean, message: string): T {
  const matches = nodes.filter(predicate);
  if (matches.length !== 1) throw new Error(message);
  return matches[0];
}

export function hasTrigger(state: CuaAppState, event: CuaEvent): boolean {
  const bubbles = flatten(state.accessibility?.nodes).filter(
    (n) => n.identifier === 'chat_bubble_item_view',
  );
  const lowType = (event.local_type ?? Number.NaN) % 4294967296;
  if ([3, 47].includes(lowType)) {
    return (
      event.image?.status === 'read' &&
      Boolean(event.image.hash) &&
      bubbles.some((n) =>
        [n.title, n.value].some((v) =>
          lowType === 47
            ? ['动画表情', '[动画表情]', '表情'].includes(v ?? '')
            : v === '图片' || v === '[图片]',
        ),
      )
    );
  }
  const expected = messageBody(event as { kind: string; local_type: number; text: string }) ?? '';
  return bubbles.length
    ? bubbles.some((n) =>
        [n.title, n.value].some(
          (v) =>
            typeof v === 'string' &&
            (lowType === 49
              ? v.replace(/\s/g, '').includes(expected.replace(/\s/g, ''))
              : v === expected),
        ),
      )
    : Boolean(state.text?.includes(expected));
}

const delay: CuaPause = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });

export class SwiftCua {
  path: string;
  runner: CuaRunner;
  pause: CuaPause;
  pasteboard: ClipboardFn;

  constructor(
    path: string,
    runner: CuaRunner = exec,
    pause: CuaPause = delay,
    pasteboard: ClipboardFn = clipboard,
  ) {
    this.path = path;
    this.runner = runner;
    this.pause = pause;
    this.pasteboard = pasteboard;
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    activate = false,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    try {
      const { stdout } = await this.runner(
        this.path,
        [...(activate ? ['--activate'] : []), 'call', method, JSON.stringify({ app: APP, ...params })],
        { signal, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (e) {
      const killed = Boolean(
        e && typeof e === 'object' && 'killed' in e && (e as { killed?: unknown }).killed,
      );
      throw new Error(
        `SwiftCUA ${method} 操作失败${signal.aborted || killed ? '（取消或超时）' : ''}；请检查微信界面与 SwiftCUA 服务`,
        { cause: e },
      );
    }
  }

  async state(
    signal: AbortSignal,
    extra: Record<string, unknown> = {},
    activate = false,
  ): Promise<CuaAppState> {
    const response = (await this.call(
      'getAppState',
      { includeScreenshot: false, disableDiff: true, limit: 1000, depth: 15, ...extra },
      signal,
      activate,
    )) as { state?: CuaAppState };
    const { state } = response;
    if (!state || state.info?.frontmostApp === 'com.apple.loginwindow') {
      throw new Error('Mac mini 桌面已锁定');
    }
    if (!state.info?.permissions?.accessibility) {
      throw new Error('SwiftCUA 未获辅助功能权限');
    }
    return state;
  }

  async clickFrame(frame: Rect | undefined, signal: AbortSignal): Promise<void> {
    if (!frame || frame.width <= 0 || frame.height <= 0) {
      throw new Error('目标元素没有有效坐标');
    }
    await this.call(
      'click',
      {
        x: frame.x + frame.width / 2,
        y: frame.y + frame.height / 2,
        coordinateSpace: 'global',
        strategy: 'coordinate',
      },
      signal,
      true,
    );
  }

  chat(state: CuaAppState, title: string): { nodes: CuaNode[]; input: CuaNode } {
    const nodes = flatten(state.accessibility?.nodes);
    const name = one(nodes, (n) => n.identifier === 'current_chat_name_label', '无法确定当前微信会话');
    if (
      name.value !== title &&
      !new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[（(]\\d+[）)]$`).test(
        name.value || '',
      )
    ) {
      throw new Error('当前微信会话与收件人不一致');
    }
    const input = one(nodes, (n) => n.identifier === 'chat_input_field', '找不到会话输入框');
    return { nodes, input };
  }

  async waitChat(title: string, signal: AbortSignal, attempts = 8): Promise<CuaAppState> {
    let error: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const state = await this.state(signal);
        this.chat(state, title);
        return state;
      } catch (e) {
        error = e;
        await this.pause(250, signal);
      }
    }
    throw error;
  }

  async selectSession(
    state: CuaAppState,
    rule: { title: string },
    signal: AbortSignal,
  ): Promise<CuaAppState> {
    const id = state.info?.window?.id;
    if (!id) throw Error('缺少微信窗口标识');
    const windowNode = (s: CuaAppState): CuaNode =>
      one(flatten(s.accessibility?.nodes), (n) => n.role === 'AXWindow', '无法唯一核对微信窗口');
    const params = (s: CuaAppState): { elementIndex: number | undefined; windowId: number } => ({
      elementIndex: windowNode(s).index,
      windowId: id,
    });
    await this.call('axAction', { ...params(state), action: 'AXRaise' }, signal, true);
    await this.pause(200, signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      state = await this.state(signal);
      if (state.info?.window?.id !== id) throw Error('微信窗口已改变');
      const nodes = flatten(state.accessibility?.nodes);
      if (
        nodes.some(
          (n) => (n.identifier === 'chat_input_field' && n.value) || n.title === '删除引用消息',
        )
      ) {
        throw Error('微信中已有未发送草稿或引用');
      }
      try {
        this.chat(state, rule.title);
        return state;
      } catch {}
      let row = one(nodes, (n) => n.identifier === 'session_item_' + rule.title, '会话列表已改变');
      if (row.actions?.includes('AXPress') && attempt === 0) {
        await this.call(
          'axAction',
          { elementIndex: row.index, windowId: id, action: 'AXPress' },
          signal,
          true,
        );
        try {
          return await this.waitChat(rule.title, signal, 3);
        } catch {}
        state = await this.state(signal);
        if (state.info?.window?.id !== id) throw Error('微信窗口已改变');
        const refreshed = flatten(state.accessibility?.nodes);
        if (
          refreshed.some(
            (n) => (n.identifier === 'chat_input_field' && n.value) || n.title === '删除引用消息',
          )
        ) {
          throw Error('微信中已有未发送草稿或引用');
        }
        try {
          this.chat(state, rule.title);
          return state;
        } catch {}
        row = one(refreshed, (n) => n.identifier === 'session_item_' + rule.title, '会话列表已改变');
      }
      const { stdout } = await this.runner(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', fileURLToPath(new URL('./desktop-layout.jxa', import.meta.url)), String(id)],
        { signal, timeout: 5000 },
      );
      const { move, point } = sessionPoint(
        row.frame,
        state.info?.window?.bounds,
        JSON.parse(stdout) as DesktopLayout,
        attempt === 0,
      );
      if (move) {
        await this.call('axSet', { ...params(state), attribute: 'AXPosition', value: move }, signal, true);
        await this.pause(200, signal);
        continue;
      }
      await this.call(
        'click',
        { ...point, coordinateSpace: 'global', strategy: 'coordinate', windowId: id },
        signal,
        true,
      );
      return this.waitChat(rule.title, signal);
    }
    throw Error('微信会话列表被遮挡，没有可核对的点击位置；未点击或发送');
  }

  async openChat(rule: CuaRule, signal: AbortSignal): Promise<CuaAppState> {
    const checkDraft = (s: CuaAppState): { nodes: CuaNode[]; existing: CuaNode | undefined } => {
      const nodes = flatten(s.accessibility?.nodes);
      const existing = nodes.find((n) => n.identifier === 'chat_input_field');
      if (existing?.value || nodes.some((n) => n.title === '删除引用消息')) {
        throw new Error('微信中已有未发送草稿或引用，暂停自动操作');
      }
      return { nodes, existing };
    };
    const hasEntry = (nodes: CuaNode[]): boolean =>
      nodes.some(
        (n) =>
          n.title === '搜索' ||
          n.identifier === 'chat_input_field' ||
          (n.role === 'AXButton' && n.title === '微信'),
      );
    let state = await this.state(signal);
    let { nodes, existing } = checkDraft(state);
    if (!hasEntry(nodes)) {
      const mainWins = (state.windows || []).filter(
        (w) => ['微信', 'WeChat'].includes(w.title ?? '') && w.id && w.id !== state.info?.window?.id,
      );
      if (mainWins.length === 1) {
        try {
          const target = await this.state(signal, { windowId: mainWins[0].id });
          checkDraft(target);
          const winNode = one(
            flatten(target.accessibility?.nodes),
            (n) => n.role === 'AXWindow',
            '无法唯一核对微信主窗口',
          );
          if (Number.isInteger(winNode.index)) {
            await this.call(
              'axAction',
              { elementIndex: winNode.index, windowId: mainWins[0].id, action: 'AXRaise' },
              signal,
              true,
            );
            await this.pause(200, signal);
            state = await this.state(signal);
            ({ nodes, existing } = checkDraft(state));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (signal.aborted || /桌面已锁定|辅助功能权限|未发送草稿或引用/.test(msg)) throw e;
        }
      }
      if (!hasEntry(nodes) && state.info?.frontmostApp !== APP) {
        await this.state(signal, {}, true);
        await this.pause(200, signal);
        state = await this.state(signal);
        ({ nodes, existing } = checkDraft(state));
      }
    }
    if (existing) {
      try {
        this.chat(state, rule.title);
        return state;
      } catch {}
    }
    if (!nodes.some((n) => n.title === '搜索' || n.identifier === 'chat_input_field')) {
      const winTitle = state.info?.window?.title;
      const missing =
        winTitle && !['微信', 'WeChat'].includes(winTitle)
          ? `找不到微信聊天入口（当前活动窗口为「${winTitle}」，请切回微信主窗口）`
          : '找不到微信聊天入口';
      const tab = one(nodes, (n) => n.role === 'AXButton' && n.title === '微信', missing);
      await this.clickFrame(tab.frame, signal);
      await this.pause(250, signal);
      state = await this.state(signal);
      ({ nodes } = checkDraft(state));
    }
    let obstructedFallback = false;
    if (rule.uniqueTitle || rule.sourceId === 'filehelper') {
      state = await this.state(signal);
      if (flatten(state.accessibility?.nodes).some((n) => n.title === '搜索' && n.value)) {
        await this.call('pressKey', { key: 'Escape' }, signal, true);
        await this.pause(200, signal);
        state = await this.state(signal);
      }
      const rows = flatten(state.accessibility?.nodes).filter(
        (n) => n.identifier === `session_item_${rule.title}`,
      );
      if (rows.length === 1) {
        try {
          return await this.selectSession(state, rule, signal);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (signal.aborted || !/OBSTRUCTED|微信会话列表被遮挡/.test(msg)) {
            throw e;
          }
          obstructedFallback = true;
          state = await this.state(signal);
          checkDraft(state);
        }
      }
    }
    const isSearchField = (n: CuaNode): boolean =>
      n.title === '搜索' && ['AXTextArea', 'AXTextField'].includes(n.role ?? '');
    let fields = flatten(state.accessibility?.nodes).filter(isSearchField);
    if (obstructedFallback || fields.length !== 1) {
      await this.call('pressKey', { key: 'Cmd+f' }, signal, true);
      state = await this.state(signal);
      fields = flatten(state.accessibility?.nodes).filter(isSearchField);
    }
    const field =
      fields.length === 1
        ? fields[0]
        : one(fields, (n) => Boolean(n.states?.includes('focused')), '无法确定微信搜索框');
    if (!obstructedFallback || !field.states?.includes('focused')) {
      await this.clickFrame(field.frame, signal);
    }
    const focusedSearch = one(
      flatten((await this.state(signal)).accessibility?.nodes),
      (n) => n.title === '搜索' && Boolean(n.states?.includes('focused')),
      '搜索框没有取得焦点',
    );
    if (!['AXTextArea', 'AXTextField'].includes(focusedSearch.role ?? '')) {
      throw new Error('搜索焦点不是文本输入框');
    }
    await this.call('pressKey', { key: 'Cmd+a' }, signal, true);
    await this.call('typeText', { text: rule.search }, signal, true);
    await this.pause(800, signal);
    const afterSearch = await this.state(signal);
    const searchFields = flatten(afterSearch.accessibility?.nodes).filter(isSearchField);
    const searched =
      searchFields.length === 1
        ? searchFields[0]
        : one(searchFields, (n) => Boolean(n.states?.includes('focused')), '搜索框发生变化');
    if (searched.value !== rule.search) throw new Error('搜索内容与配置不一致');
    const byName = rule.sourceId === 'filehelper' || (!rule.wechatId && Boolean(rule.uniqueTitle));
    const query = byName ? rule.title : rule.wechatId;
    if (!query) throw new Error('缺少可核对的收件人身份');
    const found = (await this.call(
      'findText',
      { text: query, exact: byName, useOCR: true, ocrOnly: true, composited: true, limit: 20 },
      signal,
    )) as { matches?: CuaOcrMatch[] };
    const win = afterSearch.info?.window || state.info?.window;
    const searchBottom =
      (searched.frame?.y ?? 0) + (searched.frame?.height ?? 0) - (win?.bounds.y || 0);
    const matches = (found.matches || []).filter((m) => {
      if (byName && win && (m.rect.y < searchBottom + 15 || m.rect.y > searchBottom + 170)) {
        return false;
      }
      const label = m.text.replace(/\s/g, '').replace(/：/g, ':');
      return byName ? label === rule.title.replace(/\s/g, '') : label === `微信号:${rule.wechatId}`;
    });
    if (matches.length !== 1) throw new Error('搜索结果无法唯一确认微信号，未选择联系人');
    const match = matches[0];
    if (match.source === 'ocr' && (match.confidence ?? 0) < 0.85) {
      throw new Error('微信号文字识别置信度不足');
    }
    if (!match.windowId || !match.rect || match.rect.width <= 0 || match.rect.height <= 0) {
      throw new Error('搜索结果窗口或坐标无效');
    }
    await this.call(
      'click',
      {
        x: match.rect.x + match.rect.width / 2,
        y: match.rect.y + match.rect.height / 2,
        windowId: match.windowId,
        coordinateSpace: 'window',
        strategy: 'coordinate',
      },
      signal,
      true,
    );
    await this.pause(500, signal);
    return this.waitChat(rule.title, signal);
  }

  async readArticle(
    job: { rule: CuaRule; event: { text?: string } },
    signal: AbortSignal,
  ): Promise<{ title: string; text: string; method: 'wechat' }> {
    const initial = await this.openChat(job.rule, signal);
    if (this.chat(initial, job.rule.title).input.value) {
      throw new Error('微信已有草稿，未打开文章');
    }
    const normalize = (text?: string): string => (text || '').replace(/\s/g, '');
    const bubble = one(
      flatten(initial.accessibility?.nodes),
      (n) =>
        n.identifier === 'chat_bubble_item_view' &&
        normalize(n.title).includes(normalize(job.event.text)),
      '无法唯一确定收到的文章卡片',
    );
    const prior = new Set((initial.windows || []).map((w) => w.id));
    let opened: number | undefined;
    try {
      const f = bubble.frame;
      if (!f) throw new Error('目标元素没有有效坐标');
      await this.clickFrame(
        {
          x: f.x + 50,
          y: f.y + 20,
          width: Math.min(f.width - 60, 300),
          height: Math.min(f.height - 30, 100),
        },
        signal,
      );
      for (let i = 0; i < 12; i++) {
        await this.pause(300, signal);
        const s = await this.state(signal);
        if (
          s.info?.window &&
          !prior.has(s.info.window.id) &&
          s.info.window.title === '微信 (窗口)'
        ) {
          opened = s.info.window.id;
          break;
        }
      }
      if (!opened) throw new Error('文章没有在可核对的微信阅读窗口中打开');
      const title = (job.event.text ?? '').replace(/^\[链接\]\s*/, '').trim();
      let heading: CuaOcrMatch | undefined;
      for (let i = 0; i < 8; i++) {
        const result = (await this.call(
          'findText',
          { text: title, windowId: opened, ocrOnly: true, composited: true, limit: 20 },
          signal,
        )) as { matches?: CuaOcrMatch[] };
        const exact = (result.matches || []).filter((m) => normalize(m.text) === normalize(title));
        if (exact.length === 1) {
          heading = exact[0];
          break;
        }
        await this.pause(500, signal);
      }
      if (!heading) throw new Error('微信文章正文尚不可读或需要验证，未仅凭标题回复');
      await this.call(
        'click',
        {
          x: heading.rect.x + heading.rect.width / 2,
          y: heading.rect.y + heading.rect.height / 2,
          windowId: opened,
          coordinateSpace: 'window',
          strategy: 'coordinate',
        },
        signal,
        true,
      );
      const saved = await clipboard({ action: 'snapshot' }, signal);
      let copied: { count: number; text: string };
      try {
        const current = await this.state(signal);
        if (current.info?.window?.id !== opened || current.info?.frontmostApp !== APP) {
          throw new Error('读取文章前窗口发生变化');
        }
        await this.call('pressKey', { key: 'Cmd+a' }, signal, true);
        await this.call('pressKey', { key: 'Cmd+c' }, signal, true);
        await this.pause(300, signal);
        copied = await clipboard({ action: 'read' }, signal);
        const after = await this.state(signal);
        if (
          copied.count === saved.count ||
          after.info?.window?.id !== opened ||
          normalize(copied.text.split('\n').find((x) => x.trim()) || '') !== normalize(title)
        ) {
          throw new Error('没有复制到与链接对应的文章正文');
        }
      } finally {
        await clipboard({ action: 'restore', items: saved.items });
      }
      return { title, text: copied.text, method: 'wechat' };
    } finally {
      if (opened) {
        const cleanup = AbortSignal.timeout(8000);
        try {
          const current = await this.state(cleanup);
          if (current.info?.window?.id === opened) {
            const close = one(
              flatten(current.accessibility?.nodes),
              (n) => n.subrole === 'AXCloseButton',
              '无法关闭文章阅读窗口',
            );
            await this.call(
              'click',
              { elementIndex: close.index, windowId: opened, strategy: 'ax' },
              cleanup,
              true,
            );
            await this.pause(300, cleanup);
          }
        } catch {}
      }
    }
  }

  moment(state: CuaAppState, job: { rule: { title: string }; event: { text?: string } }): MomentTarget {
    const list = one(
      flatten(state.accessibility?.nodes),
      (n) => n.identifier === 'sns_list',
      '找不到朋友圈列表',
    );
    const norm = (text?: string): string => (text || '').replace(/\s/g, '');
    const eventText = job.event.text ?? '';
    const matches = (list.children || []).filter(
      (n) =>
        (n.title || '').startsWith(job.rule.title + ' ') &&
        norm((n.title || '').slice(job.rule.title.length + 1)).startsWith(norm(eventText)) &&
        (n.frame?.height ?? 0) > 20,
    );
    const post = one(
      matches.filter((n) => {
        const body = (n.title || '').slice(job.rule.title.length + 1);
        const normalized = body.replace(/\s+/g, ' ').trim();
        const expected = eventText.replace(/\s+/g, ' ').trim();
        return normalized === expected || normalized.startsWith(expected + ' ');
      }),
      () => true,
      '无法唯一定位朋友圈作者与正文',
    );
    const f = post.frame;
    const l = list.frame;
    if (!f || !l || f.y < l.y || f.y + f.height > l.y + l.height) {
      throw new Error('朋友圈动态没有完整显示');
    }
    const children = list.children || [];
    const at = children.indexOf(post);
    const area = children[at + 1];
    if (area?.title !== '评论区') throw new Error('无法确认该动态的评论区域');
    return { list, post, area };
  }

  inside(frame: Rect | undefined, outer: Rect | undefined): boolean {
    return Boolean(
      frame &&
      outer &&
      frame.x >= outer.x &&
      frame.y >= outer.y &&
      frame.x + frame.width <= outer.x + outer.width + 2 &&
      frame.y + frame.height <= outer.y + outer.height + 2,
    );
  }

  commentInput(state: CuaAppState, area: { frame?: Rect }): CuaNode {
    return one(
      flatten(state.accessibility?.nodes),
      (n) =>
        ['AXTextArea', 'AXTextField'].includes(n.role ?? '') &&
        Boolean(n.states?.includes('focused')) &&
        this.inside(n.frame, area.frame),
      '无法确认朋友圈评论输入框',
    );
  }

  async visibleText(
    state: CuaAppState,
    query: string,
    area: Rect | undefined,
    signal: AbortSignal,
  ): Promise<CuaOcrMatch[]> {
    const result = (await this.call(
      'findText',
      { text: query, ocrOnly: true, composited: true, exact: false, limit: 200 },
      signal,
    )) as { matches?: CuaOcrMatch[] };
    const w = state.info?.window;
    if (!w) return [];
    return (result.matches || []).filter(
      (m) =>
        m.windowId === w.id &&
        this.inside({ ...m.rect, x: m.rect.x + w.bounds.x, y: m.rect.y + w.bounds.y }, area),
    );
  }

  async prepareMoment(job: CuaJob, signal: AbortSignal): Promise<PreparedCommit> {
    if (!job.event.text || !job.rule.uniqueTitle) {
      throw new Error('朋友圈作者或正文无法唯一确认');
    }
    let state = await this.state(signal);
    if (
      flatten(state.accessibility?.nodes).some(
        (n) => n.role === 'AXTextArea' && n.title !== '搜索' && n.value,
      )
    ) {
      throw new Error('微信中已有未发送草稿');
    }
    const tab = one(
      flatten(state.accessibility?.nodes),
      (n) => n.role === 'AXButton' && n.title === '发现',
      '找不到发现入口',
    );
    await this.clickFrame(tab.frame, signal);
    await this.pause(400, signal);
    state = await this.state(signal);
    if (!flatten(state.accessibility?.nodes).some((n) => n.identifier === 'sns_list')) {
      const entry = one(
        flatten(state.accessibility?.nodes),
        (n) => n.role === 'AXButton' && n.title === '朋友圈',
        '找不到朋友圈入口',
      );
      await this.clickFrame(entry.frame, signal);
      await this.pause(400, signal);
      state = await this.state(signal);
    }
    let target: MomentTarget | undefined;
    for (let i = 0; i < 9; i++) {
      try {
        target = this.moment(state, job);
        break;
      } catch (e) {
        if (i === 8) throw e;
      }
      const list = one(
        flatten(state.accessibility?.nodes),
        (n) => n.identifier === 'sns_list',
        '找不到朋友圈列表',
      );
      const w = state.info?.window;
      const listFrame = list.frame;
      if (!w || !listFrame) throw new Error('找不到朋友圈列表');
      await this.call(
        'scroll',
        {
          x: listFrame.x + listFrame.width / 2 - w.bounds.x,
          y: listFrame.y + listFrame.height / 2 - w.bounds.y,
          windowId: w.id,
          direction: i === 0 ? 'up' : 'down',
          pages: i === 0 ? 12 : 0.6,
          strategy: 'events',
        },
        signal,
        true,
      );
      await this.pause(400, signal);
      state = await this.state(signal);
    }
    if (!target || !target.post.frame) throw new Error('无法唯一定位朋友圈作者与正文');
    const frame = target.post.frame;
    await this.clickFrame(
      { x: frame.x + frame.width - 60, y: frame.y + frame.height - 20, width: 24, height: 20 },
      signal,
    );
    await this.pause(200, signal);
    state = await this.state(signal);
    target = this.moment(state, job);
    const menu = await this.visibleText(
      state,
      '评论',
      { x: frame.x + frame.width - 260, y: frame.y + frame.height - 45, width: 240, height: 60 },
      signal,
    );
    const choice = one(
      menu,
      (m) => /^[\p{P}\p{S}口□]{0,4}评论$/u.test(m.text.replace(/\s/g, '')),
      '未找到该动态的评论操作',
    );
    await this.call(
      'click',
      {
        x: choice.rect.x + choice.rect.width / 2,
        y: choice.rect.y + choice.rect.height / 2,
        windowId: choice.windowId,
        coordinateSpace: 'window',
        strategy: 'coordinate',
      },
      signal,
      true,
    );
    await this.pause(300, signal);
    state = await this.state(signal);
    target = this.moment(state, job);
    if (this.commentInput(state, target.area).value) throw new Error('评论框中已有内容，未覆盖');
    await this.call('typeText', { text: job.decision.text }, signal, true);
    state = await this.state(signal);
    target = this.moment(state, job);
    if (this.commentInput(state, target.area).value !== job.decision.text) {
      throw new Error('朋友圈输入内容与生成评论不一致');
    }
    return async (commitSignal: AbortSignal): Promise<CommitReceipt> => {
      const before = await this.state(commitSignal);
      const currentTarget = this.moment(before, job);
      if (
        before.info?.frontmostApp !== APP ||
        this.commentInput(before, currentTarget.area).value !== job.decision.text
      ) {
        throw new Error('发布前朋友圈目标或正文改变');
      }
      const sends = await this.visibleText(before, '发送', currentTarget.area.frame, commitSignal);
      const send = one(sends, (m) => m.text.replace(/\s/g, '') === '发送', '找不到评论发送按钮');
      const latest = await this.state(commitSignal);
      if (
        JSON.stringify(this.moment(latest, job).area.frame) !==
          JSON.stringify(currentTarget.area.frame) ||
        JSON.stringify(latest.info?.window?.bounds) !== JSON.stringify(before.info?.window?.bounds) ||
        this.commentInput(latest, this.moment(latest, job).area).value !== job.decision.text
      ) {
        throw new Error('评论输入发生改变');
      }
      await this.call(
        'click',
        {
          x: send.rect.x + send.rect.width / 2,
          y: send.rect.y + send.rect.height / 2,
          windowId: send.windowId,
          coordinateSpace: 'window',
          strategy: 'coordinate',
        },
        commitSignal,
        true,
      );
      await this.pause(1000, commitSignal);
      const after = await this.state(commitSignal);
      const area = this.moment(after, job).area;
      const refusal = await this.visibleText(
        after,
        '评论未发送',
        after.info?.window?.bounds,
        commitSignal,
      );
      const editor = flatten(after.accessibility?.nodes).find(
        (n) => n.role === 'AXTextArea' && this.inside(n.frame, area.frame),
      );
      const lines = await this.visibleText(after, '', area.frame, commitSignal);
      const text = lines
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
        .map((m) => m.text)
        .join('')
        .replace(/\s/g, '');
      const confirmed = !editor?.value && text.includes(job.decision.text.replace(/\s/g, ''));
      return {
        confirmed,
        ...(!confirmed && refusal.length
          ? { detail: '微信界面存在评论未发送提示，请核对当前评论' }
          : {}),
      };
    };
  }

  quotePreview(state: CuaAppState, job: CuaJob): CuaNode {
    const { nodes, input } = this.chat(state, job.rule.title);
    const remove = one(nodes, (n) => n.title === '删除引用消息', '没有唯一的微信引用框');
    const event = quoteEvent(job);
    const author =
      event.senderIdentity && event.senderIdentity.id === event.senderId
        ? event.senderIdentity.uiName || event.sender
        : event.sender;
    const expected = `引用 ${author} 的消息 : ${messageBody(event as { kind: string; local_type: number; text: string })}`;
    return one(
      nodes,
      (n) =>
        n.role === 'AXGroup' &&
        n.title === expected &&
        Boolean(
          n.frame &&
          input.frame &&
          remove.frame &&
          n.frame.y >= input.frame.y &&
          n.frame.y <= remove.frame.y + remove.frame.height,
        ),
      '微信引用框中的发言人或原文不一致',
    );
  }

  verifyQuoteState(state: CuaAppState, job: CuaJob): CuaNode | undefined {
    if (job.decision.replyTo) return this.quotePreview(state, job);
    if (this.chat(state, job.rule.title).nodes.some((n) => n.title === '删除引用消息')) {
      throw Error('出现了未选择的引用');
    }
    return undefined;
  }

  async prepareQuote(job: CuaJob, state: CuaAppState, signal: AbortSignal): Promise<CuaAppState> {
    const event = quoteEvent(job);
    const typedEvent = event as { kind: string; local_type: number; text: string };
    if (event.local_type !== 1 && !isQuote(typedEvent)) {
      throw new Error('当前仅支持原生引用文字消息');
    }
    state = await this.focusInput(state, job.rule.title, signal);
    const body = messageBody(typedEvent);
    const { nodes } = this.chat(state, job.rule.title);
    const bubble = one(
      nodes,
      (n) =>
        n.identifier === 'chat_bubble_item_view' &&
        (n.title === body ||
          Boolean(n.title?.startsWith(body + '\n引用 ')) ||
          (isQuote(typedEvent) && Boolean(n.title?.startsWith(body + '\n')))),
      '无法唯一定位需要引用的原消息',
    );
    const list = one(nodes, (n) => n.identifier === 'chat_message_list', '找不到聊天消息列表');
    if (!this.inside(bubble.frame, list.frame)) {
      throw new Error('需要引用的消息没有完整显示');
    }
    const hits = await this.visibleText(state, body.slice(0, 4), bubble.frame, signal);
    const candidates = hits.filter(
      (m) => (m.confidence ?? 0) >= 0.85 && ocrText(body).startsWith(ocrText(m.text)),
    );
    if (candidates.length !== 1) {
      throw new QuoteLocationUnavailable('无法确定原消息气泡中的文字位置');
    }
    const hit = candidates[0];
    const w = state.info?.window;
    if (!w) throw new Error('缺少微信窗口标识');
    const x = hit.rect.x + hit.rect.width / 2;
    const y = hit.rect.y + hit.rect.height / 2;
    await this.call(
      'click',
      { x, y, windowId: w.id, coordinateSpace: 'window', strategy: 'coordinate', mouseButton: 'right' },
      signal,
      true,
    );
    await this.pause(200, signal);
    const found = (await this.call(
      'findText',
      {
        text: '引用',
        ocrOnly: true,
        composited: true,
        windowId: w.id,
        region: {
          x: Math.max(0, w.bounds.x + x - 220),
          y: Math.max(0, w.bounds.y + y - 400),
          width: 460,
          height: 800,
        },
      },
      signal,
    )) as { matches?: CuaOcrMatch[] };
    const menu = one(
      found.matches || [],
      (m) => m.windowId === w.id && /^[\p{P}\p{S}\s]*引用$/u.test(m.text),
      '找不到微信原生引用菜单',
    );
    await this.call(
      'click',
      {
        x: menu.rect.x + menu.rect.width / 2,
        y: menu.rect.y + menu.rect.height / 2,
        windowId: w.id,
        coordinateSpace: 'window',
        strategy: 'coordinate',
      },
      signal,
      true,
    );
    await this.pause(200, signal);
    const prepared = await this.state(signal);
    this.quotePreview(prepared, job);
    return prepared;
  }

  async focusInput(state: CuaAppState, title: string, signal: AbortSignal): Promise<CuaAppState> {
    let input = this.chat(state, title).input;
    if (state.info?.frontmostApp !== APP) {
      const value = input.value;
      await this.clickFrame(input.frame, signal);
      state = await this.state(signal);
      input = this.chat(state, title).input;
      if (input.value !== value) throw Error('激活微信时输入内容已改变');
    }
    if (Number.isInteger(input.index)) {
      await this.call(
        'axFocus',
        { elementIndex: input.index, windowId: state.info?.window?.id },
        signal,
        true,
      );
    } else {
      await this.clickFrame(input.frame, signal);
    }
    const current = await this.state(signal);
    const after = this.chat(current, title).input;
    if (
      current.info?.frontmostApp !== APP ||
      after.value !== input.value ||
      !after.states?.includes('focused')
    ) {
      throw Error('输入框焦点或内容发生变化');
    }
    return current;
  }

  async finishCopy(state: CuaAppState, job: CuaJob, signal: AbortSignal): Promise<void> {
    if (job.mention) {
      state = await this.focusInput(state, job.rule.title, signal);
      const input = this.chat(state, job.rule.title).input;
      if (!Number.isInteger(input.index)) throw Error('无法定位原生 @ 输入框光标');
      await this.call(
        'axSet',
        {
          elementIndex: input.index,
          windowId: state.info?.window?.id,
          attribute: 'AXSelectedTextRange',
          value: { location: (input.value ?? '').length, length: 0 },
        },
        signal,
        true,
      );
    } else {
      await this.call('pressKey', { key: 'Right' }, signal, true);
    }
  }

  async selectMention(
    job: CuaJob,
    state: CuaAppState,
    signal: AbortSignal,
    mentionOverride?: CuaMention,
    axPrefixSoFar = '',
  ): Promise<CuaAppState> {
    const mention = mentionOverride ?? job.mention;
    if (!mention) throw Error('原生 @ 缺少可核对的成员身份');
    const typed = axPrefixSoFar + '@' + mention.name;
    const norm = (text?: string): string => (text || '').normalize('NFKC').replace(/\s/g, '');
    const targetName = norm(mention.name);
    let chat = this.chat(state, job.rule.title);
    if (chat.input.value !== typed) throw Error('@ 成员搜索内容已改变');
    try {
      const w = state.info?.window;
      const f = chat.input.frame;
      if (!w || !f) throw Error('无法唯一核对微信 @ 成员菜单');
      const x = Math.max(w.bounds.x, f.x - 8);
      const maxWidth = Math.min(
        axPrefixSoFar ? Math.max(420, f.width + 16) : 420,
        Math.max(0, w.bounds.x + w.bounds.width - x),
      );
      const initialWidth = axPrefixSoFar
        ? maxWidth
        : Math.min(
            maxWidth,
            mention.name.length <= 4 ? 100 : Math.max(100, mention.name.length * 32 + 40),
          );
      const retryWidth = axPrefixSoFar
        ? maxWidth
        : Math.min(maxWidth, Math.max(initialWidth, mention.name.length * 36 + 80));
      let choice: CuaOcrMatch | undefined;
      let lastObserved: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await this.pause(200, signal);
          state = await this.state(signal);
          chat = this.chat(state, job.rule.title);
          if (
            chat.input.value !== typed ||
            JSON.stringify(state.info?.window?.bounds) !== JSON.stringify(w.bounds)
          ) {
            throw Error('@ 菜单或输入已改变');
          }
        }
        const scanHeight = attempt === 0 ? 70 : 120;
        const y = Math.max(w.bounds.y, f.y - scanHeight);
        const height = Math.max(0, f.y - y);
        const band: Rect = { x, y, width: attempt === 0 ? initialWidth : retryWidth, height };
        const bounds: Rect = {
          x: band.x - 2,
          y: band.y - 2,
          width: band.width + 4,
          height: band.height + 4,
        };
        const inBand = (matches?: CuaOcrMatch[]): CuaOcrMatch[] =>
          (matches || []).filter(
            (m) =>
              m.windowId === w.id &&
              (m.confidence ?? 0) >= 0.5 &&
              this.inside(
                { ...m.rect, x: m.rect.x + w.bounds.x, y: m.rect.y + w.bounds.y },
                bounds,
              ),
          );
        const isEllipsizedPrefix = (raw?: string): boolean => {
          const text = norm(raw);
          if (!text) return false;
          const stripped = text.replace(/(?:\u2026|\.{2,3})$/, '');
          return (
            stripped.length < text.length &&
            stripped.length >= 4 &&
            targetName.length > stripped.length &&
            targetName.startsWith(stripped)
          );
        };
        const matchInBand = (matches?: CuaOcrMatch[]): CuaOcrMatch[] => {
          const inside = inBand(matches);
          const observed = inside.map((m) => String(m.text || '').trim()).filter(Boolean);
          if (observed.length > 0) lastObserved = observed.slice(0, 6);
          const exact = inside.filter((m) => norm(m.text) === targetName);
          if (exact.length > 0) return exact;
          return inside.filter((m) => isEllipsizedPrefix(m.text));
        };
        let found = (await this.call(
          'findText',
          {
            text: mention.name,
            exact: false,
            ocrOnly: true,
            composited: true,
            windowId: w.id,
            region: band,
            limit: 20,
          },
          signal,
        )) as { matches?: CuaOcrMatch[] };
        let matches = matchInBand(found.matches);
        if (matches.length === 0 && attempt === 1) {
          found = (await this.call(
            'findText',
            {
              text: '',
              exact: false,
              ocrOnly: true,
              composited: true,
              windowId: w.id,
              region: band,
              limit: 20,
            },
            signal,
          )) as { matches?: CuaOcrMatch[] };
          matches = matchInBand(found.matches);
        }
        if (matches.length === 1) {
          choice = matches[0];
          break;
        }
        if (matches.length > 1) {
          throw Error(`无法唯一核对微信 @ 成员菜单（命中 ${matches.length} 项：${matches.map((m) => m.text).join(' | ')}）`);
        }
      }
      if (!choice) {
        const diag = lastObserved.length > 0 ? lastObserved.join(' | ') : '空';
        throw Error(`无法唯一核对微信 @ 成员菜单（OCR=${diag}）`);
      }
      const checked = await this.state(signal);
      if (
        this.chat(checked, job.rule.title).input.value !== typed ||
        JSON.stringify(checked.info?.window?.bounds) !== JSON.stringify(w.bounds)
      ) {
        throw Error('@ 菜单或输入已改变');
      }
      this.verifyQuoteState(checked, job);
      await this.call(
        'click',
        {
          x: choice.rect.x + choice.rect.width / 2,
          y: choice.rect.y + choice.rect.height / 2,
          windowId: w.id,
          coordinateSpace: 'window',
          strategy: 'coordinate',
        },
        signal,
        true,
      );
      state = await this.state(signal);
      chat = this.chat(state, job.rule.title);
      const val = chat.input.value ?? '';
      if (!val.startsWith(axPrefixSoFar) || !/^\uFFFC[ \u2005]*$/.test(val.slice(axPrefixSoFar.length))) {
        throw Error('微信没有插入原生 @ 成员对象');
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const cleanup = AbortSignal.timeout(20000);
        let current = await this.state(cleanup);
        let currentChat = this.chat(current, job.rule.title);
        if (current.info?.frontmostApp !== APP || currentChat.input.value !== typed) {
          throw Error('草稿已改变');
        }
        this.verifyQuoteState(current, job);
        await this.call('pressKey', { key: 'Escape' }, cleanup, true);
        current = await this.state(cleanup);
        currentChat = this.chat(current, job.rule.title);
        if (current.info?.frontmostApp !== APP || currentChat.input.value !== typed) {
          throw Error('草稿已改变');
        }
        this.verifyQuoteState(current, job);
        if (!currentChat.input.states?.includes('focused')) {
          current = await this.focusInput(current, job.rule.title, cleanup);
          currentChat = this.chat(current, job.rule.title);
          if (currentChat.input.value !== typed || !currentChat.input.states?.includes('focused')) {
            throw Error('草稿焦点无法确认');
          }
        }
        await this.call('pressKey', { key: 'Cmd+a' }, cleanup, true);
        await this.call('pressKey', { key: 'Backspace' }, cleanup, true);
        let after = await this.state(cleanup);
        let afterChat = this.chat(after, job.rule.title);
        if (afterChat.input.value) throw Error('草稿清理未确认');
        if (job.decision.replyTo) {
          this.quotePreview(after, job);
          await this.clickFrame(
            one(afterChat.nodes, (n) => n.title === '删除引用消息', '无法核对旧草稿引用').frame,
            cleanup,
          );
          after = await this.state(cleanup);
          afterChat = this.chat(after, job.rule.title);
        }
        if (afterChat.input.value || afterChat.nodes.some((n) => n.title === '删除引用消息')) {
          throw Error('草稿或引用尚未清理');
        }
      } catch {
        throw Object.assign(
          new Error(message + '；半成品草稿无法安全清理，请核对微信输入框', { cause: error }),
          { mentionId: mention.id },
        );
      }
      throw Object.assign(
        new Error(message + '；已清理本次未发送的 @ 查询和引用', { cause: error }),
        { mentionId: mention.id },
      );
    }
  }

  async prepareMention(job: CuaJob, signal: AbortSignal): Promise<CuaJob> {
    const mentions = jobMentions(job);
    if (!mentions.length) return job;
    const target = quoteEvent(job);
    const resolvedNames: string[][] = mentions.map((mention) => {
      if (!mention?.id || !mention?.name) {
        throw Error('原生 @ 缺少可核对的成员身份');
      }
      const isSender = mention.id === target.senderId && target.senderIdentity?.id === target.senderId;
      if (isSender) {
        const identity = target.senderIdentity!;
        if (!identity.uniqueUiName || identity.uiName !== mention.name) {
          throw Error('原生 @ 缺少可核对的成员身份');
        }
        return [identity.groupNickname, identity.nickname, identity.uiName].filter(
          (n): n is string => Boolean(n),
        );
      }
      if (!mention.uniqueUiName) {
        throw Error('原生 @ 缺少可核对的成员身份');
      }
      return [mention.groupNickname, mention.nickname, mention.name].filter(
        (n): n is string => Boolean(n),
      );
    });
    let axPrefixSoFar = '';
    let copiedPrefixSoFar = '';
    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i];
      const names = resolvedNames[i];
      let state = await this.state(signal);
      let chat = this.chat(state, job.rule.title);
      if ((chat.input.value ?? '') !== axPrefixSoFar || !chat.input.states?.includes('focused')) {
        throw Error('@ 前输入框已改变');
      }
      this.verifyQuoteState(state, job);
      await this.call('pressKey', { key: 'Shift+2' }, signal, true);
      await this.call('typeText', { text: mention.name }, signal, true);
      await this.pause(250, signal);
      state = await this.state(signal);
      chat = this.chat(state, job.rule.title);
      const typed = axPrefixSoFar + '@' + mention.name;
      if (chat.input.value !== typed || !chat.input.states?.includes('focused')) {
        throw Error('@ 成员搜索内容已改变');
      }
      state = await this.selectMention(job, state, signal, mention, axPrefixSoFar);
      chat = this.chat(state, job.rule.title);
      const axPrefix = chat.input.value ?? '';
      const saved = await this.pasteboard({ action: 'snapshot' }, signal);
      let copiedText = '';
      try {
        await this.focusInput(state, job.rule.title, signal);
        await this.call('pressKey', { key: 'Cmd+a' }, signal, true);
        await this.call('pressKey', { key: 'Cmd+c' }, signal, true);
        const copied = await this.pasteboard({ action: 'read' }, signal);
        copiedText = copied.text ?? '';
        const after = this.chat(await this.state(signal), job.rule.title).input;
        const segment = copiedText.startsWith(copiedPrefixSoFar)
          ? copiedText.slice(copiedPrefixSoFar.length)
          : '';
        if (
          copied.count === saved.count ||
          !copiedText.startsWith(copiedPrefixSoFar) ||
          !names.some(
            (n) =>
              segment === `\u2005@${n}\u2005` ||
              segment === `@${n}\u2005` ||
              segment === `@${n} `,
          ) ||
          after.value !== axPrefix ||
          !after.states?.includes('focused')
        ) {
          throw Error('原生 @ 名称或成员对象不一致');
        }
        await this.finishCopy(await this.state(signal), job, signal);
      } finally {
        await this.pasteboard({ action: 'restore', items: saved.items ?? [] });
      }
      axPrefixSoFar = axPrefix;
      copiedPrefixSoFar = copiedText;
    }
    return {
      ...job,
      inputText: copiedPrefixSoFar + job.decision.text,
      mentionProof: { axPrefix: axPrefixSoFar },
    };
  }

  async verifyInput(job: CuaJob, signal: AbortSignal): Promise<CuaAppState> {
    let state = await this.state(signal);
    const { input } = this.chat(state, job.rule.title);
    const text = job.inputText || job.decision.text;
    const hasMentions = jobMentions(job).length > 0;
    if (state.info?.frontmostApp !== APP) throw new Error('核对输入时微信不在前台');
    if (input.value === text && !hasMentions) return state;
    if (hasMentions && (!job.mentionProof || !input.value?.startsWith(job.mentionProof.axPrefix))) {
      throw Error('原生 @ 成员对象已改变');
    }
    if (!input.value?.includes('\uFFFC')) {
      throw new Error('微信输入内容与回复不一致，未点击发送');
    }
    const saved = await this.pasteboard({ action: 'snapshot' }, signal);
    try {
      await this.focusInput(state, job.rule.title, signal);
      const focused = this.chat(await this.state(signal), job.rule.title).input;
      if (focused.value !== input.value || !focused.states?.includes('focused')) {
        throw new Error('核对表情前输入框发生变化');
      }
      await this.call('pressKey', { key: 'Cmd+a' }, signal, true);
      await this.call('pressKey', { key: 'Cmd+c' }, signal, true);
      const copied = await this.pasteboard({ action: 'read' }, signal);
      state = await this.state(signal);
      const after = this.chat(state, job.rule.title).input;
      if (
        state.info?.frontmostApp !== APP ||
        after.value !== input.value ||
        !after.states?.includes('focused')
      ) {
        throw new Error('核对表情时输入框发生变化');
      }
      await this.finishCopy(state, job, signal);
      if (copied.count === saved.count || copied.text !== text) {
        throw new Error('微信输入内容（含表情）与回复不一致，未点击发送');
      }
      return await this.state(signal);
    } finally {
      await this.pasteboard({ action: 'restore', items: saved.items ?? [] });
    }
  }

  async prepare(job: CuaJob, signal: AbortSignal): Promise<PreparedCommit> {
    if (job.event.kind === 'sns') return this.prepareMoment(job, signal);
    let state = await this.openChat(job.rule, signal);
    const { input } = this.chat(state, job.rule.title);
    if (input.value || flatten(state.accessibility?.nodes).some((n) => n.title === '删除引用消息')) {
      throw new Error('目标会话中已有草稿或引用，未覆盖');
    }
    if (!hasTrigger(state, quoteEvent(job))) {
      const { replyTo, ...decision } = job.decision;
      job = {
        ...job,
        decision,
        deliveryDetail: replyTo
          ? '当前会话未显示触发原消息，已取消引用并直接回复'
          : '当前会话未显示触发原消息，已直接回复',
      };
    }
    if (job.decision.replyTo === 'current') {
      try {
        state = await this.prepareQuote(job, state, signal);
      } catch (error) {
        if (!(error instanceof QuoteLocationUnavailable)) throw error;
        signal.throwIfAborted();
        state = await this.state(signal);
        const checked = this.chat(state, job.rule.title);
        if (checked.input.value || checked.nodes.some((n) => n.title === '删除引用消息')) {
          throw Error('引用定位失败后出现了草稿或引用，未覆盖');
        }
        const { replyTo: _removedReplyTo, ...decision } = job.decision;
        job = {
          ...job,
          decision,
          deliveryDetail: '原消息引用位置无法可靠识别，已取消引用并直接回复',
        };
      }
    }
    await this.focusInput(state, job.rule.title, signal);
    const focused = this.chat(await this.state(signal), job.rule.title).input;
    if (focused.value || !focused.states?.includes('focused')) {
      throw new Error('目标输入框未取得焦点或已有内容');
    }
    if (jobMentions(job).length > 0) job = await this.prepareMention(job, signal);
    await this.call('typeText', { text: job.decision.text }, signal, true);
    return this.preparedReply(job, signal);
  }

  async preparedReply(job: CuaJob, signal: AbortSignal): Promise<PreparedCommit> {
    const prepared = await this.verifyInput(job, signal);
    this.verifyQuoteState(prepared, job);
    const hasMentions = jobMentions(job).length > 0;
    const commit: PreparedCommit = async (commitSignal: AbortSignal): Promise<CommitReceipt> => {
      const before = await this.verifyInput(job, commitSignal);
      const { nodes } = this.chat(before, job.rule.title);
      const quote = job.decision.replyTo ? (this.quotePreview(before, job).title ?? null) : null;
      if (!quote && nodes.some((n) => n.title === '删除引用消息')) {
        throw new Error('发送前出现了未选择的引用');
      }
      const button = one(
        nodes,
        (n) => n.role === 'AXButton' && n.title === '发送' && !n.states?.includes('disabled'),
        '找不到唯一可用的发送按钮',
      );
      const occurrences = (s: CuaAppState): number =>
        flatten(s.accessibility?.nodes).filter(
          (n) =>
            n.identifier !== 'chat_input_field' &&
            [n.value, n.title, n.description].some(
              (v) => typeof v === 'string' && v.includes(job.decision.text),
            ),
        ).length;
      const previous = occurrences(before);
      await this.clickFrame(button.frame, commitSignal);
      await this.pause(700, commitSignal);
      const after = await this.state(commitSignal);
      const field = this.chat(after, job.rule.title).input;
      const expectedEcho = (job.inputText || job.decision.text) + (quote ? '\n' + quote : '');
      const quoted =
        (!quote && !hasMentions) ||
        flatten(after.accessibility?.nodes).some(
          (n) =>
            n.identifier === 'chat_bubble_item_view' &&
            (hasMentions
              ? n.title?.replace(/\s+/gu, ' ').trim() ===
                expectedEcho.replace(/\s+/gu, ' ').trim()
              : n.title === expectedEcho),
        );
      return {
        confirmed: !field.value && occurrences(after) > previous && quoted,
        ...(job.deliveryDetail ? { detail: job.deliveryDetail } : {}),
      };
    };
    commit.deliveryDetail = job.deliveryDetail;
    commit.discard = async (cleanupSignal: AbortSignal): Promise<void> => {
      const state = await this.verifyInput(job, cleanupSignal);
      this.verifyQuoteState(state, job);
      await this.focusInput(state, job.rule.title, cleanupSignal);
      const checked = await this.verifyInput(job, cleanupSignal);
      if (!this.chat(checked, job.rule.title).input.states?.includes('focused')) {
        throw Error('旧草稿焦点无法确认，未清理');
      }
      await this.call('pressKey', { key: 'Cmd+a' }, cleanupSignal, true);
      await this.call('pressKey', { key: 'Backspace' }, cleanupSignal, true);
      let after = await this.state(cleanupSignal);
      if (this.chat(after, job.rule.title).input.value) throw Error('旧草稿清理未确认');
      if (job.decision.replyTo) {
        this.quotePreview(after, job);
        await this.clickFrame(
          one(
            this.chat(after, job.rule.title).nodes,
            (n) => n.title === '删除引用消息',
            '无法核对旧草稿引用',
          ).frame,
          cleanupSignal,
        );
        after = await this.state(cleanupSignal);
      }
      const chat = this.chat(after, job.rule.title);
      if (chat.input.value || chat.nodes.some((n) => n.title === '删除引用消息')) {
        throw Error('旧草稿或引用尚未清理');
      }
    };
    return commit;
  }
}
