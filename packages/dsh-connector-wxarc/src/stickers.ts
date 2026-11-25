import { randomUUID, createHash } from 'node:crypto';
import { flatten, one, hasTrigger } from './cua.js';
import type { CuaAppState, CuaEvent, CuaNode, CuaOcrMatch, CuaRule, PreparedCommit } from './cua.js';
import type { Rect } from './session-position.js';
import { validateAccount } from './source.js';

const APP = 'com.tencent.xinWeChat';

interface StickerShot {
  url: string;
}

const digest = (shot: StickerShot): string =>
  createHash('sha256').update(shot.url).digest('hex');

export interface StickerLayout {
  panel: Rect;
  search: CuaNode;
  bar: Rect;
  cells: Rect[];
  grid: Rect;
}

export interface StickerLease {
  ticket?: string;
  runId: string;
  jobId: number;
  query: string;
  layout?: StickerLayout;
  windowId?: number;
  hashes?: string[];
  stable?: number[];
  expires: number;
}

export interface StickerSearchResult {
  ticket: string;
  query: string;
  selectable: number[];
  instructions: string;
  image: {
    type: 'image';
    mediaType: 'image/jpeg';
    data: string;
  };
}

export interface StickerJob {
  id: number;
  event: CuaEvent & {
    session?: string;
    dshRunId?: string;
  };
  rule: CuaRule;
  decision?: {
    action?: string;
    text?: string;
    sticker?: {
      ticket: string;
      index: number;
    };
  };
}

export interface StickersCua {
  call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    activate?: boolean,
  ): Promise<Record<string, unknown>>;
  state(
    signal: AbortSignal,
    extra?: Record<string, unknown>,
    activate?: boolean,
  ): Promise<CuaAppState>;
  openChat?(rule: CuaRule, signal: AbortSignal): Promise<CuaAppState>;
  chat(state: CuaAppState, title: string): { nodes?: CuaNode[]; input: CuaNode };
  clickFrame(frame: Rect | undefined, signal: AbortSignal): Promise<void>;
  visibleText?(
    state: CuaAppState,
    query: string,
    area: Rect | undefined,
    signal: AbortSignal,
  ): Promise<CuaOcrMatch[]>;
  pause(ms: number, signal: AbortSignal): Promise<void>;
}

export interface StickersAutomation {
  cua: StickersCua;
  active?: AbortController | null;
  controller?: AbortController;
  wxarcHome?: string;
  tail(): number;
  job?(id: number): StickerJob;
  assertCurrent?(job: StickerJob, signal: AbortSignal): unknown;
  settings(): {
    policy: {
      ownId: string;
      provider?: string;
      model?: string;
    };
  };
  listener: {
    wechatRoot?: string;
  };
  store: {
    db: {
      prepare(sql: string): {
        all(param: number): unknown[];
      };
    };
  };
  resolveSource(
    home: string,
    event: Record<string, unknown>,
  ): {
    session?: string;
    senderId?: string;
    local_type?: number;
    account?: string;
  };
}

export interface StickersBridgeRun {
  id: string;
  job_id?: number;
  preview?: boolean | number;
  manual?: boolean | number;
  status?: string;
}

export interface StickersBridge {
  owner?(agent: unknown): { session_id: string } | null | undefined;
  active?(sessionId: string): StickersBridgeRun | null | undefined;
  run?(id: string): StickersBridgeRun | null | undefined;
  ctx?: {
    llm: {
      resolveModelInfo(
        provider: string | undefined,
        model: string | undefined,
        signal: AbortSignal,
      ): Promise<{ inputModalities?: string[] }>;
    };
  };
}

export function stickerLayout(state: CuaAppState, query?: string): StickerLayout {
  const panels = flatten(state.accessibility?.nodes).filter(
    (n) => n.role === 'AXWindow' && n.subrole === 'AXDialog',
  );
  const panel = one(
    panels,
    (n) => flatten([n]).some((x) => x.identifier === 'emoticon_panel_tool_bar'),
    '无法唯一核对微信表情面板',
  );
  const nodes = flatten([panel]);
  const search = one(
    nodes,
    (n) => n.role === 'AXTextArea' && n.title === '搜索',
    '无法核对表情搜索框',
  );
  const bar = one(
    nodes,
    (n) => n.identifier === 'emoticon_panel_tool_bar',
    '无法核对表情工具栏',
  );
  if (query !== undefined && search.value !== query) {
    throw Error('表情搜索词已改变');
  }
  const panelFrame = panel.frame;
  const searchFrame = search.frame;
  const barFrame = bar.frame;
  if (
    !panelFrame ||
    !searchFrame ||
    !barFrame ||
    Math.abs(barFrame.width - 466) > 2 ||
    Math.abs(panelFrame.width - 514) > 2 ||
    Math.abs(barFrame.y - searchFrame.y - 390) > 3
  ) {
    throw Error('微信表情面板布局已改变');
  }
  const cells: Rect[] = Array.from({ length: 10 }, (_, i) => ({
    x: barFrame.x + 20 + (i % 5) * 88,
    y: searchFrame.y + 87 + Math.floor(i / 5) * 88,
    width: 72,
    height: 72,
  }));
  return {
    panel: panelFrame,
    search,
    bar: barFrame,
    cells,
    grid: { x: cells[0].x, y: cells[0].y, width: 424, height: 160 },
  };
}

export class Stickers {
  auto: StickersAutomation;
  bridge: StickersBridge;
  cua: StickersCua;
  lease: StickerLease | null;

  constructor(auto: StickersAutomation, bridge: StickersBridge) {
    this.auto = auto;
    this.bridge = bridge;
    this.cua = auto.cua;
    this.lease = null;
  }

  async shot(state: CuaAppState, region: Rect, signal: AbortSignal): Promise<StickerShot> {
    const r = (await this.cua.call(
      'captureScreenshot',
      { windowId: state.info?.window?.id, composited: true, region },
      signal,
    )) as { screenshots?: Array<{ url?: string }> };
    const shot = r.screenshots?.[0];
    if (!shot?.url?.startsWith('data:image/jpeg;base64,')) {
      throw Error('无法读取表情候选图片');
    }
    return { url: shot.url };
  }

  async search(
    args: { query?: unknown },
    exec: { agent: unknown; signal: AbortSignal },
  ): Promise<StickerSearchResult> {
    if (
      typeof args.query !== 'string' ||
      !args.query.trim() ||
      args.query.length > 30 ||
      /[\r\n]/.test(args.query)
    ) {
      throw Error('表情搜索词需要是 1–30 字的短语');
    }
    const row = this.bridge.owner?.(exec.agent);
    const run = row ? this.bridge.active?.(row.session_id) : undefined;
    if (!run || run.preview || run.manual || !run.job_id) {
      throw Error('表情搜索仅用于当前正在处理的微信聊天');
    }
    const job = this.auto.job!(run.job_id);
    if (job.event.kind !== 'text') throw Error('朋友圈评论不发送表情包');
    const model = await this.bridge.ctx!.llm.resolveModelInfo(
      this.auto.settings().policy.provider,
      this.auto.settings().policy.model,
      exec.signal,
    );
    if (!model.inputModalities?.includes('image')) {
      throw Error('当前模型不能看表情候选图');
    }
    for (let i = 0; this.auto.active && i < 40; i++) {
      await this.cua.pause(250, exec.signal);
    }
    if (this.auto.active) {
      throw Error('微信界面正在处理其他任务，请先使用文字回复');
    }
    const abort = (this.auto.active = new AbortController());
    const signals = [abort.signal, exec.signal, AbortSignal.timeout(60000)];
    if (this.auto.controller) signals.splice(2, 0, this.auto.controller.signal);
    const signal = AbortSignal.any(signals);
    try {
      this.auto.assertCurrent?.(job, signal);
      if (this.lease && this.lease.runId !== run.id) {
        throw Error('另一个聊天正在选择表情，请使用文字回复');
      }
      await this.release(signal);
      let state = await this.cua.openChat!(job.rule, signal);
      const chat = this.cua.chat(state, job.rule.title);
      if (chat.input.value || !hasTrigger(state, job.event)) {
        throw Error('当前聊天或触发消息无法核实');
      }
      const chatNodes = chat.nodes ?? [];
      const button = one(
        chatNodes,
        (n) => n.role === 'AXButton' && Boolean(n.title?.startsWith('发送表情')),
        '找不到表情入口',
      );
      if (!chatNodes.some((n) => n.identifier === 'emoticon_panel_tool_bar')) {
        await this.cua.clickFrame(button.frame, signal);
        await this.cua.pause(300, signal);
      }
      state = await this.cua.state(signal);
      const tab = one(
        flatten(state.accessibility?.nodes),
        (n) => n.role === 'AXRadioButton' && n.title === '搜索表情',
        '找不到微信表情搜索入口',
      );
      await this.cua.clickFrame(tab.frame, signal);
      await this.cua.pause(200, signal);
      state = await this.cua.state(signal);
      let layout = stickerLayout(state);
      const query = args.query.trim();
      await this.cua.clickFrame(layout.search.frame, signal);
      await this.cua.call('pressKey', { key: 'Cmd+a' }, signal, true);
      await this.cua.call('typeText', { text: query }, signal, true);
      await this.cua.pause(1800, signal);
      state = await this.cua.state(signal);
      layout = stickerLayout(state, query);
      const labels = await this.cua.visibleText!(state, '全部表情', layout.panel, signal);
      if (labels.length !== 1) throw Error('未能确认微信表情搜索结果');
      this.lease = { runId: run.id, jobId: job.id, query, expires: Date.now() + 90000 };
      const shots: StickerShot[] = [];
      for (const cell of layout.cells) {
        shots.push(await this.shot(state, cell, signal));
      }
      const grid = await this.shot(state, layout.grid, signal);
      const stable: number[] = [];
      for (let i = 0; i < layout.cells.length; i++) {
        const now = await this.shot(state, layout.cells[i], signal);
        if (digest(now) === digest(shots[i])) stable.push(i + 1);
      }
      if (!stable.length) {
        throw Error('表情预览持续变化，暂时无法稳定核对，请使用文字回复');
      }
      this.auto.assertCurrent?.(job, signal);
      const ticket = randomUUID();
      this.lease = {
        ticket,
        runId: run.id,
        jobId: job.id,
        query,
        layout,
        windowId: state.info?.window?.id,
        hashes: shots.map(digest),
        stable,
        expires: Date.now() + 90000,
      };
      return {
        ticket,
        query,
        selectable: stable,
        instructions:
          '图片为两行五列，编号按从左到右、从上到下为 1–10。仅可选 selectable 中确实有内容、符合当前语境的表情。空白、加载中或不合适时改用文字。此工具没有发送。要发送请立即返回 action=sticker，sticker={ticket,index}，text 填搜索失败时可使用的自然文字回复。一次只发一个表情包。',
        image: {
          type: 'image',
          mediaType: 'image/jpeg',
          data: grid.url.split(',')[1],
        },
      };
    } catch (e) {
      await this.release(AbortSignal.timeout(3000));
      throw e;
    } finally {
      if (this.auto.active === abort) this.auto.active = null;
    }
  }

  async release(signal: AbortSignal): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (!lease) return;
    try {
      const state = await this.cua.state(signal);
      stickerLayout(state, lease.query);
      if (state.info?.frontmostApp === APP) {
        await this.cua.call('pressKey', { key: 'Escape' }, signal, true);
      }
    } catch {}
  }

  async reconcile(signal: AbortSignal): Promise<void> {
    if (this.lease) {
      const r = this.bridge.run?.(this.lease.runId);
      if (
        Date.now() > this.lease.expires ||
        !r ||
        r.manual ||
        !['running', 'waiting', 'admitting', 'ready'].includes(r.status ?? '')
      ) {
        await this.release(signal);
      }
    }
  }

  async prepare(job: StickerJob, signal: AbortSignal): Promise<PreparedCommit> {
    const v = job.decision?.sticker;
    const l = this.lease;
    if (
      !v ||
      !l ||
      !l.ticket ||
      !l.layout ||
      !l.stable ||
      !l.hashes ||
      v.ticket !== l.ticket ||
      job.id !== l.jobId ||
      job.event.dshRunId !== l.runId ||
      Date.now() > l.expires ||
      !l.stable.includes(v.index)
    ) {
      throw Error('表情选择已失效，请重新搜索');
    }
    const expectedLayout = l.layout;
    const expectedHashes = l.hashes;
    const expectedWindowId = l.windowId;
    const expectedQuery = l.query;
    const inspect = async (s: AbortSignal): Promise<CuaAppState> => {
      const state = await this.cua.state(s);
      const chat = this.cua.chat(state, job.rule.title);
      const layout = stickerLayout(state, expectedQuery);
      if (
        state.info?.frontmostApp !== APP ||
        chat.input.value ||
        state.info?.window?.id !== expectedWindowId ||
        JSON.stringify(layout.cells) !== JSON.stringify(expectedLayout.cells)
      ) {
        throw Error('表情发送前聊天或面板发生改变');
      }
      const shot = await this.shot(state, layout.cells[v.index - 1], s);
      if (digest(shot) !== expectedHashes[v.index - 1]) {
        throw Error('选中的表情预览已改变，未点击发送');
      }
      return state;
    };
    await inspect(signal);
    let used = false;
    return async (s: AbortSignal) => {
      if (used) throw Error('这次表情发送已经尝试过，不能重复点击');
      used = true;
      await inspect(s);
      const before = this.auto.tail();
      this.lease = null;
      await this.cua.clickFrame(expectedLayout.cells[v.index - 1], s);
      for (let i = 0; i < 20; i++) {
        await this.cua.pause(500, s);
        const rows = this.auto.store.db
          .prepare("SELECT payload FROM events WHERE seq>? AND kind='text' ORDER BY seq")
          .all(before) as Array<{ payload: string }>;
        for (const row of rows) {
          try {
            const e = this.auto.resolveSource(
              this.auto.wxarcHome ?? '',
              JSON.parse(row.payload) as Record<string, unknown>,
            );
            const ownId = this.auto.settings().policy.ownId;
            validateAccount(e, ownId, this.auto.listener.wechatRoot ?? '');
            if (
              e.session === job.event.session &&
              e.senderId === ownId &&
              (e.local_type ?? 0) % 4294967296 === 47
            ) {
              return { confirmed: true };
            }
          } catch {}
        }
      }
      return {
        confirmed: false,
        detail: '已点击表情，但尚未核对到本账号发出的表情消息；不会自动重发',
      };
    };
  }
}
