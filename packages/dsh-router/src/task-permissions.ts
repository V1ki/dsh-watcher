import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface ToolExecutionLike {
  name: string;
  arguments?: Record<string, unknown>;
}

interface ShellToken {
  word?: string;
  op?: string;
}

export const SAFE_COMMANDS = new Set([
  'cd',
  'pwd',
  'ls',
  'head',
  'tail',
  'cat',
  'wc',
  'file',
  'du',
  'stat',
  'test',
  'echo',
  'printf',
  'true',
  'false',
  'command',
  'pgrep',
  'which',
  'uname',
  'sw_vers',
  'date',
  'sleep',
  'grep',
  'rg',
  'find',
  'plutil',
]);

export function needsOperationConfirmation(exec: ToolExecutionLike): boolean {
  const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
  return (
    exec.name === 'bash' &&
    /(?:^|[\s;|&/])(rm|rmdir|unlink|trash|sudo|osascript|kill|killall|pkill|launchctl|pmset|diskutil|networksetup|chmod|chown|installer|softwareupdate)(?:\s|$)|\b(?:install|uninstall|upgrade)\b|\bdefaults\s+(?:write|delete)\b|\bgit\s+(?:push|reset\s+--hard|clean)\b/i.test(
      command,
    )
  );
}

export function isReadOnlyBash(
  command: unknown,
  args?: Record<string, unknown>,
): boolean {
  if (typeof command !== 'string' || !command.trim()) {
    return false;
  }
  if (
    /[\n\r`$\\]/.test(command) ||
    args?.sandbox_permissions === 'require_escalated' ||
    needsOperationConfirmation({ name: 'bash', arguments: { command } })
  ) {
    return false;
  }

  const tokens: ShellToken[] = [];
  let word = '';
  let quote = '';
  let started = false;
  const push = (): void => {
    if (started) {
      tokens.push({ word });
    }
    word = '';
    started = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) {
        quote = '';
      } else {
        word += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (';&|<>'.includes(c)) {
      push();
      let op = c;
      if (command[i + 1] === c || (c === '>' && command[i + 1] === '&')) {
        op += command[++i];
      }
      tokens.push({ op });
      continue;
    }
    word += c;
    started = true;
  }

  if (quote) {
    return false;
  }
  push();

  const parts: string[][] = [];
  let segment: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.op) {
      if ([';', '&&', '||', '|'].includes(t.op)) {
        if (segment.length === 0) {
          return false;
        }
        parts.push(segment);
        segment = [];
        continue;
      }
      if (
        (t.op === '>' && tokens[i + 1]?.word === '/dev/null') ||
        (t.op === '>&' && tokens[i + 1]?.word === '1')
      ) {
        if (/^\d+$/.test(segment.at(-1) || '')) {
          segment.pop();
        }
        i += 1;
        continue;
      }
      return false;
    }
    if (t.word !== undefined) {
      segment.push(t.word);
    }
  }

  if (segment.length > 0) {
    parts.push(segment);
  } else {
    return false;
  }

  return parts.every((words) => {
    const rawCmd = words[0] ?? '';
    const cmdName = rawCmd.split('/').at(-1) || '';
    const cmdArgs = words.slice(1);
    if (cmdName === 'cua') {
      return (
        /^(?:~|\/Users\/[^/]+)?\/Applications\/SwiftCUA\.app\/Contents\/MacOS\/cua$/.test(rawCmd) &&
        ['--help', 'ping', 'permissions', 'apps', 'windows', 'state'].includes(cmdArgs[0] ?? '')
      );
    }
    if (rawCmd.includes('/') && !/^\/(?:usr\/)?bin\/[^/]+$/.test(rawCmd)) {
      return false;
    }
    if (!SAFE_COMMANDS.has(cmdName)) {
      return false;
    }
    if (
      cmdName === 'find' &&
      cmdArgs.some((x) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)/.test(x))
    ) {
      return false;
    }
    if (cmdName === 'rg' && cmdArgs.some((x) => /^--(?:pre|hostname-bin)/.test(x))) {
      return false;
    }
    if (
      cmdName === 'plutil' &&
      cmdArgs.some((x) => !['-p', '-lint', '--'].includes(x) && x.startsWith('-'))
    ) {
      return false;
    }
    if (cmdName === 'command') {
      return cmdArgs[0] === '-v' || cmdArgs[0] === '-V';
    }
    return true;
  });
}

export function taskReusable(exec: ToolExecutionLike): boolean {
  if (['job_output', 'web_search', 'web_fetch', 'wxarc_sticker_search'].includes(exec.name)) {
    return true;
  }
  if (exec.name !== 'bash') {
    return false;
  }
  return isReadOnlyBash(exec.arguments?.command, exec.arguments);
}

export function withinWorkspace(root: string, value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return false;
  }
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
    ancestor = dirname(ancestor);
  }
  try {
    const actual = realpathSync(ancestor);
    const resolvedRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    const r = relative(resolvedRoot, actual);
    return !r.startsWith('..') && !isAbsolute(r);
  } catch {
    return false;
  }
}
