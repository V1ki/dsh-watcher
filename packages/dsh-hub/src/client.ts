interface ReactNodeLike {
  readonly __brand?: 'react-node';
}

interface ReactRuntime {
  createElement: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ReactNodeLike;
  Fragment: unknown;
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T;
}

interface SlotContext {
  slots: {
    inject: (name: string, factory: () => unknown) => void;
    register: (meta: Record<string, unknown>, component: unknown) => unknown;
  };
  uiWorkspace?: {
    openSession?: (sessionId: string) => void;
  };
}

interface WatcherWindow {
  __ModuleLoader__?: {
    load: (spec: {
      id: string;
      factory: (require: (mod: string) => unknown) => {
        inject: string[];
        apply: (ctx: SlotContext) => void;
      };
    }) => void;
  };
}

interface ConnectorView {
  id: string;
  label: string;
  kind: string;
  panelId?: string;
  panelLabel?: string;
  health?: { ok: boolean; detail?: string };
}

interface SubscriptionView {
  id: string;
  source: string;
  threadKey: string;
  workstreamId: string | null;
  sessionId: string;
  personaId: string | null;
  owner: string;
  status: string;
  updatedAt: string;
}

interface StatusView {
  sources: Array<{ id: string; label: string; health?: { ok: boolean; consecutiveErrors?: number; lastError?: string } }>;
  connectors?: ConnectorView[];
  sinks?: Array<{ id: string; label: string; kind: string }>;
  activeWorkstreams: number;
  activeSubscriptions?: number;
  activeMemos?: number;
  unreadInbox: number;
  pendingDrafts: number;
  autoSessionsThisHour: number;
}

interface InboxView {
  id: string;
  source: string;
  type: string;
  sessionId: string | null;
  summary: string;
  tier: string;
  verdict?: string;
  preGateTags: string[];
  rawUrl?: string;
  createdAt: string;
  entityKey?: string | null;
  actor?: string;
  status?: string;
  occurredAt?: string;
  updatedAt?: string;
}

type PostRole = 'root' | 'comment' | 'other';
type PostKind = 'Issue' | 'PR' | null;

interface FloorInfo {
  label: string;
  tone: 'root' | 'comment' | 'old' | 'other';
  verb: string;
}

interface InboxThread {
  key: string;
  sourceKey: string;
  sourceLabel: string;
  title: string;
  primary: InboxView;
  items: InboxView[];
  others: InboxView[];
  sessionId: string | null;
  rawUrl: string | null;
  unread: number;
  latestAt: number;
  root: InboxView | null;
  kind: PostKind;
  forum: boolean;
  commentNo: Record<string, number>;
}

interface MemoView {
  id: string;
  kind: 'time_nudge' | 'news_followup' | 'long_watch';
  roomKey: string;
  targetSessionId: string | null;
  title: string;
  basis: string;
  status: string;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  resultSummary: string | null;
}

interface DraftView {
  id: string;
  sinkId: string;
  action: string;
  sessionId: string | null;
  previewText: string;
  status: string;
  createdAt: string;
}

interface WorkstreamView {
  id: string;
  primaryEntityKey: string;
  deliveryCount: number;
  maxWakeups: number;
}

interface ChangeEventLike {
  target: { value: string; checked?: boolean };
}

void (() => {
  (window as unknown as WatcherWindow).__ModuleLoader__?.load({
    id: '@local/dsh-hub',
  factory: (require) => {
    const React = require('react') as ReactRuntime;
    const { useEffect, useState, useCallback } = React;
    const h = React.createElement;
    const PANEL_ID = 'dsh-hub-panel';
    let openSession: (id: string) => void = () => {};

    const MEMO_KIND_LABELS: Record<MemoView['kind'], string> = {
      time_nudge: '时间惦记',
      news_followup: '新闻后续',
      long_watch: '长期蹲官宣',
    };

    const MEMO_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
      active: { label: '进行中', tone: '' },
      fired: { label: '已触发', tone: 'muted' },
      completed: { label: '已完成', tone: 'muted' },
      torn: { label: '已撕掉', tone: 'warn' },
      expired: { label: '已过期', tone: 'muted' },
    };

    const MEMO_REASON_LABELS: Record<string, string> = {
      proactive_budget_exhausted: '主动消息额度已用尽（当次未发出）',
      'deferred:proactive_budget_exhausted': '主动消息额度已用尽，已顺延至额度恢复后重试',
      missed_time_window_no_backfill: '已错过时间窗，按规则不补发',
      memo_expired: '便签已到期作废',
      cancelled: '已手动撕掉',
      cancelled_by_tool: '已手动撕掉',
      'torn:chat_paused': '已撕掉：该聊天已暂停发言',
      'torn:owner_already_spoke': '已撕掉：本人近期已发言',
      'torn:topic_already_discussed': '已撕掉：群内已讨论该话题',
      'torn:active_conversation': '已撕掉：群内正在聊别的话题',
      'deferred:wechat_transport_unhealthy': '已顺延：微信通道暂不可用',
      'deferred:active_conversation': '已顺延：群内正在聊天，稍后重试',
    };

    function formatMemoStatus(status: string): { label: string; tone: string } {
      return MEMO_STATUS_LABELS[status] ?? { label: status || '未知状态', tone: 'warn' };
    }

    function formatMemoResultSummary(summary: string | null | undefined): string {
      const raw = (summary || '').trim();
      if (!raw) return '';
      if (MEMO_REASON_LABELS[raw]) return MEMO_REASON_LABELS[raw];
      if (raw.startsWith('fired_wechat_session:')) {
        return `已交由微信会话自然发出（${formatTime(raw.slice('fired_wechat_session:'.length))}）`;
      }
      if (raw.startsWith('fired_wechat:')) {
        return `已通过微信发出（${formatTime(raw.slice('fired_wechat:'.length))}）`;
      }
      if (raw.startsWith('fired:')) {
        return `已送入房间触发（${formatTime(raw.slice('fired:'.length))}）`;
      }
      return raw;
    }

    const DRAFT_STATUS_LABELS: Record<string, string> = {
      pending_approval: '待确认',
      approved: '已批准',
      executing: '发送中',
      executed: '已发送',
      uncertain: '待核实',
      rejected: '已丢弃',
      expired: '已过期',
    };

    const SOURCE_META: Record<string, { key: string; label: string }> = {
      github: { key: 'github', label: 'GitHub' },
      wechat: { key: 'wechat', label: '微信' },
      wxarc: { key: 'wechat', label: '微信' },
      weixin: { key: 'wechat', label: '微信' },
      wx: { key: 'wechat', label: '微信' },
      memo: { key: 'memo', label: '备忘' },
    };

    const TYPE_LABELS: Record<string, string> = {
      'github.pinned.activity': '盯防评论',
      'github.pr.updated': 'PR 更新',
      'github.issue.updated': 'Issue 更新',
      'github.issue.comment': 'Issue 评论',
      'github.pr.comment': 'PR 评论',
      'github.issue.labeled': 'Issue 标签',
      'github.pr.labeled': 'PR 标签',
      'github.pr.ready_for_review': 'PR 可审阅',
      'github.pr.review_requested': '请求审阅',
      'github.reaction.delta': '表情回应',
    };

    const TIER_LABELS: Record<string, string> = {
      'inbox-only': '仅收件',
      triage: '待分诊',
      review: '待审阅',
      autonomous: '自动处理',
    };

    const VERDICT_LABELS: Record<string, { label: string; warn: boolean }> = {
      ACTION_REQUIRED: { label: '需处理', warn: true },
      CONFLICT_OR_STALE: { label: '冲突或过期', warn: true },
      OBSOLETE_OR_DUPLICATE: { label: '重复或过时', warn: false },
      INFO_ONLY: { label: '仅告知', warn: false },
    };

    function sourceMeta(source: string): { key: string; label: string } {
      const key = (source || '').trim().toLowerCase();
      return SOURCE_META[key] ?? { key: key || 'other', label: source || '未知来源' };
    }

    function typeLabel(type: string): string {
      const t = (type || '').trim().toLowerCase();
      if (TYPE_LABELS[t]) return TYPE_LABELS[t];
      if (t.includes('review_requested')) return '请求审阅';
      if (t.includes('mention')) return '提到你';
      if (t.includes('comment')) return '新评论';
      if (t.includes('labeled')) return '标签变更';
      if (t.includes('opened')) return '新建';
      if (t.includes('updated')) return '更新';
      if (t.includes('long_watch')) return '蹲守命中';
      if (t.startsWith('memo')) return '备忘提醒';
      if (t.startsWith('wechat') || t.startsWith('wx')) return '微信消息';
      return type || '动态';
    }

    function cleanThreadTitle(source: string, entityKey: string): string {
      let t = (entityKey || '').trim();
      const prefixes = [(source || '').trim().toLowerCase(), ...Object.keys(SOURCE_META)].filter(Boolean);
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of prefixes) {
          if (t.toLowerCase().startsWith(`${p}:`)) {
            t = t.slice(p.length + 1).trim();
            changed = true;
          }
        }
      }
      return t.replace(/^([^\s#]+?)\s*#(\d+)$/, '$1 #$2') || entityKey;
    }

    function timeOf(iso: string | null | undefined): number {
      const t = Date.parse(iso || '');
      return Number.isFinite(t) ? t : 0;
    }

    function fmtRelative(iso: string | null | undefined, now: number): string {
      if (!iso) return '';
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return iso;
      const abs = Math.abs(now - t);
      const future = now - t < 0;
      if (abs < 60000) return future ? '即将' : '刚刚';
      const min = Math.round(abs / 60000);
      if (min < 60) return future ? `${min} 分钟后` : `${min} 分钟前`;
      const hr = Math.round(min / 60);
      if (hr < 24) return future ? `${hr} 小时后` : `${hr} 小时前`;
      const day = Math.round(hr / 24);
      if (day < 7) return future ? `${day} 天后` : `${day} 天前`;
      const d = new Date(t);
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    }

    function flattenText(text: string): string {
      return (text || '').replace(/\r\n?/g, '\n').replace(/^\s*#{1,6}\s+/gm, '').replace(/\s*\n+\s*/g, ' ').trim();
    }

    function safeUrl(url: string | null | undefined): string | null {
      return url && /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
    }

    function inboxThreadKey(item: InboxView): string {
      const ek = (item.entityKey || '').trim();
      if (!ek) return `id::${item.id}`;
      return `${sourceMeta(item.source).key}::${cleanThreadTitle(item.source, ek).toLowerCase().replace(/\s+/g, '')}`;
    }

    function buildInboxThreads(items: InboxView[]): InboxThread[] {
      const map = new Map<string, InboxView[]>();
      const order: string[] = [];
      for (const item of items) {
        const key = inboxThreadKey(item);
        const bucket = map.get(key);
        if (bucket) bucket.push(item);
        else {
          map.set(key, [item]);
          order.push(key);
        }
      }
      return order.map((key) => {
        const list = [...(map.get(key) ?? [])].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
        const asc = [...list].sort((a, b) => occurredOf(a) - occurredOf(b) || timeOf(a.createdAt) - timeOf(b.createdAt));
        const root = [...asc].reverse().find((x) => roleOf(x) === 'root') ?? null;
        const kind = threadKind(list, root);
        const forum = kind !== null;
        const primary = root ?? (forum ? asc[0] : list[0]);
        const meta = sourceMeta(primary.source);
        const ek = list.map((x) => x.entityKey).find((x): x is string => Boolean(x && x.trim()));
        const commentNo: Record<string, number> = {};
        let n = 0;
        for (const x of asc) if (roleOf(x) === 'comment') commentNo[x.id] = ++n;
        return {
          key,
          sourceKey: meta.key,
          sourceLabel: meta.label,
          title: ek ? cleanThreadTitle(primary.source, ek) : typeLabel(primary.type),
          primary,
          items: list,
          others: forum ? asc.filter((x) => x !== primary) : list.filter((x) => x !== primary),
          sessionId: primary.sessionId ?? list.map((x) => x.sessionId).find((x): x is string => Boolean(x)) ?? null,
          rawUrl: safeUrl(primary.rawUrl) ?? list.map((x) => safeUrl(x.rawUrl)).find((x): x is string => Boolean(x)) ?? null,
          unread: list.filter((x) => x.status === 'unread').length,
          latestAt: Math.max(...list.map((x) => Math.max(timeOf(x.createdAt), timeOf(x.occurredAt)))),
          root,
          kind,
          forum,
          commentNo,
        };
      }).sort((a, b) => b.latestAt - a.latestAt);
    }

    const COMMENT_URL_RE = /#(?:issuecomment-|discussion_r|pullrequestreview-|commitcomment-)/i;
    const ROOT_URL_RE = /\/(?:issues|pull)\/\d+\/?$/i;
    const COMMENT_TYPE_RE = /comment|pinned\.activity|reaction/i;
    const ROOT_TYPE_RE = /(?:^|[.:])(?:issues?|pr|pull_request)(?:\.(?:updated|opened|edited|reopened|synchronize|closed))?$/i;
    const PR_TYPE_RE = /(?:^|[._:-])(?:pr|pull|pull_request)(?:[._:-]|$)/i;

    function roleOf(it: InboxView): PostRole {
      const u = (it.rawUrl || '').trim().replace(/\?[^#]*/, '');
      const t = (it.type || '').trim();
      if (COMMENT_URL_RE.test(u) || COMMENT_TYPE_RE.test(t)) return 'comment';
      if (ROOT_URL_RE.test(u) || ROOT_TYPE_RE.test(t)) return 'root';
      return 'other';
    }

    function kindOf(it: InboxView): PostKind {
      const u = it.rawUrl || '';
      const t = it.type || '';
      if (/\/pull\/\d+/i.test(u) || PR_TYPE_RE.test(t) || /pull_request/i.test(t)) return 'PR';
      if (/\/issues\/\d+/i.test(u) || /issue/i.test(t) || sourceMeta(it.source).key === 'github') return 'Issue';
      return null;
    }

    function occurredOf(it: InboxView): number {
      return timeOf(it.occurredAt) || timeOf(it.createdAt);
    }

    function threadKind(list: InboxView[], root: InboxView | null): PostKind {
      if (root) return kindOf(root);
      if (list.some((x) => kindOf(x) === 'PR')) return 'PR';
      return list.map(kindOf).find((k) => k !== null) ?? null;
    }

    function floorOf(t: InboxThread, it: InboxView): FloorInfo {
      if (!t.forum) return { label: '', tone: 'other', verb: '原文于' };
      const kind = t.kind ?? 'Issue';
      const role = roleOf(it);
      if (it === t.root) return { label: `${kind} 主楼`, tone: 'root', verb: `${kind} 于` };
      if (role === 'root') return { label: '主楼旧快照', tone: 'old', verb: `${kind} 于` };
      if (role === 'comment') {
        const no = t.commentNo[it.id];
        return { label: no ? `评论 ${no}` : '评论', tone: 'comment', verb: '评论于' };
      }
      return { label: typeLabel(it.type) || '后续动态', tone: 'other', verb: '原文于' };
    }

    function foldText(t: InboxThread, open: boolean): string {
      const n = t.others.length;
      if (!t.forum) return open ? '收起历史动态 ▴' : `展开 ${n} 条历史动态 ▾`;
      const allComments = t.others.every((x) => roleOf(x) === 'comment');
      if (open) return allComments ? '收起评论 ▴' : '收起后续动态 ▴';
      return allComments ? `展开 ${n} 条评论 ▾` : `展开 ${n} 条后续动态 ▾`;
    }

    function pad2(n: number): string {
      return String(n).padStart(2, '0');
    }

    function fmtAbs(iso: string): string {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function fmtFull(iso: string): string {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    function clickSidebarLabel(label: string): boolean {
      if (typeof document === 'undefined') return false;
      const nodes = document.querySelectorAll('button, [role="button"], a');
      for (const node of Array.from(nodes)) {
        const text = (node.textContent || '').trim();
        if (text === label || text.includes(label)) {
          (node as HTMLElement).click();
          return true;
        }
      }
      return false;
    }

    const PANEL_CSS = [
      '.dw-root{--bg:#f6f7f5;--card:#fff;--line:#e3e8e5;--line2:#eef1ef;--ink:#1c2621;--ink2:#4b5952;--ink3:#87948d;--brand:#1f6f50;--brand-soft:#e8f3ee;--amber:#9a5b00;--amber-soft:#fff5e3;--amber-line:#f1d39f;--blue:#2459a8;height:100%;overflow:auto;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}',
      '.dw-root *{box-sizing:border-box}',
      '.dw-wrap{max-width:980px;margin:0 auto;padding:20px 24px 64px}',
      '.dw-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:12px}',
      '.dw-head h1{margin:0;font-size:18px;font-weight:650;line-height:1.3}',
      '.dw-sub{margin:4px 0 0;color:var(--ink3);font-size:12.5px}',
      '.dw-tabs{display:flex;gap:2px;flex-wrap:wrap;margin-bottom:16px;border-bottom:1px solid var(--line)}',
      '.dw-root .dw-tab{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--ink2);padding:9px 14px;margin-bottom:-1px;cursor:pointer;font:inherit}',
      '.dw-root .dw-tab:hover{color:var(--ink);background:none}',
      '.dw-root .dw-tab.active{color:var(--brand);border-bottom-color:var(--brand);font-weight:600}',
      '.dw-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 2px rgba(16,24,20,.03);position:relative}',
      '.dw-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dw-space{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dw-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}',
      '.dw-wide{grid-column:1/-1}',
      '.dw-root input,.dw-root select,.dw-root textarea,.dw-root button{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:6px 12px;background:#fff;color:var(--ink);outline:none}',
      '.dw-root input:focus,.dw-root select:focus,.dw-root textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(31,111,80,.12)}',
      '.dw-root textarea{width:100%;min-height:76px;resize:vertical}',
      '.dw-root button{cursor:pointer;transition:background .12s,border-color .12s}.dw-root button:hover{border-color:#c6d0ca;background:#fafbfa}.dw-root button:disabled{opacity:.5;cursor:default}',
      '.dw-root .dw-primary{background:var(--brand);border-color:var(--brand);color:#fff}',
      '.dw-root .dw-primary:hover{background:#185c42;border-color:#185c42}',
      '.dw-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;background:var(--brand-soft);color:var(--brand);white-space:nowrap}',
      '.dw-badge.warn{background:var(--amber-soft);color:var(--amber);font-weight:600}',
      '.dw-badge.muted{background:#f1f3f2;color:var(--ink3)}',
      '.dw-error{color:#b42318;background:#fdecea;border-radius:8px;padding:8px 12px;margin:8px 0}.dw-notice{color:var(--brand);margin:8px 0}',
      '.dw-pre{white-space:pre-wrap;margin:8px 0;font-family:inherit;background:#f7f9f8;border:1px solid var(--line2);padding:10px 12px;border-radius:8px}',
      '.dw-list-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 0;border-top:1px solid var(--line2)}',
      '.dw-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer}',
      '.dw-toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:8px;position:sticky;top:0;z-index:2;background:var(--bg);padding:6px 0}',
      '.dw-caps{display:inline-flex;gap:6px;flex-wrap:wrap}',
      '.dw-root .dw-cap{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 12px;font-size:12.5px;color:var(--ink2)}',
      '.dw-root .dw-cap.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}',
      '.dw-cap-n{font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}',
      '.dw-root .dw-search{flex:1 1 200px;max-width:280px}',
      '.dw-hint{font-size:12px;color:var(--ink3);margin:0 0 10px}',
      '.dw-empty{padding:28px 16px;text-align:center;color:var(--ink3);font-size:13px;background:var(--card);border:1px dashed var(--line);border-radius:12px}',
      '.dw-thread.unread:before{content:"";position:absolute;left:-1px;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--brand)}',
      '.dw-thread.open{border-color:#cfe0d7}',
      '.dw-th-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px 12px;flex-wrap:wrap}',
      '.dw-th-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.dw-src{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:600;background:#64748b;color:#fff;flex:none}',
      '.dw-src.s-github{background:#24292f}.dw-src.s-wechat{background:#07a35a}.dw-src.s-memo{background:#b7791f}',
      '.dw-th-name{font-weight:600;word-break:break-word}',
      '.dw-type{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;background:#eaf1fb;color:var(--blue);white-space:nowrap}',
      '.dw-actor{color:var(--ink2);font-size:13px}',
      '.dw-time{color:var(--ink3);font-size:12px;white-space:nowrap}',
      '.dw-root .dw-count{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;border-color:#cfe0d7;background:var(--brand-soft);color:var(--brand);font-size:12px;font-weight:600;white-space:nowrap}',
      '.dw-root .dw-count:hover{border-color:var(--brand);background:var(--brand-soft)}',
      '.dw-root .dw-count.on{background:var(--brand);border-color:var(--brand);color:#fff}',
      '.dw-th-sum{margin-top:6px;color:var(--ink);font-size:13.5px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dw-th-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.dw-link{font-size:13px;color:var(--blue);text-decoration:none;padding:4px 6px;border-radius:6px}',
      '.dw-link:hover{background:#eaf1fb}',
      '.dw-root .dw-btn-sm{font-size:12px;padding:3px 9px;border-radius:6px}',
      '.dw-tl{list-style:none;margin:12px 0 0;padding:8px 0 0 16px;position:relative;border-top:1px dashed var(--line)}',
      '.dw-tl:before{content:"";position:absolute;left:5px;top:18px;bottom:10px;width:2px;border-radius:1px;background:var(--line)}',
      '.dw-tl-item{position:relative;padding:6px 10px 8px 12px;margin:0 0 4px;border-radius:8px}',
      '.dw-tl-item:before{content:"";position:absolute;left:-15px;top:12px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #9fcdb6;box-sizing:border-box}',
      '.dw-tl-item:hover{background:#fafbfa}',
      '.dw-tl-item.hit{background:var(--amber-soft);box-shadow:inset 0 0 0 1px var(--amber-line)}',
      '.dw-tl-head{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;font-size:12.5px}',
      '.dw-tl-sum{margin-top:2px;font-size:13px;color:var(--ink2);line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dw-tl-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}',
      '.dw-meta{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;margin-top:6px;font-size:12px}',
      '.dw-floor{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:600;letter-spacing:.2px;border:1px solid var(--line);background:#fff;color:var(--ink2);white-space:nowrap}',
      '.dw-floor.f-root{border-color:#b9dccb;background:#f2f9f5;color:var(--brand)}',
      '.dw-floor.f-old{border-style:dashed;color:var(--ink3)}',
      '.dw-floor.f-other{border-color:var(--line2);background:#f6f8f7;color:var(--ink3)}',
      '.dw-times{display:inline-flex;align-items:stretch;height:20px;border:1px solid var(--line);border-radius:999px;overflow:hidden;font-size:11.5px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums;background:#fff}',
      '.dw-tm{display:inline-flex;align-items:center;gap:5px;padding:0 9px;cursor:default}',
      '.dw-tm.src{color:var(--ink);font-weight:500}',
      '.dw-tm.src:before{content:"";width:6px;height:6px;border-radius:50%;background:#24292f;opacity:.5}',
      '.dw-tm.ana{color:var(--ink3);background:#f6f8f7}',
      '.dw-tm.src+.dw-tm.ana{border-left:1px solid var(--line)}',
      '.dw-root .dw-tl-toggle{border:0;background:none;padding:2px 0;margin-top:10px;font-size:12.5px;color:var(--ink2);font-weight:600;display:inline-flex;align-items:center;gap:8px}',
      '.dw-root .dw-tl-toggle:hover{color:var(--brand);background:none}',
      '.dw-tl-item.root{background:#f7fbf9;box-shadow:inset 0 0 0 1px #d6e9df}',
      '.dw-tl-item.root:before{border-color:var(--brand);background:var(--brand)}',
      '@media (max-width:640px){.dw-wrap{padding:16px 14px 48px}.dw-grid{grid-template-columns:1fr}.dw-root .dw-search{max-width:none}}',
    ].join('');

    async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
      const headers = {
        'Content-Type': 'application/json',
        ...((options.headers as Record<string, string> | undefined) ?? {}),
      };
      const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
      const data = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
      return data;
    }

    function formatTime(iso: string | null | undefined): string {
      if (!iso) return '未安排';
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString('zh-CN', { hour12: false });
    }

    function WatcherIcon({ size = 18 }: { size?: number }): ReactNodeLike {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        h('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }),
        h('circle', { cx: 12, cy: 12, r: 3 }),
      );
    }

    function MemoTab({ memos, onRefresh }: { memos: MemoView[]; onRefresh: () => Promise<void> }): ReactNodeLike {
      const [kind, setKind] = useState<MemoView['kind']>('time_nudge');
      const [title, setTitle] = useState('');
      const [basis, setBasis] = useState('');
      const [roomKey, setRoomKey] = useState('');
      const [nextCheckAt, setNextCheckAt] = useState('');
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');
      const [showHistory, setShowHistory] = useState(false);

      const createMemo = async (): Promise<void> => {
        if (!basis.trim()) return;
        setBusy(true);
        setMsg('');
        try {
          await api('/local-hub/memos', {
            method: 'POST',
            body: JSON.stringify({
              kind,
              title: title.trim() || undefined,
              basis: basis.trim(),
              roomKey: roomKey.trim() || undefined,
              nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : undefined,
            }),
          });
          setTitle('');
          setBasis('');
          setNextCheckAt('');
          setMsg('便签已新建。');
          await onRefresh();
        } catch (err) {
          setMsg(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      const act = async (id: string, action: 'check' | 'cancel'): Promise<void> => {
        setBusy(true);
        setMsg('');
        try {
          await api(`/local-hub/memos/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
          setMsg(action === 'check' ? '已触发立即检查。' : '便签已撕掉。');
          await onRefresh();
        } catch (err) {
          setMsg(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      const activeMemos = memos.filter((m) => m.status === 'active');
      const historyMemos = memos.filter((m) => m.status !== 'active');

      const renderMemoCard = (m: MemoView): ReactNodeLike => {
        const st = formatMemoStatus(m.status);
        const summaryText = formatMemoResultSummary(m.resultSummary);
        const timeMeta =
          m.status === 'active'
            ? `下次检查：${formatTime(m.nextCheckAt)}`
            : `最后检查：${formatTime(m.lastCheckedAt)}`;
        return h(
          'article',
          { key: m.id, className: `dw-card dw-memo-card ${m.status === 'active' ? 'active' : 'history'}` },
          h(
            'div',
            { className: 'dw-space' },
            h('strong', null, `${MEMO_KIND_LABELS[m.kind] || m.kind} · ${m.title || m.id}`),
            h('span', { className: `dw-badge ${st.tone}`.trim() }, st.label),
          ),
          h('p', { style: { margin: '6px 0' } }, m.basis),
          h('div', { className: 'dw-sub' }, `${timeMeta} · 房间：${m.roomKey}`),
          summaryText && h('div', { className: 'dw-pre' }, summaryText),
          h(
            'div',
            { className: 'dw-row', style: { marginTop: 10 } },
            m.status === 'active' && h('button', { disabled: busy, onClick: () => act(m.id, 'check') }, '立即查'),
            m.status === 'active' && h('button', { disabled: busy, onClick: () => act(m.id, 'cancel') }, '撕掉'),
            m.targetSessionId && h('button', { onClick: () => openSession(m.targetSessionId!) }, '打开会话'),
          ),
        );
      };

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dw-card' },
          h('strong', null, '新建便签'),
          h(
            'div',
            { className: 'dw-grid' },
            h(
              'select',
              { value: kind, onChange: (e: ChangeEventLike) => setKind(e.target.value as MemoView['kind']) },
              h('option', { value: 'time_nudge' }, '时间惦记'),
              h('option', { value: 'news_followup' }, '新闻后续'),
              h('option', { value: 'long_watch' }, '长期蹲官宣'),
            ),
            h('input', { value: title, placeholder: '标题（可选）', onChange: (e: ChangeEventLike) => setTitle(e.target.value) }),
            h('input', { value: roomKey, placeholder: '关联房间/会话键（可选）', onChange: (e: ChangeEventLike) => setRoomKey(e.target.value) }),
            h('input', { type: 'datetime-local', value: nextCheckAt, onChange: (e: ChangeEventLike) => setNextCheckAt(e.target.value) }),
            h('textarea', { className: 'dw-wide', value: basis, placeholder: '写下要惦记的事、验收标准或跟进背景', onChange: (e: ChangeEventLike) => setBasis(e.target.value) }),
          ),
          h(
            'div',
            { className: 'dw-row', style: { marginTop: 10 } },
            h('button', { className: 'dw-primary', disabled: busy || !basis.trim(), onClick: createMemo }, '新建'),
            msg && h('span', { className: 'dw-notice' }, msg),
          ),
        ),
        memos.length === 0
          ? h('div', { className: 'dw-card dw-sub' }, '还没有便签。')
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dw-space', style: { margin: '12px 0 8px' } },
                h('strong', null, `进行中便签（${activeMemos.length}）`),
                historyMemos.length > 0 &&
                  h(
                    'button',
                    {
                      className: 'dw-btn-sm dw-memo-history-toggle',
                      onClick: () => setShowHistory((v) => !v),
                    },
                    showHistory
                      ? `收起历史便签（${historyMemos.length}） ▴`
                      : `展开 ${historyMemos.length} 条历史便签（已触发 / 已撕掉 / 已过期） ▾`,
                  ),
              ),
              activeMemos.length === 0
                ? h('div', { className: 'dw-card dw-sub' }, '当前没有进行中的便签。')
                : activeMemos.map(renderMemoCard),
              showHistory && historyMemos.length > 0 && h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dw-sub', style: { margin: '14px 0 8px', fontWeight: 600 } },
                  `历史便签（${historyMemos.length}）`,
                ),
                historyMemos.map(renderMemoCard),
              ),
            ),
      );
    }

    function ConnectorsTab({
      connectors,
      sources,
      sinks,
      subscriptions,
      onRefresh,
    }: {
      connectors: ConnectorView[];
      sources: StatusView['sources'];
      sinks: NonNullable<StatusView['sinks']>;
      subscriptions: SubscriptionView[];
      onRefresh: () => Promise<void>;
    }): ReactNodeLike {
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');

      const jumpToPanel = (label: string): void => {
        const ok = clickSidebarLabel(label);
        setMsg(ok ? `已跳转至「${label}」面板。` : `未在侧栏找到「${label}」，请确认对应插件已启用。`);
      };

      const removeSub = async (source: string, threadKey: string): Promise<void> => {
        setBusy(true);
        setMsg('');
        try {
          await api(
            `/local-hub/subscriptions?source=${encodeURIComponent(source)}&threadKey=${encodeURIComponent(threadKey)}`,
            { method: 'DELETE' },
          );
          setMsg(`已移除订阅 ${source}:${threadKey}。`);
          await onRefresh();
        } catch (err) {
          setMsg(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dw-card' },
          h('strong', null, '快捷跳转已安装模块'),
          h(
            'div',
            { className: 'dw-row', style: { marginTop: 10 } },
            h('button', { className: 'dw-primary', onClick: () => jumpToPanel('GitHub') }, '打开 GitHub'),
            h('button', { className: 'dw-primary', onClick: () => jumpToPanel('微信消息') }, '打开 微信消息'),
            h('button', { className: 'dw-primary', onClick: () => jumpToPanel('性格衣柜') }, '打开 性格衣柜'),
          ),
          msg && h('div', { className: 'dw-notice' }, msg),
        ),
        h(
          'div',
          { className: 'dw-card' },
          h('strong', null, `已注册连接器 / 触发器（${connectors.length}）`),
          connectors.length === 0
            ? h('div', { className: 'dw-sub', style: { marginTop: 6 } }, '暂无外部插件注册到 Hub 连接器列表。')
            : connectors.map((c) =>
                h(
                  'div',
                  { key: c.id, className: 'dw-list-row' },
                  h('strong', null, c.label || c.id),
                  h('span', { className: 'dw-badge' }, c.kind),
                  c.health &&
                    h(
                      'span',
                      { className: `dw-badge ${c.health.ok ? '' : 'warn'}` },
                      c.health.ok ? '正常' : c.health.detail || '异常',
                    ),
                  c.panelLabel && h('button', { onClick: () => jumpToPanel(c.panelLabel!) }, `打开 ${c.panelLabel}`),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dw-card' },
          h('strong', null, `数据源 (${sources.length}) · 出站通道 (${sinks.length})`),
          h(
            'div',
            { className: 'dw-row', style: { marginTop: 8 } },
            sources.length === 0
              ? h('span', { className: 'dw-sub' }, '无数据源')
              : sources.map((s) => h('span', { key: `src-${s.id}`, className: 'dw-badge' }, `Source: ${s.label || s.id}`)),
            sinks.map((s) => h('span', { key: `sink-${s.id}`, className: 'dw-badge warn' }, `Sink: ${s.label || s.id} (${s.kind})`)),
          ),
        ),
        h(
          'div',
          { className: 'dw-card' },
          h('strong', null, `快车道订阅绑定（${subscriptions.length}）`),
          subscriptions.length === 0
            ? h('div', { className: 'dw-sub', style: { marginTop: 6 } }, '暂无活跃的线程订阅。')
            : subscriptions.map((sub) =>
                h(
                  'div',
                  { key: sub.id, className: 'dw-list-row' },
                  h('strong', null, `${sub.source}:${sub.threadKey}`),
                  h('span', { className: 'dw-badge' }, sub.status),
                  h('span', { className: 'dw-sub' }, `会话 ${sub.sessionId} · 归属 ${sub.owner}`),
                  h('button', { onClick: () => openSession(sub.sessionId) }, '打开会话'),
                  h(
                    'button',
                    { disabled: busy, onClick: () => void removeSub(sub.source, sub.threadKey) },
                    '移除订阅',
                  ),
                ),
              ),
        ),
      );
    }

    type HubTabId = 'inbox' | 'memos' | 'drafts' | 'connectors';

    function normalizeTabId(raw: string | undefined): HubTabId | null {
      if (raw === 'inbox' || raw === 'memos' || raw === 'drafts' || raw === 'connectors') return raw;
      if (raw === 'personas' || raw === 'github') return 'connectors';
      return null;
    }

    function HubPanel(): ReactNodeLike {
      const readPendingTab = (): HubTabId => {
        const w = window as unknown as { __dshHubPendingTab?: string; __dshWatcherPendingTab?: string };
        const pending = normalizeTabId(w.__dshHubPendingTab ?? w.__dshWatcherPendingTab);
        delete w.__dshHubPendingTab;
        delete w.__dshWatcherPendingTab;
        return pending ?? 'inbox';
      };
      const [tab, setTab] = useState<HubTabId>(readPendingTab);
      const [status, setStatus] = useState<StatusView | null>(null);
      const [inbox, setInbox] = useState<InboxView[]>([]);
      const [memos, setMemos] = useState<MemoView[]>([]);
      const [drafts, setDrafts] = useState<DraftView[]>([]);
      const [connectors, setConnectors] = useState<ConnectorView[]>([]);
      const [subscriptions, setSubscriptions] = useState<SubscriptionView[]>([]);
      const [inboxQuery, setInboxQuery] = useState('');
      const [inboxSource, setInboxSource] = useState('');
      const [inboxOpen, setInboxOpen] = useState<Record<string, boolean>>({});
      const [error, setError] = useState('');

      useEffect(() => {
        const onOpenTab = (ev: Event): void => {
          const next = normalizeTabId((ev as CustomEvent<string>).detail);
          if (next) {
            const w = window as unknown as { __dshHubPendingTab?: string; __dshWatcherPendingTab?: string };
            delete w.__dshHubPendingTab;
            delete w.__dshWatcherPendingTab;
            setTab(next);
          }
        };
        window.addEventListener('dsh-hub:open-tab', onOpenTab);
        window.addEventListener('dsh-watcher:open-tab', onOpenTab);
        return () => {
          window.removeEventListener('dsh-hub:open-tab', onOpenTab);
          window.removeEventListener('dsh-watcher:open-tab', onOpenTab);
        };
      }, []);

      const reload = useCallback(async () => {
        try {
          const inboxPath = '/local-hub/inbox?limit=200';
          const [st, ib, mm, dr, cn, sb] = await Promise.all([
            api<StatusView>('/local-hub/status'),
            api<{ items: InboxView[] }>(inboxPath),
            api<{ memos: MemoView[] }>('/local-hub/memos'),
            api<{ drafts: DraftView[] }>('/local-hub/drafts'),
            api<{ connectors: ConnectorView[] }>('/local-hub/connectors'),
            api<{ subscriptions: SubscriptionView[] }>('/local-hub/subscriptions'),
          ]);
          setStatus(st);
          setInbox(ib.items || []);
          setMemos(mm.memos || []);
          setDrafts(dr.drafts || []);
          setConnectors(cn.connectors || st.connectors || []);
          setSubscriptions(sb.subscriptions || []);
          setError('');
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      useEffect(() => {
        void reload();
        const timer = setInterval(() => {
          void reload();
        }, 6000);
        return () => clearInterval(timer);
      }, [reload]);

      const handleDraft = async (id: string, action: 'approve' | 'discard'): Promise<void> => {
        try {
          await api(`/local-hub/drafts/${encodeURIComponent(id)}/${action}`, {
            method: 'POST',
            body: action === 'discard' ? JSON.stringify({ reason: 'discarded_in_ui' }) : '{}',
          });
          await reload();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      };

      const now = Date.now();
      const iq = inboxQuery.trim().toLowerCase();
      const inboxThreads = buildInboxThreads(inbox);
      const itemMatches = (it: InboxView): boolean => !iq || [it.summary, it.type, typeLabel(it.type), it.actor ? `@${it.actor}` : '', it.entityKey ?? '', it.entityKey ? cleanThreadTitle(it.source, it.entityKey) : '', sourceMeta(it.source).label, it.source].join('\n').toLowerCase().includes(iq);
      const queryThreads = iq ? inboxThreads.filter((t) => t.items.some(itemMatches)) : inboxThreads;
      const sourceCaps: Array<{ key: string; label: string; count: number }> = [];
      for (const t of queryThreads) {
        const cap = sourceCaps.find((c) => c.key === t.sourceKey);
        if (cap) cap.count += 1;
        else sourceCaps.push({ key: t.sourceKey, label: t.sourceLabel, count: 1 });
      }
      const shownThreads = inboxSource ? queryThreads.filter((t) => t.sourceKey === inboxSource) : queryThreads;
      const threadOpen = (t: InboxThread): boolean => {
        const v = inboxOpen[t.key];
        return v === undefined ? Boolean(iq) && t.others.some(itemMatches) : v;
      };
      const setThreadOpen = (key: string, value: boolean): void => setInboxOpen((prev) => ({ ...prev, [key]: value }));

      const itemActions = (it: InboxView, small: boolean): ReactNodeLike[] => {
        const out: ReactNodeLike[] = [];
        const raw = safeUrl(it.rawUrl);
        if (it.sessionId) {
          const sid = it.sessionId;
          out.push(h('button', { key: 'open', className: small ? 'dw-btn-sm' : '', onClick: () => openSession(sid) }, '打开 DSH 会话'));
        }
        if (raw) out.push(h('a', { key: 'raw', className: 'dw-link', href: raw, target: '_blank', rel: 'noopener noreferrer' }, '查看原文 ↗'));
        return out;
      };

      const statusBadges = (it: InboxView): ReactNodeLike[] => {
        const out: ReactNodeLike[] = [];
        if (it.tier) out.push(h('span', { key: 'tier', className: 'dw-badge muted' }, TIER_LABELS[it.tier] ?? it.tier));
        const v = it.verdict ? VERDICT_LABELS[it.verdict] : undefined;
        if (it.verdict) out.push(h('span', { key: 'vd', className: `dw-badge ${v?.warn ? 'warn' : ''}` }, v?.label ?? it.verdict));
        return out;
      };

      const timePair = (verb: string, occurred: string | null | undefined, stamp: string | null | undefined): ReactNodeLike =>
        h(
          'span',
          { className: 'dw-times' },
          occurred && timeOf(occurred) ? h('span', { key: 'src', className: 'dw-tm src', title: fmtFull(occurred) }, `${verb} ${fmtAbs(occurred)}`) : null,
          stamp ? h('span', { key: 'ana', className: 'dw-tm ana', title: fmtFull(stamp) }, `入箱于 ${fmtRelative(stamp, now)}`) : null,
        );

      const floorTag = (f: FloorInfo): ReactNodeLike | null => (f.label ? h('span', { key: 'floor', className: `dw-floor f-${f.tone}` }, f.label) : null);

      const renderInboxThread = (t: InboxThread): ReactNodeLike => {
        const it = t.primary;
        const open = threadOpen(t);
        const hits = iq ? t.others.filter(itemMatches).length : 0;
        const head = floorOf(t, it);
        return h(
          'article',
          { key: t.key, className: `dw-card dw-thread ${t.unread > 0 ? 'unread' : ''} ${open ? 'open' : ''}` },
          h(
            'div',
            { className: 'dw-th-head' },
            h(
              'div',
              { className: 'dw-th-title' },
              h('span', { className: `dw-src s-${t.sourceKey}` }, t.sourceLabel),
              h('span', { className: 'dw-th-name' }, t.title),
              h('span', { className: 'dw-type' }, typeLabel(it.type)),
            ),
            t.items.length > 1
              ? h(
                  'button',
                  { className: `dw-count ${open ? 'on' : ''}`, 'aria-expanded': open, onClick: () => setThreadOpen(t.key, !open) },
                  `${t.items.length} 条动态`,
                  hits > 0 && !open ? ` · ${hits} 条命中` : '',
                  open ? ' ▴' : ' ▾',
                )
              : null,
          ),
          h(
            'div',
            { className: 'dw-meta' },
            floorTag(head),
            it.actor ? h('span', { className: 'dw-actor' }, `@${it.actor}`) : null,
            timePair(head.verb, it.occurredAt, it.createdAt),
          ),
          h('div', { className: 'dw-th-sum' }, flattenText(it.summary)),
          h(
            'div',
            { className: 'dw-th-foot' },
            h('div', { className: 'dw-row' }, ...statusBadges(it)),
            h(
              'div',
              { className: 'dw-row' },
              t.sessionId ? h('button', { onClick: () => openSession(t.sessionId!) }, '打开 DSH 会话') : null,
              t.rawUrl ? h('a', { className: 'dw-link', href: t.rawUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看原文 ↗') : null,
            ),
          ),
          t.others.length > 0
            ? h('button', { className: 'dw-tl-toggle', 'aria-expanded': open, onClick: () => setThreadOpen(t.key, !open) }, foldText(t, open))
            : null,
          open && t.others.length > 0
            ? h(
                'ol',
                { className: 'dw-tl', 'aria-label': t.forum ? '主楼与评论楼层' : '同线程时间线' },
                ...t.others.map((x) => {
                  const f = floorOf(t, x);
                  return h(
                    'li',
                    { key: x.id, className: `dw-tl-item ${f.tone === 'old' ? 'root' : ''} ${iq && itemMatches(x) ? 'hit' : ''}` },
                    h(
                      'div',
                      { className: 'dw-tl-head' },
                      floorTag(f),
                      h('span', { className: 'dw-type' }, typeLabel(x.type)),
                      x.actor ? h('span', { className: 'dw-actor' }, `@${x.actor}`) : null,
                      timePair(f.verb, x.occurredAt, x.createdAt),
                      ...statusBadges(x),
                    ),
                    h('div', { className: 'dw-tl-sum' }, flattenText(x.summary)),
                    h('div', { className: 'dw-tl-acts' }, ...itemActions(x, true)),
                  );
                }),
              )
            : null,
        );
      };

      const renderInbox = (): ReactNodeLike =>
        h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dw-toolbar' },
            h(
              'div',
              { className: 'dw-caps', role: 'tablist', 'aria-label': '来源筛选' },
              h(
                'button',
                { key: 'all', role: 'tab', 'aria-selected': !inboxSource, className: `dw-cap ${!inboxSource ? 'on' : ''}`, onClick: () => setInboxSource('') },
                '全部',
                h('span', { className: 'dw-cap-n' }, String(queryThreads.length)),
              ),
              ...sourceCaps.map((c) =>
                h(
                  'button',
                  { key: c.key, role: 'tab', 'aria-selected': inboxSource === c.key, className: `dw-cap ${inboxSource === c.key ? 'on' : ''}`, onClick: () => setInboxSource(c.key) },
                  c.label,
                  h('span', { className: 'dw-cap-n' }, String(c.count)),
                ),
              ),
            ),
            h('input', {
              className: 'dw-search',
              type: 'search',
              value: inboxQuery,
              placeholder: '搜索仓库、摘要、@人…',
              'aria-label': '搜索收件箱',
              onChange: (e: ChangeEventLike) => setInboxQuery(e.target.value),
            }),
          ),
          inbox.length > 0
            ? h('div', { className: 'dw-hint' }, `${shownThreads.length} 个线程 · ${shownThreads.reduce((n, t) => n + t.items.length, 0)} 条动态 · 主楼在上，评论按发帖时间正序折叠在下`)
            : null,
          inbox.length === 0
            ? h('div', { className: 'dw-empty' }, '暂无收件箱消息。')
            : shownThreads.length === 0
              ? h('div', { className: 'dw-empty' }, iq ? `没有匹配「${inboxQuery.trim()}」的动态。` : '这个来源下暂时没有动态。')
              : h(React.Fragment, null, ...shownThreads.map(renderInboxThread)),
        );

      const tabs: Array<{ id: HubTabId; label: string }> = [
        { id: 'inbox', label: `收件箱 (${inboxThreads.length})` },
        { id: 'memos', label: `便签本 (${memos.filter((m) => m.status === 'active').length})` },
        { id: 'drafts', label: `草稿箱 (${drafts.filter((d) => d.status === 'pending_approval' || d.status === 'uncertain').length})` },
        { id: 'connectors', label: `已接入插件 (${connectors.length})` },
      ];

      return h(
        'section',
        { className: 'dw-root', 'aria-label': 'Hub 总控台' },
        h('style', null, PANEL_CSS),
        h(
          'div',
          { className: 'dw-wrap' },
          h(
            'header',
            { className: 'dw-head' },
            h(
              'div',
              null,
              h('h1', null, 'Hub 总控台'),
              h(
                'p',
                { className: 'dw-sub' },
                status
                  ? `连接器 ${connectors.length} · 活跃订阅 ${status.activeSubscriptions ?? subscriptions.length} · 活跃监听 ${status.activeWorkstreams} · 活跃便签 ${status.activeMemos ?? 0} · 未读 ${status.unreadInbox} · 待审草稿 ${status.pendingDrafts}`
                  : '正在读取状态…',
              ),
            ),
            h('button', { onClick: () => void reload() }, '刷新'),
          ),
          error && h('div', { className: 'dw-error', role: 'alert' }, error),
          h(
            'nav',
            { className: 'dw-tabs' },
            ...tabs.map((t) =>
              h('button', { key: t.id, className: `dw-tab ${tab === t.id ? 'active' : ''}`, onClick: () => setTab(t.id) }, t.label),
            ),
          ),
          tab === 'inbox' && renderInbox(),
          tab === 'memos' && h(MemoTab, { memos, onRefresh: reload }),
          tab === 'drafts' &&
            (drafts.length === 0
              ? h('div', { className: 'dw-card dw-sub' }, '草稿箱为空。')
              : h(
                  React.Fragment,
                  null,
                  ...drafts.map((d) =>
                    h(
                      'article',
                      { key: d.id, className: 'dw-card' },
                      h(
                        'div',
                        { className: 'dw-space' },
                        h('strong', null, `${d.sinkId} · ${d.action}`),
                        h(
                          'span',
                          { className: `dw-badge ${d.status === 'uncertain' ? 'warn' : ''}` },
                          DRAFT_STATUS_LABELS[d.status] || d.status,
                        ),
                      ),
                      h('pre', { className: 'dw-pre' }, d.previewText),
                      h(
                        'div',
                        { className: 'dw-row' },
                        d.status === 'pending_approval' &&
                          h('button', { className: 'dw-primary', onClick: () => void handleDraft(d.id, 'approve') }, '发送'),
                        (d.status === 'pending_approval' || d.status === 'uncertain') &&
                          h('button', { onClick: () => void handleDraft(d.id, 'discard') }, '丢弃'),
                        d.sessionId && h('button', { onClick: () => openSession(d.sessionId!) }, '打开会话'),
                      ),
                    ),
                  ),
                )),
          tab === 'connectors' &&
            h(ConnectorsTab, {
              connectors,
              sources: status?.sources || [],
              sinks: status?.sinks || [],
              subscriptions,
              onRefresh: reload,
            }),
        ),
      );
    }

    function SessionWatchBadge({ sessionId }: { sessionId?: string }): ReactNodeLike | null {
      const [watches, setWatches] = useState<WorkstreamView[]>([]);
      const [memos, setMemos] = useState<MemoView[]>([]);

      useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        const load = async (): Promise<void> => {
          try {
            const [ws, mm] = await Promise.all([
              api<{ workstreams: WorkstreamView[] }>(
                `/local-hub/workstreams?sessionId=${encodeURIComponent(sessionId)}&status=active`,
              ),
              api<{ memos: MemoView[] }>(
                `/local-hub/memos?sessionId=${encodeURIComponent(sessionId)}&status=active`,
              ),
            ]);
            if (!cancelled) {
              setWatches(ws.workstreams || []);
              setMemos(mm.memos || []);
            }
          } catch {
          }
        };
        void load();
        const timer = setInterval(() => {
          void load();
        }, 8000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);

      if (!watches.length && !memos.length) return null;
      const label = [
        watches.length > 0 ? `监听 ${watches.length}` : '',
        memos.length > 0 ? `便签 ${memos.length}` : '',
      ]
        .filter(Boolean)
        .join(' · ');

      return h(
        'button',
        {
          title: watches[0] ? `点击停止监听 ${watches[0].primaryEntityKey}` : '当前会话有活跃便签',
          style: { fontSize: 12, padding: '2px 8px', borderRadius: 12, border: '1px solid #cbd5e1', cursor: 'pointer' },
          onClick: async () => {
            if (watches[0]) {
              await api(`/local-hub/workstreams/${encodeURIComponent(watches[0].id)}/cancel`, {
                method: 'POST',
                body: '{}',
              });
              setWatches((prev) => prev.slice(1));
            }
          },
        },
        label,
      );
    }

    function SidebarWatchDot({ sessionId }: { sessionId?: string }): ReactNodeLike | null {
      const [count, setCount] = useState(0);

      useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        Promise.all([
          api<{ workstreams: WorkstreamView[] }>(
            `/local-hub/workstreams?sessionId=${encodeURIComponent(sessionId)}&status=active`,
          ),
          api<{ memos: MemoView[] }>(
            `/local-hub/memos?sessionId=${encodeURIComponent(sessionId)}&status=active`,
          ),
        ])
          .then(([ws, mm]) => {
            if (!cancelled) setCount((ws.workstreams || []).length + (mm.memos || []).length);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [sessionId]);

      if (!count) return null;
      return h('span', {
        title: `${count} 个活跃监听或便签`,
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: '#16a34a',
          marginRight: 6,
          flexShrink: 0,
        },
      });
    }

    const inject = ['slots', 'uiWorkspace'];
    function apply(ctx: SlotContext): void {
      openSession = (id: string) => ctx.uiWorkspace?.openSession?.(id);
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, HubPanel),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 13, label: () => 'Hub 总控台' }, WatcherIcon),
      );
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'dsh-hub-header-badge',
            inject: (props: string | { sessionId?: string; session?: { id?: string } } | undefined) => ({
              sessionId: typeof props === 'string' ? props : (props?.sessionId ?? props?.session?.id),
            }),
          },
          SessionWatchBadge,
        ),
      );
      ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register(
          {
            name: 'sidebar.session.row.leading',
            id: 'dsh-hub-sidebar-dot',
            inject: () => ({}),
          },
          SidebarWatchDot,
        ),
      );
    }

    return { inject, apply };
  },
  });
})();
