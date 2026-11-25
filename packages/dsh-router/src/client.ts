interface ReactNodeLike {
  readonly __brand?: 'react-node';
}

interface ReactRuntime {
  Fragment: unknown;
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactNodeLike;
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

interface RouterWindow {
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

type ActionLevel = 'ignore' | 'inform' | 'prepare' | 'act';
type Presence = 'auto' | 'present' | 'away';
type Channel = 'web' | 'wechat' | 'defer' | 'none';
type SlotKind = 'work' | 'off_hours' | 'weekend';
type TabId = 'decisions' | 'notifications' | 'policy' | 'stats';
type DecisionStatus = 'filtered' | 'notified' | 'deferred' | 'dispatched' | 'resolved' | 'restored';
type NotifStatus = 'delivered' | 'deferred' | 'failed' | 'read';
type DecisionFilter = 'all' | 'pending' | 'work' | 'inform' | 'ignored' | 'answered';
type NotifFilter = 'all' | 'unread' | 'deferred' | 'read';
type Tone = 'neutral' | 'muted' | 'green' | 'amber' | 'blue' | 'violet' | 'red';

interface PolicyView {
  enabled: boolean;
  timezone: string;
  workdays: number[];
  workStartHour: number;
  workEndHour: number;
  presenceMode: Presence;
  lastWebActiveAt: string | null;
  workHoursDest: Channel;
  offHoursDest: Channel;
  weekendDest: Channel;
  awayFallbackDest: Channel;
  wechatTarget: string;
  triageFilterEnabled: boolean;
  defaultMaxLevel: ActionLevel;
}

interface StatusView {
  ok: boolean;
  enabled: boolean;
  presenceMode: Presence;
  webActive: boolean;
  currentSlot: SlotKind;
  currentDestination: Channel;
  unreadNotifications: number;
  pendingDecisions: number;
  activeSubscriptions: number;
  policy: PolicyView;
}

interface DecisionView {
  id: string;
  source: string;
  threadKey: string;
  actor: string;
  level: ActionLevel;
  summary: string;
  reason: string;
  question: string | null;
  options: string[];
  recommendedIndex: number | null;
  answeredOption: string | null;
  status: DecisionStatus;
  destination: Channel;
  workerSessionId: string | null;
  subscriptionId: string | null;
  rawUrl: string | null;
  createdAt: string;
  eventType?: string | null;
  eventOccurredAt?: string | null;
  updatedAt?: string;
}

type PostRole = 'root' | 'comment' | 'other';
type PostKind = 'Issue' | 'PR' | null;

interface FloorInfo {
  label: string;
  tone: 'root' | 'comment' | 'pending' | 'old' | 'other';
  verb: string;
}

interface NotificationView {
  id: string;
  decisionId: string;
  channel: Channel;
  title: string;
  summary: string;
  reason: string;
  rawUrl: string | null;
  status: NotifStatus;
  dueAt?: string | null;
  createdAt: string;
}

interface PreviewView {
  destination: Channel;
  slot: SlotKind;
  present: boolean;
  reason: string;
  dueAt: string | null;
}

interface StatsView {
  days: number;
  totalEvents: number;
  notifiedCount: number;
  filteredCount: number;
  restoredCount: number;
  restoreRate: number;
  dispatchedWorkers: number;
  activeSubscriptions: number;
  answeredDecisions: number;
  recommendedPickedCount: number;
}

interface SubView {
  id: string;
  source: string;
  threadKey: string;
  sessionId: string;
  owner: string;
  status: string;
  updatedAt: string;
}

interface WechatTarget {
  id: string;
  title: string;
}

interface ChangeEv {
  target: { value: string; checked?: boolean };
}

interface Meta {
  label: string;
  tone: Tone;
}

interface MdBlock {
  kind: 'p' | 'ul' | 'ol' | 'h' | 'quote' | 'code';
  lines: string[];
  start: number;
}

interface SourceInfo {
  key: string;
  label: string;
}

interface DecisionThread {
  key: string;
  primary: DecisionView;
  items: DecisionView[];
  others: DecisionView[];
  latestAt: number;
  pending: boolean;
  root: DecisionView | null;
  kind: PostKind;
  forum: boolean;
  rootInFold: boolean;
  commentNo: Record<string, number>;
}

interface NotifThread {
  key: string;
  source: string;
  title: string;
  actor: string;
  primary: NotificationView;
  items: NotificationView[];
  others: NotificationView[];
  latestAt: number;
  unread: number;
}

void (() => {
  (window as unknown as RouterWindow).__ModuleLoader__?.load({
    id: '@local/dsh-router',
    factory: (require) => {
      const React = require('react') as ReactRuntime;
      const { createElement: h, useState, useEffect, useCallback, Fragment } = React;
      const PANEL_ID = 'dsh-router-panel';
      let openSession: (id: string) => void = () => {};

      const LEVEL_META: Record<ActionLevel, Meta> = {
        ignore: { label: '忽略', tone: 'muted' },
        inform: { label: '告知', tone: 'blue' },
        prepare: { label: '准备', tone: 'amber' },
        act: { label: '代办', tone: 'violet' },
      };
      const STATUS_META: Record<DecisionStatus, Meta> = {
        filtered: { label: '已过滤', tone: 'muted' },
        notified: { label: '已通知', tone: 'blue' },
        deferred: { label: '已延后', tone: 'amber' },
        dispatched: { label: 'Worker 处理中', tone: 'violet' },
        resolved: { label: '已完结', tone: 'green' },
        restored: { label: '已找回', tone: 'green' },
      };
      const NOTIF_META: Record<NotifStatus, Meta> = {
        delivered: { label: '未读', tone: 'amber' },
        deferred: { label: '延后', tone: 'violet' },
        failed: { label: '发送失败', tone: 'red' },
        read: { label: '已读', tone: 'muted' },
      };
      const PRESENCE_LABELS: Record<Presence, string> = { auto: '自动', present: '在电脑前', away: '已离开' };
      const DEST_LABELS: Record<Channel, string> = { web: '网页提醒', wechat: '微信转发', defer: '延后汇总', none: '静默' };
      const SLOT_LABELS: Record<SlotKind, string> = { work: '工作时段', off_hours: '下班时段', weekend: '周末' };
      const SOURCE_LABELS: Record<string, SourceInfo> = {
        github: { key: 'github', label: 'GitHub' },
        wechat: { key: 'wechat', label: '微信' },
        wxarc: { key: 'wechat', label: '微信' },
        weixin: { key: 'wechat', label: '微信' },
        wx: { key: 'wechat', label: '微信' },
        memo: { key: 'memo', label: '备忘' },
        tool: { key: 'other', label: '工具' },
      };
      const WEEKDAYS: Array<[number, string]> = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
      const REC_MARK = '[(（\\[【]\\s*(?:recommended|推荐)\\s*[)）\\]】]';
      const REC_HEAD = new RegExp(`^\\s*${REC_MARK}\\s*`, 'i');
      const REC_TAIL = new RegExp(`\\s*${REC_MARK}\\s*[。.]?\\s*$`, 'i');
      const REC_ANY = new RegExp(REC_MARK, 'i');
      const INLINE_SRC = '`([^`\\n]+)`|\\*\\*([^*\\n]+?)\\*\\*|__([^_\\n]+?)__|\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)|(https?:\\/\\/[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?\'"，。、）】])';

      const optsOf = (d: DecisionView): string[] => (Array.isArray(d.options) ? d.options : []);
      const isPending = (d: DecisionView): boolean => (optsOf(d).length > 0 && !d.answeredOption) || d.status === 'dispatched';
      const isAnswered = (d: DecisionView): boolean => Boolean(d.answeredOption) || d.status === 'resolved';
      const isIgnored = (d: DecisionView): boolean => d.status === 'filtered' || d.level === 'ignore';
      const isWork = (d: DecisionView): boolean => d.level === 'prepare' || d.level === 'act';
      const isRich = (d: DecisionView): boolean => isPending(d) || isWork(d) || optsOf(d).length > 0 || Boolean(d.answeredOption);
      const isUnread = (n: NotificationView): boolean => n.status === 'delivered' || n.status === 'failed';

      function cleanOption(opt: string): string {
        const stripped = opt.replace(REC_HEAD, '').replace(REC_TAIL, '').trim();
        return stripped || opt;
      }

      function resolveRec(d: DecisionView): number | null {
        const opts = optsOf(d);
        if (d.recommendedIndex !== null && d.recommendedIndex >= 0 && d.recommendedIndex < opts.length) return d.recommendedIndex;
        const idx = opts.findIndex((o) => REC_ANY.test(o));
        return idx >= 0 ? idx : null;
      }

      function sourceInfo(source: string): SourceInfo {
        const key = (source || '').trim().toLowerCase();
        return SOURCE_LABELS[key] ?? { key: 'other', label: source || '未知来源' };
      }

      function threadTitle(source: string, threadKey: string): string {
        let t = (threadKey || '').trim();
        const prefixes = [(source || '').trim().toLowerCase(), ...Object.keys(SOURCE_LABELS)].filter(Boolean);
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
        return t.replace(/^([^\s#]+?)\s*#(\d+)$/, '$1 #$2') || threadKey;
      }

      function timeOf(iso: string | null | undefined): number {
        const t = Date.parse(iso || '');
        return Number.isFinite(t) ? t : 0;
      }

      function threadKeyOf(source: string, threadKey: string, fallbackId: string): string {
        const info = sourceInfo(source);
        const src = info.key === 'other' ? (source || '').trim().toLowerCase() : info.key;
        const title = threadTitle(source, threadKey).toLowerCase().replace(/\s+/g, '');
        return title ? `${src}::${title}` : `id::${fallbackId}`;
      }

      function buildDecisionThreads(list: DecisionView[]): DecisionThread[] {
        const map = new Map<string, DecisionView[]>();
        const order: string[] = [];
        for (const d of list) {
          const key = threadKeyOf(d.source, d.threadKey, d.id);
          const bucket = map.get(key);
          if (bucket) bucket.push(d);
          else {
            map.set(key, [d]);
            order.push(key);
          }
        }
        return order.map((key) => {
          const items = [...(map.get(key) ?? [])].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
          const asc = [...items].sort((a, b) => occurredOf(a) - occurredOf(b) || timeOf(a.createdAt) - timeOf(b.createdAt));
          const root = [...asc].reverse().find((d) => roleOf(d) === 'root') ?? null;
          const kind = threadKind(items, root);
          const forum = kind !== null;
          const pick = root && isPending(root) ? root : items.find(isPending);
          const primary = pick ?? root ?? (forum ? asc[0] : items[0]);
          const rootInFold = Boolean(root && root !== primary);
          const rest = asc.filter((d) => d !== primary && d !== root);
          const others = forum ? (root && rootInFold ? [root, ...rest] : rest) : items.filter((d) => d !== primary);
          const commentNo: Record<string, number> = {};
          let n = 0;
          for (const d of asc) if (roleOf(d) === 'comment') commentNo[d.id] = ++n;
          const latestAt = Math.max(...items.map((d) => Math.max(timeOf(d.createdAt), timeOf(d.eventOccurredAt))));
          return { key, primary, items, others, latestAt, pending: items.some(isPending), root, kind, forum, rootInFold, commentNo };
        }).sort((a, b) => b.latestAt - a.latestAt);
      }

      const COMMENT_URL_RE = /#(?:issuecomment-|discussion_r|pullrequestreview-|commitcomment-)/i;
      const ROOT_URL_RE = /\/(?:issues|pull)\/\d+\/?$/i;
      const COMMENT_TYPE_RE = /comment|pinned\.activity|reaction/i;
      const ROOT_TYPE_RE = /(?:^|[.:])(?:issues?|pr|pull_request)(?:\.(?:updated|opened|edited|reopened|synchronize|closed))?$/i;
      const PR_TYPE_RE = /(?:^|[._:-])(?:pr|pull|pull_request)(?:[._:-]|$)/i;

      function postRole(url: string | null | undefined, type: string | null | undefined): PostRole {
        const u = (url || '').trim().replace(/\?[^#]*/, '');
        const t = (type || '').trim();
        if (COMMENT_URL_RE.test(u) || COMMENT_TYPE_RE.test(t)) return 'comment';
        if (ROOT_URL_RE.test(u) || ROOT_TYPE_RE.test(t)) return 'root';
        return 'other';
      }

      function postKind(url: string | null | undefined, type: string | null | undefined, source: string): PostKind {
        const u = url || '';
        const t = type || '';
        if (/\/pull\/\d+/i.test(u) || PR_TYPE_RE.test(t) || /pull_request/i.test(t)) return 'PR';
        if (/\/issues\/\d+/i.test(u) || /issue/i.test(t) || sourceInfo(source).key === 'github') return 'Issue';
        return null;
      }

      function roleOf(d: DecisionView): PostRole {
        return postRole(d.rawUrl, d.eventType);
      }

      function kindOf(d: DecisionView): PostKind {
        return postKind(d.rawUrl, d.eventType, d.source);
      }

      function occurredOf(d: DecisionView): number {
        return timeOf(d.eventOccurredAt) || timeOf(d.createdAt);
      }

      function analyzedAt(d: DecisionView): string {
        return d.updatedAt || d.createdAt;
      }

      function threadKind(items: DecisionView[], root: DecisionView | null): PostKind {
        if (root) return kindOf(root);
        if (items.some((d) => kindOf(d) === 'PR')) return 'PR';
        return items.map(kindOf).find((k) => k !== null) ?? null;
      }

      function floorOf(t: DecisionThread, d: DecisionView): FloorInfo {
        if (!t.forum) return { label: '', tone: 'other', verb: '原文于' };
        const kind = t.kind ?? 'Issue';
        const role = roleOf(d);
        const pendingTop = d === t.primary && t.rootInFold && isPending(d);
        if (d === t.root) return { label: `${kind} 主楼`, tone: 'root', verb: `${kind} 于` };
        if (role === 'root') return { label: '主楼旧快照', tone: 'old', verb: `${kind} 于` };
        if (role === 'comment') {
          const no = t.commentNo[d.id];
          const base = no ? `评论 ${no}` : '评论';
          return pendingTop ? { label: `评论待拍板 · ${base}`, tone: 'pending', verb: '评论于' } : { label: base, tone: 'comment', verb: '评论于' };
        }
        const label = d.eventType ? eventTypeLabel(d.eventType) : '后续动态';
        return pendingTop ? { label: `动态待拍板 · ${label}`, tone: 'pending', verb: '原文于' } : { label, tone: 'other', verb: '原文于' };
      }

      function foldText(t: DecisionThread, open: boolean, noun: string): string {
        const n = t.others.length;
        if (!t.forum) return open ? '收起同线程历史 ▴' : `展开 ${n} 条历史动态 ▾`;
        const rest = t.others.filter((d) => d !== t.root);
        const allComments = rest.every((d) => roleOf(d) === 'comment');
        if (t.rootInFold) {
          if (open) return `收起主楼与${allComments ? '评论' : '后续动态'} ▴`;
          return rest.length === 0 ? `展开查看 ${t.kind ?? 'Issue'} 主楼 ▾` : `展开主楼与 ${rest.length} 条${allComments ? noun : '后续动态'} ▾`;
        }
        if (open) return allComments ? `收起${noun} ▴` : '收起后续动态 ▴';
        return allComments ? `展开 ${n} 条${noun} ▾` : `展开 ${n} 条后续动态 ▾`;
      }

      const DEST_VERBS: Record<string, string> = { web: '在网页提醒你', wechat: '转发到微信', defer: '延后汇总', none: '静默不打扰' };
      const REASON_FIXED: Record<string, string> = {
        bot_self_filtered: '机器人或你自己触发的动态，已自动过滤',
        deterministic_default_inform: '规则判定：普通动态，告知即可',
        deterministic_urgent_inform: '规则判定：紧急动态，需要尽快告知你',
        deterministic_memo_inform: '规则判定：备忘提醒，到点告知你',
        deterministic_urgent_memo: '规则判定：紧急备忘，需要尽快告知你',
        llm_triage: '智能分诊已判定',
        urgent_never_ignore: '紧急事件不会被忽略，已提升为「告知」',
        wechat_unavailable_deferred: '微信暂时发不出去，已改为延后汇总',
        queued_behind_focus: '微信正在聊另一条任务，已排在队列后面',
        inform_web_only: '常规告知不推微信，已留档在网页提醒',
        worker_pending_report: '已派发后台处理，等查完再汇报',
        discarded_in_ui: '已在界面中丢弃',
        cancelled_by_ui: '已在界面中取消',
      };
      const CODE_WORDS: Record<string, string> = {
        urgent: '紧急', policy: '策略', defer: '延后', deferred: '已延后', filter: '过滤', filtered: '已过滤', inform: '告知', ignore: '忽略', ignored: '已忽略',
        prepare: '准备', act: '代办', web: '网页', wechat: '微信', away: '不在电脑前', present: '在电脑前', work: '工作', off: '下班', hours: '时段', weekend: '周末',
        fallback: '回退', capped: '封顶', untrusted: '不受信任', trusted: '受信任', bot: '机器人', self: '自身', llm: '模型', triage: '分诊', timeout: '超时',
        invalid: '无效', json: 'JSON', unavailable: '不可用', manual: '手动', restore: '找回', restored: '已找回', dispatch: '派发', dispatched: '已派发',
        worker: 'Worker', user: '用户', default: '默认', deterministic: '规则', memo: '备忘', override: '越过', duplicate: '重复', stale: '过期', obsolete: '已过时',
        error: '错误', failed: '失败', fail: '失败', open: '放行', skip: '跳过', skipped: '已跳过', rate: '频率', limit: '限制', limited: '受限', quiet: '免打扰',
        cancelled: '已取消', discarded: '已丢弃', ui: '界面', no: '无', not: '未', subscription: '订阅', noise: '噪音', low: '低', value: '价值',
        actionable: '需处理', notify: '通知', notified: '已通知', none: '静默', review: '审阅', mention: '提及', comment: '评论', new: '新',
      };
      const CODE_STOP = new Set(['by', 'in', 'the', 'to', 'of', 'for', 'a', 'an', 'and']);

      function eventTypeLabel(type: string): string {
        const t = (type || '').trim().toLowerCase();
        if (t.includes('review_requested')) return '有人请你审阅 PR';
        if (t.includes('mention')) return '有人 @ 了你';
        if (t.includes('pull_request_review_comment')) return 'PR 审阅评论';
        if (t.includes('issue_comment') || t.includes('issue.comment')) return 'Issue 新评论';
        if (t.includes('pr_comment') || t.includes('pr.comment')) return 'PR 新评论';
        if (t.includes('pull_request.opened')) return '新开 PR';
        if (t.includes('issues.opened')) return '新开 Issue';
        if (t.includes('pinned.activity')) return '盯防线程有新动态';
        if (t.includes('ready_for_review')) return 'PR 可以审阅了';
        if (t.includes('pr.updated')) return 'PR 有更新';
        if (t.includes('issue.updated')) return 'Issue 有更新';
        if (t.includes('labeled')) return '标签变更';
        if (t.includes('reaction')) return '表情回应';
        if (t.includes('long_watch')) return '长期蹲守命中';
        if (t.startsWith('memo')) return '备忘提醒';
        if (t.startsWith('wechat') || t.startsWith('wx')) return '微信消息';
        if (t.includes('comment')) return '新评论';
        return `「${type}」事件`;
      }

      function llmErrorText(err: string): string {
        const e = (err || '').trim();
        if (/invalid_json/i.test(e)) return '模型返回的不是有效 JSON';
        const tm = /timeout_(\d+)ms/i.exec(e);
        if (tm) return `模型 ${Math.max(1, Math.round(Number(tm[1]) / 1000))} 秒内未响应`;
        if (/timeout|timed out/i.test(e)) return '模型响应超时';
        if (/no_prepare_call|no_supported_method/i.test(e)) return '当前没有可调用的分诊模型';
        if (/fetch failed|network|econn|enotfound/i.test(e)) return '网络连接失败';
        if (/[\u4e00-\u9fa5]/.test(e)) return e;
        return '模型调用异常';
      }

      function levelWord(level: string): string {
        return LEVEL_META[level as ActionLevel]?.label ?? level;
      }

      function translateReasonCode(seg: string): string | null {
        const s = seg.trim();
        const low = s.toLowerCase();
        if (low === 'llm_fail_open' || low.startsWith('llm_fail_open:')) return `智能分诊暂不可用（${llmErrorText(s.slice(14))}），已按规则兜底`;
        if (!s.includes('_') || !/^[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)+$/i.test(s)) return null;
        if (REASON_FIXED[low]) return REASON_FIXED[low];
        let m = /^(work|off_hours|weekend)_(present|away)_policy_(web|wechat|defer|none)$/.exec(low);
        if (m) return `${SLOT_LABELS[m[1] as SlotKind]} · ${m[2] === 'present' ? '你在电脑前' : '你不在电脑前'}，按作息策略${DEST_VERBS[m[3]]}`;
        m = /^(work|off_hours|weekend)_away_fallback_(web|wechat|defer|none)$/.exec(low);
        if (m) return `${SLOT_LABELS[m[1] as SlotKind]} · 你不在电脑前，网页提醒改走离开时回退：${DEST_LABELS[m[2] as Channel]}`;
        m = /^urgent_override_(work|off_hours|weekend)_(web|wechat|defer|none)$/.exec(low);
        if (m) return `紧急事件：跳过${SLOT_LABELS[m[1] as SlotKind]}的延后/静默，直接${DEST_VERBS[m[2]]}`;
        m = /^capped_by_policy_(ignore|inform|prepare|act)$/.exec(low);
        if (m) return `受「默认最高级别」限制，最多做到「${levelWord(m[1])}」`;
        m = /^untrusted_capped_(ignore|inform|prepare|act)$/.exec(low);
        if (m) return `来源不在信任名单，最多只做到「${levelWord(m[1])}」`;
        const act = /^deterministic_actionable_(.+)$/i.exec(s);
        if (act) return `规则判定：${eventTypeLabel(act[1])}，需要你处理`;
        const words = low.split(/[_.:-]+/).filter((w) => w && !CODE_STOP.has(w));
        const mapped = words.map((w) => CODE_WORDS[w]);
        if (words.length > 0 && mapped.every(Boolean)) return `系统判定：${mapped.join('')}`;
        return `其他系统判定（${s}）`;
      }

      function humanizeReasonParts(raw: string | null | undefined): string[] {
        const text = (raw || '').trim();
        if (!text) return [];
        const prepared = text.replace(/\s*[(（]\s*([a-z][a-z0-9]*(?:_[a-z0-9.]+)+(?:\s*;\s*[a-z][a-z0-9]*(?:_[a-z0-9.]+)+)*)\s*[)）]/gi, (_all: string, inner: string) => `;${inner}`);
        const out: string[] = [];
        let natural: string[] = [];
        let changed = false;
        const flush = (): void => {
          const t = natural.join(';').trim();
          if (t && !out.includes(t)) out.push(t);
          natural = [];
        };
        for (const seg of prepared.split(';')) {
          const s = seg.trim();
          if (!s) continue;
          const zh = translateReasonCode(s);
          if (zh === null) {
            natural.push(s);
            continue;
          }
          changed = true;
          flush();
          if (!out.includes(zh)) out.push(zh);
        }
        flush();
        return changed ? out : [text];
      }

      function humanizeReason(raw: string | null | undefined): string {
        return humanizeReasonParts(raw).join('；');
      }

      function pad2(n: number): string {
        return String(n).padStart(2, '0');
      }

      function fmtAbs(iso: string | null | undefined): string {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      }

      function fmtFull(iso: string | null | undefined): string {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      }

      function fmtRelative(iso: string | null | undefined, now: number): string {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return iso;
        const diff = now - t;
        const future = diff < 0;
        const abs = Math.abs(diff);
        if (abs < 60000) return future ? '即将' : '刚刚';
        const min = Math.round(abs / 60000);
        if (min < 60) return future ? `${min} 分钟后` : `${min} 分钟前`;
        const hr = Math.round(min / 60);
        if (hr < 24) return future ? `${hr} 小时后` : `${hr} 小时前`;
        const day = Math.round(hr / 24);
        if (day < 7) return future ? `${day} 天后` : `${day} 天前`;
        return fmtAbs(iso);
      }

      function toLocalInput(d: Date): string {
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      }

      function pct(part: number, total: number): number {
        if (!total || total <= 0) return 0;
        return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
      }

      function shortUrl(url: string): string {
        const bare = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        return bare.length > 48 ? `${bare.slice(0, 45)}…` : bare;
      }

      function flatten(text: string): string {
        return (text || '').replace(/\r\n?/g, '\n').replace(/^\s*#{1,6}\s+/gm, '').replace(/\s*\n+\s*(?:[-*+•·]\s+|\d{1,3}[.)、]\s+)?/g, ' ').trim();
      }

      function splitWorkerChanges(text: string): string {
        const m = /^([\s\S]*?\S)\s*\(([^()]*;[^()]*)\)\s*$/.exec(text || '');
        if (!m) return text;
        const changes = m[2].split(/;\s*/).map((s) => s.trim()).filter(Boolean);
        if (changes.length < 2) return text;
        return `${m[1]}\n\n**改动**\n${changes.map((c) => `- ${c}`).join('\n')}`;
      }

      function closeBlock(blocks: MdBlock[], cur: MdBlock | null): null {
        if (cur && cur.lines.length > 0) blocks.push(cur);
        return null;
      }

      function parseBlocks(text: string): MdBlock[] {
        const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
        const blocks: MdBlock[] = [];
        let cur: MdBlock | null = null;
        let inCode = false;
        for (const raw of lines) {
          if (inCode && cur) {
            if (/^\s*```/.test(raw)) {
              inCode = false;
              cur = closeBlock(blocks, cur);
            } else {
              cur.lines.push(raw);
            }
            continue;
          }
          if (/^\s*```/.test(raw)) {
            cur = closeBlock(blocks, cur);
            cur = { kind: 'code', lines: [], start: 1 };
            inCode = true;
            continue;
          }
          const line = raw.replace(/\s+$/, '');
          if (!line.trim()) {
            cur = closeBlock(blocks, cur);
            continue;
          }
          const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
          if (heading) {
            cur = closeBlock(blocks, cur);
            blocks.push({ kind: 'h', lines: [heading[1]], start: 1 });
            continue;
          }
          const bullet = /^\s*[-*+•·]\s+(.+)$/.exec(line);
          if (bullet) {
            if (!cur || cur.kind !== 'ul') {
              cur = closeBlock(blocks, cur);
              cur = { kind: 'ul', lines: [], start: 1 };
            }
            cur.lines.push(bullet[1]);
            continue;
          }
          const ordered = /^\s*(\d{1,3})[.)、]\s+(.+)$/.exec(line);
          if (ordered) {
            if (!cur || cur.kind !== 'ol') {
              cur = closeBlock(blocks, cur);
              cur = { kind: 'ol', lines: [], start: Number(ordered[1]) || 1 };
            }
            cur.lines.push(ordered[2]);
            continue;
          }
          const quote = /^\s*>\s?(.*)$/.exec(line);
          if (quote) {
            if (!cur || cur.kind !== 'quote') {
              cur = closeBlock(blocks, cur);
              cur = { kind: 'quote', lines: [], start: 1 };
            }
            cur.lines.push(quote[1]);
            continue;
          }
          if (cur && (cur.kind === 'ul' || cur.kind === 'ol') && /^\s{2,}\S/.test(line)) {
            cur.lines[cur.lines.length - 1] += ` ${line.trim()}`;
            continue;
          }
          if (!cur || cur.kind !== 'p') {
            cur = closeBlock(blocks, cur);
            cur = { kind: 'p', lines: [], start: 1 };
          }
          cur.lines.push(line.trim());
        }
        closeBlock(blocks, cur);
        return blocks;
      }

      function safeUrl(url: string): string | null {
        return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
      }

      function renderInline(text: string, keyBase: string): unknown[] {
        const out: unknown[] = [];
        const re = new RegExp(INLINE_SRC, 'g');
        let last = 0;
        let i = 0;
        let m: RegExpExecArray | null = re.exec(text);
        while (m !== null) {
          if (m.index > last) out.push(text.slice(last, m.index));
          const k = `${keyBase}-${i++}`;
          if (m[1] !== undefined) {
            out.push(h('code', { key: k, className: 'dr-code' }, m[1]));
          } else if (m[2] !== undefined || m[3] !== undefined) {
            out.push(h('strong', { key: k }, ...renderInline(m[2] ?? m[3] ?? '', k)));
          } else if (m[4] !== undefined) {
            const url = safeUrl(m[5] ?? '');
            out.push(url ? h('a', { key: k, href: url, target: '_blank', rel: 'noopener noreferrer' }, m[4]) : m[4]);
          } else if (m[6] !== undefined) {
            out.push(h('a', { key: k, href: m[6], target: '_blank', rel: 'noopener noreferrer' }, shortUrl(m[6])));
          }
          last = re.lastIndex;
          m = re.exec(text);
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
      }

      function renderBlocks(blocks: MdBlock[], keyBase: string): unknown[] {
        return blocks.map((b, bi) => {
          const k = `${keyBase}-b${bi}`;
          if (b.kind === 'h') return h('div', { key: k, className: 'dr-md-h' }, ...renderInline(b.lines[0], k));
          if (b.kind === 'code') return h('pre', { key: k }, h('code', null, b.lines.join('\n')));
          if (b.kind === 'ul' || b.kind === 'ol') {
            return h(b.kind, { key: k, start: b.kind === 'ol' && b.start !== 1 ? b.start : undefined },
              ...b.lines.map((item, li) => h('li', { key: `${k}-${li}` }, ...renderInline(item, `${k}-${li}`))));
          }
          const parts: unknown[] = [];
          b.lines.forEach((ln, li) => {
            if (li > 0) parts.push(h('br', { key: `${k}-br${li}` }));
            parts.push(...renderInline(ln, `${k}-${li}`));
          });
          return h(b.kind === 'quote' ? 'blockquote' : 'p', { key: k }, ...parts);
        });
      }

      const CSS_BASE = [
        '.dr-root{--bg:#f6f7f5;--card:#fff;--line:#e3e8e5;--line2:#eef1ef;--ink:#1c2621;--ink2:#4b5952;--ink3:#87948d;--brand:#1f6f50;--brand-soft:#e8f3ee;--amber:#9a5b00;--amber-soft:#fff5e3;--amber-line:#f1d39f;--blue:#2459a8;--blue-soft:#eaf1fb;--violet:#6941c6;--violet-soft:#f2edfd;--red:#b42318;--red-soft:#fdecea;height:100%;overflow:auto;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}',
        '.dr-root *{box-sizing:border-box}',
        '.dr-wrap{max-width:980px;margin:0 auto;padding:20px 24px 64px}',
        '.dr-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}',
        '.dr-brand{display:flex;align-items:center;gap:12px}',
        '.dr-logo{width:36px;height:36px;border-radius:10px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}',
        '.dr-brand h1{margin:0;font-size:18px;font-weight:650;line-height:1.25}',
        '.dr-next{appearance:none;border:0;background:none;padding:0;font:inherit;font-size:13px;color:var(--ink2);text-align:left}',
        '.dr-next.hot{color:var(--amber);font-weight:600;cursor:pointer}',
        '.dr-next.off{color:var(--red);font-weight:600}',
        '.dr-top-right{display:flex;align-items:center;gap:8px}',
        '.dr-chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 14px}',
        '.dr-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card);font-size:12px;color:var(--ink3)}',
        '.dr-chip b{font-weight:600;color:var(--ink)}',
        '.dr-chip.warn{border-color:var(--amber-line);background:var(--amber-soft)}',
        '.dr-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:16px;overflow-x:auto}',
        '.dr-tab{appearance:none;border:0;background:none;padding:9px 14px;font:inherit;color:var(--ink2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
        '.dr-tab:hover{color:var(--ink)}',
        '.dr-tab.on{color:var(--brand);border-bottom-color:var(--brand);font-weight:600}',
        '.dr-tab-n{min-width:18px;height:18px;padding:0 6px;border-radius:9px;background:var(--line2);color:var(--ink2);font-size:11px;line-height:18px;text-align:center;font-weight:600}',
        '.dr-tab-n.hot{background:var(--amber);color:#fff}',
        '.dr-btn{appearance:none;font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none;line-height:1.4;white-space:nowrap;transition:background .12s,border-color .12s}',
        '.dr-btn:hover{border-color:#c6d0ca;background:#fafbfa}',
        '.dr-btn:disabled{opacity:.5;cursor:default}',
        '.dr-btn.pri{background:var(--brand);border-color:var(--brand);color:#fff}',
        '.dr-btn.pri:hover{background:#185c42}',
        '.dr-btn.ghost{background:transparent;border-color:transparent;color:var(--ink2)}',
        '.dr-btn.ghost:hover{background:var(--line2)}',
        '.dr-btn.sm{font-size:12px;padding:3px 9px;border-radius:6px}',
        '.dr-btn.danger:hover{color:var(--red);border-color:#f0b8b2;background:var(--red-soft)}',
        '.dr-switch{appearance:none;font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--card);border-radius:999px;padding:4px 12px 4px 4px;cursor:pointer;color:var(--ink2)}',
        '.dr-switch:disabled{opacity:.5;cursor:default}',
        '.dr-switch i,.dr-toggle i{width:32px;height:18px;border-radius:9px;background:#cdd5d0;position:relative;flex:none;transition:background .15s}',
        '.dr-switch i:after,.dr-toggle i:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}',
        '.dr-switch.on{color:var(--brand);font-weight:600}',
        '.dr-switch.on i,.dr-toggle input:checked+i{background:var(--brand)}',
        '.dr-switch.on i:after,.dr-toggle input:checked+i:after{left:16px}',
        '.dr-toggle{display:inline-flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--ink2);position:relative}',
        '.dr-toggle input{position:absolute;opacity:0;width:0;height:0;margin:0}',
        '.dr-toggle input:focus-visible+i{box-shadow:0 0 0 3px rgba(31,111,80,.2)}',
        '.dr-alert{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:13px}',
        '.dr-alert.err{background:var(--red-soft);color:var(--red)}',
        '.dr-alert.ok{background:var(--brand-soft);color:var(--brand)}',
        '.dr-x{appearance:none;border:0;background:none;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 4px;opacity:.7}',
        '.dr-sec{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:4px 0 10px;flex-wrap:wrap}',
        '.dr-sec h2{margin:0;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}',
        '.dr-sec-hint{font-size:12px;color:var(--ink3)}',
        '.dr-dot{width:8px;height:8px;border-radius:50%;background:#e39b17;box-shadow:0 0 0 3px var(--amber-soft)}',
        '.dr-focus{margin-bottom:20px}',
        '.dr-calm{display:flex;align-items:center;gap:8px;padding:11px 14px;border:1px dashed #cbe2d6;border-radius:12px;background:#f3faf6;color:var(--brand);font-size:13px;margin-bottom:18px}',
        '.dr-empty{padding:28px 16px;text-align:center;color:var(--ink3);font-size:13px;background:var(--card);border:1px dashed var(--line);border-radius:12px}',
      ].join('');

      const CSS_CARD = [
        '.dr-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,20,.03);position:relative}',
        '.dr-card.focus{border-color:var(--amber-line);box-shadow:0 0 0 3px rgba(241,211,159,.28),0 1px 2px rgba(16,24,20,.04)}',
        '.dr-card.focus:before,.dr-card.unread:before{content:"";position:absolute;left:-1px;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:#e39b17}',
        '.dr-card.unread:before{background:var(--brand)}',
        '.dr-dhead{display:flex;justify-content:space-between;align-items:flex-start;gap:8px 12px;flex-wrap:wrap}',
        '.dr-dtitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
        '.dr-src{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:600;background:#24292f;color:#fff;flex:none}',
        '.dr-src.s-wechat{background:#07a35a}.dr-src.s-memo{background:#b7791f}.dr-src.s-other{background:#64748b}',
        '.dr-thread{font-weight:600;color:var(--ink);word-break:break-word}',
        '.dr-actor{color:var(--ink2);font-size:13px}',
        '.dr-time{color:var(--ink3);font-size:12px;white-space:nowrap}',
        '.dr-badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
        '.dr-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:500;white-space:nowrap}',
        '.t-neutral{background:var(--line2);color:var(--ink2)}.t-muted{background:#f1f3f2;color:var(--ink3)}.t-green{background:var(--brand-soft);color:var(--brand)}',
        '.t-amber{background:var(--amber-soft);color:var(--amber)}.t-blue{background:var(--blue-soft);color:var(--blue)}.t-violet{background:var(--violet-soft);color:var(--violet)}.t-red{background:var(--red-soft);color:var(--red)}',
        '.dr-md{color:var(--ink);font-size:14px;line-height:1.72;margin-top:10px;word-break:break-word;font-weight:400}',
        '.dr-md p{margin:0 0 8px}',
        '.dr-md ul,.dr-md ol{margin:0 0 8px;padding-left:22px}',
        '.dr-md li{margin:3px 0}',
        '.dr-md li::marker{color:var(--ink3)}',
        '.dr-md>:last-child{margin-bottom:0}',
        '.dr-md-h{font-weight:650;margin:10px 0 4px}',
        '.dr-md blockquote{margin:0 0 8px;padding:2px 12px;border-left:3px solid var(--line);color:var(--ink2)}',
        '.dr-md pre{margin:0 0 8px;padding:10px 12px;background:#f5f7f6;border:1px solid var(--line2);border-radius:8px;overflow:auto;font-size:12.5px;line-height:1.55}',
        '.dr-md pre code,.dr-code,.dr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
        '.dr-code{font-size:.86em;padding:1px 6px;border-radius:5px;background:#f0f3f1;border:1px solid #e2e8e4;color:#2b3a33;word-break:break-all}',
        '.dr-md a{color:var(--blue);text-decoration:none;border-bottom:1px solid rgba(36,89,168,.25)}',
        '.dr-md a:hover{border-bottom-color:var(--blue)}',
        '.dr-md strong{font-weight:650}',
        '.dr-md.clamp{max-height:11.6em;overflow:hidden;-webkit-mask-image:linear-gradient(180deg,#000 60%,transparent);mask-image:linear-gradient(180deg,#000 60%,transparent)}',
        '.dr-more{appearance:none;border:0;background:none;padding:4px 0 0;font:inherit;font-size:12.5px;color:var(--brand);cursor:pointer;font-weight:600}',
        '.dr-q{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--amber-soft);border:1px solid var(--amber-line)}',
        '.dr-q-label{font-size:11.5px;font-weight:700;color:var(--amber);letter-spacing:.4px;margin-bottom:2px}',
        '.dr-q-text{font-weight:600;color:var(--ink);line-height:1.6}',
        '.dr-opts{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
        '.dr-opt{appearance:none;font:inherit;text-align:left;display:flex;align-items:flex-start;gap:12px;width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);cursor:pointer;line-height:1.55;transition:border-color .12s,background .12s,box-shadow .12s}',
        '.dr-opt:hover{border-color:var(--brand);background:#f7fbf9;box-shadow:0 1px 4px rgba(31,111,80,.1)}',
        '.dr-opt:disabled{opacity:.55;cursor:default}',
        '.dr-opt-key{flex:none;width:24px;height:24px;border-radius:7px;background:var(--line2);color:var(--ink2);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}',
        '.dr-opt-text{flex:1;min-width:0;font-size:14px;word-break:break-word}',
        '.dr-opt-rec{flex:none;align-self:center;height:20px;padding:0 8px;border-radius:999px;background:var(--brand);color:#fff;font-size:11px;font-weight:600;line-height:20px}',
        '.dr-opt.rec{border-color:#9fcdb6;background:#f4faf7}',
        '.dr-opt.rec .dr-opt-key{background:var(--brand);color:#fff}',
        '.dr-adopted{display:flex;gap:10px;align-items:flex-start;margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--brand-soft);border:1px solid #cde4d8}',
        '.dr-adopted-mark{flex:none;width:22px;height:22px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}',
        '.dr-adopted-label{font-size:11.5px;font-weight:700;color:var(--brand);letter-spacing:.3px}',
        '.dr-adopted-text{font-weight:600;word-break:break-word}',
        '.dr-hint{margin-top:10px;font-size:13px;color:var(--violet)}',
        '.dr-fold{margin-top:12px;border-top:1px dashed var(--line);padding-top:8px;font-size:12.5px;color:var(--ink2)}',
        '.dr-fold summary{cursor:pointer;color:var(--ink3);list-style:none;display:inline-flex;align-items:center;gap:5px;user-select:none}',
        '.dr-fold summary::-webkit-details-marker{display:none}',
        '.dr-fold summary:before{content:"▸";font-size:10px;transition:transform .12s}',
        '.dr-fold[open] summary:before{transform:rotate(90deg)}',
        '.dr-fold-body{margin-top:6px;line-height:1.65;white-space:pre-wrap;word-break:break-word}',
        '.dr-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}',
        '.dr-due{display:inline-flex;align-items:center;gap:6px;margin-top:10px;font-size:12.5px;color:var(--violet);background:var(--violet-soft);padding:3px 10px;border-radius:999px}',
      ].join('');

      const CSS_LIST = [
        '.dr-toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px;position:sticky;top:0;z-index:2;background:var(--bg);padding:6px 0}',
        '.dr-seg{display:inline-flex;gap:2px;padding:3px;background:#eaedeb;border-radius:10px;flex-wrap:wrap}',
        '.dr-seg-btn{appearance:none;border:0;background:transparent;font:inherit;font-size:12.5px;color:var(--ink2);padding:5px 10px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
        '.dr-seg-btn:hover{color:var(--ink)}',
        '.dr-seg-btn.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}',
        '.dr-seg-n{font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}',
        '.dr-seg-btn.on .dr-seg-n{color:var(--brand)}',
        '.dr-seg-n.hot{color:var(--amber);font-weight:700}',
        '.dr-search,.dr-input,.dr-root select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);outline:none}',
        '.dr-search{flex:1 1 200px;max-width:280px}',
        '.dr-search:focus,.dr-input:focus,.dr-root select:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(31,111,80,.12)}',
        '.dr-feed{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}',
        '.dr-crow{display:flex;gap:12px;align-items:flex-start;padding:10px 14px;border-top:1px solid var(--line2)}',
        '.dr-crow:first-child{border-top:0}',
        '.dr-crow:hover{background:#fafbfa}',
        '.dr-crow.muted .dr-crow-main{opacity:.66}',
        '.dr-crow.muted:hover .dr-crow-main{opacity:1}',
        '.dr-crow-main{flex:1;min-width:0}',
        '.dr-crow-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}',
        '.dr-crow-top .dr-thread{font-size:13px}',
        '.dr-crow-sum{margin-top:3px;color:var(--ink2);font-size:13px;line-height:1.55;word-break:break-word}',
        '.dr-crow-sum.clip{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
        '.dr-crow-sum .dr-md{margin-top:4px;font-size:13px;color:var(--ink)}',
        '.dr-crow-side{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none;max-width:44%}',
        '.dr-crow-acts{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}',
        '.dr-crow .hov{opacity:0;transition:opacity .12s}',
        '.dr-crow:hover .hov,.dr-crow:focus-within .hov,.dr-crow.open .hov{opacity:1}',
        '.dr-card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}',
        '.dr-card-h h3{margin:0;font-size:14.5px;font-weight:650}',
        '.dr-card-sub{font-size:12.5px;color:var(--ink3);margin-top:2px}',
        '.dr-form{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px 18px;align-items:center;margin-top:14px}',
        '.dr-label{font-size:13px;color:var(--ink2);font-weight:500}',
        '.dr-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:13px;color:var(--ink2)}',
        '.dr-field-hint{font-size:12px;color:var(--ink3)}',
        '.dr-root select{min-width:150px}',
        '.dr-input.wide{flex:1 1 240px;max-width:340px}',
        '.dr-input.num{width:64px;text-align:center}',
        '.dr-days{display:inline-flex;gap:4px;flex-wrap:wrap}',
        '.dr-day{appearance:none;font:inherit;font-size:12.5px;width:32px;height:30px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink2);cursor:pointer}',
        '.dr-day.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}',
        '.dr-result{margin-top:14px;padding:12px 14px;border-radius:10px;background:#f7f9f8;border:1px solid var(--line2)}',
        '.dr-result-why{margin-top:8px;font-size:13px;color:var(--ink2)}',
        '.dr-savebar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;margin:4px 0 16px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.95);box-shadow:0 -4px 16px rgba(16,24,20,.05)}',
        '.dr-savebar.dirty{border-color:var(--amber-line)}',
        '.dr-dirty{font-size:12.5px;color:var(--ink3)}',
        '.dr-savebar.dirty .dr-dirty{color:var(--amber);font-weight:600}',
        '.dr-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:14px}',
        '.dr-kpi{border:1px solid var(--line2);border-radius:10px;padding:12px 14px;background:#fbfcfb}',
        '.dr-kpi-label{font-size:12px;color:var(--ink2)}',
        '.dr-kpi-val{font-size:24px;font-weight:650;line-height:1.3;margin-top:2px;font-variant-numeric:tabular-nums}',
        '.dr-kpi-val small{font-size:13px;color:var(--ink3);font-weight:500;margin-left:4px}',
        '.dr-bar{height:6px;border-radius:3px;background:var(--line2);overflow:hidden;margin-top:8px}',
        '.dr-bar i{display:block;height:100%;border-radius:3px;background:var(--brand)}',
        '.dr-bar.amber i{background:#e39b17}.dr-bar.blue i{background:#4f86d8}',
        '.dr-kpi-note{font-size:11.5px;color:var(--ink3);margin-top:6px}',
        '.dr-subrow{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line2)}',
        '.dr-subrow:first-child{border-top:0}',
        '.dr-subs{margin-top:8px}',
        '.dr-sub-meta{font-size:12px;color:var(--ink3);margin-top:3px;display:flex;gap:12px;flex-wrap:wrap}',
        '.dr-mono{font-size:11.5px}',
        '@media (max-width:640px){.dr-wrap{padding:16px 14px 48px}.dr-form{grid-template-columns:1fr;gap:4px 0}.dr-label{margin-top:10px}.dr-crow{flex-direction:column}.dr-crow-side{max-width:none;align-items:flex-start}.dr-crow .hov{opacity:1}}',
      ].join('');
      const CSS_THREAD = [
        '.dr-count{appearance:none;font:inherit;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;border:1px solid #cfe0d7;background:var(--brand-soft);color:var(--brand);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}',
        '.dr-count:hover{border-color:var(--brand)}',
        '.dr-count.on{background:var(--brand);border-color:var(--brand);color:#fff}',
        '.dr-tl-wrap{margin-top:12px;border-top:1px dashed var(--line);padding-top:8px}',
        '.dr-crow .dr-tl-wrap{margin-top:8px;padding-top:6px}',
        '.dr-tl-toggle{appearance:none;border:0;background:none;padding:2px 0;font:inherit;font-size:12.5px;color:var(--ink2);cursor:pointer;display:inline-flex;align-items:center;gap:8px;font-weight:600}',
        '.dr-tl-toggle:hover{color:var(--brand)}',
        '.dr-tl-hitn{font-size:11px;font-weight:600;color:var(--amber);background:var(--amber-soft);border-radius:999px;padding:0 7px;height:18px;line-height:18px}',
        '.dr-tl{list-style:none;margin:8px 0 0;padding:0 0 0 16px;position:relative}',
        '.dr-tl:before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;border-radius:1px;background:var(--line)}',
        '.dr-tl-item{position:relative;padding:6px 10px 8px 12px;margin:0 0 4px;border-radius:8px;transition:background .12s}',
        '.dr-tl-item:before{content:"";position:absolute;left:-15px;top:12px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #b8c4bd;box-sizing:border-box}',
        '.dr-tl-item.tone-blue:before{border-color:#4f86d8}.dr-tl-item.tone-amber:before{border-color:#e39b17}.dr-tl-item.tone-violet:before{border-color:var(--violet)}.dr-tl-item.tone-green:before{border-color:var(--brand)}.dr-tl-item.tone-red:before{border-color:var(--red)}',
        '.dr-tl-item:hover{background:#fafbfa}',
        '.dr-tl-item.hit{background:var(--amber-soft);box-shadow:inset 0 0 0 1px var(--amber-line)}',
        '.dr-tl-item.muted .dr-tl-sum{opacity:.7}',
        '.dr-tl-head{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;font-size:12.5px}',
        '.dr-tl-sum{margin-top:2px;font-size:13px;color:var(--ink2);line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
        '.dr-tl-body .dr-md{margin-top:4px;font-size:13px}',
        '.dr-tl-opts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
        '.dr-tl-ans{margin-top:4px;font-size:12.5px;color:var(--brand);font-weight:600}',
        '.dr-tl-why{margin-top:4px;font-size:12.5px;color:var(--ink2)}',
        '.dr-tl-acts{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}',
        '.dr-fold-list{margin:6px 0 0;padding-left:18px;line-height:1.65}',
        '.dr-fold-list li{margin:2px 0}',
        '.dr-meta{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;margin-top:6px;font-size:12px}',
        '.dr-crow .dr-meta{margin-top:4px}',
        '.dr-floor{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:600;letter-spacing:.2px;border:1px solid var(--line);background:#fff;color:var(--ink2);white-space:nowrap}',
        '.dr-floor.f-root{border-color:#b9dccb;background:#f2f9f5;color:var(--brand)}',
        '.dr-floor.f-pending{border-color:var(--amber-line);background:var(--amber-soft);color:var(--amber)}',
        '.dr-floor.f-old{border-style:dashed;color:var(--ink3)}',
        '.dr-floor.f-other{border-color:var(--line2);background:#f6f8f7;color:var(--ink3)}',
        '.dr-times{display:inline-flex;align-items:stretch;height:20px;border:1px solid var(--line);border-radius:999px;overflow:hidden;font-size:11.5px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums;background:#fff}',
        '.dr-tm{display:inline-flex;align-items:center;gap:5px;padding:0 9px;cursor:default}',
        '.dr-tm.src{color:var(--ink);font-weight:500}',
        '.dr-tm.src:before{content:"";width:6px;height:6px;border-radius:50%;background:#24292f;opacity:.5}',
        '.dr-tm.ana{color:var(--ink3);background:#f6f8f7}',
        '.dr-tm.src+.dr-tm.ana{border-left:1px solid var(--line)}',
        '.dr-tl-item.root{background:#f7fbf9;box-shadow:inset 0 0 0 1px #d6e9df}',
        '.dr-tl-item.root:before{border-color:var(--brand);background:var(--brand)}',
      ].join('');
      const CSS = CSS_BASE + CSS_CARD + CSS_LIST + CSS_THREAD;

      async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
        const headers = { 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) };
        const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
        const data = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
        return data;
      }

      function badge(meta: Meta | undefined, fallback: string, key?: string): ReactNodeLike {
        const m = meta ?? { label: fallback, tone: 'neutral' as Tone };
        return h('span', { key, className: `dr-badge t-${m.tone}` }, m.label);
      }

      function srcBadge(source: string): ReactNodeLike {
        const info = sourceInfo(source);
        return h('span', { className: `dr-src s-${info.key}` }, info.label);
      }

      function channelSelect(value: Channel, onChange: (v: Channel) => void): ReactNodeLike {
        return h('select', { value, onChange: (e: ChangeEv) => onChange(e.target.value as Channel) },
          h('option', { value: 'web' }, '网页提醒'),
          h('option', { value: 'wechat' }, '微信转发'),
          h('option', { value: 'defer' }, '延后汇总'),
          h('option', { value: 'none' }, '静默'),
        );
      }

      function presenceSelect(value: Presence, onChange: (v: Presence) => void): ReactNodeLike {
        return h('select', { value, onChange: (e: ChangeEv) => onChange(e.target.value as Presence) },
          h('option', { value: 'auto' }, '自动判断'),
          h('option', { value: 'present' }, '在电脑前'),
          h('option', { value: 'away' }, '已离开'),
        );
      }

      function toggle(checked: boolean, onChange: (v: boolean) => void, text: string): ReactNodeLike {
        return h('label', { className: 'dr-toggle' },
          h('input', { type: 'checkbox', checked, onChange: (e: ChangeEv) => onChange(Boolean(e.target.checked)) }),
          h('i', null),
          h('span', null, text),
        );
      }

      function formRow(key: string, label: string, ...controls: unknown[]): ReactNodeLike {
        return h(Fragment, { key },
          h('div', { className: 'dr-label' }, label),
          h('div', { className: 'dr-field' }, ...controls),
        );
      }

      function reasonFold(reason: string | null | undefined, label: string): ReactNodeLike | null {
        const parts = humanizeReasonParts(reason);
        if (parts.length === 0) return null;
        return h('details', { className: 'dr-fold' },
          h('summary', null, label),
          parts.length === 1
            ? h('div', { className: 'dr-fold-body' }, parts[0])
            : h('ul', { className: 'dr-fold-list' }, ...parts.map((p, i) => h('li', { key: `r${i}` }, p))),
        );
      }

      function kpi(label: string, value: string | number, opts: { unit?: string; bar?: number; tone?: string; note?: string } = {}): ReactNodeLike {
        return h('div', { className: 'dr-kpi', key: label },
          h('div', { className: 'dr-kpi-label' }, label),
          h('div', { className: 'dr-kpi-val' }, String(value), opts.unit ? h('small', null, opts.unit) : null),
          opts.bar !== undefined ? h('div', { className: `dr-bar ${opts.tone ?? ''}` }, h('i', { style: { width: `${opts.bar}%` } })) : null,
          opts.note ? h('div', { className: 'dr-kpi-note' }, opts.note) : null,
        );
      }

      function RouterIcon({ size = 18 }: { size?: number }): ReactNodeLike {
        return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
          h('circle', { cx: 6, cy: 12, r: 2.5 }),
          h('circle', { cx: 18, cy: 6, r: 2.5 }),
          h('circle', { cx: 18, cy: 18, r: 2.5 }),
          h('path', { d: 'M8.5 11 15.5 7M8.5 13l7 4' }),
        );
      }

      function RouterPanel(): ReactNodeLike {
        const [tab, setTab] = useState<TabId>('decisions');
        const [status, setStatus] = useState<StatusView | null>(null);
        const [decisions, setDecisions] = useState<DecisionView[]>([]);
        const [notifications, setNotifications] = useState<NotificationView[]>([]);
        const [policy, setPolicy] = useState<PolicyView | null>(null);
        const [stats, setStats] = useState<StatsView | null>(null);
        const [subs, setSubs] = useState<SubView[]>([]);
        const [wechatTargets, setWechatTargets] = useState<WechatTarget[]>([]);
        const [customWechat, setCustomWechat] = useState(false);
        const [days, setDays] = useState<7 | 30>(7);
        const [filter, setFilter] = useState<DecisionFilter>('all');
        const [query, setQuery] = useState('');
        const [notifFilter, setNotifFilter] = useState<NotifFilter>('all');
        const [notifQuery, setNotifQuery] = useState('');
        const [expanded, setExpanded] = useState<Record<string, boolean>>({});
        const [pvTime, setPvTime] = useState<string>(() => toLocalInput(new Date()));
        const [pvPresence, setPvPresence] = useState<Presence>('auto');
        const [pvUrgent, setPvUrgent] = useState(false);
        const [preview, setPreview] = useState<PreviewView | null>(null);
        const [busy, setBusy] = useState(false);
        const [msg, setMsg] = useState('');
        const [err, setErr] = useState('');

        const reload = useCallback(async (statDays: 7 | 30 = days): Promise<void> => {
          try {
            const [st, dc, nf, ss, sb, wx] = await Promise.all([
              api<StatusView>('/local-router/status'),
              api<{ decisions: DecisionView[] }>('/local-router/decisions'),
              api<{ notifications: NotificationView[] }>('/local-router/notifications'),
              api<StatsView>(`/local-router/stats?days=${statDays}`),
              api<{ subscriptions: SubView[] }>('/local-router/subscriptions'),
              api<{ targets?: WechatTarget[] }>('/wxarc/automation').catch(() => ({ targets: [] })),
            ]);
            setStatus(st);
            setPolicy((prev) => prev ?? st.policy);
            setDecisions(dc.decisions || []);
            setNotifications(nf.notifications || []);
            setStats(ss);
            setSubs(sb.subscriptions || []);
            const rawTargets = Array.isArray(wx?.targets) ? wx.targets : [];
            const seen = new Map<string, WechatTarget>();
            for (const item of rawTargets) {
              const id = String(item?.id ?? '').trim();
              if (!id) continue;
              const title = String(item?.title ?? '').trim() || id;
              if (!seen.has(id)) seen.set(id, { id, title });
            }
            if (!seen.has('filehelper')) {
              seen.set('filehelper', { id: 'filehelper', title: '文件传输助手' });
            }
            const rankTarget = (t: WechatTarget): number => {
              if (t.id === 'filehelper') return 2;
              const named = t.title && t.title !== t.id;
              const isGroup = t.id.endsWith('@chatroom');
              if (named && !isGroup) return 0;
              if (named && isGroup) return 1;
              return 3;
            };
            const sortedTargets = [...seen.values()].sort((a, b) => {
              const diff = rankTarget(a) - rankTarget(b);
              return diff !== 0 ? diff : a.title.localeCompare(b.title, 'zh-CN');
            });
            setWechatTargets(sortedTargets);
            setErr('');
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : String(ex));
          }
        }, [days]);

        useEffect(() => {
          void reload(days);
          const timer = setInterval(() => void reload(days), 6000);
          return () => clearInterval(timer);
        }, [reload, days]);

        const run = async (notice: string, fn: () => Promise<void>): Promise<void> => {
          setBusy(true);
          setErr('');
          setMsg('');
          try {
            await fn();
            if (notice) setMsg(notice);
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : String(ex));
          } finally {
            setBusy(false);
          }
        };

        const toggleEnabled = async (): Promise<void> => {
          if (!status) return;
          await run(status.enabled ? 'Router 已暂停' : 'Router 已启用', async () => {
            const updated = await api<PolicyView>('/local-router/policy', { method: 'PUT', body: JSON.stringify({ enabled: !status.enabled }) });
            setPolicy(updated);
            await reload();
          });
        };

        const actDecision = async (id: string, action: 'restore' | 'dispatch'): Promise<void> => {
          await run(action === 'restore' ? '已恢复通知并计入找回' : '已派发 Worker 并建立快车道', async () => {
            await api(`/local-router/decisions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
            await reload();
          });
        };

        const answerDecision = async (id: string, optionIndex: number): Promise<void> => {
          await run('已提交你的决定，Worker 会按该方案继续', async () => {
            await api(`/local-router/decisions/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ optionIndex }) });
            await reload();
          });
        };

        const markRead = async (id: string): Promise<void> => {
          await run('已标为已读', async () => {
            await api(`/local-router/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' });
            await reload();
          });
        };

        const markThreadRead = async (ids: string[]): Promise<void> => {
          await run(`本线程 ${ids.length} 条提醒已全部标为已读`, async () => {
            for (const id of ids) {
              await api(`/local-router/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' });
            }
            await reload();
          });
        };

        const savePolicy = async (): Promise<void> => {
          if (!policy) return;
          await run('注意力与作息偏好已保存', async () => {
            const updated = await api<PolicyView>('/local-router/policy', { method: 'PUT', body: JSON.stringify(policy) });
            setPolicy(updated);
            await reload();
          });
        };

        const runPreview = async (): Promise<void> => {
          await run('情境预演完成（未发送任何通知）', async () => {
            const isoTime = pvTime ? new Date(pvTime).toISOString() : new Date().toISOString();
            const res = await api<PreviewView>('/local-router/preview', {
              method: 'POST',
              body: JSON.stringify({ isoTime, presenceMode: pvPresence, urgent: pvUrgent }),
            });
            setPreview(res);
          });
        };

        const removeSub = async (source: string, threadKey: string): Promise<void> => {
          await run(`已解除订阅 ${threadTitle(source, threadKey)}`, async () => {
            await api('/local-router/subscriptions', { method: 'DELETE', body: JSON.stringify({ source, threadKey }) });
            await reload();
          });
        };

        const flip = (key: string): void => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
        const now = Date.now();

        const renderReport = (key: string, text: string): ReactNodeLike => {
          const blocks = parseBlocks(text);
          const isLong = (text || '').length > 280 || blocks.length > 3;
          const open = Boolean(expanded[key]);
          return h('div', { className: 'dr-report' },
            h('div', { className: `dr-md ${isLong && !open ? 'clamp' : ''}` }, ...renderBlocks(blocks, key)),
            isLong ? h('button', { type: 'button', className: 'dr-more', onClick: () => flip(key) }, open ? '收起 ▴' : `展开完整报告（${text.length} 字）▾`) : null,
          );
        };

        const setOpen = (key: string, value: boolean): void => setExpanded((prev) => ({ ...prev, [key]: value }));
        const q = query.trim().toLowerCase();
        const matches = (d: DecisionView): boolean => !q || [d.summary, d.threadKey, threadTitle(d.source, d.threadKey), d.actor, d.reason, humanizeReason(d.reason), d.question ?? '', d.source, sourceInfo(d.source).label, ...optsOf(d)].join('\n').toLowerCase().includes(q);
        const pendingAll = decisions.filter(isPending);
        const segments: Array<{ id: DecisionFilter; label: string; test: (d: DecisionView) => boolean }> = [
          { id: 'all', label: '全部', test: () => true },
          { id: 'pending', label: '待拍板', test: isPending },
          { id: 'work', label: '准备·代办', test: isWork },
          { id: 'inform', label: '告知', test: (d) => d.level === 'inform' },
          { id: 'ignored', label: '已过滤', test: isIgnored },
          { id: 'answered', label: '已拍板', test: isAnswered },
        ];
        const seg = segments.find((s) => s.id === filter) ?? segments[0];
        const segActive = seg.id !== 'all';
        const isHit = (d: DecisionView): boolean => (Boolean(q) || segActive) && (!q || matches(d)) && (!segActive || seg.test(d));
        const threadOpen = (t: DecisionThread): boolean => {
          const v = expanded[`t:${t.key}`];
          return v === undefined ? t.others.some(isHit) : v;
        };
        const countButton = (key: string, total: number, open: boolean): ReactNodeLike | null => (total > 1
          ? h('button', { key: 'cnt', type: 'button', className: `dr-count ${open ? 'on' : ''}`, 'aria-expanded': open, title: open ? '收起同线程历史' : '展开同线程历史', onClick: () => setOpen(key, !open) }, `${total} 条动态`)
          : null);

        const decisionTitle = (d: DecisionView, extra: ReactNodeLike | null = null): ReactNodeLike => h('div', { className: 'dr-dtitle' },
          srcBadge(d.source),
          h('span', { className: 'dr-thread' }, threadTitle(d.source, d.threadKey)),
          extra,
        );

        const timePair = (verb: string, occurred: string | null | undefined, stampLabel: string, stamp: string | null | undefined): ReactNodeLike => h('span', { className: 'dr-times' },
          occurred && timeOf(occurred) ? h('span', { key: 'src', className: 'dr-tm src', title: fmtFull(occurred) }, `${verb} ${fmtAbs(occurred)}`) : null,
          stamp ? h('span', { key: 'ana', className: 'dr-tm ana', title: fmtFull(stamp) }, `${stampLabel}于 ${fmtRelative(stamp, now)}`) : null,
        );

        const floorTag = (f: FloorInfo): ReactNodeLike | null => (f.label ? h('span', { key: 'floor', className: `dr-floor f-${f.tone}` }, f.label) : null);

        const decisionMeta = (t: DecisionThread, d: DecisionView): ReactNodeLike => {
          const f = floorOf(t, d);
          return h('div', { className: 'dr-meta' },
            floorTag(f),
            d.actor ? h('span', { className: 'dr-actor' }, `@${d.actor}`) : null,
            timePair(f.verb, d.eventOccurredAt, '分析', analyzedAt(d)),
          );
        };

        const decisionBadges = (d: DecisionView, withDest: boolean): ReactNodeLike => h('div', { className: 'dr-badges' },
          badge(LEVEL_META[d.level], String(d.level), 'lv'),
          badge(STATUS_META[d.status], String(d.status), 'st'),
          withDest && d.destination && d.destination !== 'none' ? badge({ label: DEST_LABELS[d.destination] ?? d.destination, tone: 'neutral' }, '', 'dest') : null,
        );

        const actionButtons = (d: DecisionView, compact: boolean): ReactNodeLike[] => {
          const size = compact ? ' sm' : '';
          const hov = compact ? ' hov' : '';
          const out: ReactNodeLike[] = [];
          if (d.workerSessionId) {
            const sid = d.workerSessionId;
            out.push(h('button', { key: 'open', type: 'button', className: `dr-btn${size}${compact ? ' hov' : ' pri'}`, onClick: () => openSession(sid) }, '打开 Worker 会话'));
          }
          if (d.status === 'filtered') {
            out.push(h('button', { key: 'restore', type: 'button', className: `dr-btn${size}${hov}`, disabled: busy, onClick: () => void actDecision(d.id, 'restore') }, '仍然通知'));
          }
          if ((d.level === 'inform' || d.status === 'notified') && !d.workerSessionId) {
            out.push(h('button', { key: 'dispatch', type: 'button', className: `dr-btn${size}${hov}`, disabled: busy, onClick: () => void actDecision(d.id, 'dispatch') }, '派 Worker 建快车道'));
          }
          if (d.rawUrl && safeUrl(d.rawUrl)) {
            out.push(h('a', { key: 'raw', className: `dr-btn ghost${size}`, href: d.rawUrl, target: '_blank', rel: 'noopener noreferrer' }, compact ? '原文 ↗' : '查看原文 ↗'));
          }
          return out;
        };

        const renderOptions = (d: DecisionView, opts: string[], recIdx: number | null): ReactNodeLike => h('div', { className: 'dr-opts', role: 'group', 'aria-label': '可选方案' },
          ...opts.map((opt, idx) => {
            const rec = idx === recIdx;
            return h('button', {
              key: `${d.id}-opt-${idx}`,
              type: 'button',
              className: `dr-opt ${rec ? 'rec' : ''}`,
              disabled: busy,
              onClick: () => void answerDecision(d.id, idx),
            },
            h('span', { className: 'dr-opt-key' }, String.fromCharCode(65 + (idx % 26))),
            h('span', { className: 'dr-opt-text' }, ...renderInline(cleanOption(opt), `${d.id}-o${idx}`)),
            rec ? h('span', { className: 'dr-opt-rec' }, '推荐') : null);
          }),
        );

        const renderAdopted = (d: DecisionView, opts: string[], recIdx: number | null): ReactNodeLike => {
          const answer = cleanOption(d.answeredOption ?? '');
          const pickedRec = recIdx !== null && opts[recIdx] !== undefined && cleanOption(opts[recIdx]) === answer;
          return h('div', { className: 'dr-adopted' },
            h('span', { className: 'dr-adopted-mark' }, '✓'),
            h('div', null,
              h('div', { className: 'dr-adopted-label' }, pickedRec ? '已采纳 · 推荐方案' : '已采纳'),
              h('div', { className: 'dr-adopted-text' }, ...renderInline(answer, `${d.id}-ans`)),
            ),
          );
        };

        const timelineActions = (d: DecisionView): ReactNodeLike[] => {
          const out: ReactNodeLike[] = [];
          if (d.workerSessionId) {
            const sid = d.workerSessionId;
            out.push(h('button', { key: 'open', type: 'button', className: 'dr-btn sm', onClick: () => openSession(sid) }, '打开会话'));
          }
          if (d.status === 'filtered') {
            out.push(h('button', { key: 'restore', type: 'button', className: 'dr-btn sm', disabled: busy, onClick: () => void actDecision(d.id, 'restore') }, '仍然通知'));
          }
          if ((d.level === 'inform' || d.status === 'notified') && !d.workerSessionId) {
            out.push(h('button', { key: 'dispatch', type: 'button', className: 'dr-btn sm', disabled: busy, onClick: () => void actDecision(d.id, 'dispatch') }, '派 Worker'));
          }
          if (d.rawUrl && safeUrl(d.rawUrl)) {
            out.push(h('a', { key: 'raw', className: 'dr-btn ghost sm', href: d.rawUrl, target: '_blank', rel: 'noopener noreferrer' }, '原文 ↗'));
          }
          return out;
        };

        const renderTimelineItem = (t: DecisionThread, d: DecisionView): ReactNodeLike => {
          const key = `ti:${d.id}`;
          const more = Boolean(expanded[key]);
          const opts = optsOf(d);
          const recIdx = resolveRec(d);
          const awaiting = opts.length > 0 && !d.answeredOption;
          const summary = d.summary || '';
          const canMore = summary.length > 110 || summary.includes('\n') || Boolean(d.reason && d.reason.trim()) || Boolean(d.question);
          const tone = isPending(d) ? 'amber' : (LEVEL_META[d.level]?.tone ?? 'neutral');
          const f = floorOf(t, d);
          return h('li', { key: d.id, className: `dr-tl-item tone-${tone} ${d === t.root ? 'root' : ''} ${isHit(d) ? 'hit' : ''} ${isIgnored(d) ? 'muted' : ''}` },
            h('div', { className: 'dr-tl-head' },
              floorTag(f),
              h('span', { className: 'dr-actor' }, d.actor ? `@${d.actor}` : '系统'),
              timePair(f.verb, d.eventOccurredAt, '分析', analyzedAt(d)),
              badge(LEVEL_META[d.level], String(d.level), 'lv'),
              badge(STATUS_META[d.status], String(d.status), 'st'),
              awaiting ? badge({ label: '待拍板', tone: 'amber' }, '', 'pd') : null,
            ),
            more
              ? h('div', { className: 'dr-tl-body' }, h('div', { className: 'dr-md' }, ...renderBlocks(parseBlocks(isWork(d) ? splitWorkerChanges(summary) : summary), key)))
              : h('div', { className: 'dr-tl-sum' }, ...renderInline(flatten(summary), `${key}-f`)),
            more && d.question ? h('div', { className: 'dr-tl-why' }, `当时的问题：${d.question}`) : null,
            awaiting
              ? h('div', { className: 'dr-tl-opts', role: 'group', 'aria-label': '可选方案' }, ...opts.map((opt, idx) => h('button', {
                  key: `${d.id}-tlo-${idx}`,
                  type: 'button',
                  className: `dr-btn sm ${idx === recIdx ? 'pri' : ''}`,
                  disabled: busy,
                  onClick: () => void answerDecision(d.id, idx),
                }, `${String.fromCharCode(65 + (idx % 26))} · ${cleanOption(opt)}${idx === recIdx ? '（推荐）' : ''}`)))
              : null,
            d.answeredOption ? h('div', { className: 'dr-tl-ans' }, `✓ 已采纳：${cleanOption(d.answeredOption)}`) : null,
            more ? reasonFold(d.reason, '分诊依据') : null,
            h('div', { className: 'dr-tl-acts' },
              canMore ? h('button', { key: 'more', type: 'button', className: 'dr-btn sm ghost', onClick: () => flip(key) }, more ? '收起' : '详情') : null,
              ...timelineActions(d),
            ),
          );
        };

        const renderTimeline = (t: DecisionThread): ReactNodeLike | null => {
          if (t.others.length === 0) return null;
          const key = `t:${t.key}`;
          const open = threadOpen(t);
          const hits = t.others.filter(isHit).length;
          const pendingOthers = t.others.filter(isPending).length;
          return h('div', { className: `dr-tl-wrap ${open ? 'open' : ''}` },
            h('button', { type: 'button', className: 'dr-tl-toggle', 'aria-expanded': open, onClick: () => setOpen(key, !open) },
              foldText(t, open, '评论分析'),
              !open && pendingOthers > 0 ? h('span', { className: 'dr-tl-hitn' }, `${pendingOthers} 条待拍板`) : null,
              !open && hits > 0 ? h('span', { className: 'dr-tl-hitn' }, `${hits} 条命中`) : null,
            ),
            open ? h('ol', { className: 'dr-tl', 'aria-label': t.forum ? '主楼与评论楼层' : '同线程时间线' }, ...t.others.map((d) => renderTimelineItem(t, d))) : null,
          );
        };

        const renderDecisionCard = (t: DecisionThread, focus: boolean): ReactNodeLike => {
          const d = t.primary;
          const opts = optsOf(d);
          const recIdx = resolveRec(d);
          const awaiting = opts.length > 0 && !d.answeredOption;
          const acts = actionButtons(d, false);
          return h('article', { key: t.key, className: `dr-card ${focus ? 'focus' : ''}` },
            h('div', { className: 'dr-dhead' }, decisionTitle(d, countButton(`t:${t.key}`, t.items.length, threadOpen(t))), decisionBadges(d, true)),
            decisionMeta(t, d),
            renderReport(d.id, isWork(d) ? splitWorkerChanges(d.summary) : d.summary),
            d.question || awaiting
              ? h('div', { className: 'dr-q' },
                  h('div', { className: 'dr-q-label' }, awaiting ? '待你确认 · 选一个方案即可' : '当时的问题'),
                  d.question ? h('div', { className: 'dr-q-text' }, ...renderInline(d.question, `${d.id}-q`)) : null,
                )
              : null,
            awaiting ? renderOptions(d, opts, recIdx) : null,
            d.answeredOption ? renderAdopted(d, opts, recIdx) : null,
            d.status === 'dispatched' && !awaiting ? h('div', { className: 'dr-hint' }, '⏳ Worker 正在处理，完成后会在这里汇报结论。') : null,
            reasonFold(d.reason, '分诊依据'),
            acts.length > 0 ? h('div', { className: 'dr-acts' }, ...acts) : null,
            renderTimeline(t),
          );
        };

        const renderCompactRow = (t: DecisionThread): ReactNodeLike => {
          const d = t.primary;
          const key = `c:${d.id}`;
          const open = Boolean(expanded[key]);
          const summary = d.summary || '';
          const canExpand = summary.length > 110 || summary.includes('\n') || Boolean(d.reason && d.reason.trim());
          const muted = isIgnored(d) && !t.others.some(isHit);
          return h('div', { key: t.key, className: `dr-crow ${muted ? 'muted' : ''} ${open ? 'open' : ''}` },
            h('div', { className: 'dr-crow-main' },
              decisionTitle(d, countButton(`t:${t.key}`, t.items.length, threadOpen(t))),
              decisionMeta(t, d),
              open
                ? h('div', { className: 'dr-crow-sum' }, h('div', { className: 'dr-md' }, ...renderBlocks(parseBlocks(summary), d.id)))
                : h('div', { className: 'dr-crow-sum clip' }, ...renderInline(flatten(summary), `${d.id}-f`)),
              open ? reasonFold(d.reason, '分诊依据') : null,
              renderTimeline(t),
            ),
            h('div', { className: 'dr-crow-side' },
              decisionBadges(d, false),
              h('div', { className: 'dr-crow-acts' },
                canExpand ? h('button', { key: 'more', type: 'button', className: 'dr-btn sm ghost', onClick: () => flip(key) }, open ? '收起' : '详情') : null,
                ...actionButtons(d, true),
              ),
            ),
          );
        };

        const renderList = (list: DecisionThread[]): ReactNodeLike => {
          const out: unknown[] = [];
          let feed: unknown[] = [];
          const flushFeed = (): void => {
            if (feed.length > 0) out.push(h('div', { key: `feed-${out.length}`, className: 'dr-feed' }, ...feed));
            feed = [];
          };
          for (const t of list) {
            if (t.items.some(isRich)) {
              flushFeed();
              out.push(renderDecisionCard(t, isPending(t.primary)));
            } else {
              feed.push(renderCompactRow(t));
            }
          }
          flushFeed();
          return h(Fragment, null, ...out);
        };

        const threadsAll = buildDecisionThreads(decisions);
        const visibleThreads = q ? threadsAll.filter((t) => t.items.some(matches)) : threadsAll;

        const renderDecisionsTab = (): ReactNodeLike => {
          if (decisions.length === 0) {
            return h('div', { className: 'dr-empty' }, '暂无分诊记录。GitHub、微信、备忘等来源有新事件时，会按「待你拍板 → 其余动态」排在这里。');
          }
          const focus = visibleThreads.filter((t) => t.pending);
          const list = segActive ? visibleThreads.filter((t) => t.items.some(seg.test)) : visibleThreads.filter((t) => !t.pending);
          const listItems = list.reduce((n, t) => n + t.items.length, 0);
          const toolbar = h('div', { className: 'dr-toolbar' },
            h('div', { className: 'dr-seg', role: 'tablist', 'aria-label': '分诊筛选' },
              ...segments.map((s) => {
                const count = visibleThreads.filter((t) => t.items.some(s.test)).length;
                return h('button', { key: s.id, type: 'button', role: 'tab', 'aria-selected': filter === s.id, className: `dr-seg-btn ${filter === s.id ? 'on' : ''}`, onClick: () => setFilter(s.id) },
                  s.label,
                  h('span', { className: `dr-seg-n ${s.id === 'pending' && count > 0 ? 'hot' : ''}` }, String(count)));
              }),
            ),
            h('input', { className: 'dr-search', type: 'search', value: query, placeholder: '搜索仓库、摘要、@人、原因…', 'aria-label': '搜索分诊记录', onChange: (e: ChangeEv) => setQuery(e.target.value) }),
          );
          return h(Fragment, null,
            !segActive
              ? (focus.length > 0
                  ? h('section', { className: 'dr-focus', 'aria-label': '待你拍板' },
                      h('div', { className: 'dr-sec' },
                        h('h2', null, h('span', { className: 'dr-dot' }), `待你拍板 · ${focus.length}`),
                        h('span', { className: 'dr-sec-hint' }, '先处理这里，其余都可以晚点看'),
                      ),
                      ...focus.map((t) => renderDecisionCard(t, true)),
                    )
                  : (q ? null : h('div', { className: 'dr-calm' }, '✓ 目前没有需要你拍板的事项。')))
              : null,
            toolbar,
            list.length > 0
              ? h('div', { className: 'dr-sec' },
                  h('h2', null, segActive ? seg.label : '其余动态'),
                  h('span', { className: 'dr-sec-hint' }, `${list.length} 个线程 · ${listItems} 条动态 · 主楼在上，评论按发帖时间正序折叠在下`),
                )
              : null,
            list.length === 0
              ? h('div', { className: 'dr-empty' }, q ? `没有匹配「${query.trim()}」的记录。` : '这个分类下暂时没有记录。')
              : renderList(list),
          );
        };

        const decisionById = new Map(decisions.map((d) => [d.id, d] as [string, DecisionView]));
        const threadByDecision = new Map<string, DecisionThread>();
        for (const t of threadsAll) for (const d of t.items) threadByDecision.set(d.id, t);
        const notifTimes = (n: NotificationView): ReactNodeLike => {
          const d = decisionById.get(n.decisionId);
          const t = d ? threadByDecision.get(d.id) : undefined;
          const f = d && t ? floorOf(t, d) : null;
          return h(Fragment, null,
            f ? floorTag(f) : null,
            timePair(f?.verb ?? '原文于', d?.eventOccurredAt, '提醒', n.createdAt),
          );
        };
        const notifBuckets: Array<{ id: NotifFilter; label: string; test: (n: NotificationView) => boolean }> = [
          { id: 'all', label: '全部', test: () => true },
          { id: 'unread', label: '未读', test: isUnread },
          { id: 'deferred', label: '延后', test: (n) => n.status === 'deferred' },
          { id: 'read', label: '已读', test: (n) => n.status === 'read' },
        ];
        const unreadCount = notifications.filter(isUnread).length;
        const nq = notifQuery.trim().toLowerCase();
        const notifMeta = (n: NotificationView): { source: string; title: string; key: string; actor: string } => {
          const d = decisionById.get(n.decisionId);
          if (d) return { source: d.source, title: threadTitle(d.source, d.threadKey), key: threadKeyOf(d.source, d.threadKey, n.id), actor: d.actor || '' };
          const m = /^\s*\[([^\]]+)\]\s*(.+)$/.exec(n.title || '');
          if (m) return { source: m[1], title: threadTitle(m[1], m[2]), key: threadKeyOf(m[1], m[2], n.id), actor: '' };
          return { source: '', title: n.title || '提醒', key: `id::${n.id}`, actor: '' };
        };
        const notifMatches = (n: NotificationView): boolean => {
          if (!nq) return true;
          const meta = notifMeta(n);
          return [n.title, n.summary, n.reason, humanizeReason(n.reason), meta.title, meta.actor, sourceInfo(meta.source).label].join('\n').toLowerCase().includes(nq);
        };
        const notifThreadsAll: NotifThread[] = (() => {
          const map = new Map<string, NotificationView[]>();
          const order: string[] = [];
          for (const n of notifications) {
            const k = notifMeta(n).key;
            const bucketList = map.get(k);
            if (bucketList) bucketList.push(n);
            else {
              map.set(k, [n]);
              order.push(k);
            }
          }
          const rank = (t: NotifThread): number => (t.unread > 0 ? 0 : t.items.some((n) => n.status === 'deferred') ? 1 : 2);
          return order.map((k) => {
            const items = [...(map.get(k) ?? [])].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
            const primary = items.find(isUnread) ?? items.find((n) => n.status === 'deferred') ?? items[0];
            const meta = notifMeta(primary);
            return { key: k, source: meta.source, title: meta.title, actor: meta.actor, primary, items, others: items.filter((n) => n !== primary), latestAt: timeOf(items[0].createdAt), unread: items.filter(isUnread).length };
          }).sort((a, b) => rank(a) - rank(b) || b.latestAt - a.latestAt);
        })();
        const bucket = notifBuckets.find((b) => b.id === notifFilter) ?? notifBuckets[0];
        const bucketActive = bucket.id !== 'all';
        const notifHit = (n: NotificationView): boolean => (Boolean(nq) || bucketActive) && notifMatches(n) && bucket.test(n);
        const notifOpen = (t: NotifThread): boolean => {
          const v = expanded[`nt:${t.key}`];
          return v === undefined ? t.others.some(notifHit) : v;
        };
        const notifVisible = nq ? notifThreadsAll.filter((t) => t.items.some(notifMatches)) : notifThreadsAll;

        const renderNotifTimeline = (t: NotifThread, open: boolean): ReactNodeLike | null => {
          if (t.others.length === 0) return null;
          const key = `nt:${t.key}`;
          const hits = t.others.filter(notifHit).length;
          const unreadOthers = t.others.filter(isUnread).length;
          return h('div', { className: `dr-tl-wrap ${open ? 'open' : ''}` },
            h('button', { type: 'button', className: 'dr-tl-toggle', 'aria-expanded': open, onClick: () => setOpen(key, !open) },
              open ? '收起历史提醒 ▴' : `展开历史提醒（${t.others.length}）▾`,
              !open && unreadOthers > 0 ? h('span', { className: 'dr-tl-hitn' }, `${unreadOthers} 条未读`) : null,
              !open && hits > 0 ? h('span', { className: 'dr-tl-hitn' }, `${hits} 条命中`) : null,
            ),
            open
              ? h('ol', { className: 'dr-tl', 'aria-label': '同线程历史提醒' }, ...t.others.map((x) => {
                  const ik = `ni:${x.id}`;
                  const more = Boolean(expanded[ik]);
                  const tone = NOTIF_META[x.status]?.tone ?? 'neutral';
                  return h('li', { key: x.id, className: `dr-tl-item tone-${tone} ${notifHit(x) ? 'hit' : ''} ${x.status === 'read' ? 'muted' : ''}` },
                    h('div', { className: 'dr-tl-head' },
                      notifTimes(x),
                      badge(NOTIF_META[x.status], String(x.status), 'st'),
                      badge({ label: DEST_LABELS[x.channel] ?? x.channel, tone: 'neutral' }, '', 'ch'),
                      x.status === 'deferred' && x.dueAt ? h('span', { className: 'dr-time', title: fmtFull(x.dueAt) }, `⏰ 延后至 ${fmtAbs(x.dueAt)}`) : null,
                    ),
                    more
                      ? h('div', { className: 'dr-tl-body' }, h('div', { className: 'dr-md' }, ...renderBlocks(parseBlocks(x.summary || ''), ik)))
                      : h('div', { className: 'dr-tl-sum' }, ...renderInline(flatten(x.summary || ''), `${ik}-f`)),
                    more ? reasonFold(x.reason, '提醒原因') : null,
                    h('div', { className: 'dr-tl-acts' },
                      h('button', { key: 'more', type: 'button', className: 'dr-btn sm ghost', onClick: () => flip(ik) }, more ? '收起' : '详情'),
                      x.status !== 'read' ? h('button', { key: 'read', type: 'button', className: 'dr-btn sm', disabled: busy, onClick: () => void markRead(x.id) }, '已读') : null,
                      x.rawUrl && safeUrl(x.rawUrl) ? h('a', { key: 'raw', className: 'dr-btn ghost sm', href: x.rawUrl, target: '_blank', rel: 'noopener noreferrer' }, '原文 ↗') : null,
                    ),
                  );
                }))
              : null,
          );
        };

        const renderNotifThread = (t: NotifThread): ReactNodeLike => {
          const n = t.primary;
          const d = decisionById.get(n.decisionId);
          const sid = d?.workerSessionId ?? t.items.map((x) => decisionById.get(x.decisionId)?.workerSessionId ?? '').find(Boolean) ?? null;
          const openKey = `nt:${t.key}`;
          const open = notifOpen(t);
          const pendingIds = t.items.filter((x) => x.status !== 'read').map((x) => x.id);
          return h('article', { key: t.key, className: `dr-card ${t.unread > 0 ? 'unread' : ''}` },
            h('div', { className: 'dr-dhead' },
              h('div', { className: 'dr-dtitle' },
                t.source ? srcBadge(t.source) : null,
                h('span', { className: 'dr-thread' }, t.title),
                countButton(openKey, t.items.length, open),
              ),
              h('div', { className: 'dr-badges' },
                badge(NOTIF_META[n.status], String(n.status), 'st'),
                badge({ label: DEST_LABELS[n.channel] ?? n.channel, tone: 'neutral' }, '', 'ch'),
                t.unread > 1 ? badge({ label: `${t.unread} 条未读`, tone: 'amber' }, '', 'un') : null,
              ),
            ),
            h('div', { className: 'dr-meta' },
              t.actor ? h('span', { className: 'dr-actor' }, `@${t.actor}`) : null,
              notifTimes(n),
            ),
            n.status === 'deferred' && n.dueAt ? h('div', { className: 'dr-due', title: fmtFull(n.dueAt) }, `⏰ 延后至 ${fmtAbs(n.dueAt)} · ${fmtRelative(n.dueAt, now)}`) : null,
            renderReport(`n:${n.id}`, d && isWork(d) ? splitWorkerChanges(n.summary) : n.summary),
            reasonFold(n.reason, '提醒原因'),
            h('div', { className: 'dr-acts' },
              n.status !== 'read' ? h('button', { type: 'button', className: 'dr-btn pri', disabled: busy, onClick: () => void markRead(n.id) }, '标为已读') : null,
              pendingIds.length > 1 ? h('button', { type: 'button', className: 'dr-btn', disabled: busy, onClick: () => void markThreadRead(pendingIds) }, `本线程全部标为已读（${pendingIds.length}）`) : null,
              sid ? h('button', { type: 'button', className: 'dr-btn', onClick: () => openSession(sid) }, '打开会话') : null,
              n.rawUrl && safeUrl(n.rawUrl) ? h('a', { className: 'dr-btn ghost', href: n.rawUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看原文 ↗') : null,
            ),
            renderNotifTimeline(t, open),
          );
        };

        const renderNotificationsTab = (): ReactNodeLike => {
          if (notifications.length === 0) return h('div', { className: 'dr-empty' }, '提醒队列为空。Router 判定需要告诉你的事件会出现在这里。');
          const list = notifVisible.filter((t) => t.items.some(bucket.test));
          return h(Fragment, null,
            h('div', { className: 'dr-toolbar' },
              h('div', { className: 'dr-seg', role: 'tablist', 'aria-label': '提醒筛选' },
                ...notifBuckets.map((b) => {
                  const count = notifVisible.filter((t) => t.items.some(b.test)).length;
                  return h('button', { key: b.id, type: 'button', role: 'tab', 'aria-selected': notifFilter === b.id, className: `dr-seg-btn ${notifFilter === b.id ? 'on' : ''}`, onClick: () => setNotifFilter(b.id) },
                    b.label,
                    h('span', { className: `dr-seg-n ${b.id === 'unread' && count > 0 ? 'hot' : ''}` }, String(count)));
                }),
              ),
              h('input', { className: 'dr-search', type: 'search', value: notifQuery, placeholder: '搜索仓库、摘要、原因…', 'aria-label': '搜索提醒', onChange: (e: ChangeEv) => setNotifQuery(e.target.value) }),
            ),
            list.length === 0
              ? h('div', { className: 'dr-empty' }, nq ? `没有匹配「${notifQuery.trim()}」的提醒。` : '这个分类下没有提醒。')
              : h(Fragment, null, ...list.map(renderNotifThread)),
          );
        };

        const policyKey = (p: PolicyView | null): string => (p ? JSON.stringify({ ...p, lastWebActiveAt: null, workdays: [...(p.workdays || [])].sort() }) : '');
        const dirty = Boolean(policy && status && policyKey(policy) !== policyKey(status.policy));

        const renderPolicyTab = (): ReactNodeLike => {
          if (!policy) return h('div', { className: 'dr-empty' }, '正在读取注意力与作息偏好…');
          const upd = (patch: Partial<PolicyView>): void => setPolicy({ ...policy, ...patch });
          const workdays = policy.workdays || [];
          const toggleDay = (day: number): void => upd({ workdays: workdays.includes(day) ? workdays.filter((x) => x !== day) : [...workdays, day].sort((a, b) => a - b) });
          const hourInput = (value: number, onChange: (v: number) => void, label: string): ReactNodeLike => h('input', {
            className: 'dr-input num', type: 'number', min: 0, max: 23, value, 'aria-label': label,
            onChange: (e: ChangeEv) => onChange(Number(e.target.value)),
          });
          return h(Fragment, null,
            h('div', { className: 'dr-card' },
              h('div', { className: 'dr-card-h' }, h('div', null, h('h3', null, '基础开关'), h('div', { className: 'dr-card-sub' }, 'Router 的总开关与分诊强度'))),
              h('div', { className: 'dr-form' },
                formRow('en', '启用 Router', toggle(policy.enabled, (v) => upd({ enabled: v }), policy.enabled ? '已开启' : '已暂停')),
                formRow('tf', '低价值过滤', toggle(policy.triageFilterEnabled, (v) => upd({ triageFilterEnabled: v }), policy.triageFilterEnabled ? '自动挡掉低价值事件' : '全部放行')),
                formRow('pm', '在场状态', presenceSelect(policy.presenceMode, (v) => upd({ presenceMode: v })), h('span', { className: 'dr-field-hint' }, '自动＝按网页最近活跃判断')),
                formRow('ml', '默认最高级别', h('select', { value: policy.defaultMaxLevel, onChange: (e: ChangeEv) => upd({ defaultMaxLevel: e.target.value as ActionLevel }) },
                  h('option', { value: 'ignore' }, '忽略'), h('option', { value: 'inform' }, '告知'), h('option', { value: 'prepare' }, '准备'), h('option', { value: 'act' }, '代办'),
                ), h('span', { className: 'dr-field-hint' }, 'Worker 最多能自主做到哪一级')),
              ),
            ),
            h('div', { className: 'dr-card' },
              h('div', { className: 'dr-card-h' }, h('div', null, h('h3', null, '作息时段与去向'), h('div', { className: 'dr-card-sub' }, `时区 ${policy.timezone || '本地'} · 不同时段的提醒发到哪里`))),
              h('div', { className: 'dr-form' },
                formRow('wd', '工作日', h('div', { className: 'dr-days' }, ...WEEKDAYS.map(([day, label]) => h('button', {
                  key: `d${day}`, type: 'button', className: `dr-day ${workdays.includes(day) ? 'on' : ''}`, 'aria-pressed': workdays.includes(day), onClick: () => toggleDay(day),
                }, label)))),
                formRow('wh', '工作时间', hourInput(policy.workStartHour, (v) => upd({ workStartHour: v }), '开始小时'), '点 至', hourInput(policy.workEndHour, (v) => upd({ workEndHour: v }), '结束小时'), '点'),
                formRow('d1', '工作时段去向', channelSelect(policy.workHoursDest, (v) => upd({ workHoursDest: v }))),
                formRow('d2', '下班时段去向', channelSelect(policy.offHoursDest, (v) => upd({ offHoursDest: v }))),
                formRow('d3', '周末去向', channelSelect(policy.weekendDest, (v) => upd({ weekendDest: v }))),
                formRow('d4', '离开时回退', channelSelect(policy.awayFallbackDest, (v) => upd({ awayFallbackDest: v })), h('span', { className: 'dr-field-hint' }, '不在电脑前时改用这个去向')),
              ),
            ),
            h('div', { className: 'dr-card' },
              h('div', { className: 'dr-card-h' }, h('div', null, h('h3', null, '微信转发目标'), h('div', { className: 'dr-card-sub' }, '去向为「微信转发」时发到哪个微信会话'))),
              h('div', { className: 'dr-form' },
                (() => {
                  const cur = (policy.wechatTarget || '').trim();
                  const known = wechatTargets.some((t) => t.id === cur);
                  const formatTarget = (t: WechatTarget): string => {
                    if (t.id === 'filehelper') return `${t.title}（系统）`;
                    const kind = t.id.endsWith('@chatroom') ? '群聊' : '私聊';
                    return t.title === t.id ? `${t.id}（${kind}）` : `${t.title}（${kind}）`;
                  };
                  const selectVal = customWechat ? '__custom__' : (cur || 'filehelper');
                  return formRow('wx', '目标会话',
                    h('select', {
                      'aria-label': '微信转发会话',
                      value: selectVal,
                      onChange: (e: ChangeEv) => {
                        const v = e.target.value;
                        if (v === '__custom__') {
                          setCustomWechat(true);
                        } else {
                          setCustomWechat(false);
                          upd({ wechatTarget: v });
                        }
                      },
                    },
                    ...wechatTargets.map((t) => h('option', { key: t.id, value: t.id }, formatTarget(t))),
                    !known && cur ? h('option', { key: `cur-${cur}`, value: cur }, `${cur}（当前保存）`) : null,
                    h('option', { key: '__custom__', value: '__custom__' }, '自定义会话 ID…')),
                    customWechat
                      ? h('input', { className: 'dr-input wide', value: policy.wechatTarget, placeholder: '输入微信会话 ID（如 wxid_xxx 或 filehelper）', onChange: (e: ChangeEv) => upd({ wechatTarget: e.target.value }) })
                      : null,
                    h('span', { className: 'dr-field-hint' }, cur ? `会话 ID：${cur}` : '从已监听的微信会话中选择'),
                  );
                })(),
              ),
            ),
            h('div', { className: `dr-savebar ${dirty ? 'dirty' : ''}` },
              h('span', { className: 'dr-dirty' }, dirty ? '● 有未保存的修改' : '偏好已与服务器同步'),
              h('div', { className: 'dr-field' },
                dirty ? h('button', { type: 'button', className: 'dr-btn ghost', disabled: busy, onClick: () => status && setPolicy(status.policy) }, '还原') : null,
                h('button', { type: 'button', className: 'dr-btn pri', disabled: busy, onClick: () => void savePolicy() }, '保存偏好'),
              ),
            ),
            h('div', { className: 'dr-card' },
              h('div', { className: 'dr-card-h' },
                h('div', null, h('h3', null, '情境预演'), h('div', { className: 'dr-card-sub' }, '按当前已保存的策略试算去向，不会发送任何通知')),
                h('button', { type: 'button', className: 'dr-btn pri', disabled: busy, onClick: () => void runPreview() }, '试算去向'),
              ),
              h('div', { className: 'dr-form' },
                formRow('pt', '模拟时间', h('input', { className: 'dr-input', type: 'datetime-local', value: pvTime, onChange: (e: ChangeEv) => setPvTime(e.target.value) })),
                formRow('pp', '在场状态', presenceSelect(pvPresence, setPvPresence)),
                formRow('pu', '紧急事件', toggle(pvUrgent, setPvUrgent, pvUrgent ? '按紧急事件处理' : '普通事件')),
              ),
              preview
                ? h('div', { className: 'dr-result' },
                    h('div', { className: 'dr-badges' },
                      badge({ label: `去向：${DEST_LABELS[preview.destination] ?? preview.destination}`, tone: 'green' }, '', 'pd'),
                      badge({ label: `时段：${SLOT_LABELS[preview.slot] ?? preview.slot}`, tone: 'neutral' }, '', 'ps'),
                      badge({ label: preview.present ? '在电脑前' : '已离开', tone: preview.present ? 'blue' : 'amber' }, '', 'pr'),
                      preview.dueAt ? badge({ label: `延后至 ${fmtAbs(preview.dueAt)}`, tone: 'violet' }, '', 'pdue') : null,
                    ),
                    h('div', { className: 'dr-result-why' }, `判定依据：${humanizeReason(preview.reason)}`),
                  )
                : null,
            ),
          );
        };

        const renderStatsTab = (): ReactNodeLike => h(Fragment, null,
          h('div', { className: 'dr-card' },
            h('div', { className: 'dr-card-h' },
              h('div', null, h('h3', null, 'Router 效果'), h('div', { className: 'dr-card-sub' }, '挡掉多少噪音、找回多少误判、推荐方案被采纳几次')),
              h('div', { className: 'dr-seg' },
                h('button', { type: 'button', className: `dr-seg-btn ${days === 7 ? 'on' : ''}`, onClick: () => { setDays(7); void reload(7); } }, '近 7 天'),
                h('button', { type: 'button', className: `dr-seg-btn ${days === 30 ? 'on' : ''}`, onClick: () => { setDays(30); void reload(30); } }, '近 30 天'),
              ),
            ),
            stats
              ? h('div', { className: 'dr-kpis' },
                  kpi('总处理事件', stats.totalEvents, { unit: '条', note: `近 ${stats.days || days} 天进入 Router 的事件` }),
                  kpi('实际通知', stats.notifiedCount, { unit: '条', bar: pct(stats.notifiedCount, stats.totalEvents), tone: 'blue', note: `通知率 ${pct(stats.notifiedCount, stats.totalEvents)}%` }),
                  kpi('分诊挡掉', stats.filteredCount, { unit: '条', bar: pct(stats.filteredCount, stats.totalEvents), note: `过滤率 ${pct(stats.filteredCount, stats.totalEvents)}% · 替你省下的打扰` }),
                  kpi('找回率', `${Math.round((stats.restoreRate || 0) * 100)}%`, { unit: `${stats.restoredCount} 条`, bar: Math.round((stats.restoreRate || 0) * 100), tone: 'amber', note: '点了「仍然通知」的比例，越低说明过滤越准' }),
                  kpi('已派 Worker', stats.dispatchedWorkers, { unit: '个' }),
                  kpi('活跃快车道', stats.activeSubscriptions, { unit: '条', note: '后续评论直接唤醒原 Worker' }),
                  kpi('推荐采纳率', `${pct(stats.recommendedPickedCount, stats.answeredDecisions)}%`, { unit: `${stats.recommendedPickedCount} / ${stats.answeredDecisions}`, bar: pct(stats.recommendedPickedCount, stats.answeredDecisions), note: '拍板时选中推荐方案的比例' }),
                )
              : h('div', { className: 'dr-card-sub', style: { marginTop: 12 } }, '正在读取统计…'),
          ),
          h('div', { className: 'dr-card' },
            h('div', { className: 'dr-card-h' }, h('div', null, h('h3', null, `活跃快车道 · ${subs.length}`), h('div', { className: 'dr-card-sub' }, '这些线程的新动态会绕过分诊，直接交给已有 Worker'))),
            subs.length === 0
              ? h('div', { className: 'dr-empty', style: { marginTop: 12 } }, '暂无活跃快车道。在分诊里点「派 Worker 建快车道」即可建立。')
              : h('div', { className: 'dr-subs' }, ...subs.map((s) => h('div', { key: s.id, className: 'dr-subrow' },
                  h('div', { style: { minWidth: 0 } },
                    h('div', { className: 'dr-dtitle' },
                      srcBadge(s.source),
                      h('span', { className: 'dr-thread' }, threadTitle(s.source, s.threadKey)),
                      badge(s.status === 'active' ? { label: '活跃', tone: 'green' } : undefined, s.status, 'ss'),
                    ),
                    h('div', { className: 'dr-sub-meta' },
                      h('span', null, '会话 ', h('span', { className: 'dr-mono' }, s.sessionId.length > 14 ? `${s.sessionId.slice(0, 12)}…` : s.sessionId)),
                      h('span', null, `归属 ${s.owner}`),
                      h('span', { title: fmtFull(s.updatedAt) }, `更新于 ${fmtRelative(s.updatedAt, now)}`),
                    ),
                  ),
                  h('div', { className: 'dr-badges' },
                    h('button', { type: 'button', className: 'dr-btn sm', onClick: () => openSession(s.sessionId) }, '打开会话'),
                    h('button', { type: 'button', className: 'dr-btn sm danger', disabled: busy, onClick: () => void removeSub(s.source, s.threadKey) }, '解除订阅'),
                  ),
                ))),
          ),
        );

        const presenceText = !status ? '读取中' : status.presenceMode === 'auto' ? `自动 · ${status.webActive ? '在电脑前' : '已离开'}` : PRESENCE_LABELS[status.presenceMode];
        const away = Boolean(status && (status.presenceMode === 'away' || (status.presenceMode === 'auto' && !status.webActive)));
        const nextNode = !status
          ? h('div', { className: 'dr-next' }, '正在读取 Router 状态…')
          : !status.enabled
            ? h('div', { className: 'dr-next off' }, 'Router 已暂停：新事件不会分诊或通知')
            : pendingAll.length > 0
              ? h('button', { type: 'button', className: 'dr-next hot', onClick: () => { setTab('decisions'); setFilter('all'); } }, `${pendingAll.length} 件事等你拍板 →`)
              : unreadCount > 0
                ? h('button', { type: 'button', className: 'dr-next hot', onClick: () => setTab('notifications') }, `${unreadCount} 条提醒未读 →`)
                : h('div', { className: 'dr-next' }, '没有需要你处理的事');
        const chip = (key: string, label: string, value: string, warn = false): ReactNodeLike => h('span', { key, className: `dr-chip ${warn ? 'warn' : ''}` }, label, h('b', null, value));
        const tabs: Array<{ id: TabId; label: string; count: number | null; hot: boolean }> = [
          { id: 'decisions', label: '分诊', count: pendingAll.length, hot: pendingAll.length > 0 },
          { id: 'notifications', label: '提醒队列', count: unreadCount, hot: unreadCount > 0 },
          { id: 'policy', label: '注意力与作息', count: null, hot: false },
          { id: 'stats', label: '效果与快车道', count: subs.length, hot: false },
        ];

        return h('section', { className: 'dr-root', 'aria-label': 'Router' },
          h('style', null, CSS),
          h('div', { className: 'dr-wrap' },
            h('header', { className: 'dr-top' },
              h('div', { className: 'dr-brand' },
                h('div', { className: 'dr-logo' }, RouterIcon({ size: 20 })),
                h('div', null, h('h1', null, 'Router'), nextNode),
              ),
              h('div', { className: 'dr-top-right' },
                h('button', { type: 'button', role: 'switch', 'aria-checked': Boolean(status?.enabled), className: `dr-switch ${status?.enabled ? 'on' : ''}`, disabled: busy || !status, onClick: () => void toggleEnabled() },
                  h('i', null), status?.enabled ? '已开启' : '已暂停'),
                h('button', { type: 'button', className: 'dr-btn ghost', disabled: busy, onClick: () => void reload() }, '刷新'),
              ),
            ),
            status
              ? h('div', { className: 'dr-chips' },
                  chip('slot', '当前时段', SLOT_LABELS[status.currentSlot] ?? status.currentSlot),
                  chip('dest', '默认去向', DEST_LABELS[status.currentDestination] ?? status.currentDestination),
                  chip('presence', '在场', presenceText, away),
                  chip('subs', '活跃快车道', String(status.activeSubscriptions ?? subs.length)),
                )
              : null,
            err ? h('div', { className: 'dr-alert err', role: 'alert' }, h('span', null, err), h('button', { type: 'button', className: 'dr-x', 'aria-label': '关闭', onClick: () => setErr('') }, '×')) : null,
            msg ? h('div', { className: 'dr-alert ok', role: 'status' }, h('span', null, `✓ ${msg}`), h('button', { type: 'button', className: 'dr-x', 'aria-label': '关闭', onClick: () => setMsg('') }, '×')) : null,
            h('nav', { className: 'dr-tabs', role: 'tablist' }, ...tabs.map((t) =>
              h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': tab === t.id, className: `dr-tab ${tab === t.id ? 'on' : ''}`, onClick: () => setTab(t.id) },
                t.label,
                t.count !== null && t.count > 0 ? h('span', { className: `dr-tab-n ${t.hot ? 'hot' : ''}` }, String(t.count)) : null),
            )),
            tab === 'decisions' ? renderDecisionsTab() : null,
            tab === 'notifications' ? renderNotificationsTab() : null,
            tab === 'policy' ? renderPolicyTab() : null,
            tab === 'stats' ? renderStatsTab() : null,
          ),
        );
      }

      return {
        inject: ['slots', 'uiWorkspace'],
        apply(ctx: SlotContext): void {
          openSession = (id: string) => ctx.uiWorkspace?.openSession?.(id);
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, RouterPanel));
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => 'Router' }, RouterIcon));
        },
      };
    },
  });
})();
