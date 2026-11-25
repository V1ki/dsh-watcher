import fs from 'node:fs';
import path from 'node:path';

const ASSET_EXTENSIONS = new Set(['.py', '.jxa']);
const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, 'src');
const outArg = process.argv[2];

if (!outArg) {
  process.stderr.write('Usage: node scripts/copy-assets.ts <destination-dir>\n');
  process.exit(1);
}

const destDir = path.resolve(repoRoot, outArg);
fs.mkdirSync(destDir, { recursive: true });

for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const ext = path.extname(entry.name);
  if (!ASSET_EXTENSIONS.has(ext)) continue;
  fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
}
