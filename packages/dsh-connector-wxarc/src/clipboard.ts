import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type ClipboardItem = Record<string, string>;

export type ClipboardRequest =
  | { action: 'snapshot' }
  | { action: 'read' }
  | { action: 'image' }
  | { action: 'count' }
  | { action: 'setImage'; count: number; type: 'public.png' | 'public.jpeg'; data: string }
  | { action: 'restore'; items: ClipboardItem[]; count?: number };

export interface ClipboardSnapshotResult {
  count: number;
  items: ClipboardItem[];
}

export interface ClipboardReadResult {
  count: number;
  text: string;
}

export interface ClipboardImageResult {
  count: number;
  data: string;
}

export interface ClipboardCountResult {
  count: number;
}

export interface ClipboardRestoreResult {
  restored: boolean;
}

export interface ClipboardResponse {
  count?: number;
  items?: ClipboardItem[];
  text?: string;
  data?: string;
  restored?: boolean;
}

export type ClipboardFn = (
  request: ClipboardRequest,
  signal?: AbortSignal,
) => Promise<ClipboardResponse>;

export function clipboard(
  request: { action: 'snapshot' },
  signal?: AbortSignal,
): Promise<ClipboardSnapshotResult>;
export function clipboard(
  request: { action: 'read' },
  signal?: AbortSignal,
): Promise<ClipboardReadResult>;
export function clipboard(
  request: { action: 'image' },
  signal?: AbortSignal,
): Promise<ClipboardImageResult>;
export function clipboard(
  request: { action: 'count' },
  signal?: AbortSignal,
): Promise<ClipboardCountResult>;
export function clipboard(
  request: { action: 'setImage'; count: number; type: 'public.png' | 'public.jpeg'; data: string },
  signal?: AbortSignal,
): Promise<ClipboardCountResult>;
export function clipboard(
  request: { action: 'restore'; items: ClipboardItem[]; count?: number },
  signal?: AbortSignal,
): Promise<ClipboardRestoreResult>;
export function clipboard(
  request: ClipboardRequest,
  signal?: AbortSignal,
): Promise<ClipboardResponse>;
export function clipboard(
  request: ClipboardRequest,
  signal?: AbortSignal,
): Promise<ClipboardResponse> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', fileURLToPath(new URL('./clipboard.jxa', import.meta.url))],
      { signal, timeout: 8000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(new Error('无法读取或恢复系统剪贴板'));
        try {
          resolve(JSON.parse(stdout) as ClipboardResponse);
        } catch {
          reject(new Error('剪贴板返回结果无效'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}
