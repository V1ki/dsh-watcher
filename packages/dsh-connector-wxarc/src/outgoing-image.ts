import { openSync, closeSync, fstatSync, constants, readSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageType } from './images.js';
import { sessionPoint } from './session-position.js';
import type { DesktopLayout } from './session-position.js';
import { validateAccount } from './source.js';
import type { ClipboardFn } from './clipboard.js';
import type { CuaAppState, CuaNode, CuaRule, CuaRunner, PreparedCommit } from './cua.js';

export interface OutgoingImageData {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
  hash: string;
}

export interface OutgoingImageJob {
  rule: CuaRule;
  event: {
    session?: string;
  };
  decision: {
    image?: string;
  };
}

export interface OutgoingImageCua {
  runner: CuaRunner;
  pause: (ms: number, signal: AbortSignal) => Promise<void>;
  pasteboard: ClipboardFn;
  openChat(rule: CuaRule, signal: AbortSignal): Promise<CuaAppState>;
  focusInput(state: CuaAppState, title: string, signal: AbortSignal): Promise<CuaAppState>;
  state(
    signal: AbortSignal,
    extra?: Record<string, unknown>,
    activate?: boolean,
  ): Promise<CuaAppState>;
  chat(state: CuaAppState, title: string): { nodes: CuaNode[]; input: CuaNode };
  call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    activate?: boolean,
  ): Promise<Record<string, unknown>>;
}

export interface OutgoingImageAutomation {
  cua: OutgoingImageCua;
  outgoingPython: string;
  wxarcHome: string;
  tail(): number;
  settings(): { policy: { ownId: string } };
  listener: { wechatRoot?: string };
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

export const validImageName = (n: unknown): n is string =>
  typeof n === 'string' && /^[^./\\:\x00-\x1f][^/\\:\x00-\x1f]{0,110}\.(png|jpe?g)$/iu.test(n);

const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_LOCAL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

export function loadLocalImage(imagePath: unknown): OutgoingImageData {
  if (typeof imagePath !== 'string') {
    throw new Error('图片路径必须是字符串');
  }
  const trimmed = imagePath.trim();
  if (!trimmed || trimmed.includes('\0') || !isAbsolute(trimmed)) {
    throw new Error('图片路径必须是本地绝对路径');
  }
  const ext = extname(trimmed).toLowerCase();
  if (!ALLOWED_LOCAL_IMAGE_EXTS.has(ext)) {
    throw new Error('图片仅支持 .png、.jpg 或 .jpeg 格式');
  }
  let fd: number;
  try {
    fd = openSync(trimmed, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new Error('图片文件不存在或无法读取');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error('图片必须是普通文件且不超过 8 MiB');
    }
    const bytes = Buffer.alloc(stat.size);
    let n = 0;
    while (n < bytes.length) {
      const k = readSync(fd, bytes, n, bytes.length - n, n);
      if (!k) throw new Error('图片读取不完整');
      n += k;
    }
    let mime: string;
    try {
      mime = imageType(bytes);
    } catch {
      throw new Error('图片内容不是有效的 PNG 或 JPEG 文件');
    }
    const expectedMime = ext === '.png' ? 'image/png' : 'image/jpeg';
    if (mime !== expectedMime) {
      throw new Error('图片格式与文件名不一致');
    }
    return {
      bytes,
      mime: expectedMime,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}

export function outgoingImage(
  root: string,
  cwd: string | null | undefined,
  name: unknown,
): OutgoingImageData {
  if (
    !validImageName(name) ||
    !cwd ||
    cwd !== realpathSync(cwd) ||
    !cwd.startsWith(realpathSync(root) + '/') ||
    !/^[a-f0-9]{20}$/.test(cwd.slice(realpathSync(root).length + 1))
  ) {
    throw Error('只能发送当前会话工作目录内的 PNG 或 JPEG 图片');
  }
  const fd = openSync(join(cwd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8 * 1024 * 1024) {
      throw Error('图片必须是普通文件且不超过 8 MiB');
    }
    const bytes = Buffer.alloc(stat.size);
    let n = 0;
    while (n < bytes.length) {
      const k = readSync(fd, bytes, n, bytes.length - n, n);
      if (!k) throw Error('图片读取不完整');
      n += k;
    }
    const mime = imageType(bytes);
    const expectedMime = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    if (mime !== expectedMime) {
      throw Error('图片格式与文件名不一致');
    }
    return {
      bytes,
      mime,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}

export const pixelDigest = (
  python: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((ok, no) => {
    const child = execFile(
      python,
      ['-B', fileURLToPath(new URL('./image-pixels.py', import.meta.url))],
      { signal, timeout: 10000 },
      (e, out) => (e ? no(Error('图片无法解码或超过 400 万像素')) : ok(out.trim())),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(bytes);
  });

export async function prepareImage(
  auto: OutgoingImageAutomation,
  job: OutgoingImageJob,
  img: OutgoingImageData,
  signal: AbortSignal,
): Promise<PreparedCommit> {
  const c = auto.cua;
  const python = auto.outgoingPython;
  const title = job.rule.title;
  await pixelDigest(python, img.bytes, signal);
  let state = await c.openChat(job.rule, signal);
  state = await c.focusInput(state, title, signal);
  const wid = state.info?.window?.id;

  async function input(
    s: AbortSignal,
    expected: string,
  ): Promise<{ st: CuaAppState; nodes: CuaNode[] }> {
    const st = await c.state(s);
    const { input: field, nodes } = c.chat(st, title);
    if (
      st.info?.frontmostApp !== 'com.tencent.xinWeChat' ||
      st.info?.window?.id !== wid ||
      field.value !== expected ||
      !field.states?.includes('focused') ||
      nodes.some((n) => n.title === '删除引用消息')
    ) {
      throw Error('图片发送前会话、焦点或草稿已改变');
    }
    return { st, nodes };
  }

  const key = (keyName: string, s: AbortSignal): Promise<Record<string, unknown>> =>
    c.call('pressKey', { key: keyName, windowId: wid }, s, true);

  const picture = async (s: AbortSignal): Promise<{ count: number | undefined; hash: string }> => {
    const p = await c.pasteboard({ action: 'image' }, s);
    return {
      count: p.count,
      hash: await pixelDigest(python, Buffer.from(p.data ?? '', 'base64'), s),
    };
  };

  const snap = await c.pasteboard({ action: 'snapshot' }, signal);
  let own: number | undefined;
  let expected: string | undefined;
  try {
    own = (
      await c.pasteboard(
        {
          action: 'setImage',
          count: snap.count ?? 0,
          type: img.mime === 'image/png' ? 'public.png' : 'public.jpeg',
          data: img.bytes.toString('base64'),
        },
        signal,
      )
    ).count;
    const p = await picture(signal);
    if (p.count !== own) throw Error('剪贴板已改变');
    expected = p.hash;
    await input(signal, '');
    if ((await c.pasteboard({ action: 'count' }, signal)).count !== own) {
      throw Error('剪贴板已改变');
    }
    await key('Cmd+v', signal);
    await c.pause(300, signal);
    await input(signal, '\uFFFC');
  } finally {
    if (own !== undefined) {
      await c.pasteboard(
        { action: 'restore', count: own, items: snap.items ?? [] },
        AbortSignal.timeout(8000),
      );
    }
  }

  async function verify(s: AbortSignal): Promise<{ st: CuaAppState; nodes: CuaNode[] }> {
    await input(s, '\uFFFC');
    const saved = await c.pasteboard({ action: 'snapshot' }, s);
    let copied: number | undefined;
    try {
      await key('Cmd+a', s);
      await key('Cmd+c', s);
      const p = await picture(s);
      copied = p.count;
      if (p.count === saved.count || p.hash !== expected) {
        throw Error('微信图片草稿与选中图片不一致');
      }
      return await input(s, '\uFFFC');
    } finally {
      if (copied !== undefined && copied !== saved.count) {
        await c.pasteboard(
          { action: 'restore', count: copied, items: saved.items ?? [] },
          AbortSignal.timeout(8000),
        );
      }
    }
  }

  let used = false;
  const commit: PreparedCommit = async (s: AbortSignal) => {
    if (used) throw Error('图片已尝试发送');
    used = true;
    await verify(s);
    const { nodes, st } = await input(s, '\uFFFC');
    const buttons = nodes.filter(
      (n) => n.role === 'AXButton' && n.title === '发送' && n.states?.includes('enabled'),
    );
    if (buttons.length !== 1 || !Number.isInteger(buttons[0].index)) {
      throw Error('图片发送按钮不可核实');
    }
    const { stdout } = await c.runner(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', fileURLToPath(new URL('./desktop-layout.jxa', import.meta.url)), String(wid)],
      { signal: s, timeout: 5000 },
    );
    const { point } = sessionPoint(
      buttons[0].frame,
      st.info?.window?.bounds,
      JSON.parse(stdout) as DesktopLayout,
      false,
    );
    await input(s, '\uFFFC');
    const before = auto.tail();
    await c.call(
      'click',
      { ...point, windowId: wid, coordinateSpace: 'global', strategy: 'coordinate' },
      s,
      true,
    );
    for (let i = 0; i < 24; i++) {
      await c.pause(500, s);
      const rows = auto.store.db
        .prepare("SELECT payload FROM events WHERE seq>? AND kind='text'")
        .all(before) as Array<{ payload: string }>;
      for (const r of rows) {
        try {
          const e = auto.resolveSource(
            auto.wxarcHome,
            JSON.parse(r.payload) as Record<string, unknown>,
          );
          const ownId = auto.settings().policy.ownId;
          validateAccount(e, ownId, auto.listener.wechatRoot ?? '');
          if (
            e.session === job.event.session &&
            e.senderId === ownId &&
            (e.local_type ?? 0) % 4294967296 === 3
          ) {
            return { confirmed: true, detail: '已核对本账号在目标会话发出的图片' };
          }
        } catch {}
      }
    }
    return { confirmed: false, detail: '未收到图片发送记录，不自动重发' };
  };

  commit.discard = async (s: AbortSignal): Promise<void> => {
    await verify(s);
    await key('Backspace', s);
    await input(s, '');
  };
  commit.deliveryDetail = '图片：' + (job.decision.image ?? '');
  return commit;
}
