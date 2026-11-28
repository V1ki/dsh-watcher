import fs from 'node:fs';
import path from 'node:path';

type Severity = 'error' | 'warn';

interface DocIssue {
  severity: Severity;
  file: string;
  line: number;
  rule: string;
  message: string;
}

interface ProseBlock {
  kind: 'paragraph' | 'list-item';
  startLine: number;
  text: string;
}

interface MermaidBlock {
  startLine: number;
  lines: Array<{ line: number; text: string }>;
}

const NUMBERED_DOC_RE = /^\d{2}-.+\.md$/;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;
const TABLE_SEP_RE = /^\|[\s:-]+(?:\|[\s:-]+)*\|$/;
const LINK_RE = /(!?)\[([^\]]*)\]\(([^)\n]+)\)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const BACKTICK_CALL_RE = /`[^`]*\b[a-zA-Z_][a-zA-Z0-9_.]*\([^`)]*\)[^`]*`/;
const PROSE_CALL_RE =
  /\b(?:[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_.]*|[a-z][a-zA-Z0-9_]*_[a-zA-Z0-9_]+|[a-z]+[A-Z][a-zA-Z0-9_]*)\([^)\n]*\)|\b[a-zA-Z_][a-zA-Z0-9_.]*\(\)/;
const CODE_SYNTAX_CHECKS: Array<{ label: string; pattern: RegExp }> = [
  { label: '===', pattern: /===/ },
  { label: '!==', pattern: /!==/ },
  { label: '=>', pattern: /=>/ },
  { label: 'ctx.provide(', pattern: /ctx\.provide\s*\(/ },
  { label: '.ts/.tsx file path', pattern: /\.tsx?\b/ },
  { label: 'function call signature', pattern: BACKTICK_CALL_RE },
  { label: 'function call signature', pattern: PROSE_CALL_RE },
];
const PRIVACY_CHECKS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'local user path (/Users/)', pattern: /\/Users\// },
  { label: 'private LAN IP (192.168.x.x)', pattern: /\b192\.168\./ },
  {
    label: 'Tailscale/CGNAT IP (100.64.0.0/10)',
    pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    label: 'non-loopback IPv4 address',
    pattern:
      /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|255\.255\.255\.255\b)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/,
  },
  { label: 'real WeChat ID (wxid_...)', pattern: /\bwxid_[a-zA-Z0-9_-]{6,}\b/ },
];
const MERMAID_KEYWORDS = new Set([
  'flowchart',
  'graph',
  'sequencediagram',
  'statediagram',
  'statediagram-v2',
  'classdiagram',
  'erdiagram',
  'subgraph',
  'end',
  'direction',
  'style',
  'classdef',
  'class',
  'linkstyle',
  'click',
  'participant',
  'actor',
  'note',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'and',
  'rect',
  'activate',
  'deactivate',
  'autonumber',
]);

function splitLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function stripInlineCode(text: string): string {
  return text.replace(INLINE_CODE_RE, (match) => ' '.repeat(match.length));
}

function stripMarkdownLinks(text: string): string {
  return text.replace(LINK_RE, (_full, _bang: string, label: string) => label);
}

function toPlainText(text: string): string {
  return stripMarkdownLinks(text)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFenceClose(line: string, fenceChar: string, fenceLen: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fenceLen) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fenceChar) return false;
  }
  return true;
}

function parseLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith('<')) {
    const closeIdx = trimmed.indexOf('>');
    if (closeIdx > 1) return trimmed.slice(1, closeIdx).trim();
  }
  const spaceIdx = trimmed.search(/\s/);
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

function safeDecodeUri(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function checkLinksAndCollectResolved(
  filePath: string,
  lines: string[],
  issues: DocIssue[],
): Set<string> {
  const resolvedTargets = new Set<string>();
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      continue;
    }

    const sanitized = stripInlineCode(line);
    LINK_RE.lastIndex = 0;
    let match = LINK_RE.exec(sanitized);
    while (match !== null) {
      const target = parseLinkTarget(match[3]);
      if (
        target.length > 0 &&
        !target.startsWith('#') &&
        !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
      ) {
        const pathOnly = target.split('#')[0];
        if (pathOnly.length > 0) {
          const decoded = safeDecodeUri(pathOnly);
          const resolved = path.resolve(path.dirname(filePath), decoded);
          resolvedTargets.add(resolved);
          if (!fs.existsSync(resolved)) {
            issues.push({
              severity: 'error',
              file: filePath,
              line: i + 1,
              rule: 'broken-link',
              message: `broken relative link "${target}"`,
            });
          }
        }
      }
      match = LINK_RE.exec(sanitized);
    }
  }

  return resolvedTargets;
}

function checkPrivacy(filePath: string, lines: string[], issues: DocIssue[]): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const check of PRIVACY_CHECKS) {
      if (check.pattern.test(line)) {
        issues.push({
          severity: 'error',
          file: filePath,
          line: i + 1,
          rule: 'privacy-leak',
          message: `forbidden ${check.label}`,
        });
      }
    }
  }
}

function findCodeSyntaxIssue(text: string): string | null {
  const withoutLinkUrls = stripMarkdownLinks(text);
  for (const check of CODE_SYNTAX_CHECKS) {
    const match = check.pattern.exec(withoutLinkUrls);
    if (match) {
      return `${check.label} (${match[0].slice(0, 40)})`;
    }
  }
  return null;
}

function findNestedParensIssue(text: string): string | null {
  const withoutLinkUrls = stripMarkdownLinks(text);
  if (/（[^）]*（/.test(withoutLinkUrls)) {
    return 'nested Chinese parentheses （...（...）...）';
  }
  if (/\([^)]*\(/.test(withoutLinkUrls)) {
    return 'nested ASCII parentheses (...(...)...)';
  }
  const chineseParenRe = /（([^）]*)）/g;
  let match = chineseParenRe.exec(withoutLinkUrls);
  while (match !== null) {
    const inner = match[1];
    const asciiInsideRe = /\(([^)]*)\)/g;
    let asciiMatch = asciiInsideRe.exec(inner);
    while (asciiMatch !== null) {
      if (/[`_./=><:;{}[\]$|'"\\]/.test(asciiMatch[1])) {
        return `code symbols in nested parentheses (${asciiMatch[0].slice(0, 40)})`;
      }
      asciiMatch = asciiInsideRe.exec(inner);
    }
    match = chineseParenRe.exec(withoutLinkUrls);
  }
  return null;
}

function checkReadmeTable(filePath: string, lines: string[], issues: DocIssue[]): void {
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (TABLE_SEP_RE.test(trimmed)) continue;

    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    const hasDocLink = cells.some((cell) => /\]\([^)]*\d{2}-[^)]*\.md\)/.test(cell));
    if (!hasDocLink) continue;

    const summaryCell = cells[cells.length - 1] ?? '';
    const plainSummary = toPlainText(summaryCell);
    const backtickCount = (summaryCell.match(INLINE_CODE_RE) ?? []).length;

    if (plainSummary.length > 80) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: i + 1,
        rule: 'readme-summary-length',
        message: `index summary too long (${plainSummary.length} chars, max 80)`,
      });
    } else if (plainSummary.length > 55) {
      issues.push({
        severity: 'warn',
        file: filePath,
        line: i + 1,
        rule: 'readme-summary-length',
        message: `index summary verbose (${plainSummary.length} chars, target <= 40)`,
      });
    }

    if (backtickCount > 2) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: i + 1,
        rule: 'readme-summary-backticks',
        message: `too many inline code spans in index summary (${backtickCount}, max 2)`,
      });
    }

    const codeIssue = findCodeSyntaxIssue(summaryCell);
    if (codeIssue) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: i + 1,
        rule: 'readme-summary-code',
        message: `code syntax in index summary: ${codeIssue}`,
      });
    }
  }
}

function checkHeaderSummary(filePath: string, lines: string[], issues: DocIssue[]): void {
  const searchLimit = Math.min(10, lines.length);
  let quoteStart = -1;
  for (let i = 0; i < searchLimit; i += 1) {
    if (lines[i].trim().startsWith('>')) {
      quoteStart = i;
      break;
    }
  }

  if (quoteStart === -1) {
    issues.push({
      severity: 'error',
      file: filePath,
      line: 1,
      rule: 'header-summary-missing',
      message: 'missing opening ">" one-liner summary within the first 10 lines',
    });
    return;
  }

  const rawParts: string[] = [];
  for (let i = quoteStart; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('>')) break;
    rawParts.push(trimmed.replace(/^>+\s?/, ''));
  }

  const rawJoined = rawParts.join(' ');
  if (rawJoined.includes('`')) {
    issues.push({
      severity: 'error',
      file: filePath,
      line: quoteStart + 1,
      rule: 'header-summary-backtick',
      message: 'opening ">" summary must contain 0 backticks',
    });
  }

  const compactLength = rawJoined.replace(/\s+/g, '').length;
  if (compactLength === 0) {
    issues.push({
      severity: 'error',
      file: filePath,
      line: quoteStart + 1,
      rule: 'header-summary-empty',
      message: 'opening ">" summary is empty',
    });
  } else if (compactLength > 80) {
    issues.push({
      severity: 'error',
      file: filePath,
      line: quoteStart + 1,
      rule: 'header-summary-length',
      message: `opening ">" summary too long (${compactLength} chars without spaces, max 80)`,
    });
  }
}

function extractProseAndMermaid(lines: string[]): {
  blocks: ProseBlock[];
  mermaids: MermaidBlock[];
} {
  const blocks: ProseBlock[] = [];
  const mermaids: MermaidBlock[] = [];
  let fenceChar = '';
  let fenceLen = 0;
  let activeMermaid: MermaidBlock | null = null;
  let current: ProseBlock | null = null;

  const flush = (): void => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        if (activeMermaid) {
          mermaids.push(activeMermaid);
          activeMermaid = null;
        }
        fenceChar = '';
        fenceLen = 0;
      } else if (activeMermaid) {
        activeMermaid.lines.push({ line: i + 1, text: line });
      }
      continue;
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      flush();
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim().toLowerCase();
      if (lang === 'mermaid' || lang.startsWith('mermaid ')) {
        activeMermaid = { startLine: i + 1, lines: [] };
      }
      continue;
    }

    const trimmed = line.trim();
    if (
      trimmed.length === 0 ||
      HEADING_RE.test(line) ||
      HR_RE.test(line) ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('|')
    ) {
      flush();
      continue;
    }

    const listMatch = LIST_ITEM_RE.exec(line);
    if (listMatch) {
      flush();
      current = {
        kind: 'list-item',
        startLine: i + 1,
        text: listMatch[1].trim(),
      };
      continue;
    }

    if (current) {
      current.text = `${current.text} ${trimmed}`;
    } else {
      current = {
        kind: 'paragraph',
        startLine: i + 1,
        text: trimmed,
      };
    }
  }

  flush();
  return { blocks, mermaids };
}

function checkProseBlocks(filePath: string, blocks: ProseBlock[], issues: DocIssue[]): void {
  for (const block of blocks) {
    const plain = toPlainText(block.text);
    if (plain.length > 240) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: block.startLine,
        rule: 'prose-length',
        message: `${block.kind} too long (${plain.length} chars, max 240)`,
      });
    }

    const backticks = block.text.match(INLINE_CODE_RE) ?? [];
    if (backticks.length > 3) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: block.startLine,
        rule: 'prose-backticks',
        message: `too many inline code spans in ${block.kind} (${backticks.length}, max 3)`,
      });
    }

    const codeIssue = findCodeSyntaxIssue(block.text);
    if (codeIssue) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: block.startLine,
        rule: 'prose-code-syntax',
        message: `forbidden code syntax in ${block.kind}: ${codeIssue}`,
      });
    }

    const parensIssue = findNestedParensIssue(block.text);
    if (parensIssue) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: block.startLine,
        rule: 'prose-nested-parens',
        message: `forbidden ${parensIssue} in ${block.kind}`,
      });
    }
  }
}

function checkMermaidBlocks(filePath: string, mermaids: MermaidBlock[], issues: DocIssue[]): void {
  for (const block of mermaids) {
    const nodes = new Set<string>();
    let definitionLines = 0;
    let isSequence = false;

    for (const entry of block.lines) {
      const trimmed = entry.text.trim();
      if (trimmed.length === 0 || trimmed.startsWith('%%')) continue;

      if (/\.tsx?\b/.test(trimmed) || /\bctx\./.test(trimmed)) {
        issues.push({
          severity: 'error',
          file: filePath,
          line: entry.line,
          rule: 'mermaid-code-leak',
          message: 'mermaid diagram must not contain .ts/.tsx paths or ctx. references',
        });
      }

      const lower = trimmed.toLowerCase();
      if (lower.startsWith('sequencediagram')) {
        isSequence = true;
        continue;
      }

      const firstWord = lower.split(/\s+/)[0];
      if (
        firstWord === 'flowchart' ||
        firstWord === 'graph' ||
        firstWord === 'statediagram' ||
        firstWord === 'statediagram-v2' ||
        firstWord === 'classdiagram' ||
        firstWord === 'erdiagram' ||
        firstWord === 'subgraph' ||
        firstWord === 'end' ||
        firstWord === 'direction' ||
        firstWord === 'style' ||
        firstWord === 'classdef' ||
        firstWord === 'class' ||
        firstWord === 'linkstyle' ||
        firstWord === 'click' ||
        firstWord === 'note' ||
        firstWord === 'loop' ||
        firstWord === 'alt' ||
        firstWord === 'else' ||
        firstWord === 'opt' ||
        firstWord === 'par' ||
        firstWord === 'and' ||
        firstWord === 'rect' ||
        firstWord === 'activate' ||
        firstWord === 'deactivate' ||
        firstWord === 'autonumber'
      ) {
        continue;
      }

      definitionLines += 1;

      if (isSequence) {
        const participantMatch = /^(?:participant|actor)\s+([a-zA-Z0-9_-]+)/i.exec(trimmed);
        if (participantMatch) {
          nodes.add(participantMatch[1]);
          continue;
        }
        const seqArrowMatch =
          /^([a-zA-Z0-9_-]+)\s*(?:->>|-->>|->|-->|-x|--x|-\)|--\))\s*\+?([a-zA-Z0-9_-]+)/.exec(
            trimmed,
          );
        if (seqArrowMatch) {
          nodes.add(seqArrowMatch[1]);
          nodes.add(seqArrowMatch[2]);
        }
        continue;
      }

      const withoutQuoted = trimmed.replace(/"[^"]*"/g, '""');
      const nodeDeclRe = /\b([a-zA-Z_][a-zA-Z0-9_-]*)\s*(?:\[|\(|\{)/g;
      let declMatch = nodeDeclRe.exec(withoutQuoted);
      while (declMatch !== null) {
        const id = declMatch[1];
        if (!MERMAID_KEYWORDS.has(id.toLowerCase())) {
          nodes.add(id);
        }
        declMatch = nodeDeclRe.exec(withoutQuoted);
      }

      const arrowRe =
        /\b([a-zA-Z_][a-zA-Z0-9_-]*)(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(?:-->|-.->|==>|---|--[^>]*-->)\s*(?:\|[^|]*\|\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)/g;
      let arrowMatch = arrowRe.exec(withoutQuoted);
      while (arrowMatch !== null) {
        const fromId = arrowMatch[1];
        const toId = arrowMatch[2];
        if (!MERMAID_KEYWORDS.has(fromId.toLowerCase())) nodes.add(fromId);
        if (!MERMAID_KEYWORDS.has(toId.toLowerCase())) nodes.add(toId);
        arrowMatch = arrowRe.exec(withoutQuoted);
      }
    }

    if (definitionLines > 30) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: block.startLine,
        rule: 'mermaid-too-complex',
        message: `mermaid diagram has too many node/edge lines (${definitionLines}, max 30)`,
      });
    }

    if (nodes.size > 10) {
      issues.push({
        severity: 'warn',
        file: filePath,
        line: block.startLine,
        rule: 'mermaid-too-many-nodes',
        message: `mermaid diagram declares ${nodes.size} nodes (target <= 10)`,
      });
    }
  }
}

function checkDocLength(filePath: string, lineCount: number, issues: DocIssue[]): void {
  if (lineCount > 260) {
    issues.push({
      severity: 'error',
      file: filePath,
      line: 1,
      rule: 'doc-too-long',
      message: `document has ${lineCount} lines (hard limit 260; split into focused docs)`,
    });
  } else if (lineCount > 220) {
    issues.push({
      severity: 'warn',
      file: filePath,
      line: 1,
      rule: 'doc-long',
      message: `document has ${lineCount} lines (target <= 220)`,
    });
  } else if (lineCount < 60) {
    issues.push({
      severity: 'warn',
      file: filePath,
      line: 1,
      rule: 'doc-short',
      message: `document has ${lineCount} lines (target >= 60)`,
    });
  }
}

function main(): void {
  const repoRoot = process.cwd();
  const docsDir = process.argv[2]
    ? path.resolve(repoRoot, process.argv[2])
    : path.join(repoRoot, 'docs');

  if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
    process.stderr.write(`docs directory not found: ${docsDir}\n`);
    process.exitCode = 1;
    return;
  }

  const entries = fs
    .readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  const readmePath = path.join(docsDir, 'README.md');
  const numberedDocs = entries.filter((name) => NUMBERED_DOC_RE.test(name));
  const issues: DocIssue[] = [];

  let readmeLinks = new Set<string>();
  if (!fs.existsSync(readmePath)) {
    issues.push({
      severity: 'error',
      file: readmePath,
      line: 1,
      rule: 'readme-missing',
      message: 'docs/README.md is missing',
    });
  } else {
    const readmeLines = splitLines(fs.readFileSync(readmePath, 'utf8'));
    readmeLinks = checkLinksAndCollectResolved(readmePath, readmeLines, issues);
    checkPrivacy(readmePath, readmeLines, issues);
    checkReadmeTable(readmePath, readmeLines, issues);
  }

  for (const docName of numberedDocs) {
    const fullPath = path.join(docsDir, docName);
    if (fs.existsSync(readmePath) && !readmeLinks.has(path.resolve(fullPath))) {
      issues.push({
        severity: 'error',
        file: readmePath,
        line: 1,
        rule: 'index-missing',
        message: `numbered doc "${docName}" is not linked in docs/README.md`,
      });
    }
  }

  for (const fileName of entries) {
    if (fileName === 'README.md') continue;
    const fullPath = path.join(docsDir, fileName);
    const lines = splitLines(fs.readFileSync(fullPath, 'utf8'));

    checkLinksAndCollectResolved(fullPath, lines, issues);
    checkPrivacy(fullPath, lines, issues);

    if (NUMBERED_DOC_RE.test(fileName)) {
      checkHeaderSummary(fullPath, lines, issues);
      checkDocLength(fullPath, lines.length, issues);
      const { blocks, mermaids } = extractProseAndMermaid(lines);
      checkProseBlocks(fullPath, blocks, issues);
      checkMermaidBlocks(fullPath, mermaids, issues);
    }
  }

  let errorCount = 0;
  let warnCount = 0;

  for (const issue of issues) {
    const rel = path.relative(repoRoot, issue.file);
    const tag = issue.severity === 'error' ? 'ERROR' : 'WARN';
    const lineOut = `${tag} ${rel}:${issue.line} [${issue.rule}] ${issue.message}\n`;
    if (issue.severity === 'error') {
      errorCount += 1;
      process.stderr.write(lineOut);
    } else {
      warnCount += 1;
      process.stdout.write(lineOut);
    }
  }

  const summary = `Checked ${entries.length} doc file(s): ${errorCount} error(s), ${warnCount} warning(s).\n`;
  if (errorCount > 0) {
    process.stderr.write(summary);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`OK: ${summary}`);
}

main();
