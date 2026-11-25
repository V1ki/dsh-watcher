import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const IGNORED_DIRS = new Set(['node_modules', 'lib', 'lib-test', '.git', 'dist']);

interface CommentViolation {
  file: string;
  line: number;
  column: number;
  kind: string;
  preview: string;
}

function collectTsFiles(targetPath: string, out: string[]): void {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (targetPath.endsWith('.ts') || targetPath.endsWith('.tsx')) {
      out.push(targetPath);
    }
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    collectTsFiles(path.join(targetPath, entry.name), out);
  }
}

function scanFileForComments(filePath: string): CommentViolation[] {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const seen = new Set<string>();
  const ranges: ts.CommentRange[] = [];

  const recordRanges = (list: ts.CommentRange[] | undefined): void => {
    if (!list) return;
    for (const range of list) {
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push(range);
    }
  };

  const visit = (node: ts.Node): void => {
    recordRanges(ts.getLeadingCommentRanges(sourceText, node.pos));
    recordRanges(ts.getTrailingCommentRanges(sourceText, node.end));
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };

  visit(sourceFile);
  ranges.sort((a, b) => a.pos - b.pos || a.end - b.end);

  return ranges.map((range) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const raw = sourceText.slice(range.pos, range.end).replace(/\s+/g, ' ').trim();
    const kind =
      range.kind === ts.SyntaxKind.SingleLineCommentTrivia
        ? '//'
        : raw.startsWith('/**')
          ? '/** */'
          : '/* */';
    return {
      file: filePath,
      line: line + 1,
      column: character + 1,
      kind,
      preview: raw.slice(0, 80),
    };
  });
}

const repoRoot = process.cwd();
const cliArgs = process.argv.slice(2);
const roots =
  cliArgs.length > 0
    ? cliArgs.map((arg) => path.resolve(repoRoot, arg))
    : [path.join(repoRoot, 'packages'), path.join(repoRoot, 'scripts')];

const files: string[] = [];
for (const root of roots) {
  collectTsFiles(root, files);
}
files.sort();

const allViolations: CommentViolation[] = [];
for (const file of files) {
  allViolations.push(...scanFileForComments(file));
}

if (allViolations.length > 0) {
  for (const v of allViolations) {
    const rel = path.relative(repoRoot, v.file);
    process.stderr.write(`${rel}:${v.line}:${v.column} forbidden ${v.kind} comment: ${v.preview}\n`);
  }
  process.stderr.write(`Found ${allViolations.length} comment(s) across ${files.length} TypeScript file(s).\n`);
  process.exit(1);
}

process.stdout.write(`OK: 0 comments across ${files.length} TypeScript file(s).\n`);
