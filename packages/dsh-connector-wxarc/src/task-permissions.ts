export interface ToolExecutionLike {
  name: string;
  arguments?: Record<string, unknown>;
}

interface ShellToken {
  word?: string;
  op?: string;
}

const SAFE_COMMANDS = new Set([
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

export function taskReusable(exec: ToolExecutionLike): boolean {
  if (['job_output', 'web_search', 'web_fetch', 'wxarc_sticker_search'].includes(exec.name)) {
    return true;
  }
  if (exec.name !== 'bash' || needsOperationConfirmation(exec)) {
    return false;
  }
  const command = exec.arguments?.command;
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    /[\n\r`$\\]/.test(command) ||
    exec.arguments?.sandbox_permissions === 'require_escalated'
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
  for (let i = 0; i < command.length; i++) {
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
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op) {
      if ([';', '&&', '||', '|'].includes(t.op)) {
        if (!segment.length) {
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
        i++;
        continue;
      }
      return false;
    }
    if (t.word !== undefined) {
      segment.push(t.word);
    }
  }
  if (segment.length) {
    parts.push(segment);
  } else {
    return false;
  }
  return parts.every((words) => {
    const name = words[0].split('/').at(-1) || '';
    const args = words.slice(1);
    if (name === 'cua') {
      return (
        /^(?:~|\/Users\/[^/]+)?\/Applications\/SwiftCUA\.app\/Contents\/MacOS\/cua$/.test(words[0]) &&
        ['--help', 'ping', 'permissions', 'apps', 'windows', 'state'].includes(args[0])
      );
    }
    if (words[0].includes('/') && !/^\/(?:usr\/)?bin\/[^/]+$/.test(words[0])) {
      return false;
    }
    if (!SAFE_COMMANDS.has(name)) {
      return false;
    }
    if (
      name === 'find' &&
      args.some((x) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)/.test(x))
    ) {
      return false;
    }
    if (name === 'rg' && args.some((x) => /^--(?:pre|hostname-bin)/.test(x))) {
      return false;
    }
    if (name === 'plutil' && args.some((x) => !['-p', '-lint', '--'].includes(x) && x.startsWith('-'))) {
      return false;
    }
    if (name === 'command') {
      return args[0] === '-v' || args[0] === '-V';
    }
    return true;
  });
}
