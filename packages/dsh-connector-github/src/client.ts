(() => {
  type ReactNodeLike = unknown;
  type StateSetter<T> = (next: T | ((prev: T) => T)) => void;
  interface ReactLike {
    Fragment: unknown;
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactNodeLike;
    useState<T>(initial: T | (() => T)): [T, StateSetter<T>];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  }
  interface ChangeEv { target: { value: string; checked?: boolean; files?: FileList | null }; }
  interface AppView {
    configured: boolean;
    appId: number | null;
    slug: string | null;
    defaultRepo?: string | null;
    installationId?: number | null;
    botLogin?: string | null;
    permissions?: Record<string, string>;
  }
  interface AuthView {
    configured: boolean;
    source: string;
    login: string | null;
    scopes: string[];
    notificationsScopeMissing: boolean;
    hasBotToken: boolean;
    botLogin?: string | null;
    actMode?: string;
    githubApp?: AppView | null;
  }
  interface RepoItem {
    repo: string;
    localPath?: string;
    autoSend?: boolean;
    personaId?: string | null;
    enabled?: boolean;
  }
  interface PinItem { repo: string; number: number; linkedPrs: number[]; watchReactions: boolean; }
  interface ConfigView {
    authStatus: AuthView;
    enableNotifications: boolean;
    pollIntervalMs: number;
    autoSendOwners: string[];
    defaultPersonaId?: string | null;
    repos: RepoItem[];
    pinnedItems: PinItem[];
  }
  interface PersonaItem { id: string; name: string; kind: string; }
  interface RawEventItem {
    id: string;
    source?: string;
    type: string;
    repo?: string | null;
    number?: number | null;
    entityKey?: string | null;
    threadKey?: string | null;
    actor?: string | { login?: string } | null;
    summary?: string | null;
    url?: string | null;
    occurredAt: string;
    ingestedAt?: string | null;
    rawRef?: { url?: string; repo?: string } | null;
  }
  type TabId = 'inbox' | 'repos' | 'settings';
  type Cat = 'all' | 'issue' | 'pr' | 'social';
  type Kind = 'issue' | 'pr' | 'pin' | 'comment' | 'other';
  type Role = 'head' | 'comment' | 'other';
  type Tone = 'neutral' | 'muted' | 'green' | 'amber' | 'blue' | 'violet' | 'red';
  interface Meta { label: string; tone: Tone; }
  interface EvView { id: string; type: string; kind: Kind; role: Role; label: string; actor: string; summary: string; url: string | null; occurredAt: string; ingestedAt: string | null; ts: number; }
  interface ThreadView {
    key: string;
    title: string;
    repo: string | null;
    number: number | null;
    entity: Kind;
    events: EvView[];
    latest: EvView;
    head: EvView;
    headIsMain: boolean;
    rest: EvView[];
    url: string | null;
    social: boolean;
    haystack: string;
  }
  interface LoaderWin {
    __ModuleLoader__: {
      load: (entry: { id: string; factory: (req: (id: string) => unknown) => { inject: string[]; apply: (ctx: SlotCtx) => void } }) => void;
    };
  }
  interface SlotCtx {
    slots: {
      inject: (name: string, fn: () => unknown) => unknown;
      register: (slot: Record<string, unknown>, comp: unknown) => unknown;
    };
  }

  (window as unknown as LoaderWin).__ModuleLoader__.load({
    id: '@local/dsh-connector-github',
    factory(requireModule: (id: string) => unknown) {
      const React = requireModule('react') as ReactLike;
      const { createElement: h, useState, useEffect, useCallback, useMemo, Fragment } = React;
      const PANEL_ID = 'dsh-connector-github-panel';

      const KIND_META: Record<Kind, Meta> = {
        issue: { label: 'Issue', tone: 'green' },
        pr: { label: 'PR', tone: 'violet' },
        pin: { label: '盯防', tone: 'amber' },
        comment: { label: '评论', tone: 'blue' },
        other: { label: '动态', tone: 'neutral' },
      };
      const TYPE_LABELS: Record<string, string> = {
        'github.issue.updated': 'Issue 更新',
        'github.issue.labeled': 'Issue 标签变更',
        'github.issue.comment': 'Issue 新评论',
        'github.issue_comment': '新评论',
        'github.pr.updated': 'PR 更新',
        'github.pr.comment': 'PR 新评论',
        'github.pr.labeled': 'PR 标签变更',
        'github.pr.ready_for_review': 'PR 可审阅',
        'github.pr.review_requested': '请求审阅',
        'github.pinned.activity': '盯防动态',
        'github.reaction.delta': 'Reaction 变化',
        'github.notification.mention': '@ 提及',
        'github.notification': '账号通知',
        'github.event': '仓库动态',
        'github.draft': '回复草稿',
      };
      const CATS: Array<{ id: Cat; label: string }> = [
        { id: 'all', label: '全部' },
        { id: 'issue', label: 'Issue' },
        { id: 'pr', label: 'PR' },
        { id: 'social', label: '评论与盯防' },
      ];

      function kindOf(type: string): Kind {
        const t = (type || '').toLowerCase();
        if (t.includes('pinned') || t.includes('reaction')) return 'pin';
        if (t.includes('comment') || t.includes('mention')) return 'comment';
        if (t.startsWith('github.pr') || t.includes('pull')) return 'pr';
        if (t.startsWith('github.issue')) return 'issue';
        return 'other';
      }

      function entityOf(type: string): Kind | null {
        const t = (type || '').toLowerCase();
        if (t.startsWith('github.pr') || t.includes('pull_request')) return 'pr';
        if (t.startsWith('github.issue')) return 'issue';
        return null;
      }

      const COMMENT_URL = /#(issuecomment-|discussion_r|pullrequestreview-|commitcomment-)/i;
      const HEAD_URL = /\/(issues|pull)\/\d+\/?$/i;
      const HEAD_TYPES = new Set([
        'github.issue.updated', 'github.pr.updated',
        'github.issue.opened', 'github.pr.opened',
        'github.issue.edited', 'github.pr.edited',
        'github.issue.reopened', 'github.pr.reopened',
        'github.issue.closed', 'github.pr.closed', 'github.pr.merged',
        'issues.opened', 'issues.edited', 'issues.reopened', 'issues.closed',
        'pull_request.opened', 'pull_request.edited', 'pull_request.reopened', 'pull_request.closed',
      ]);

      function roleOf(type: string, url: string | null): Role {
        const t = (type || '').toLowerCase();
        const u = url || '';
        if (COMMENT_URL.test(u) || t.includes('comment') || t.includes('pinned.activity') || t.includes('reaction')) return 'comment';
        if (HEAD_URL.test(u) || HEAD_TYPES.has(t)) return 'head';
        return 'other';
      }

      function urlEntity(url: string | null): Kind | null {
        if (!url) return null;
        if (/\/pull\/\d+/i.test(url)) return 'pr';
        if (/\/issues\/\d+/i.test(url)) return 'issue';
        return null;
      }

      function headNoun(ev: EvView, entity: Kind): 'Issue' | 'PR' {
        const k = urlEntity(ev.url) ?? entityOf(ev.type) ?? (entity === 'pr' ? 'pr' : 'issue');
        return k === 'pr' ? 'PR' : 'Issue';
      }

      function whenPrefix(ev: EvView, entity: Kind): string {
        if (ev.role === 'comment') return '评论于';
        if (ev.role === 'head') return `${headNoun(ev, entity)} 于`;
        return '动态于';
      }

      function validIso(s: string | null | undefined): string | null {
        return s && Number.isFinite(Date.parse(s)) ? s : null;
      }

      function typeLabel(type: string): string {
        const t = (type || '').toLowerCase();
        return TYPE_LABELS[t] ?? (t.replace(/^github\./, '').replace(/[._]+/g, ' ') || '动态');
      }

      function stripPrefix(k: string | null | undefined): string {
        let t = (k || '').trim();
        while (/^github:/i.test(t)) t = t.slice(7).trim();
        return t;
      }

      function parseRef(k: string): { repo: string; number: number } | null {
        const m = /^([^/\s#]+\/[^#\s]+)\s*#(\d+)$/.exec(k);
        return m ? { repo: m[1], number: Number(m[2]) } : null;
      }

      function actorOf(a: RawEventItem['actor']): string {
        if (!a) return 'github';
        if (typeof a === 'string') return a.replace(/^@/, '') || 'github';
        return a.login || 'github';
      }

      function cleanSummary(s: string | null | undefined): string {
        return (s || '')
          .replace(/\r\n?/g, '\n')
          .replace(/\s+/g, ' ')
          .replace(/^\[?[\w.-]+\/[\w.-]+\s*#\d+\]?\s*[:：\-–—]?\s*/, '')
          .trim();
      }

      function safeUrl(u: string | null | undefined): string | null {
        return u && /^https?:\/\/[^\s]+$/i.test(u) ? u : null;
      }

      function pad2(n: number): string {
        return String(n).padStart(2, '0');
      }

      function fmtFull(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso || '';
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      }

      function fmtRelative(iso: string, now: number): string {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return iso || '';
        const abs = Math.abs(now - t);
        if (abs < 60000) return '刚刚';
        const min = Math.round(abs / 60000);
        if (min < 60) return `${min} 分钟前`;
        const hr = Math.round(min / 60);
        if (hr < 24) return `${hr} 小时前`;
        const day = Math.round(hr / 24);
        if (day < 7) return `${day} 天前`;
        const d = new Date(t);
        return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      }

      function buildThreads(events: RawEventItem[]): ThreadView[] {
        const map = new Map<string, { key: string; title: string; repo: string | null; number: number | null; entity: Kind | null; events: EvView[] }>();
        for (const ev of events) {
          const ref = parseRef(stripPrefix(ev.entityKey)) ?? parseRef(stripPrefix(ev.threadKey));
          const repo = ev.repo || ref?.repo || ev.rawRef?.repo || null;
          const num = typeof ev.number === 'number' ? ev.number : ref?.number ?? null;
          const base = stripPrefix(ev.threadKey) || stripPrefix(ev.entityKey) || (repo && num !== null ? `${repo}#${num}` : `id:${ev.id}`);
          const key = base.toLowerCase();
          const ts = Date.parse(ev.occurredAt);
          const url = safeUrl(ev.url) ?? safeUrl(ev.rawRef?.url);
          const view: EvView = {
            id: ev.id,
            type: ev.type,
            kind: kindOf(ev.type),
            role: roleOf(ev.type, url),
            label: typeLabel(ev.type),
            actor: actorOf(ev.actor),
            summary: cleanSummary(ev.summary),
            url,
            occurredAt: ev.occurredAt,
            ingestedAt: validIso(ev.ingestedAt),
            ts: Number.isFinite(ts) ? ts : 0,
          };
          let g = map.get(key);
          if (!g) {
            const title = repo && num !== null ? `${repo} #${num}` : base.startsWith('id:') ? repo || 'GitHub 动态' : base;
            g = { key, title, repo, number: num, entity: null, events: [] };
            map.set(key, g);
          }
          if (!g.repo && repo) g.repo = repo;
          if (g.number === null && num !== null) g.number = num;
          g.entity = g.entity ?? entityOf(ev.type);
          g.events.push(view);
        }
        const out: ThreadView[] = [];
        for (const g of map.values()) {
          const seen = new Set<string>();
          const evs = g.events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => b.ts - a.ts);
          const latest = evs[0];
          const mainHead = evs.find((e) => e.role === 'head');
          const head = mainHead ?? [...evs].reverse().find((e) => e.role === 'comment') ?? evs[evs.length - 1];
          const rest = evs.filter((e) => e !== head).sort((a, b) => a.ts - b.ts);
          const entity: Kind = g.entity ?? urlEntity(head.url) ?? evs.map((e) => urlEntity(e.url)).find((k) => k !== null) ?? latest.kind;
          const direct = (head.role === 'head' ? head.url : null) ?? evs.find((e) => e.url)?.url ?? null;
          const url = direct ?? (g.repo && g.number !== null ? `https://github.com/${g.repo}/${entity === 'pr' ? 'pull' : 'issues'}/${g.number}` : null);
          const haystack = [g.title, g.repo || '', g.number !== null ? `#${g.number}` : '', ...evs.map((e) => `${e.summary} @${e.actor} ${e.label}`)].join(' ').toLowerCase();
          out.push({ key: g.key, title: g.title, repo: g.repo, number: g.number, entity, events: evs, latest, head, headIsMain: Boolean(mainHead), rest, url, social: evs.some((e) => e.kind === 'pin' || e.kind === 'comment'), haystack });
        }
        return out.sort((a, b) => b.latest.ts - a.latest.ts);
      }

      function inCat(t: ThreadView, c: Cat): boolean {
        if (c === 'issue') return t.entity === 'issue';
        if (c === 'pr') return t.entity === 'pr';
        if (c === 'social') return t.social;
        return true;
      }

      const CSS_BASE = [
        '.gh-root{--bg:#f6f7f5;--card:#fff;--line:#e3e8e5;--line2:#eef1ef;--ink:#1c2621;--ink2:#4b5952;--ink3:#87948d;--brand:#1f6f50;--brand-soft:#e8f3ee;--amber:#9a5b00;--amber-soft:#fff5e3;--amber-line:#f1d39f;--blue:#2459a8;--blue-soft:#eaf1fb;--violet:#6941c6;--violet-soft:#f2edfd;--red:#b42318;--red-soft:#fdecea;height:100%;overflow:auto;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}',
        '.gh-root *{box-sizing:border-box}',
        '.gh-wrap{max-width:980px;margin:0 auto;padding:20px 24px 64px}',
        '.gh-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}',
        '.gh-brand{display:flex;align-items:center;gap:12px;min-width:0}',
        '.gh-logo{width:36px;height:36px;border-radius:10px;background:#24292f;color:#fff;display:flex;align-items:center;justify-content:center;flex:none}',
        '.gh-brand h1{margin:0;font-size:18px;font-weight:650;line-height:1.25}',
        '.gh-next{appearance:none;border:0;background:none;padding:0;font:inherit;font-size:13px;color:var(--ink2);text-align:left}',
        '.gh-next.hot{color:var(--amber);font-weight:600;cursor:pointer}',
        '.gh-top-right{display:flex;align-items:center;gap:8px}',
        '.gh-chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 14px}',
        '.gh-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card);font-size:12px;color:var(--ink3)}',
        '.gh-chip b{font-weight:600;color:var(--ink)}',
        '.gh-chip.warn{border-color:var(--amber-line);background:var(--amber-soft)}',
        '.gh-chip.ok b{color:var(--brand)}',
        '.gh-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:16px;overflow-x:auto}',
        '.gh-tab{appearance:none;border:0;background:none;padding:9px 14px;font:inherit;color:var(--ink2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
        '.gh-tab:hover{color:var(--ink)}',
        '.gh-tab.on{color:var(--brand);border-bottom-color:var(--brand);font-weight:600}',
        '.gh-tab-n{min-width:18px;height:18px;padding:0 6px;border-radius:9px;background:var(--line2);color:var(--ink2);font-size:11px;line-height:18px;text-align:center;font-weight:600}',
        '.gh-tab-n.hot{background:var(--amber);color:#fff}',
        '.gh-btn{appearance:none;font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none;line-height:1.4;white-space:nowrap;transition:background .12s,border-color .12s}',
        '.gh-btn:hover{border-color:#c6d0ca;background:#fafbfa}',
        '.gh-btn:disabled{opacity:.5;cursor:default}',
        '.gh-btn.pri{background:var(--brand);border-color:var(--brand);color:#fff}',
        '.gh-btn.pri:hover{background:#185c42}',
        '.gh-btn.ghost{background:transparent;border-color:transparent;color:var(--ink2)}',
        '.gh-btn.ghost:hover{background:var(--line2)}',
        '.gh-btn.sm{font-size:12px;padding:3px 9px;border-radius:6px}',
        '.gh-btn.danger:hover{color:var(--red);border-color:#f0b8b2;background:var(--red-soft)}',
        '.gh-toggle{display:inline-flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--ink2);position:relative}',
        '.gh-toggle input{position:absolute;opacity:0;width:0;height:0;margin:0}',
        '.gh-toggle i{width:32px;height:18px;border-radius:9px;background:#cdd5d0;position:relative;flex:none;transition:background .15s}',
        '.gh-toggle i:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}',
        '.gh-toggle input:checked+i{background:var(--brand)}',
        '.gh-toggle input:checked+i:after{left:16px}',
        '.gh-toggle input:focus-visible+i{box-shadow:0 0 0 3px rgba(31,111,80,.2)}',
        '.gh-alert{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:13px}',
        '.gh-alert.err{background:var(--red-soft);color:var(--red)}',
        '.gh-alert.ok{background:var(--brand-soft);color:var(--brand)}',
        '.gh-alert.warn{background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line)}',
        '.gh-x{appearance:none;border:0;background:none;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 4px;opacity:.7}',
        '.gh-empty{padding:28px 16px;text-align:center;color:var(--ink3);font-size:13px;background:var(--card);border:1px dashed var(--line);border-radius:12px}',
        '.gh-foot{margin-top:6px;font-size:12px;color:var(--ink3);text-align:center}',
      ].join('');

      const CSS_CARD = [
        '.gh-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,20,.03);position:relative}',
        '.gh-thread:before{content:"";position:absolute;left:-1px;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--line)}',
        '.gh-thread.k-issue:before{background:#3f9b72}.gh-thread.k-pr:before{background:#8b6ad8}.gh-thread.k-pin:before{background:#e39b17}.gh-thread.k-comment:before{background:#4f86d8}',
        '.gh-thead{display:flex;justify-content:space-between;align-items:flex-start;gap:8px 12px;flex-wrap:wrap}',
        '.gh-ttitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
        '.gh-tname{font-weight:650;color:var(--ink);word-break:break-word}',
        '.gh-tname .gh-num{color:var(--ink3);font-weight:600;margin-left:4px}',
        '.gh-tside{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.gh-tmeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:12.5px}',
        '.gh-evlabel{color:var(--ink2);font-weight:600}',
        '.gh-actor{color:var(--ink2)}',
        '.gh-time{color:var(--ink3);font-size:12px;white-space:nowrap;cursor:default}',
        '.gh-sep{color:var(--line)}',
        '.gh-times{display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:var(--ink3)}',
        '.gh-when{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}',
        '.gh-when-k{color:var(--ink2)}',
        '.gh-when.ing .gh-when-k{color:var(--ink3)}',
        '.gh-floor{font-variant-numeric:tabular-nums}',
        '.gh-sum{margin-top:8px;color:var(--ink);font-size:14px;line-height:1.65;word-break:break-word;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}',
        '.gh-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:500;white-space:nowrap}',
        '.gh-badge.strong{font-weight:650}',
        '.t-neutral{background:var(--line2);color:var(--ink2)}.t-muted{background:#f1f3f2;color:var(--ink3)}.t-green{background:var(--brand-soft);color:var(--brand)}',
        '.t-amber{background:var(--amber-soft);color:var(--amber)}.t-blue{background:var(--blue-soft);color:var(--blue)}.t-violet{background:var(--violet-soft);color:var(--violet)}.t-red{background:var(--red-soft);color:var(--red)}',
        '.gh-more{appearance:none;border:0;background:none;padding:6px 0 0;font:inherit;font-size:12.5px;color:var(--brand);cursor:pointer;font-weight:600}',
        '.gh-tl{list-style:none;margin:10px 0 0;padding:4px 0 0 18px;border-top:1px dashed var(--line);position:relative}',
        '.gh-tl-item{position:relative;padding:8px 0 8px 4px}',
        '.gh-tl-item:before{content:"";position:absolute;left:-13px;top:0;bottom:0;width:2px;background:var(--line2)}',
        '.gh-tl-item:after{content:"";position:absolute;left:-17px;top:14px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #b8c4bd}',
        '.gh-tl-item.k-issue:after{border-color:#3f9b72}.gh-tl-item.k-pr:after{border-color:#8b6ad8}.gh-tl-item.k-pin:after{border-color:#e39b17}.gh-tl-item.k-comment:after{border-color:#4f86d8}',
        '.gh-tl-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}',
        '.gh-tl-sum{margin-top:3px;color:var(--ink2);font-size:13px;line-height:1.55;word-break:break-word}',
        '.gh-link{color:var(--blue);text-decoration:none;font-size:12px}',
        '.gh-link:hover{text-decoration:underline}',
        '.gh-card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}',
        '.gh-card-h h3{margin:0;font-size:14.5px;font-weight:650;display:flex;align-items:center;gap:8px}',
        '.gh-card-sub{font-size:12.5px;color:var(--ink3);margin-top:2px}',
      ].join('');

      const CSS_FORM = [
        '.gh-toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px;position:sticky;top:0;z-index:2;background:var(--bg);padding:6px 0}',
        '.gh-tools-r{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1 1 280px;justify-content:flex-end}',
        '.gh-seg{display:inline-flex;gap:2px;padding:3px;background:#eaedeb;border-radius:10px;flex-wrap:wrap}',
        '.gh-seg-btn{appearance:none;border:0;background:transparent;font:inherit;font-size:12.5px;color:var(--ink2);padding:5px 10px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
        '.gh-seg-btn:hover{color:var(--ink)}',
        '.gh-seg-btn.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}',
        '.gh-seg-n{font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}',
        '.gh-seg-btn.on .gh-seg-n{color:var(--brand)}',
        '.gh-input,.gh-root select,.gh-root textarea{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);outline:none;min-width:0}',
        '.gh-input:focus,.gh-root select:focus,.gh-root textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(31,111,80,.12)}',
        '.gh-search{flex:1 1 180px;max-width:260px}',
        '.gh-root select{max-width:240px}',
        '.gh-root textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;resize:vertical}',
        '.gh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
        '.gh-items{margin-top:10px}',
        '.gh-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--line2);flex-wrap:wrap}',
        '.gh-item:first-child{border-top:0}',
        '.gh-item-main{flex:1 1 260px;min-width:0}',
        '.gh-item-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600}',
        '.gh-item-sub{margin-top:3px;color:var(--ink3);word-break:break-all}',
        '.gh-item-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
        '.gh-add{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;padding:12px;border-radius:10px;background:#f7f9f8;border:1px dashed var(--line)}',
        '.gh-add .gh-input{flex:1 1 160px}',
        '.gh-add .gh-input.num{flex:0 0 96px}',
        '.gh-add-label{font-size:12px;font-weight:600;color:var(--ink2);flex:0 0 100%}',
        '.gh-form{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px 18px;align-items:center;margin-top:14px}',
        '.gh-label{font-size:13px;color:var(--ink2);font-weight:500}',
        '.gh-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:13px;color:var(--ink2)}',
        '.gh-field .gh-input{flex:1 1 220px;max-width:360px}',
        '.gh-field .gh-input.num{flex:0 0 90px}',
        '.gh-hint{font-size:12px;color:var(--ink3)}',
        '.gh-actrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}',
        '.gh-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin-top:14px}',
        '.gh-kv-cell{border:1px solid var(--line2);border-radius:10px;padding:10px 12px;background:#fbfcfb;min-width:0}',
        '.gh-kv-k{font-size:12px;color:var(--ink3)}',
        '.gh-kv-v{font-weight:600;margin-top:2px;word-break:break-all;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.gh-fold-btn{appearance:none;border:0;background:none;padding:0;font:inherit;font-size:13px;color:var(--brand);cursor:pointer;font-weight:600;margin-top:10px}',
        '.gh-fold-body{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}',
        '.gh-fold-body .gh-field{margin-bottom:10px}',
        '@media (max-width:640px){.gh-wrap{padding:16px 14px 48px}.gh-form{grid-template-columns:1fr;gap:4px 0}.gh-label{margin-top:10px}.gh-search{max-width:none}.gh-tools-r{justify-content:flex-start}}',
      ].join('');
      const CSS = CSS_BASE + CSS_CARD + CSS_FORM;

      async function api<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(path, {
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          ...init,
        });
        const data = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        return data;
      }

      function jumpToPersonaWardrobe(onFallback: (msg: string) => void): void {
        const btns = Array.from(document.querySelectorAll('button,[role="button"],a'));
        const target = btns.find((el) => {
          const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
          return t === '性格衣柜';
        });
        if (target && typeof (target as HTMLElement).click === 'function') {
          (target as HTMLElement).click();
          return;
        }
        onFallback('请点击左侧边栏「性格衣柜」统一编辑人物设定与记忆。');
      }

      function badge(meta: Meta, key?: string, strong = false): ReactNodeLike {
        return h('span', { key, className: `gh-badge t-${meta.tone}${strong ? ' strong' : ''}` }, meta.label);
      }

      function toggle(checked: boolean, onChange: (v: boolean) => void, text: string): ReactNodeLike {
        return h('label', { className: 'gh-toggle' },
          h('input', { type: 'checkbox', checked, onChange: (e: ChangeEv) => onChange(Boolean(e.target.checked)) }),
          h('i', null),
          h('span', null, text),
        );
      }

      function formRow(key: string, label: string, ...controls: unknown[]): ReactNodeLike {
        return h(Fragment, { key },
          h('div', { className: 'gh-label' }, label),
          h('div', { className: 'gh-field' }, ...controls),
        );
      }

      function kv(key: string, label: string, ...value: unknown[]): ReactNodeLike {
        return h('div', { key, className: 'gh-kv-cell' },
          h('div', { className: 'gh-kv-k' }, label),
          h('div', { className: 'gh-kv-v' }, ...value),
        );
      }

      function whenEl(key: string, cls: string, label: string, iso: string, now: number): ReactNodeLike {
        return h('span', { key, className: `gh-when ${cls}` },
          h('span', { className: 'gh-when-k' }, label),
          h('time', { className: 'gh-time', dateTime: iso, title: fmtFull(iso) }, fmtRelative(iso, now)),
        );
      }

      function timesEl(ev: EvView, prefix: string, now: number): ReactNodeLike {
        const ing = ev.ingestedAt;
        return h('div', { className: 'gh-times' },
          whenEl('src', 'src', prefix, ev.occurredAt, now),
          ing ? h('span', { key: 'sep', className: 'gh-sep' }, '·') : null,
          ing ? whenEl('ing', 'ing', '拉取于', ing, now) : null,
        );
      }

      function extLink(url: string | null, text: string, cls = 'gh-link'): ReactNodeLike | null {
        return url ? h('a', { className: cls, href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : null;
      }

      function GitHubPanel(): ReactNodeLike {
        const [cfg, setCfg] = useState<ConfigView | null>(null);
        const [personas, setPersonas] = useState<PersonaItem[]>([]);
        const [events, setEvents] = useState<RawEventItem[]>([]);
        const [busy, setBusy] = useState(false);
        const [err, setErr] = useState('');
        const [msg, setMsg] = useState('');
        const [tab, setTab] = useState<TabId>('inbox');
        const [cat, setCat] = useState<Cat>('all');
        const [repoFilter, setRepoFilter] = useState('');
        const [query, setQuery] = useState('');
        const [expanded, setExpanded] = useState<Record<string, boolean>>({});
        const [now, setNow] = useState(() => Date.now());
        const [appOpen, setAppOpen] = useState<boolean | null>(null);
        const [tokOpen, setTokOpen] = useState<boolean | null>(null);
        const [slot, setSlot] = useState<'read' | 'act'>('read');
        const [tok, setTok] = useState('');
        const [appId, setAppId] = useState('');
        const [appSlug, setAppSlug] = useState('');
        const [appRepo, setAppRepo] = useState('');
        const [appPem, setAppPem] = useState('');
        const [ownersText, setOwnersText] = useState('');
        const [intervalSec, setIntervalSec] = useState('60');
        const [enableNotif, setEnableNotif] = useState(true);
        const [defaultPersonaId, setDefaultPersonaId] = useState('');
        const [repos, setRepos] = useState<RepoItem[]>([]);
        const [pins, setPins] = useState<PinItem[]>([]);
        const [newRepo, setNewRepo] = useState('');
        const [newPath, setNewPath] = useState('');
        const [newRepoPersona, setNewRepoPersona] = useState('');
        const [newPinRepo, setNewPinRepo] = useState('');
        const [newPinNum, setNewPinNum] = useState('');

        const syncCfg = useCallback((c: ConfigView) => {
          setCfg(c);
          setEnableNotif(c.enableNotifications !== false);
          setIntervalSec(String(Math.round((c.pollIntervalMs || 60000) / 1000)));
          setOwnersText((c.autoSendOwners || []).join(', '));
          setDefaultPersonaId(c.defaultPersonaId || '');
          setRepos(c.repos || []);
          setPins(c.pinnedItems || []);
          const ga = c.authStatus?.githubApp;
          if (ga?.configured) {
            if (ga.appId) setAppId(String(ga.appId));
            if (ga.slug) setAppSlug(ga.slug);
            if (ga.defaultRepo) setAppRepo(ga.defaultRepo);
          }
        }, []);

        const loadAll = useCallback(async () => {
          try {
            const [c, p, e] = await Promise.all([
              api<ConfigView>('/connector/github/config'),
              api<{ personas: PersonaItem[] }>('/connector/github/personas').catch(() => ({ personas: [] })),
              api<{ events: RawEventItem[] }>('/connector/github/events').catch(() => ({ events: [] })),
            ]);
            syncCfg(c);
            setPersonas(p.personas || []);
            setEvents(Array.isArray(e.events) ? e.events : []);
            setNow(Date.now());
            setErr('');
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : String(ex));
          }
        }, [syncCfg]);

        useEffect(() => {
          void loadAll();
        }, [loadAll]);

        useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), 60000);
          return () => clearInterval(timer);
        }, []);

        const run = async (fn: () => Promise<void>): Promise<void> => {
          setBusy(true);
          setErr('');
          setMsg('');
          try {
            await fn();
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message : String(ex));
          } finally {
            setBusy(false);
          }
        };

        const saveConfig = async (nextRepos = repos, nextPins = pins, okText = 'GitHub 连接器配置已热生效。'): Promise<void> => {
          await run(async () => {
            const updated = await api<ConfigView>('/connector/github/config', {
              method: 'PUT',
              body: JSON.stringify({
                enableNotifications: enableNotif,
                pollIntervalMs: Math.max(15, Number(intervalSec) || 60) * 1000,
                autoSendOwners: ownersText.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean),
                defaultPersonaId: defaultPersonaId || null,
                repos: nextRepos,
                pinnedItems: nextPins,
              }),
            });
            syncCfg(updated);
            setMsg(okText);
          });
        };

        const pollNow = (): void => void run(async () => {
          const r = await api<{ polled: number; events: number }>('/connector/github/poll', { method: 'POST', body: '{}' });
          await loadAll();
          setMsg(`立即拉取完成：检查 ${r.polled} 项，新事件 ${r.events} 条。`);
        });

        const threads = useMemo(() => buildThreads(events), [events]);
        const auth = cfg?.authStatus;
        const ga = auth?.githubApp;
        const botName = ga?.botLogin || auth?.botLogin || (ga?.slug ? `${ga.slug}[bot]` : 'github-app[bot]');
        const actLabel =
          auth?.actMode === 'app'
            ? `GitHub App (${ga?.botLogin || auth.botLogin || 'bot'})`
            : auth?.actMode === 'token'
              ? `静态 Bot Token (${auth.botLogin || '已配置'})`
              : '复用 Read 账号';
        const readOk = Boolean(auth?.configured && !auth.notificationsScopeMissing);
        const readLabel = !auth?.configured ? '未配置' : auth.notificationsScopeMissing ? '缺 notifications' : '连接正常';
        const personaName = (id: string | null | undefined): string => (id ? personas.find((p) => p.id === id)?.name || id : '');
        const owners = ownersText.split(/[\s,，]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const pinKeys = new Set(pins.map((p) => `${p.repo}#${p.number}`.toLowerCase()));
        const appExpanded = cfg ? appOpen ?? !ga?.configured : false;
        const tokExpanded = cfg ? tokOpen ?? !auth?.configured : false;
        const goAuth = (): void => {
          setTab('settings');
          setTokOpen(true);
          setSlot('read');
        };

        const repoOptions = useMemo(() => {
          const set = new Map<string, string>();
          for (const r of repos) set.set(r.repo.toLowerCase(), r.repo);
          for (const t of threads) if (t.repo) set.set(t.repo.toLowerCase(), t.repo);
          return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
        }, [repos, threads]);

        const repoScoped = repoFilter ? threads.filter((t) => (t.repo || '').toLowerCase() === repoFilter.toLowerCase()) : threads;
        const q = query.trim().toLowerCase().replace(/^@/, '@');
        const visible = repoScoped.filter((t) => inCat(t, cat) && (!q || t.haystack.includes(q)));
        const filtering = cat !== 'all' || Boolean(repoFilter) || Boolean(q);

        const renderThread = (t: ThreadView): ReactNodeLike => {
          const open = Boolean(expanded[t.key]);
          const head = t.head;
          const rest = t.rest;
          const noun = headNoun(head, t.entity);
          const headMeta: Meta = t.headIsMain
            ? { label: `${noun} 主楼`, tone: noun === 'PR' ? 'violet' : 'green' }
            : head.role === 'comment'
              ? { label: '评论', tone: 'blue' }
              : KIND_META[head.kind];
          const pinned = t.repo && t.number !== null && pinKeys.has(`${t.repo}#${t.number}`.toLowerCase());
          return h('article', { key: t.key, className: `gh-card gh-thread k-${t.entity}` },
            h('div', { className: 'gh-thead' },
              h('div', { className: 'gh-ttitle' },
                badge(KIND_META[t.entity], 'kind', true),
                pinned && t.entity !== 'pin' ? badge({ label: '重点盯防', tone: 'amber' }, 'pin') : null,
                h('span', { className: 'gh-tname' },
                  t.repo && t.number !== null ? t.repo : t.title,
                  t.repo && t.number !== null ? h('span', { className: 'gh-num' }, `#${t.number}`) : null),
              ),
              h('div', { className: 'gh-tside' },
                t.events.length > 1 ? badge({ label: `共 ${t.events.length} 条动态`, tone: 'neutral' }, 'n') : null,
                extLink(t.url, '在 GitHub 打开 ↗', 'gh-btn sm'),
              ),
            ),
            h('div', { className: 'gh-tmeta' },
              badge(headMeta, 'role', true),
              h('span', { className: 'gh-evlabel' }, head.label),
              h('span', { className: 'gh-sep' }, '·'),
              h('span', { className: 'gh-actor' }, `@${head.actor}`),
            ),
            timesEl(head, whenPrefix(head, t.entity), now),
            h('div', { className: 'gh-sum', title: head.summary }, head.summary || '（这条动态没有摘要）'),
            rest.length > 0
              ? h('button', { type: 'button', className: 'gh-more', 'aria-expanded': open, onClick: () => setExpanded((prev) => ({ ...prev, [t.key]: !open })) },
                  open ? '收起 ▴' : `展开 ${rest.length} 条评论动态 ▾`)
              : null,
            open
              ? h('ol', { className: 'gh-tl' }, ...rest.map((ev, i) =>
                  h('li', { key: ev.id, className: `gh-tl-item k-${ev.kind}` },
                    h('div', { className: 'gh-tl-top' },
                      h('span', { className: 'gh-badge t-muted gh-floor' }, `#${i + 1}`),
                      badge({ label: ev.label, tone: KIND_META[ev.kind].tone }),
                      h('span', { className: 'gh-actor' }, `@${ev.actor}`),
                      extLink(ev.url, '直达 ↗'),
                    ),
                    timesEl(ev, whenPrefix(ev, t.entity), now),
                    h('div', { className: 'gh-tl-sum' }, ev.summary || '（无摘要）'),
                  )))
              : null,
          );
        };

        const renderInbox = (): ReactNodeLike => h(Fragment, null,
          cfg && !auth?.configured
            ? h('div', { className: 'gh-alert warn', role: 'note' },
                h('span', null, '还没连接 GitHub 账号，事件箱不会自动更新。'),
                h('button', { type: 'button', className: 'gh-btn sm', onClick: goAuth }, '去「账号与高级设置」完成授权 →'))
            : null,
          h('div', { className: 'gh-toolbar' },
            h('div', { className: 'gh-seg', role: 'tablist', 'aria-label': '分类筛选' }, ...CATS.map((c) =>
              h('button', { key: c.id, type: 'button', role: 'tab', 'aria-selected': cat === c.id, className: `gh-seg-btn ${cat === c.id ? 'on' : ''}`, onClick: () => setCat(c.id) },
                c.label,
                h('span', { className: 'gh-seg-n' }, String(repoScoped.filter((t) => inCat(t, c.id)).length))))),
            h('div', { className: 'gh-tools-r' },
              h('select', { value: repoFilter, 'aria-label': '按仓库筛选', onChange: (e: ChangeEv) => setRepoFilter(e.target.value) },
                h('option', { value: '' }, `全部仓库（${threads.length}）`),
                ...repoOptions.map((r) => h('option', { key: r, value: r }, `${r}（${threads.filter((t) => (t.repo || '').toLowerCase() === r.toLowerCase()).length}）`))),
              h('input', { className: 'gh-input gh-search', type: 'search', value: query, placeholder: '搜仓库、#编号、摘要、@actor', onChange: (e: ChangeEv) => setQuery(e.target.value) }),
            ),
          ),
          threads.length === 0
            ? h('div', { className: 'gh-empty' }, '暂无 GitHub 动态。点右上角「立即拉取」检查一次。')
            : visible.length === 0
              ? h('div', { className: 'gh-empty' }, '没有符合筛选条件的线程。 ',
                  h('button', { type: 'button', className: 'gh-btn sm', onClick: () => { setCat('all'); setRepoFilter(''); setQuery(''); } }, '清除筛选'))
              : h(Fragment, null, ...visible.map(renderThread)),
          threads.length > 0
            ? h('div', { className: 'gh-foot' }, `${filtering ? `显示 ${visible.length} / ` : ''}${threads.length} 个线程 · 共 ${events.length} 条动态，同一 Issue / PR 已自动折叠`)
            : null,
        );

        const autoSendMeta = (r: RepoItem): Meta => {
          if (r.autoSend === true) return { label: '自动直发', tone: 'green' };
          if (r.autoSend === false) return { label: '草稿待审', tone: 'muted' };
          const owner = r.repo.split('/')[0]?.toLowerCase() || '';
          return owners.includes(owner) ? { label: '自动直发 · Owner 名单', tone: 'green' } : { label: '草稿待审', tone: 'muted' };
        };

        const addRepo = (): void => {
          const name = newRepo.trim();
          const next = [...repos.filter((r) => r.repo !== name), { repo: name, localPath: newPath.trim() || undefined, personaId: newRepoPersona || null, enabled: true }];
          setRepos(next);
          setNewRepo('');
          setNewPath('');
          setNewRepoPersona('');
          void saveConfig(next, pins, `已添加监听仓库 ${name}。`);
        };

        const addPin = (): void => {
          const num = Number(newPinNum);
          const name = newPinRepo.trim();
          const next = [...pins.filter((p) => !(p.repo === name && p.number === num)), { repo: name, number: num, linkedPrs: [], watchReactions: true }];
          setPins(next);
          setNewPinRepo('');
          setNewPinNum('');
          void saveConfig(repos, next, `已开始重点盯防 ${name} #${num}。`);
        };

        const personaOptions = (fallback: string): unknown[] => [
          h('option', { key: '', value: '' }, fallback),
          ...personas.map((p) => h('option', { key: p.id, value: p.id }, `${p.name} (${p.kind})`)),
        ];

        const renderRepos = (): ReactNodeLike => h(Fragment, null,
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, '监听仓库', badge({ label: String(repos.length), tone: 'neutral' })),
                h('div', { className: 'gh-card-sub' }, '仓库级的本地路径和性格卡会覆盖默认设置；Owner 在直发名单内的仓库会自动直发回复。')),
            ),
            repos.length === 0
              ? h('div', { className: 'gh-empty', style: { marginTop: 12 } }, '还没有监听仓库，在下方添加第一个。')
              : h('div', { className: 'gh-items' }, ...repos.map((r) =>
                  h('div', { key: r.repo, className: 'gh-item' },
                    h('div', { className: 'gh-item-main' },
                      h('div', { className: 'gh-item-title' },
                        h('span', null, r.repo),
                        badge(autoSendMeta(r), 'auto'),
                        r.enabled === false ? badge({ label: '已停用', tone: 'red' }, 'off') : null,
                        r.personaId ? badge({ label: `性格：${personaName(r.personaId)}`, tone: 'violet' }, 'persona') : badge({ label: '沿用默认性格', tone: 'muted' }, 'persona')),
                      h('div', { className: 'gh-item-sub gh-mono' }, r.localPath || '未设置本地代码路径')),
                    h('div', { className: 'gh-item-acts' },
                      h('select', { value: r.personaId || '', disabled: busy, 'aria-label': `${r.repo} 的性格卡`, onChange: (e: ChangeEv) => { const next = repos.map((x) => (x.repo === r.repo ? { ...x, personaId: e.target.value || null } : x)); setRepos(next); void saveConfig(next, pins, `${r.repo} 的性格卡已更新。`); } },
                        ...personaOptions('沿用默认性格')),
                      extLink(`https://github.com/${r.repo}`, '仓库 ↗'),
                      h('button', { type: 'button', className: 'gh-btn sm danger', disabled: busy, onClick: () => { const next = repos.filter((x) => x.repo !== r.repo); setRepos(next); void saveConfig(next, pins, `已移除 ${r.repo}。`); } }, '删除')),
                  ))),
            h('div', { className: 'gh-add' },
              h('div', { className: 'gh-add-label' }, '添加仓库'),
              h('input', { className: 'gh-input', placeholder: 'owner/repo', value: newRepo, onChange: (e: ChangeEv) => setNewRepo(e.target.value) }),
              h('input', { className: 'gh-input gh-mono', placeholder: '本地代码路径（可选）', value: newPath, onChange: (e: ChangeEv) => setNewPath(e.target.value) }),
              h('select', { value: newRepoPersona, onChange: (e: ChangeEv) => setNewRepoPersona(e.target.value) }, ...personaOptions('沿用默认性格')),
              h('button', { type: 'button', className: 'gh-btn pri', disabled: busy || !/^[^/\s]+\/[^/\s]+$/.test(newRepo.trim()), onClick: addRepo }, '添加仓库'),
            ),
          ),
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, '重点盯防', badge({ label: String(pins.length), tone: 'amber' })),
                h('div', { className: 'gh-card-sub' }, '盯防条目的评论、关联 PR 与 Reaction 变化会单独追踪，并汇入事件箱同一线程。')),
            ),
            pins.length === 0
              ? h('div', { className: 'gh-empty', style: { marginTop: 12 } }, '暂无重点盯防条目。')
              : h('div', { className: 'gh-items' }, ...pins.map((p) =>
                  h('div', { key: `${p.repo}#${p.number}`, className: 'gh-item' },
                    h('div', { className: 'gh-item-main' },
                      h('div', { className: 'gh-item-title' },
                        badge({ label: '盯防', tone: 'amber' }, 'pin', true),
                        h('span', null, p.repo, h('span', { style: { color: 'var(--ink3)', marginLeft: 4 } }, `#${p.number}`)),
                        p.watchReactions ? badge({ label: 'Reaction 监听', tone: 'blue' }, 'rx') : badge({ label: '不监听 Reaction', tone: 'muted' }, 'rx'),
                        (p.linkedPrs || []).length > 0 ? badge({ label: `关联 PR ${p.linkedPrs.map((n) => `#${n}`).join(' ')}`, tone: 'violet' }, 'prs') : null)),
                    h('div', { className: 'gh-item-acts' },
                      h('button', { type: 'button', className: 'gh-btn sm ghost', onClick: () => { setTab('inbox'); setCat('all'); setRepoFilter(p.repo); setQuery(`#${p.number}`); } }, '看动态'),
                      extLink(`https://github.com/${p.repo}/issues/${p.number}`, 'GitHub ↗'),
                      h('button', { type: 'button', className: 'gh-btn sm danger', disabled: busy, onClick: () => { const next = pins.filter((x) => !(x.repo === p.repo && x.number === p.number)); setPins(next); void saveConfig(repos, next, `已取消盯防 ${p.repo} #${p.number}。`); } }, '删除')),
                  ))),
            h('div', { className: 'gh-add' },
              h('div', { className: 'gh-add-label' }, '添加盯防'),
              h('input', { className: 'gh-input', placeholder: 'owner/repo', list: 'gh-repo-options', value: newPinRepo, onChange: (e: ChangeEv) => setNewPinRepo(e.target.value) }),
              h('datalist', { id: 'gh-repo-options' }, ...repoOptions.map((r) => h('option', { key: r, value: r }))),
              h('input', { className: 'gh-input num', type: 'number', min: 1, placeholder: '编号', value: newPinNum, onChange: (e: ChangeEv) => setNewPinNum(e.target.value) }),
              h('button', { type: 'button', className: 'gh-btn pri', disabled: busy || !newPinRepo.includes('/') || !(Number(newPinNum) > 0), onClick: addPin }, '添加盯防'),
            ),
          ),
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, '默认回复性格'),
                h('div', { className: 'gh-card-sub' }, '共享性格衣柜：未单独绑定性格卡的仓库都由这里的性格来回复 GitHub。')),
            ),
            h('div', { className: 'gh-actrow' },
              h('select', { value: defaultPersonaId, onChange: (e: ChangeEv) => setDefaultPersonaId(e.target.value) },
                ...personaOptions('默认（内置 gh-issue-triage / gh-pr-review 技能）')),
              h('button', { type: 'button', className: 'gh-btn pri', disabled: busy, onClick: () => void saveConfig(repos, pins, '默认回复性格已保存。') }, '保存'),
              h('button', { type: 'button', className: 'gh-btn', disabled: busy, onClick: () => jumpToPersonaWardrobe(setMsg) }, '去性格衣柜编辑'),
            ),
          ),
        );

        const saveApp = (): void => void run(async () => {
          const r = await api<{ verified: { ok: boolean; botLogin?: string; error?: string } }>('/connector/github/app', { method: 'POST', body: JSON.stringify({ appId: Number(appId), slug: appSlug || undefined, repo: appRepo || undefined, privateKeyPem: appPem || undefined }) });
          setAppPem('');
          await loadAll();
          if (r.verified.ok) setAppOpen(false);
          setMsg(r.verified.ok ? `GitHub App 已验证：${r.verified.botLogin || 'ok'}` : `App 已保存但验证失败：${r.verified.error || ''}`);
        });

        const verifyApp = (): void => void run(async () => {
          const r = await api<{ ok: boolean; botLogin?: string; error?: string }>('/connector/github/app/verify', { method: 'POST', body: JSON.stringify({ repo: appRepo || undefined }) });
          await loadAll();
          setMsg(r.ok ? `权限正常：${r.botLogin || ''}` : `检查失败：${r.error || ''}`);
        });

        const removeApp = (): void => void run(async () => {
          await api('/connector/github/app', { method: 'DELETE' });
          await loadAll();
          setMsg('已移除 GitHub App。');
        });

        const saveToken = (): void => void run(async () => {
          await api('/connector/github/token', { method: 'POST', body: JSON.stringify({ slot, token: tok.trim(), isBot: slot === 'act' }) });
          setTok('');
          await loadAll();
          setTokOpen(false);
          setMsg('Token 已保存并验证。');
        });

        const readPemFile = (e: ChangeEv): void => {
          const f = e.target.files?.[0];
          if (!f) return;
          const rd = new FileReader();
          rd.onload = () => setAppPem(String(rd.result || ''));
          rd.readAsText(f);
        };

        const renderSettings = (): ReactNodeLike => h(Fragment, null,
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, '连接总览', badge({ label: readLabel, tone: readOk ? 'green' : 'amber' })),
                h('div', { className: 'gh-card-sub' }, 'Read 账号负责拉取通知与动态；外发机器人负责以 Bot 身份回复。')),
              h('button', { type: 'button', className: 'gh-btn', disabled: busy || !ga?.configured, title: ga?.configured ? '' : '先配置 GitHub App', onClick: verifyApp }, '重新检查权限'),
            ),
            h('div', { className: 'gh-kv' },
              kv('login', 'Read 账号', auth?.login ? `@${auth.login}` : '未连接', badge({ label: readLabel, tone: readOk ? 'green' : 'amber' })),
              kv('scopes', '授权来源 / 权限', `${auth?.source || '—'} · ${(auth?.scopes || []).join(', ') || '无 scope 信息'}`),
              kv('act', '外发机器人模式', actLabel),
              kv('appid', 'App ID / Slug', ga?.configured ? `${ga.appId ?? '—'} / ${ga.slug || '待识别'}` : '未配置 GitHub App'),
              kv('inst', 'Installation', ga?.configured ? String(ga.installationId || '自动查找') : '—'),
              kv('repo', '绑定仓库', ga?.configured ? ga.defaultRepo || '按仓库自动' : '—'),
              kv('bot', '静态 Bot Token', auth?.hasBotToken ? badge({ label: '已配置', tone: 'green' }) : badge({ label: '未配置', tone: 'muted' })),
            ),
          ),
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, '轮询与自动直发策略'),
                h('div', { className: 'gh-card-sub' }, '保存后立即热生效，无需重启。')),
            ),
            h('div', { className: 'gh-form' },
              formRow('notif', '全账号通知', toggle(enableNotif, setEnableNotif, enableNotif ? '已启用：拉取 /notifications' : '已关闭：仅轮询监听仓库')),
              formRow('owners', '自动直发 Owner',
                h('input', { className: 'gh-input', value: ownersText, placeholder: '如 my-user, my-org', onChange: (e: ChangeEv) => setOwnersText(e.target.value) }),
                h('span', { className: 'gh-hint' }, '逗号分隔；其余仓库生成草稿待审')),
              formRow('interval', '轮询间隔',
                h('input', { className: 'gh-input num', type: 'number', min: 15, value: intervalSec, onChange: (e: ChangeEv) => setIntervalSec(e.target.value) }),
                h('span', { className: 'gh-hint' }, '秒（最少 15 秒）')),
            ),
            h('div', { className: 'gh-actrow' },
              h('button', { type: 'button', className: 'gh-btn pri', disabled: busy, onClick: () => void saveConfig(repos, pins, '轮询与直发策略已热生效。') }, '保存策略')),
          ),
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, 'GitHub App 凭据', ga?.configured ? badge({ label: `已配置 · ${botName}`, tone: 'green' }) : badge({ label: '未配置', tone: 'amber' })),
                h('div', { className: 'gh-card-sub' }, `推荐方式：以 ${botName} 身份外发，私钥只写入本地，绝不回显。`)),
              ga?.configured ? h('button', { type: 'button', className: 'gh-btn sm danger', disabled: busy, onClick: removeApp }, '移除 App') : null,
            ),
            ga?.configured
              ? h('button', { type: 'button', className: 'gh-fold-btn', 'aria-expanded': appExpanded, onClick: () => setAppOpen(!appExpanded) }, appExpanded ? '收起 App 配置 ▴' : '更新 App 配置或更换私钥 ▾')
              : null,
            appExpanded
              ? h('div', { className: 'gh-fold-body' },
                  h('div', { className: 'gh-form', style: { marginTop: 0 } },
                    formRow('appid', 'App ID', h('input', { className: 'gh-input num', type: 'number', placeholder: 'App ID', value: appId, onChange: (e: ChangeEv) => setAppId(e.target.value) })),
                    formRow('slug', 'App Slug', h('input', { className: 'gh-input', placeholder: '留空自动识别', value: appSlug, onChange: (e: ChangeEv) => setAppSlug(e.target.value) })),
                    formRow('vrepo', '验证仓库', h('input', { className: 'gh-input', placeholder: '如 example-owner/example-repo', value: appRepo, onChange: (e: ChangeEv) => setAppRepo(e.target.value) })),
                    formRow('pemfile', '私钥文件', h('input', { type: 'file', accept: '.pem,.key,.txt', onChange: readPemFile }), h('span', { className: 'gh-hint' }, '或在下方直接粘贴')),
                  ),
                  h('textarea', { rows: 4, placeholder: '粘贴 RSA 私钥 .pem（仅更新元数据可留空，绝不回显）', value: appPem, style: { marginTop: 12 }, onChange: (e: ChangeEv) => setAppPem(e.target.value) }),
                  h('div', { className: 'gh-actrow' },
                    h('button', { type: 'button', className: 'gh-btn pri', disabled: busy || !appId.trim(), onClick: saveApp }, '保存并验证 GitHub App')),
                )
              : null,
          ),
          h('div', { className: 'gh-card' },
            h('div', { className: 'gh-card-h' },
              h('div', null,
                h('h3', null, '静态 Token 备用槽', auth?.configured ? badge({ label: 'Read 已连接', tone: 'green' }) : badge({ label: 'Read 未连接', tone: 'amber' })),
                h('div', { className: 'gh-card-sub' }, 'Read Token 用于拉取；静态 Bot Token 是 GitHub App 不可用时的外发备用。')),
            ),
            auth?.configured
              ? h('button', { type: 'button', className: 'gh-fold-btn', 'aria-expanded': tokExpanded, onClick: () => setTokOpen(!tokExpanded) }, tokExpanded ? '收起 Token 配置 ▴' : '配置静态 Token 备用槽 ▾')
              : null,
            tokExpanded
              ? h('div', { className: 'gh-fold-body' },
                  h('div', { className: 'gh-field' },
                    h('select', { value: slot, onChange: (e: ChangeEv) => setSlot(e.target.value === 'act' ? 'act' : 'read') },
                      h('option', { value: 'read' }, 'Read Token'),
                      h('option', { value: 'act' }, '静态 Bot Token')),
                    h('input', { className: 'gh-input', type: 'password', value: tok, placeholder: '粘贴静态 Token（绝不回显）', onChange: (e: ChangeEv) => setTok(e.target.value) }),
                    h('button', { type: 'button', className: 'gh-btn pri', disabled: busy || !tok.trim(), onClick: saveToken }, '保存 Token')),
                )
              : null,
          ),
        );

        const lastTs = threads[0]?.latest.occurredAt;
        const nextNode = !cfg
          ? h('div', { className: 'gh-next' }, '正在读取 GitHub 状态…')
          : !auth?.configured
            ? h('button', { type: 'button', className: 'gh-next hot', onClick: goAuth }, '尚未连接 GitHub 账号，去完成授权 →')
            : auth.notificationsScopeMissing
              ? h('button', { type: 'button', className: 'gh-next hot', onClick: goAuth }, 'Read Token 缺少 notifications 权限 →')
              : h('div', { className: 'gh-next' }, threads.length > 0 && lastTs ? `同一 Issue / PR 的动态自动聚合 · 最近更新 ${fmtRelative(lastTs, now)}` : '监听 Issue / PR 动态，同一线程自动聚合');
        const chip = (key: string, label: string, value: string, tone: '' | 'warn' | 'ok' = ''): ReactNodeLike => h('span', { key, className: `gh-chip ${tone}` }, label, h('b', null, value));
        const settingsWarn = Boolean(cfg && !readOk);
        const tabs: Array<{ id: TabId; label: string; count: number | null; hot: boolean }> = [
          { id: 'inbox', label: '事件箱', count: threads.length, hot: false },
          { id: 'repos', label: '仓库与盯防', count: repos.length + pins.length, hot: false },
          { id: 'settings', label: '账号与高级设置', count: settingsWarn ? 1 : null, hot: settingsWarn },
        ];

        return h('section', { className: 'gh-root', 'aria-label': 'GitHub' },
          h('style', null, CSS),
          h('div', { className: 'gh-wrap' },
            h('header', { className: 'gh-top' },
              h('div', { className: 'gh-brand' },
                h('div', { className: 'gh-logo' }, GitHubIcon({ size: 20 })),
                h('div', null, h('h1', null, 'GitHub'), nextNode),
              ),
              h('div', { className: 'gh-top-right' },
                h('button', { type: 'button', className: 'gh-btn pri', disabled: busy, onClick: pollNow }, busy ? '处理中…' : '立即拉取'),
                h('button', { type: 'button', className: 'gh-btn ghost', disabled: busy, onClick: () => void loadAll() }, '刷新'),
              ),
            ),
            cfg
              ? h('div', { className: 'gh-chips' },
                  chip('read', 'Read 账号', auth?.configured ? `@${auth.login || '已连接'} · ${readLabel}` : '未连接', readOk ? 'ok' : 'warn'),
                  chip('bot', botName, ga?.configured ? '已就绪' : auth?.actMode === 'token' ? '用静态 Token' : '未配置', ga?.configured ? 'ok' : 'warn'),
                  chip('repos', '监听仓库', String(repos.length)),
                  chip('threads', '事件线程', String(threads.length)),
                )
              : null,
            err ? h('div', { className: 'gh-alert err', role: 'alert' }, h('span', null, err), h('button', { type: 'button', className: 'gh-x', 'aria-label': '关闭', onClick: () => setErr('') }, '×')) : null,
            msg ? h('div', { className: 'gh-alert ok', role: 'status' }, h('span', null, `✓ ${msg}`), h('button', { type: 'button', className: 'gh-x', 'aria-label': '关闭', onClick: () => setMsg('') }, '×')) : null,
            h('nav', { className: 'gh-tabs', role: 'tablist' }, ...tabs.map((t) =>
              h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': tab === t.id, className: `gh-tab ${tab === t.id ? 'on' : ''}`, onClick: () => setTab(t.id) },
                t.label,
                t.count !== null && t.count > 0 ? h('span', { className: `gh-tab-n ${t.hot ? 'hot' : ''}` }, t.hot ? '!' : String(t.count)) : null),
            )),
            tab === 'inbox' ? renderInbox() : null,
            tab === 'repos' ? renderRepos() : null,
            tab === 'settings' ? renderSettings() : null,
          ),
        );
      }

      function GitHubIcon({ size = 20 }: { size?: number }): ReactNodeLike {
        return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
          h('path', { d: 'M9 19c-4.5 1.5-4.5-2.5-6-3m12 6v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22' }),
        );
      }

      return {
        inject: ['slots'],
        apply(ctx: SlotCtx): void {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, GitHubPanel));
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => 'GitHub' }, GitHubIcon));
        },
      };
    },
  });
})();
