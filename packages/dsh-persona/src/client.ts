interface ReactNodeLike {
  readonly __brand?: 'react-node';
}

interface ReactRuntime {
  createElement: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ReactNodeLike;
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T;
}

interface SlotContext {
  slots: {
    inject: (name: string, factory: () => unknown) => void;
    register: (meta: Record<string, unknown>, component: unknown) => unknown;
  };
}

interface PersonaWindow {
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

interface PersonaView {
  id: string;
  kind: 'double' | 'original' | 'fiction';
  name: string;
  definition: string;
  work: string;
  character: string;
  style: string;
  learning: boolean;
  revision: number;
  memoryCount: number;
}

interface MemoryView {
  id: number;
  scope: string;
  note: string;
  quote: string;
  category: string;
}

interface SampleInfoView {
  available: boolean;
  count?: number;
  source?: string;
  createdAt?: string;
  path?: string;
}

interface ChangeEventLike {
  target: { value: string; checked?: boolean };
}

void (() => {
  (window as unknown as PersonaWindow).__ModuleLoader__?.load({
    id: '@local/dsh-persona',
    factory: (require) => {
      const React = require('react') as ReactRuntime;
      const { useEffect, useState, useCallback } = React;
      const h = React.createElement;
      const PANEL_ID = 'dsh-persona-panel';

      const KIND_LABELS: Record<PersonaView['kind'], string> = {
        double: '我的分身',
        original: '原创人物',
        fiction: '作品角色',
      };

      const CSS = [
        '.dp-root{height:100%;overflow:auto;background:#f6f7f8;color:#1d2422;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;font-size:14px;line-height:1.55}',
        '.dp-wrap{max-width:1040px;margin:0 auto;padding:22px 26px 48px}',
        '.dp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;flex-wrap:wrap}',
        '.dp-head h1{margin:0;font-size:21px;font-weight:650}',
        '.dp-sub{margin:4px 0 0;color:#5a6b64;font-size:13px}',
        '.dp-card{background:#fff;border:1px solid #dce4df;border-radius:10px;padding:14px 16px;margin-bottom:12px}',
        '.dp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
        '.dp-space{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}',
        '.dp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}',
        '.dp-wide{grid-column:1/-1}',
        '.dp-root input,.dp-root select,.dp-root textarea,.dp-root button{font:inherit;border:1px solid #c9d6ce;border-radius:6px;padding:7px 11px;background:#fff;color:#1d2422}',
        '.dp-root textarea{width:100%;min-height:74px;box-sizing:border-box;resize:vertical}',
        '.dp-root button{cursor:pointer}.dp-root button:disabled{opacity:.5;cursor:default}',
        '.dp-primary{background:#227455!important;border-color:#227455!important;color:#fff!important}',
        '.dp-danger{color:#b42318!important;border-color:#f2c6c2!important}',
        '.dp-badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;background:#e6f2ec;color:#1c5f43}',
        '.dp-tab{border:1px solid #cbd7d0;background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}',
        '.dp-tab.active{background:#227455;border-color:#227455;color:#fff;font-weight:600}',
        '.dp-mem{border-top:1px solid #e7eeea;padding:8px 0;margin-top:8px}',
        '.dp-err{color:#b42318;margin:8px 0}.dp-ok{color:#1c5f43;margin:8px 0}',
        '.dp-pre{white-space:pre-wrap;background:#f7faf8;padding:10px;border-radius:6px;margin-top:8px}',
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

      function PersonaPanel(): ReactNodeLike {
        const [personas, setPersonas] = useState<PersonaView[]>([]);
        const [selectedId, setSelectedId] = useState('');
        const [draft, setDraft] = useState<PersonaView | null>(null);
        const [memories, setMemories] = useState<MemoryView[]>([]);
        const [editingMemId, setEditingMemId] = useState<number | null>(null);
        const [editingNote, setEditingNote] = useState('');
        const [sampleInfo, setSampleInfo] = useState<SampleInfoView>({ available: false });
        const [previewInput, setPreviewInput] = useState('');
        const [previewReply, setPreviewReply] = useState('');
        const [wxarcPath, setWxarcPath] = useState('~/.dsh/wxarc-listener/events.sqlite');
        const [busy, setBusy] = useState(false);
        const [notice, setNotice] = useState('');
        const [error, setError] = useState('');

        const loadMemories = useCallback(async (id: string): Promise<void> => {
          if (!id) {
            setMemories([]);
            return;
          }
          const data = await api<{ memories: MemoryView[] }>(
            `/local-persona/personas/${encodeURIComponent(id)}/memories?limit=60`,
          );
          setMemories(data.memories || []);
        }, []);

        const refreshAll = useCallback(
          async (preferId?: string): Promise<void> => {
            setError('');
            try {
              const [pRes, sRes] = await Promise.all([
                api<{ personas: PersonaView[] }>('/local-persona/personas'),
                api<SampleInfoView>('/local-persona/sample-info'),
              ]);
              const list = pRes.personas || [];
              setPersonas(list);
              setSampleInfo(sRes || { available: false });
              const nextId = preferId ?? (list.some((p) => p.id === selectedId) ? selectedId : list[0]?.id ?? '');
              setSelectedId(nextId);
              const found = list.find((p) => p.id === nextId) ?? null;
              setDraft(found ? { ...found } : null);
              if (nextId) await loadMemories(nextId);
              else setMemories([]);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          },
          [selectedId, loadMemories],
        );

        useEffect(() => {
          void refreshAll();
        }, []);

        async function runAction(label: string, fn: () => Promise<void>): Promise<void> {
          setBusy(true);
          setError('');
          setNotice('');
          try {
            await fn();
            setNotice(label);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }

        function selectPersona(p: PersonaView): void {
          setSelectedId(p.id);
          setDraft({ ...p });
          setPreviewReply('');
          setEditingMemId(null);
          void loadMemories(p.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }

        async function createPersona(kind: PersonaView['kind']): Promise<void> {
          await runAction(`已创建「${KIND_LABELS[kind]}」`, async () => {
            const res = await api<{ persona: PersonaView }>('/local-persona/personas', {
              method: 'POST',
              body: JSON.stringify({ kind }),
            });
            await refreshAll(res.persona.id);
          });
        }

        async function savePersona(): Promise<void> {
          if (!draft) return;
          await runAction('人格配置已保存', async () => {
            const res = await api<{ persona: PersonaView }>(
              `/local-persona/personas/${encodeURIComponent(draft.id)}`,
              {
                method: 'PUT',
                body: JSON.stringify({ persona: draft, revision: draft.revision }),
              },
            );
            setDraft({ ...res.persona });
            await refreshAll(res.persona.id);
          });
        }

        async function deletePersona(): Promise<void> {
          if (!draft) return;
          const targetId = draft.id;
          await runAction('已删除人格', async () => {
            await api(`/local-persona/personas/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
            await refreshAll('');
          });
        }

        async function learnStyle(): Promise<void> {
          if (!draft) return;
          await runAction('已从本人样本提炼风格', async () => {
            const res = await api<{ persona: PersonaView }>(
              `/local-persona/personas/${encodeURIComponent(draft.id)}/learn-style`,
              {
                method: 'POST',
                body: JSON.stringify({ revision: draft.revision }),
              },
            );
            setDraft({ ...res.persona });
            await refreshAll(res.persona.id);
          });
        }

        async function runPreview(): Promise<void> {
          if (!draft || !previewInput.trim()) return;
          await runAction('试聊完成（未写入任何记忆）', async () => {
            const res = await api<{ reply: string }>(
              `/local-persona/personas/${encodeURIComponent(draft.id)}/preview`,
              {
                method: 'POST',
                body: JSON.stringify({ message: previewInput.trim() }),
              },
            );
            setPreviewReply(res.reply || '');
          });
        }

        async function saveMemory(memId: number): Promise<void> {
          if (!draft || !editingNote.trim()) return;
          await runAction('记忆已更新', async () => {
            await api(`/local-persona/personas/${encodeURIComponent(draft.id)}/memories/${memId}`, {
              method: 'PUT',
              body: JSON.stringify({ note: editingNote.trim() }),
            });
            setEditingMemId(null);
            await loadMemories(draft.id);
          });
        }

        async function clearMemories(): Promise<void> {
          if (!draft) return;
          await runAction('已清空该人格记忆', async () => {
            await api(`/local-persona/personas/${encodeURIComponent(draft.id)}/memories`, {
              method: 'DELETE',
            });
            await refreshAll(draft.id);
          });
        }

        async function importWxarc(): Promise<void> {
          if (!wxarcPath.trim()) return;
          await runAction('已导入 wxarc SQLite 数据', async () => {
            await api('/local-persona/personas/import-wxarc', {
              method: 'POST',
              body: JSON.stringify({ sqlitePath: wxarcPath.trim() }),
            });
            await refreshAll();
          });
        }

        return h(
          'div',
          { className: 'dp-root' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dp-wrap' },
            h(
              'div',
              { className: 'dp-head' },
              h(
                'div',
                null,
                h('h1', null, '性格衣柜'),
                h('p', { className: 'dp-sub' }, '独立人格卡片、本人样本风格学习、记忆管理与试聊'),
              ),
              h(
                'div',
                { className: 'dp-row' },
                h('button', { disabled: busy, onClick: () => void createPersona('double') }, '+ 我的分身'),
                h('button', { disabled: busy, onClick: () => void createPersona('original') }, '+ 原创人物'),
                h('button', { disabled: busy, onClick: () => void createPersona('fiction') }, '+ 作品角色'),
                h('button', { disabled: busy, onClick: () => void refreshAll() }, '刷新'),
              ),
            ),
            error ? h('div', { className: 'dp-err' }, error) : null,
            notice ? h('div', { className: 'dp-ok' }, notice) : null,
            h(
              'div',
              { className: 'dp-card' },
              h(
                'div',
                { className: 'dp-space' },
                h(
                  'div',
                  { className: 'dp-row' },
                  h('span', { className: 'dp-badge' }, sampleInfo.available ? `本人样本就绪（${sampleInfo.count ?? 0} 条）` : '未检测到本人样本文件'),
                  sampleInfo.path ? h('span', { className: 'dp-sub' }, sampleInfo.path) : null,
                ),
                h(
                  'div',
                  { className: 'dp-row' },
                  h('input', {
                    value: wxarcPath,
                    onChange: (e: ChangeEventLike) => setWxarcPath(e.target.value),
                    placeholder: 'wxarc SQLite 路径',
                    style: { minWidth: 260 },
                  }),
                  h('button', { disabled: busy, onClick: () => void importWxarc() }, '导入 wxarc 数据'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dp-row', style: { marginBottom: 12 } },
              personas.length === 0
                ? h('span', { className: 'dp-sub' }, '暂无人格，请点击上方按钮新建或导入。')
                : personas.map((p) =>
                    h(
                      'button',
                      {
                        key: p.id,
                        className: p.id === selectedId ? 'dp-tab active' : 'dp-tab',
                        onClick: () => selectPersona(p),
                      },
                      `${p.name}（${KIND_LABELS[p.kind]} · ${p.memoryCount}）`,
                    ),
                  ),
            ),
            draft
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dp-card' },
                    h(
                      'div',
                      { className: 'dp-space' },
                      h('strong', null, `${draft.name} · v${draft.revision}`),
                      h(
                        'div',
                        { className: 'dp-row' },
                        h(
                          'button',
                          {
                            disabled: busy || !sampleInfo.available,
                            onClick: () => void learnStyle(),
                          },
                          '从本人样本学习',
                        ),
                        h('button', { className: 'dp-primary', disabled: busy, onClick: () => void savePersona() }, '保存配置'),
                        h('button', { className: 'dp-danger', disabled: busy, onClick: () => void deletePersona() }, '删除人格'),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dp-grid' },
                      h('input', {
                        value: draft.name,
                        placeholder: '人格名称',
                        onChange: (e: ChangeEventLike) => setDraft({ ...draft, name: e.target.value }),
                      }),
                      h(
                        'select',
                        {
                          value: draft.kind,
                          onChange: (e: ChangeEventLike) =>
                            setDraft({ ...draft, kind: e.target.value as PersonaView['kind'] }),
                        },
                        h('option', { value: 'double' }, '我的分身'),
                        h('option', { value: 'original' }, '原创人物'),
                        h('option', { value: 'fiction' }, '作品角色'),
                      ),
                      h('input', {
                        value: draft.work,
                        placeholder: '作品 / 场景',
                        onChange: (e: ChangeEventLike) => setDraft({ ...draft, work: e.target.value }),
                      }),
                      h('input', {
                        value: draft.character,
                        placeholder: '角色 / 身份',
                        onChange: (e: ChangeEventLike) => setDraft({ ...draft, character: e.target.value }),
                      }),
                      h('textarea', {
                        className: 'dp-wide',
                        value: draft.definition,
                        placeholder: '核心设定',
                        onChange: (e: ChangeEventLike) => setDraft({ ...draft, definition: e.target.value }),
                      }),
                      h('textarea', {
                        className: 'dp-wide',
                        value: draft.style,
                        placeholder: '说话风格摘要（可手写或点击「从本人样本学习」）',
                        onChange: (e: ChangeEventLike) => setDraft({ ...draft, style: e.target.value }),
                      }),
                      h(
                        'label',
                        { className: 'dp-row dp-wide' },
                        h('input', {
                          type: 'checkbox',
                          checked: draft.learning,
                          onChange: (e: ChangeEventLike) => setDraft({ ...draft, learning: Boolean(e.target.checked) }),
                        }),
                        '允许在对话中自动记录偏好记忆',
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dp-card' },
                    h('strong', null, '沙盒试聊（不写入记忆）'),
                    h(
                      'div',
                      { className: 'dp-row', style: { marginTop: 8 } },
                      h('input', {
                        value: previewInput,
                        placeholder: '输入试聊消息...',
                        style: { flex: 1, minWidth: 240 },
                        onChange: (e: ChangeEventLike) => setPreviewInput(e.target.value),
                      }),
                      h('button', { className: 'dp-primary', disabled: busy, onClick: () => void runPreview() }, '发送试聊'),
                    ),
                    previewReply ? h('div', { className: 'dp-pre' }, previewReply) : null,
                  ),
                  h(
                    'div',
                    { className: 'dp-card' },
                    h(
                      'div',
                      { className: 'dp-space' },
                      h('strong', null, `记忆列表（${memories.length} 条）`),
                      h('button', { className: 'dp-danger', disabled: busy || memories.length === 0, onClick: () => void clearMemories() }, '清空全部记忆'),
                    ),
                    memories.length === 0
                      ? h('p', { className: 'dp-sub' }, '暂无记忆记录。')
                      : memories.map((mem) =>
                          h(
                            'div',
                            { key: mem.id, className: 'dp-mem' },
                            h(
                              'div',
                              { className: 'dp-space' },
                              h('span', { className: 'dp-badge' }, `${mem.category} · ${mem.scope}`),
                              editingMemId === mem.id
                                ? h(
                                    'div',
                                    { className: 'dp-row' },
                                    h('button', { className: 'dp-primary', disabled: busy, onClick: () => void saveMemory(mem.id) }, '保存'),
                                    h('button', { onClick: () => setEditingMemId(null) }, '取消'),
                                  )
                                : h(
                                    'button',
                                    {
                                      onClick: () => {
                                        setEditingMemId(mem.id);
                                        setEditingNote(mem.note);
                                      },
                                    },
                                    '编辑',
                                  ),
                            ),
                            editingMemId === mem.id
                              ? h('input', {
                                  value: editingNote,
                                  style: { width: '100%', marginTop: 6, boxSizing: 'border-box' },
                                  onChange: (e: ChangeEventLike) => setEditingNote(e.target.value),
                                })
                              : h('div', { style: { marginTop: 6 } }, mem.note),
                            mem.quote ? h('div', { className: 'dp-sub' }, `原话：${mem.quote}`) : null,
                          ),
                        ),
                  ),
                )
              : null,
          ),
        );
      }

      function PersonaIcon(): ReactNodeLike {
        return h(
          'svg',
          {
            width: 18,
            height: 18,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('circle', { cx: 12, cy: 8, r: 4 }),
          h('path', { d: 'M5 20c1.5-3.5 4.2-5 7-5s5.5 1.5 7 5' }),
        );
      }

      const inject = ['slots'];
      function apply(ctx: SlotContext): void {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, PersonaPanel),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 14, label: () => '性格衣柜' },
            PersonaIcon,
          ),
        );
      }

      return { inject, apply };
    },
  });
})();
