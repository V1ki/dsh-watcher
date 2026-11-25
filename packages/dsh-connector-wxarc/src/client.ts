(() => {
  type ReactElement = unknown;
  type SetState<T> = (value: T | ((prev: T) => T)) => void;

  interface ReactLike {
    Fragment: unknown;
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElement;
    useState<T>(initial: T | (() => T)): [T, SetState<T>];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    useRef<T>(initial: T): { current: T };
  }

  interface ChangeEvent {
    target: { value: string };
  }

  interface NativeRunData {
    id: string;
    session_id: string;
    status: string;
    detail?: string;
    decision?: {
      action?: string;
      reason?: string;
      text?: string | string[];
    } | null;
  }

  interface NativeConversation {
    session_id: string;
    title: string;
    latest?: { status?: string } | null;
  }

  interface PersonaItem {
    id: string;
    name: string;
    kind: 'double' | 'original' | 'fiction';
    definition: string;
    work: string;
    character: string;
    learning: boolean;
    style: string;
    revision: number;
    memoryCount: number;
  }

  interface PersonasResponse {
    activeId?: string;
    revision: number;
    personas: PersonaItem[];
    sample: {
      available: boolean;
      count?: number;
      source?: string;
      createdAt?: number | string;
    };
  }

  interface AutomationRule {
    kind: string;
    sourceId: string;
    title: string;
    search: string;
    wechatId: string;
    testPrefix?: string;
  }

  interface AutomationPolicy {
    enabled: boolean;
    mode: string;
    allChats: boolean;
    moments: string;
    momentsNotBefore: number;
    provider: string;
    model: string;
    adminIds?: string[];
    controllerId: string;
    ownId: string;
    instructions: string;
    maxAgeSeconds: number;
    debounceMs?: number;
    debounceMaxMessages?: number;
    rules: AutomationRule[];
  }

  interface ApprovalItem {
    code: string;
    tool: string;
    status: string;
    notice_status: string;
    detail?: string;
    args: string;
    task_eligible?: boolean | number;
  }

  interface AutomationJob {
    id: number;
    event_seq: number;
    status: string;
    detail?: string;
    rule: { title: string };
    event: {
      kind: string;
      local_type: number;
      text: string;
      personaName?: string;
      dshSessionId?: string;
      dshRunId?: string;
      image?: { status?: string };
      article?: { status?: string; chars?: number };
    };
    decision?: {
      action?: string;
      text?: string | string[];
      image?: string;
      sticker?: { index: number };
    } | null;
  }

  interface AutomationResponse {
    policy: AutomationPolicy;
    revision: number;
    ownIdSuggestion?: string;
    providers?: Array<{ id: string; name?: string }>;
    targets: Array<{ id: string; title: string }>;
    approvals?: ApprovalItem[];
    jobs?: AutomationJob[];
    status: {
      enabled: boolean;
      active: boolean;
      momentsWaiting?: boolean;
      momentsNotBefore?: number;
    };
  }

  interface ArticlePreviewResult {
    event: {
      article: {
        chars: number;
        snapshot?: boolean;
        fetched_at: number;
      };
    };
    run?: NativeRunData;
    decision?: { text?: string | string[] };
  }

  interface StatusResponse {
    healthy: boolean;
    connected: boolean;
    retained: number;
    retainPerStream: number;
    lastSuccess?: string | null;
    lastError?: string | null;
  }

  interface FeedEvent {
    seq: number;
    kind: 'text' | 'sns' | 'media';
    ts?: number;
    session_name?: string;
    user_name?: string;
    session?: string;
    sender?: string;
    text?: string;
    type?: string;
    local_type?: number;
  }

  interface PluginContext {
    uiWorkspace: {
      openSession(id: string): void;
    };
    slots: {
      inject(name: string, fn: () => unknown): void;
      register(slot: Record<string, unknown>, render: unknown): unknown;
    };
  }

  interface ModuleLoaderWindow {
    __ModuleLoader__: {
      load(entry: {
        id: string;
        factory: (require: (id: string) => ReactLike) => {
          inject: string[];
          apply: (ctx: PluginContext) => void;
        };
      }): void;
    };
  }

  (window as unknown as ModuleLoaderWindow).__ModuleLoader__.load({
    id: '@local/dsh-connector-wxarc',
    factory: (require) => {
      const React = require('react');
      const { useEffect, useState, useRef } = React;
      const h = React.createElement;
      const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      const replyText = (value: string | string[] | undefined): string =>
        Array.isArray(value) ? value.map((text, i) => `${i + 1}. ${text}`).join('\n\n') : (value ?? '');
      const PANEL = 'wxarc-listener';
      let openSession: (id: string) => void = () => {};
      const labels: Record<string, string> = { text: '微信消息', sns: '朋友圈', media: '媒体' };
      const css = `
.wxarc-personas h2{font-size:20px;margin:0 0 4px}.wxarc-persona-select{display:flex;gap:12px;align-items:end;margin:18px 0}.wxarc-persona-select label{flex:1;min-width:0}.wxarc-persona-editor{border-top:1px solid #dee6e0;padding:14px 0}.wxarc-persona-editor summary{font-size:15px;margin-bottom:10px}.wxarc-preview{margin:14px 0;padding:14px 16px;border-left:3px solid #227455;background:#f3f6f4}.wxarc-personas label{min-width:0}.wxarc-personas select{max-width:100%}@media(max-width:600px){.wxarc-persona-select{align-items:stretch;flex-direction:column}}

.wxarc-panel{height:100%;overflow:auto;background:#f3f6f4;color:#22342d;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;font-size:14px;line-height:1.6}
.wxarc-wrap{max-width:1000px;margin:auto;padding:30px 32px 60px}.wxarc-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.wxarc-head h1{font-size:26px;margin:0;font-weight:650;letter-spacing:-.5px}.wxarc-sub{color:#65776e;margin:4px 0 0}
.wxarc-state{background:#e2f2e9;color:#206545;border-radius:20px;padding:5px 13px;white-space:nowrap}.wxarc-state.bad{background:#fff0dc;color:#825314}.wxarc-details{margin-bottom:22px;border-left:3px solid #227455;padding:4px 14px}.wxarc-details p{margin:2px 0}.wxarc-error{color:#a12e2e}
.wxarc-bar{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.wxarc-panel input,.wxarc-panel select,.wxarc-panel button{font:inherit;border:1px solid #cbd8d0;background:white;color:#22342d;border-radius:6px;padding:8px 12px}.wxarc-panel input{flex:1;min-width:160px}.wxarc-panel button{cursor:pointer}.wxarc-panel button:hover{background:#e8f0eb}.wxarc-panel button:disabled{opacity:.5;cursor:default}.wxarc-panel :focus-visible{outline:2px solid #227455;outline-offset:3px}
.wxarc-feed{background:white;border:1px solid #dee6e0;border-radius:10px;overflow:hidden}.wxarc-row{display:grid;grid-template-columns:130px minmax(0,1fr);gap:18px;padding:20px 22px;border-bottom:1px solid #e8eeea}.wxarc-row:last-child{border-bottom:0}.wxarc-kind{color:#227455;font-size:12px;font-weight:600}.wxarc-time{font-size:12px;color:#65776e;margin-top:4px}.wxarc-title{font-weight:600;overflow-wrap:anywhere}.wxarc-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;max-width:76ch}.wxarc-empty{padding:44px 24px;text-align:center;color:#65776e}.wxarc-foot{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:18px;color:#65776e;font-size:12px}.wxarc-note{font-size:12px;color:#65776e;margin-top:18px}
.wxarc-auto{background:#fff;border:1px solid #dee6e0;border-radius:10px;padding:16px 20px;margin:20px 0}.wxarc-auto .wxarc-state{white-space:normal}.wxarc-auto summary{font-size:17px;font-weight:600;cursor:pointer}.wxarc-auto-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.wxarc-auto label{display:flex;flex-direction:column;gap:4px}.wxarc-auto textarea{font:inherit;border:1px solid #cbd8d0;border-radius:6px;padding:10px;min-height:90px;resize:vertical;width:100%;box-sizing:border-box;color:#22342d;background:white}.wxarc-auto input,.wxarc-auto select{width:100%;box-sizing:border-box}.wxarc-wide{grid-column:1/-1}.wxarc-rule{border-top:1px solid #e8eeea;margin-top:14px;padding-top:12px}.wxarc-job{border-top:1px solid #e8eeea;padding:14px 0}.wxarc-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}.wxarc-auto small{color:#65776e}.wxarc-actions .wxarc-save{background:#227455;color:white;border-color:#227455}
@media(max-width:600px){.wxarc-wrap{padding:20px 16px}.wxarc-head{align-items:flex-start}.wxarc-row{grid-template-columns:1fr;gap:5px;padding:16px}.wxarc-meta{display:flex;gap:12px;align-items:center}.wxarc-time{margin:0}.wxarc-foot{align-items:flex-start}}
@media(max-width:600px){.wxarc-auto-grid{grid-template-columns:1fr}.wxarc-auto{padding:14px}.wxarc-wide{grid-column:auto}}
`;

      async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
        const r = await fetch(path, { signal, credentials: 'same-origin' });
        if (!r.ok) throw new Error(`监听面板请求失败（${r.status}）`);
        return (await r.json()) as T;
      }

      const jobNames: Record<string, string> = {
        expired: '已过补发时限',
        retry_wait: '等待核对后补发',
        partial: '部分已发送，其余停止',
        batched: '已合并，不单独回复',
        superseded: '已收到补充，旧回复未发送',
        agent_running: 'DSH 正在执行',
        agent_waiting: '等待 DSH 审批或答复',
        manual: '已在 DSH 接管',
        queued: '等待 AI',
        processing: 'AI 处理中',
        draft: '回复草稿',
        preparing: '正在操作微信',
        sending: '正在发送',
        sent: '已发送并核对',
        uncertain: '结果待核实',
        ignored: '无需回复',
        failed: '处理未完成',
        cancelled: '已取消',
        blocked: '处理受阻',
      };

      function NativeRun({ initial }: { initial: NativeRunData }): ReactElement {
        const [run, setRun] = useState<NativeRunData>(initial);
        const [error, setError] = useState('');
        useEffect(() => {
          const abort = new AbortController();
          let timer: number | undefined;
          const poll = async (): Promise<void> => {
            try {
              const d = await api<{ run: NativeRunData }>(
                `/wxarc/agent/runs/${initial.id}`,
                abort.signal,
              );
              if (!abort.signal.aborted) {
                setRun(d.run);
                if (['running', 'waiting', 'admitting'].includes(d.run.status)) {
                  timer = setTimeout(poll, 2000);
                }
              }
            } catch (e) {
              if (!abort.signal.aborted) setError(errMessage(e));
            }
          };
          poll();
          return () => {
            abort.abort();
            clearTimeout(timer);
          };
        }, [initial.id]);
        const runLabels: Record<string, string> = {
          admitting: '正在交给 DSH',
          running: 'DSH 正在执行',
          waiting: '请在 DSH 审批或答复',
          ready: '已完成，未发送微信',
          failed: '任务未完成',
          manual: '已手动接管',
          interrupted: '任务中断',
          cancelled: '任务已取消',
        };
        return h(
          'div',
          { className: 'wxarc-preview', role: 'status' },
          h('strong', null, runLabels[run.status] || run.status),
          h('p', null, error || run.detail),
          run.decision &&
            h(
              'p',
              { className: 'wxarc-text' },
              run.decision.action === 'ignore'
                ? run.decision.reason
                : replyText(run.decision.text),
            ),
          h('button', { onClick: () => openSession(run.session_id) }, '打开 DSH 会话'),
        );
      }

      function NativeSessions(): ReactElement {
        const [data, setData] = useState<NativeConversation[]>([]);
        const [error, setError] = useState('');
        useEffect(() => {
          const abort = new AbortController();
          let timer: number | undefined;
          const poll = async (): Promise<void> => {
            try {
              const d = await api<{ conversations: NativeConversation[] }>(
                '/wxarc/agent',
                abort.signal,
              );
              if (!abort.signal.aborted) {
                setData(d.conversations);
                setError('');
              }
            } catch (e) {
              if (!abort.signal.aborted) setError(errMessage(e));
            }
            if (!abort.signal.aborted) timer = setTimeout(poll, 3000);
          };
          poll();
          return () => {
            abort.abort();
            clearTimeout(timer);
          };
        }, []);
        return h(
          'section',
          { className: 'wxarc-auto', 'aria-label': 'DSH 工作会话' },
          h('h2', null, 'DSH 工作会话'),
          h(
            'p',
            { className: 'wxarc-sub' },
            '微信任务按聊天和人物显示在 DSH 侧边栏。打开会话可查看工具执行、处理审批，或直接输入内容接管；接管后本次结果不会自动发回微信。',
          ),
          error && h('p', { className: 'wxarc-error' }, error),
          data.length
            ? h(
                'div',
                { className: 'wxarc-actions' },
                ...data.map((r) =>
                  h(
                    'button',
                    { key: r.session_id, onClick: () => openSession(r.session_id) },
                    r.title +
                      (r.latest?.status === 'waiting'
                        ? ' · 等待审批或答复'
                        : ['running', 'admitting'].includes(r.latest?.status ?? '')
                          ? ' · 正在执行'
                          : ''),
                  ),
                ),
              )
            : h('p', null, '收到新消息或开始试聊后，会话会显示在这里。'),
        );
      }

      const personaKinds: Record<'double' | 'original' | 'fiction', string> = {
        double: '我的分身',
        original: '原创人物',
        fiction: '作品角色',
      };

      function PersonaPanel(): ReactElement {
        const [data, setData] = useState<PersonasResponse | null>(null);
        const [selected, setSelected] = useState('');
        const [error, setError] = useState('');
        const [notice, setNotice] = useState('');
        const [busy, setBusy] = useState(false);

        const load = async (id?: string): Promise<PersonasResponse> => {
          const d = await api<PersonasResponse>('/wxarc/personas');
          setData(d);
          const pick = id || d.activeId || d.personas[0]?.id || '';
          setSelected(pick);
          return d;
        };
        useEffect(() => {
          load().catch((e) => setError(errMessage(e)));
        }, []);

        const write = async <T = Record<string, unknown>>(
          path: string,
          method: string,
          input?: unknown,
        ): Promise<T> => {
          const r = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            ...(input ? { body: JSON.stringify(input) } : {}),
          });
          const d = (await r.json()) as { error?: string } & T;
          if (!r.ok) throw new Error(d.error || '操作失败');
          return d;
        };

        const run = async (fn: () => Promise<void>): Promise<void> => {
          setBusy(true);
          setError('');
          setNotice('');
          try {
            await fn();
          } catch (e) {
            setError(errMessage(e));
          } finally {
            setBusy(false);
          }
        };

        const changed = (): void => {
          window.dispatchEvent(new Event('wxarc-persona-changed'));
        };

        const openWatcherWardrobe = (): void => {
          const w = window as unknown as { __dshWatcherPendingTab?: string };
          w.__dshWatcherPendingTab = 'personas';
          window.dispatchEvent(new CustomEvent('dsh-watcher:open-tab', { detail: 'personas' }));
          const buttons = Array.from(document.querySelectorAll('button,[role="button"],a'));
          const findByLabel = (target: string): Element | undefined =>
            buttons.find((el) => {
              const label =
                el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.textContent ||
                '';
              return label.trim() === target;
            });
          const targetBtn =
            findByLabel('性格衣柜') || findByLabel('Hub 总控台') || findByLabel('Watcher');
          if (targetBtn && typeof (targetBtn as HTMLElement).click === 'function') {
            (targetBtn as HTMLElement).click();
            return;
          }
          setNotice('请点击左侧边栏「性格衣柜」统一编辑人物设定、学习风格与记忆。');
        };

        const currentPersona = data?.personas.find((p) => p.id === selected) ?? null;

        return h(
          'section',
          { className: 'wxarc-auto wxarc-personas', 'aria-label': '人物选择' },
          h('h2', null, '谁来接话'),
          h(
            'p',
            { className: 'wxarc-sub' },
            data?.activeId
              ? `正在使用：${data.personas.find((p) => p.id === data.activeId)?.name || '未知人物'}`
              : '尚未选择人物，使用下方通用回复规则。',
          ),
          error && h('p', { className: 'wxarc-error', role: 'alert' }, error),
          busy && h('p', { role: 'status' }, '正在处理，请稍候…'),
          notice && h('p', { role: 'status' }, notice),
          data &&
            h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'wxarc-persona-select' },
                h(
                  'label',
                  null,
                  '选择人物',
                  h(
                    'select',
                    {
                      'aria-label': '选择人物',
                      value: selected,
                      disabled: busy || !data.personas.length,
                      onChange: (e: ChangeEvent) => {
                        setSelected(e.target.value);
                        setNotice('');
                        setError('');
                      },
                    },
                    ...data.personas.map((p) =>
                      h(
                        'option',
                        { key: p.id, value: p.id },
                        `${p.name}${p.name === personaKinds[p.kind] ? '' : ' · ' + personaKinds[p.kind]}${p.id === data.activeId ? '（使用中）' : ''}`,
                      ),
                    ),
                  ),
                ),
                h(
                  'button',
                  {
                    disabled: busy || !currentPersona || selected === data.activeId,
                    onClick: () =>
                      run(async () => {
                        if (!currentPersona) return;
                        await write(`/wxarc/personas/${selected}/activate`, 'POST', {
                          revision: data.revision,
                          personaRevision: currentPersona.revision,
                        });
                        await load(selected);
                        changed();
                        setNotice('已切换人物，从之后的新消息开始使用；原有待发送草稿已取消。');
                      }),
                  },
                  '使用这个人物',
                ),
                h(
                  'button',
                  {
                    disabled: busy,
                    onClick: openWatcherWardrobe,
                  },
                  '去性格衣柜编辑',
                ),
                h(
                  'button',
                  {
                    disabled: busy,
                    onClick: () =>
                      run(async () => {
                        await load(selected);
                        setNotice('已同步最新性格衣柜列表。');
                      }),
                  },
                  '刷新列表',
                ),
              ),
              currentPersona &&
                h(
                  'p',
                  { className: 'wxarc-note' },
                  `${personaKinds[currentPersona.kind] || currentPersona.kind} · 记忆 ${currentPersona.memoryCount} 条 · ${currentPersona.style ? '已提炼表达风格' : '未提炼表达风格'}${currentPersona.definition ? ` · ${currentPersona.definition.slice(0, 80)}` : ''}`,
                ),
              h(
                'p',
                { className: 'wxarc-note' },
                '人物设定、历史风格学习、记忆管理与试聊统一在「性格衣柜」维护，微信端仅选择当前接话人物。',
              ),
            ),
        );
      }

      function AutomationPanel(): ReactElement {
        const [data, setData] = useState<AutomationResponse | null>(null);
        const [form, setForm] = useState<AutomationPolicy | null>(null);
        const [revision, setRevision] = useState(0);
        const [error, setError] = useState('');
        const [notice, setNotice] = useState('');
        const [busy, setBusy] = useState(false);
        const [articlePreview, setArticlePreview] = useState<ArticlePreviewResult | null>(null);
        const initialized = useRef(false);
        useEffect(() => {
          const reset = (): void => {
            initialized.current = false;
          };
          window.addEventListener('wxarc-persona-changed', reset);
          return () => window.removeEventListener('wxarc-persona-changed', reset);
        }, []);
        const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
        useEffect(() => {
          const abort = new AbortController();
          if (form?.provider) {
            api<{ models: Array<{ id: string; name: string }> }>(
              `/wxarc/models?provider=${encodeURIComponent(form.provider)}`,
              abort.signal,
            )
              .then((d) => setModels(d.models))
              .catch(() => setModels([]));
          }
          return () => abort.abort();
        }, [form?.provider]);
        useEffect(() => {
          const abort = new AbortController();
          let timer: number | undefined;
          const load = async (): Promise<void> => {
            try {
              const d = await api<AutomationResponse>('/wxarc/automation', abort.signal);
              if (!abort.signal.aborted) {
                setData(d);
                if (!initialized.current) {
                  setForm(d.policy);
                  setRevision(d.revision);
                  initialized.current = true;
                }
              }
            } catch (e) {
              if (!abort.signal.aborted) setError(errMessage(e));
            }
            if (!abort.signal.aborted) timer = setTimeout(load, 3000);
          };
          load();
          return () => {
            abort.abort();
            clearTimeout(timer);
          };
        }, []);

        const edit = <K extends keyof AutomationPolicy>(key: K, value: AutomationPolicy[K]): void => {
          setForm((old) => (old ? { ...old, [key]: value } : old));
          setNotice('');
        };

        const ruleEdit = <K extends keyof AutomationRule>(
          i: number,
          key: K,
          value: AutomationRule[K],
        ): void => {
          setForm((old) =>
            old
              ? { ...old, rules: old.rules.map((r, j) => (j === i ? { ...r, [key]: value } : r)) }
              : old,
          );
        };

        const write = async <T = Record<string, unknown>>(
          path: string,
          method: string,
          value: unknown,
        ): Promise<T> => {
          const response = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
          });
          const result = (await response.json()) as { error?: string } & T;
          if (!response.ok) throw new Error(result.error || '操作失败');
          return result;
        };

        const save = async (): Promise<void> => {
          if (!form) return;
          setBusy(true);
          setError('');
          try {
            const d = await write<{ revision: number; policy: AutomationPolicy }>(
              '/wxarc/automation',
              'PUT',
              {
                policy: {
                  ...form,
                  adminIds: (form.adminIds || []).map((x) => x.trim()).filter(Boolean),
                },
                revision,
              },
            );
            setRevision(d.revision);
            setForm(d.policy);
            setNotice(
              d.policy.enabled ? '已开启，只处理此后新到达的消息。' : '已保存，自动处理已关闭。',
            );
          } catch (e) {
            setError(errMessage(e));
          } finally {
            setBusy(false);
          }
        };

        const reload = async (): Promise<void> => {
          try {
            const d = await api<AutomationResponse>('/wxarc/automation');
            setData(d);
            setForm(d.policy);
            setRevision(d.revision);
            setError('');
            setNotice('已重新读取设置。');
          } catch (e) {
            setError(errMessage(e));
          }
        };

        const field = (
          label: string,
          key: 'controllerId',
          placeholder: string,
        ): ReactElement =>
          h(
            'label',
            null,
            label,
            h('input', {
              value: form ? form[key] : '',
              placeholder,
              onChange: (e: ChangeEvent) => edit(key, e.target.value),
            }),
          );

        return h(
          'details',
          { className: 'wxarc-auto' },
          h('summary', null, `AI 处理与微信回复${data?.status.enabled ? '（已开启）' : '（未开启）'}`),
          h(
            'p',
            { className: 'wxarc-sub' },
            '由 DSH Agent 在原生会话中处理任务和调用工具，完成后由 SwiftCUA 核对目标并回复微信。',
          ),
          error && h('p', { className: 'wxarc-error', role: 'alert' }, error),
          notice && h('p', { role: 'status' }, notice),
          form
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'wxarc-auto-grid' },
                  h(
                    'label',
                    null,
                    '自动处理',
                    h(
                      'select',
                      {
                        value: String(form.enabled),
                        onChange: (e: ChangeEvent) => edit('enabled', e.target.value === 'true'),
                      },
                      h('option', { value: 'false' }, '关闭'),
                      h('option', { value: 'true' }, '开启'),
                    ),
                  ),
                  h(
                    'label',
                    null,
                    '发送方式',
                    h(
                      'select',
                      {
                        value: form.mode,
                        onChange: (e: ChangeEvent) => edit('mode', e.target.value),
                      },
                      h('option', { value: 'draft' }, '先生成草稿，由我点击发送'),
                      h('option', { value: 'send' }, '自动生成并发送'),
                    ),
                  ),
                  h(
                    'label',
                    null,
                    '聊天范围',
                    h(
                      'select',
                      {
                        value: String(form.allChats),
                        onChange: (e: ChangeEvent) => edit('allChats', e.target.value === 'true'),
                      },
                      h('option', { value: 'false' }, '仅下方指定对象'),
                      h('option', { value: 'true' }, '所有私聊和群聊'),
                    ),
                  ),
                  h(
                    'label',
                    null,
                    '朋友圈',
                    h(
                      'select',
                      {
                        value: form.moments,
                        onChange: (e: ChangeEvent) => edit('moments', e.target.value),
                      },
                      h('option', { value: 'off' }, '不处理'),
                      h('option', { value: 'draft' }, '新动态生成评论草稿'),
                      h('option', { value: 'send' }, '新动态自动评论'),
                    ),
                  ),
                  h(
                    'label',
                    { className: 'wxarc-wide' },
                    '朋友圈最早自动发布时间（本地时间，留空立即生效）',
                    h('input', {
                      type: 'datetime-local',
                      value: form.momentsNotBefore
                        ? new Date(
                            form.momentsNotBefore -
                              new Date(form.momentsNotBefore).getTimezoneOffset() * 60000,
                          )
                            .toISOString()
                            .slice(0, 16)
                        : '',
                      onChange: (e: ChangeEvent) =>
                        edit('momentsNotBefore', e.target.value ? new Date(e.target.value).getTime() : 0),
                    }),
                    h('small', null, '生效前仅生成草稿，生效后只自动处理新动态，旧草稿不批量发布。'),
                  ),
                  h(
                    'label',
                    null,
                    'DSH 模型服务',
                    h('input', {
                      'aria-label': 'DSH 模型服务',
                      list: 'wxarc-providers',
                      value: form.provider,
                      placeholder: '选择 DSH 中已配置的服务',
                      onChange: (e: ChangeEvent) => edit('provider', e.target.value),
                    }),
                    h(
                      'datalist',
                      { id: 'wxarc-providers' },
                      ...(data?.providers || []).map((p) =>
                        h('option', { key: p.id, value: p.id }, p.name || p.id),
                      ),
                    ),
                  ),
                  h(
                    'label',
                    null,
                    '模型名称',
                    h('input', {
                      'aria-label': '模型名称',
                      list: 'wxarc-models',
                      value: form.model,
                      placeholder: '选择该服务中的模型',
                      onChange: (e: ChangeEvent) => edit('model', e.target.value),
                    }),
                    h(
                      'datalist',
                      { id: 'wxarc-models' },
                      ...models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
                    ),
                  ),
                  h(
                    'label',
                    { className: 'wxarc-wide' },
                    '微信管理员（每行一个内部 ID）',
                    h('textarea', {
                      value: (form.adminIds || []).join('\n'),
                      onChange: (e: ChangeEvent) => edit('adminIds', e.target.value.split('\n')),
                      placeholder: 'wxid_…',
                    }),
                    h(
                      'small',
                      null,
                      '仅身份已核实的管理员私聊可访问 Mac mini 工作区以外的文件。所有群消息均使用普通群聊工作区。',
                    ),
                  ),
                  field(
                    '接收审批通知的本人私聊 ID',
                    'controllerId',
                    '填写你自己的微信内部 ID，用于接收工具审批通知',
                  ),
                  h(
                    'label',
                    { className: 'wxarc-wide' },
                    '本人微信内部 ID（用于跳过自己发送的消息）',
                    h('input', {
                      value: form.ownId,
                      placeholder: data?.ownIdSuggestion || '当前微信账号',
                      onChange: (e: ChangeEvent) => edit('ownId', e.target.value),
                    }),
                    data?.ownIdSuggestion &&
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => edit('ownId', data.ownIdSuggestion ?? ''),
                        },
                        '使用当前微信账号',
                      ),
                  ),
                  h(
                    'label',
                    { className: 'wxarc-wide' },
                    '身份、回复风格及业务规则',
                    h('textarea', {
                      value: form.instructions,
                      placeholder: '说明助手以什么身份回复、如何处理问题，以及哪些内容不应回复。',
                      maxLength: 6000,
                      onChange: (e: ChangeEvent) => edit('instructions', e.target.value),
                    }),
                  ),
                  h(
                    'label',
                    null,
                    '只处理最近多少秒的新消息',
                    h('input', {
                      type: 'number',
                      min: 30,
                      max: 3600,
                      value: form.maxAgeSeconds,
                      onChange: (e: ChangeEvent) => edit('maxAgeSeconds', Number(e.target.value)),
                    }),
                  ),
                  h(
                    'label',
                    null,
                    '连续安静多少秒后处理（0 关闭合并）',
                    h('input', {
                      type: 'number',
                      min: 0,
                      max: 60,
                      step: 1,
                      value: (form.debounceMs ?? 10000) / 1000,
                      onChange: (e: ChangeEvent) => edit('debounceMs', Number(e.target.value) * 1000),
                    }),
                  ),
                  h(
                    'label',
                    null,
                    '累计多少条消息立即处理',
                    h('input', {
                      type: 'number',
                      min: 1,
                      max: 24,
                      value: form.debounceMaxMessages ?? 10,
                      onChange: (e: ChangeEvent) =>
                        edit('debounceMaxMessages', Number(e.target.value)),
                    }),
                  ),
                ),
                ...form.rules.map((r, i) =>
                  h(
                    'div',
                    { className: 'wxarc-rule', key: i },
                    h(
                      'div',
                      { className: 'wxarc-auto-grid' },
                      h(
                        'label',
                        null,
                        '处理对象',
                        h(
                          'select',
                          {
                            value: r.sourceId,
                            onChange: (e: ChangeEvent) => {
                              const t = data?.targets.find((item) => item.id === e.target.value);
                              if (!t) return;
                              setForm((old) =>
                                old
                                  ? {
                                      ...old,
                                      rules: old.rules.map((x, j) =>
                                        j === i
                                          ? {
                                              ...x,
                                              sourceId: t.id,
                                              title: t.title,
                                              search: t.id === 'filehelper' ? t.title : '',
                                              wechatId: '',
                                            }
                                          : x,
                                      ),
                                    }
                                  : old,
                              );
                            },
                          },
                          ...(data?.targets || []).map((t) =>
                            h('option', { key: t.id, value: t.id }, t.title || t.id),
                          ),
                        ),
                      ),
                      h(
                        'label',
                        null,
                        '处理类型',
                        h(
                          'select',
                          {
                            value: r.kind,
                            onChange: (e: ChangeEvent) => ruleEdit(i, 'kind', e.target.value),
                          },
                          h('option', { value: 'text' }, '聊天回复'),
                          h('option', { value: 'sns' }, '朋友圈评论'),
                        ),
                      ),
                      h(
                        'label',
                        null,
                        '微信中的会话名称',
                        h('input', {
                          value: r.title,
                          onChange: (e: ChangeEvent) => ruleEdit(i, 'title', e.target.value),
                        }),
                      ),
                      h(
                        'label',
                        null,
                        '搜索联系人时使用的文字',
                        h('input', {
                          value: r.search,
                          onChange: (e: ChangeEvent) => ruleEdit(i, 'search', e.target.value),
                        }),
                      ),
                      r.sourceId !== 'filehelper' &&
                        h(
                          'label',
                          { className: 'wxarc-wide' },
                          '收件人的微信号（发送前精确核对）',
                          h('input', {
                            value: r.wechatId,
                            onChange: (e: ChangeEvent) => ruleEdit(i, 'wechatId', e.target.value),
                          }),
                        ),
                      r.sourceId === 'filehelper' &&
                        h(
                          'label',
                          { className: 'wxarc-wide' },
                          '测试消息前缀（仅此对象允许处理自己发出的测试消息）',
                          h('input', {
                            value: r.testPrefix || '',
                            placeholder: '例如 [DSH测试]',
                            onChange: (e: ChangeEvent) => ruleEdit(i, 'testPrefix', e.target.value),
                          }),
                        ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () =>
                          edit(
                            'rules',
                            form.rules.filter((_, j) => j !== i),
                          ),
                      },
                      '移除此对象',
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'wxarc-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: !data?.targets.length,
                      onClick: () => {
                        const t = data?.targets[0];
                        if (!t) return;
                        edit('rules', [
                          ...form.rules,
                          {
                            kind: 'text',
                            sourceId: t.id,
                            title: t.title,
                            search: t.id === 'filehelper' ? t.title : '',
                            wechatId: '',
                          },
                        ]);
                      },
                    },
                    '添加处理对象',
                  ),
                  h(
                    'button',
                    {
                      disabled: busy || !form.provider || !form.model,
                      onClick: async () => {
                        setBusy(true);
                        setError('');
                        try {
                          const result = await write<{ decision: { text?: string | string[] } }>(
                            '/wxarc/model-test',
                            'POST',
                            { provider: form.provider, model: form.model },
                          );
                          setNotice(`模型测试成功：${replyText(result.decision.text)}（未发送微信）`);
                        } catch (e) {
                          setError(errMessage(e));
                        } finally {
                          setBusy(false);
                        }
                      },
                    },
                    '测试模型',
                  ),
                  h(
                    'button',
                    { className: 'wxarc-save', disabled: busy, onClick: save },
                    busy ? '处理中…' : '保存设置',
                  ),
                  h('button', { disabled: busy, onClick: reload }, '重新读取设置'),
                ),
                h(
                  'p',
                  { className: 'wxarc-note' },
                  '自动发送需要桌面保持解锁。已有输入草稿、收件人无法唯一确认或发送结果不明时，流程会停止；不会自动重发。旧消息不会因开启功能而被批量回复。',
                ),
                data?.status.momentsWaiting &&
                  h(
                    'p',
                    { className: 'wxarc-state' },
                    `朋友圈将在 ${new Date(data.status.momentsNotBefore ?? 0).toLocaleString('zh-CN', { hour12: false })} 后自动评论新动态，此前仅生成草稿。`,
                  ),
                articlePreview &&
                  h(
                    'div',
                    { className: 'wxarc-job' },
                    h(
                      'strong',
                      null,
                      `已读正文 ${articlePreview.event.article.chars} 字符${articlePreview.event.article.snapshot ? '（使用 ' + new Date(articlePreview.event.article.fetched_at).toLocaleString('zh-CN', { hour12: false }) + ' 保存的版本，重新打开失败）' : ''}，以下为重新分析的草稿，未发送`,
                    ),
                    articlePreview.run
                      ? h(NativeRun, { key: articlePreview.run.id, initial: articlePreview.run })
                      : h('p', { className: 'wxarc-text' }, replyText(articlePreview.decision?.text)),
                  ),
                (data?.approvals || []).length > 0 &&
                  h(
                    'div',
                    null,
                    h('h3', null, '操作确认'),
                    ...(data?.approvals || []).map((a) =>
                      h(
                        'div',
                        { key: a.code, className: 'wxarc-job' },
                        h(
                          'p',
                          null,
                          `${a.tool} · ${a.status === 'pending' ? '等待确认' : a.status === 'allowed-task' ? '已批准本轮任务' : a.status === 'allowed-once' ? '已允许一次' : a.status === 'rejected' ? '已拒绝' : '已结束'} · ${a.notice_status === 'sent' ? '已通知本人微信' : a.detail || a.notice_status}`,
                        ),
                        h('p', { className: 'wxarc-text' }, a.args),
                        a.status === 'pending' &&
                          h(
                            'div',
                            { className: 'wxarc-actions' },
                            ...['allowed-once', ...(a.task_eligible ? ['allowed-task'] : []), 'rejected'].map(
                              (outcome) =>
                                h(
                                  'button',
                                  {
                                    key: outcome,
                                    disabled: busy,
                                    onClick: async () => {
                                      setBusy(true);
                                      setError('');
                                      try {
                                        await write(`/wxarc/approvals/${a.code}`, 'POST', { outcome });
                                      } catch (e) {
                                        setError(errMessage(e));
                                      } finally {
                                        setBusy(false);
                                      }
                                    },
                                  },
                                  outcome === 'allowed-task'
                                    ? '批准本轮任务'
                                    : outcome === 'allowed-once'
                                      ? '允许这一次'
                                      : '拒绝',
                                ),
                            ),
                          ),
                      ),
                    ),
                  ),
                h('h3', null, '处理记录'),
                (data?.jobs || []).length
                  ? (data?.jobs || []).map((j) =>
                      h(
                        'article',
                        { key: j.id, className: 'wxarc-job' },
                        h('div', { className: 'wxarc-title' }, `${j.rule.title}：${jobNames[j.status] || j.status}`),
                        h('p', { className: 'wxarc-text' }, j.event.text),
                        j.event.personaName && h('small', null, `回复人物：${j.event.personaName}`),
                        j.decision?.action === 'image' && h('p', null, '图片：' + j.decision.image),
                        j.decision?.text &&
                          h(
                            'p',
                            { className: 'wxarc-text' },
                            j.decision.action === 'sticker'
                              ? `表情包：候选 ${j.decision.sticker?.index}（文字备用：${replyText(j.decision.text)}）`
                              : `回复：${replyText(j.decision.text)}`,
                          ),
                        j.event.image?.status === 'read' &&
                          h('p', { className: 'wxarc-note' }, '已将实际图片附加到 DSH 会话'),
                        j.event.article?.status === 'read' &&
                          h('p', { className: 'wxarc-note' }, `已读取文章正文 ${j.event.article.chars} 字符`),
                        h('small', null, j.detail),
                        j.event.dshSessionId &&
                          h(
                            'button',
                            { onClick: () => openSession(j.event.dshSessionId!) },
                            '打开 DSH 会话',
                          ),
                        j.event.kind === 'text' &&
                          j.event.local_type % 4294967296 === 49 &&
                          j.event.text.startsWith('[链接]') &&
                          h(
                            'button',
                            {
                              disabled: busy || data?.status.active,
                              onClick: async () => {
                                setBusy(true);
                                setError('');
                                setArticlePreview(null);
                                try {
                                  setArticlePreview(
                                    await write<ArticlePreviewResult>(
                                      `/wxarc/events/${j.event_seq}/article-preview`,
                                      'POST',
                                      { revision: data?.revision },
                                    ),
                                  );
                                } catch (e) {
                                  setError(errMessage(e));
                                } finally {
                                  setBusy(false);
                                }
                              },
                            },
                            '阅读全文并重新分析（不发送）',
                          ),
                        j.event.dshRunId &&
                          ['failed', 'cancelled', 'manual'].includes(j.status) &&
                          h(
                            'button',
                            {
                              disabled: busy,
                              onClick: async () => {
                                setBusy(true);
                                setError('');
                                try {
                                  await write(`/wxarc/jobs/${j.id}/resume`, 'POST', {
                                    revision: data?.revision,
                                  });
                                  setNotice('已回到原 DSH 会话继续，先检查已执行的操作。');
                                } catch (e) {
                                  setError(errMessage(e));
                                } finally {
                                  setBusy(false);
                                }
                              },
                            },
                            '继续 DSH 任务',
                          ),
                        !j.event.dshRunId &&
                          ['failed', 'cancelled', 'ignored'].includes(j.status) &&
                          h(
                            'button',
                            {
                              disabled: busy || data?.status.active,
                              onClick: async () => {
                                setBusy(true);
                                setError('');
                                try {
                                  await write(`/wxarc/events/${j.event_seq}/process`, 'POST', {
                                    revision: data?.revision,
                                  });
                                  setNotice('已重新排队，请查看处理记录。');
                                } catch (e) {
                                  setError(errMessage(e));
                                } finally {
                                  setBusy(false);
                                }
                              },
                            },
                            '重新处理',
                          ),
                        j.status === 'draft' &&
                          h(
                            'div',
                            null,
                            h(
                              'button',
                              {
                                disabled: busy || data?.status.active,
                                onClick: async () => {
                                  setBusy(true);
                                  setError('');
                                  try {
                                    await write(`/wxarc/jobs/${j.id}/send`, 'POST', {});
                                    setNotice('已执行发送流程，请查看处理结果。');
                                  } catch (e) {
                                    setError(errMessage(e));
                                  } finally {
                                    setBusy(false);
                                  }
                                },
                              },
                              '通过微信发送这条草稿',
                            ),
                          ),
                      ),
                    )
                  : h('p', { className: 'wxarc-sub' }, '尚无处理记录。'),
              )
            : h('p', null, '正在读取自动处理设置…'),
        );
      }

      function Panel(): ReactElement {
        const [status, setStatus] = useState<StatusResponse | null>(null);
        const [events, setEvents] = useState<FeedEvent[]>([]);
        const [error, setError] = useState('');
        const [kind, setKind] = useState('');
        const [query, setQuery] = useState('');
        const [paused, setPaused] = useState(false);
        const [before, setBefore] = useState(0);
        const [refresh, setRefresh] = useState(0);
        useEffect(() => {
          const abort = new AbortController();
          let timer: number | undefined;
          const update = async (): Promise<void> => {
            try {
              const q = new URLSearchParams({
                kind,
                query,
                before: String(before),
                limit: '100',
              });
              const [s, result] = await Promise.all([
                api<StatusResponse>('/wxarc/status', abort.signal),
                api<{ events: FeedEvent[] }>(`/wxarc/events?${q}`, abort.signal),
              ]);
              if (!abort.signal.aborted) {
                setStatus(s);
                setEvents(result.events);
                setError('');
              }
            } catch (err) {
              if (!abort.signal.aborted) setError(errMessage(err));
            }
            if (!abort.signal.aborted && !paused) timer = setTimeout(update, 3000);
          };
          update();
          return () => {
            abort.abort();
            clearTimeout(timer);
          };
        }, [kind, query, before, paused, refresh]);

        const time = (ts?: number): string =>
          ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '时间未知';

        return h(
          'section',
          { className: 'wxarc-panel', 'aria-label': '微信消息监听' },
          h('style', null, css),
          h(
            'div',
            { className: 'wxarc-wrap' },
            h(
              'header',
              { className: 'wxarc-head' },
              h(
                'div',
                null,
                h('h1', null, '微信消息'),
                h('p', { className: 'wxarc-sub' }, '来自这台 Mac mini 的 wxarc'),
              ),
              h(
                'span',
                {
                  className: `wxarc-state ${status?.healthy && !error ? '' : 'bad'}`,
                  role: 'status',
                },
                error
                  ? '连接中断'
                  : status?.healthy
                    ? '监听正常'
                    : status?.connected
                      ? '采集需检查'
                      : '连接中断或等待连接',
              ),
            ),
            h(
              'div',
              { className: 'wxarc-details' },
              h(
                'p',
                null,
                status
                  ? `已缓存 ${status.retained} 条消息。每类最多保留 ${status.retainPerStream.toLocaleString()} 条。`
                  : '正在读取监听状态…',
              ),
              h(
                'p',
                { className: 'wxarc-sub' },
                status?.lastSuccess
                  ? `最近同步：${new Date(status.lastSuccess).toLocaleString('zh-CN', { hour12: false })}`
                  : '首次连接后将补采已有事件。',
              ),
              status?.lastError && h('p', { className: 'wxarc-error' }, status.lastError),
              status?.connected &&
                !status.healthy &&
                h(
                  'p',
                  { className: 'wxarc-error' },
                  'wxarc 采集未就绪或数据未更新，请确认微信已登录，并检查 wxarc 服务。',
                ),
            ),
            error && h('p', { className: 'wxarc-error', role: 'alert' }, error),
            h(NativeSessions),
            h(PersonaPanel),
            h(AutomationPanel),
            h(
              'div',
              { className: 'wxarc-bar' },
              h(
                'select',
                {
                  value: kind,
                  'aria-label': '消息类型',
                  onChange: (e: ChangeEvent) => {
                    setKind(e.target.value);
                    setBefore(0);
                  },
                },
                h('option', { value: '' }, '全部消息'),
                ...Object.entries(labels).map(([key, text]) =>
                  h('option', { key, value: key }, text),
                ),
              ),
              h('input', {
                value: query,
                maxLength: 200,
                placeholder: '搜索联系人、会话或正文',
                'aria-label': '搜索消息',
                onChange: (e: ChangeEvent) => {
                  setQuery(e.target.value);
                  setBefore(0);
                },
              }),
              h('button', { onClick: () => setPaused(!paused) }, paused ? '恢复刷新' : '暂停刷新'),
              h('button', { onClick: () => setRefresh(refresh + 1) }, '刷新'),
            ),
            h(
              'div',
              { className: 'wxarc-feed', 'aria-label': '消息列表' },
              events.length
                ? events.map((e) =>
                    h(
                      'article',
                      { className: 'wxarc-row', key: e.seq },
                      h(
                        'div',
                        { className: 'wxarc-meta' },
                        h('div', { className: 'wxarc-kind' }, labels[e.kind]),
                        h('div', { className: 'wxarc-time' }, time(e.ts)),
                      ),
                      h(
                        'div',
                        null,
                        h(
                          'div',
                          { className: 'wxarc-title' },
                          e.session_name || e.user_name || e.session || '未知会话',
                        ),
                        e.sender &&
                          e.sender !== e.session_name &&
                          h('div', { className: 'wxarc-sub' }, `发送者：${e.sender}`),
                        h(
                          'p',
                          { className: 'wxarc-text' },
                          e.text ||
                            (e.kind === 'media'
                              ? `本地媒体：${e.type || '文件'}`
                              : `非文字消息（类型 ${e.local_type ?? '未知'}）`),
                        ),
                        e.kind !== 'media' &&
                          h(
                            'button',
                            {
                              onClick: async () => {
                                try {
                                  const settings =
                                    await api<{ revision: number }>('/wxarc/automation');
                                  const response = await fetch(`/wxarc/events/${e.seq}/process`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ revision: settings.revision }),
                                  });
                                  const result = (await response.json()) as { error?: string };
                                  if (!response.ok) throw new Error(result.error);
                                  setError('');
                                  setRefresh((x) => x + 1);
                                } catch (err) {
                                  setError(errMessage(err));
                                }
                              },
                            },
                            '处理这条消息',
                          ),
                      ),
                    ),
                  )
                : h(
                    'div',
                    { className: 'wxarc-empty' },
                    query || kind
                      ? '当前筛选没有匹配消息。'
                      : '还没有收到事件。微信同步到本机后，消息会显示在这里。',
                  ),
            ),
            h(
              'div',
              { className: 'wxarc-foot' },
              h(
                'span',
                null,
                paused ? '页面刷新已暂停，后台仍在采集。' : '按接收顺序排列，每 3 秒刷新。',
              ),
              h(
                'div',
                null,
                before > 0 && h('button', { onClick: () => setBefore(0) }, '返回最新'),
                ' ',
                h(
                  'button',
                  {
                    disabled: events.length < 100,
                    onClick: () => {
                      const last = events.at(-1);
                      if (last) setBefore(last.seq);
                    },
                  },
                  '更早消息',
                ),
              ),
            ),
            h(
              'p',
              { className: 'wxarc-note' },
              '消息来自本机已同步的数据。AI 处理与发送行为以展开面板中的设置为准。图片、视频和更早的完整记录请在 wxarc 中查看。',
            ),
          ),
        );
      }

      function Icon({ size = 20 }: { size?: number }): ReactElement {
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            'aria-hidden': true,
          },
          h('path', { d: 'M20 11a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 17-4Z' }),
          h('path', { d: 'M7 10h10M7 14h6' }),
        );
      }

      const inject = ['slots', 'uiWorkspace'];
      function apply(ctx: PluginContext): void {
        openSession = (id: string) => ctx.uiWorkspace.openSession(id);
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({}) }, Panel),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL, order: 12, label: () => '微信消息' },
            Icon,
          ),
        );
      }
      return { inject, apply };
    },
  });
})();
