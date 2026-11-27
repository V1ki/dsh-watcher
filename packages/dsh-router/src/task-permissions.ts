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

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'describe',
  'tag',
]);

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);
const GIT_GLOBAL_BOOL_FLAGS = new Set(['--no-pager', '--paginate', '--bare', '--no-optional-locks']);
const GIT_BRANCH_VALUE_FLAGS = new Set([
  '--list',
  '-l',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
  '--color',
  '--abbrev',
]);
const GIT_TAG_VALUE_FLAGS = new Set([
  '--list',
  '-l',
  '-n',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
  '--color',
]);

function isReadOnlyGitCommand(args: string[]): boolean {
  let idx = 0;
  while (idx < args.length) {
    const token = args[idx] ?? '';
    if (!token.startsWith('-')) break;
    if (GIT_GLOBAL_BOOL_FLAGS.has(token)) {
      idx += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(token)) {
      if (idx + 1 >= args.length) return false;
      idx += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree)=/.test(token)) {
      idx += 1;
      continue;
    }
    return false;
  }

  const subcommand = args[idx] ?? '';
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  const subArgs = args.slice(idx + 1);

  if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show') {
    if (subArgs.some((x) => x === '--ext-diff' || x === '--output' || x.startsWith('--output='))) {
      return false;
    }
    return true;
  }

  if (subcommand === 'branch') {
    let allowPositional = false;
    for (let i = 0; i < subArgs.length; i += 1) {
      const arg = subArgs[i] ?? '';
      if (arg === '--') {
        if (!allowPositional && i < subArgs.length - 1) return false;
        continue;
      }
      if (arg.startsWith('--')) {
        const flagName = arg.split('=')[0] ?? arg;
        if (
          [
            '--delete',
            '--move',
            '--copy',
            '--force',
            '--set-upstream-to',
            '--unset-upstream',
            '--edit-description',
            '--create-reflog',
            '--track',
            '--no-track',
          ].includes(flagName)
        ) {
          return false;
        }
        if (flagName === '--list') {
          allowPositional = true;
        } else if (GIT_BRANCH_VALUE_FLAGS.has(flagName) && !arg.includes('=')) {
          i += 1;
        }
        continue;
      }
      if (arg.startsWith('-') && arg.length > 1) {
        if (/[dDmMcCfFu]/.test(arg.slice(1))) {
          return false;
        }
        if (arg.includes('l')) {
          allowPositional = true;
        }
        continue;
      }
      if (!allowPositional) {
        return false;
      }
    }
    return true;
  }

  if (subcommand === 'tag') {
    let allowPositional = false;
    for (let i = 0; i < subArgs.length; i += 1) {
      const arg = subArgs[i] ?? '';
      if (arg === '--') {
        if (!allowPositional && i < subArgs.length - 1) return false;
        continue;
      }
      if (arg.startsWith('--')) {
        const flagName = arg.split('=')[0] ?? arg;
        if (
          [
            '--delete',
            '--annotate',
            '--sign',
            '--local-user',
            '--force',
            '--message',
            '--file',
            '--cleanup',
            '--create-reflog',
          ].includes(flagName)
        ) {
          return false;
        }
        if (flagName === '--list') {
          allowPositional = true;
        } else if (GIT_TAG_VALUE_FLAGS.has(flagName) && !arg.includes('=')) {
          i += 1;
        }
        continue;
      }
      if (arg.startsWith('-') && arg.length > 1) {
        if (/[dDmMsufFa]/.test(arg.slice(1))) {
          return false;
        }
        if (arg.includes('l')) {
          allowPositional = true;
        }
        continue;
      }
      if (!allowPositional) {
        return false;
      }
    }
    return true;
  }

  return true;
}

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
    if (cmdName === 'git') {
      return isReadOnlyGitCommand(cmdArgs);
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
